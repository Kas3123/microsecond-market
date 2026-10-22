// Market map: every stock in the index as a tile, grouped by sector (a treemap), coloured by its move.
(function () {
  'use strict';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // Squarified treemap (Bruls, Huizing & van Wijk): lays items with value v into rectangle r, keeping tiles near-square.
  function squarify(items, x, y, w, h) {
    const out = [], total = items.reduce((a, it) => a + it.v, 0);
    if (!items.length || total <= 0 || w <= 0 || h <= 0) return out;
    const scale = (w * h) / total, rest = items.map(it => ({ it, a: it.v * scale })).sort((p, q) => q.a - p.a);
    let row = [], X = x, Y = y, W = w, H = h;
    const worst = (r, side) => { const s = r.reduce((a, q) => a + q.a, 0), mx = Math.max(...r.map(q => q.a)), mn = Math.min(...r.map(q => q.a)); return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn)); };
    const flush = () => {
      const s = row.reduce((a, q) => a + q.a, 0);
      if (W >= H) { const cw = s / H; let yy = Y; for (const q of row) { const ch = q.a / cw; out.push({ it: q.it, x: X, y: yy, w: cw, h: ch }); yy += ch; } X += cw; W -= cw; }
      else { const ch = s / W; let xx = X; for (const q of row) { const cw = q.a / ch; out.push({ it: q.it, x: xx, y: Y, w: cw, h: ch }); xx += cw; } Y += ch; H -= ch; }
      row = [];
    };
    for (const q of rest) {
      const side = Math.min(W, H);
      if (!row.length || worst(row.concat([q]), side) <= worst(row, side)) row.push(q);
      else { flush(); row.push(q); }
    }
    if (row.length) flush();
    return out;
  }

  class MapView {
    constructor(canvas) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.opts = { color: 'chg', size: 'cap' };
      this.rects = []; this.hover = null; this.mouse = null; this.sig = '';
      canvas.addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); this.mouse = [e.clientX - r.left, e.clientY - r.top]; });
      canvas.addEventListener('pointerleave', () => { this.mouse = null; });
      canvas.addEventListener('click', () => { const h = this.hit(); if (h && this.onPick) this.onPick(h.ticker); });
      canvas.addEventListener('dblclick', () => { const h = this.hit(); if (h && this.onOpen) this.onOpen(h.ticker); });
    }
    hit() { if (!this.mouse) return null; const [mx, my] = this.mouse; const r = this.rects.find(q => mx >= q.x && mx < q.x + q.w && my >= q.y && my < q.y + q.h); return r ? r.s : null; }
    layout(U, W, H) {
      const sig = `${W}x${H}:${this.opts.size}:${U.region}:${U.stocks.length}`;
      if (sig === this.sig) return;
      this.sig = sig; this.rects = []; this.secRects = [];
      const val = s => this.opts.size === 'equal' ? 1 : Math.sqrt(s.cap);
      const groups = {};
      for (const s of U.stocks) (groups[s.sector] = groups[s.sector] || []).push(s);
      const secItems = Object.entries(groups).map(([k, list]) => ({ k, list, v: list.reduce((a, s) => a + val(s), 0) }));
      const top = 4;
      for (const sr of squarify(secItems, 4, top, W - 8, H - top - 4)) {
        const head = sr.h > 40 && sr.w > 50 ? 15 : 0;
        this.secRects.push({ k: sr.it.k, list: sr.it.list, x: sr.x, y: sr.y, w: sr.w, h: sr.h, head });
        for (const q of squarify(sr.it.list.map(s => ({ s, v: val(s) })), sr.x + 1, sr.y + head + 1, sr.w - 2, sr.h - head - 2))
          this.rects.push({ s: q.it.s, x: q.x, y: q.y, w: q.w, h: q.h });
      }
    }
    move(U, s) {
      const chg = s.price / s.open - 1;
      if (this.opts.color === 'rel') return chg - s.beta * (U.futures() / U.idx.base - 1); // move not explained by the index
      return chg;
    }
    draw(U, focus, selected) {
      const cv = this.c, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); this.sig = ''; }
      const x = this.ctx, c = window.Theme.c, TH = window.Theme; x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.fillStyle = c.stage; x.fillRect(0, 0, W, H);
      this.layout(U, W, H);
      const scale = this.opts.color === 'rel' ? 0.015 : 0.025;
      const MONO = '"IBM Plex Mono", ui-monospace, monospace', COND = '"IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
      const neutral = c.panel2;
      for (const r of this.rects) {
        const s = r.s, m = this.move(U, s), f = Math.pow(clamp(Math.abs(m) / scale, 0, 1), 0.7);
        x.fillStyle = TH.mix(neutral, m >= 0 ? c.up : c.down, f * 0.85);
        x.fillRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        if (r.w > 26 && r.h > 14) {
          const big = r.w > 70 && r.h > 40, fs = big ? 13 : r.w > 40 ? 11 : 9.5;
          x.fillStyle = f > 0.55 ? '#FFFFFF' : c.ink; x.textAlign = 'center'; x.textBaseline = 'middle';
          x.font = `600 ${fs}px ${COND}`;
          const cy = r.y + r.h / 2 - (r.h > 30 ? 6 : 0);
          x.fillText(s.ticker, r.x + r.w / 2, cy);
          if (r.h > 30) { x.font = `${big ? 11.5 : 10}px ${MONO}`; x.fillText(`${m >= 0 ? '+' : ''}${(m * 100).toFixed(2)}%`, r.x + r.w / 2, cy + fs - 0.5); }
          if (big && r.h > 58) { x.font = `10px ${MONO}`; x.globalAlpha = 0.75; x.fillText(s.price.toFixed(s.price < 10 ? 3 : 2), r.x + r.w / 2, cy + fs + 12); x.globalAlpha = 1; }
        }
        if (s.ticker === focus) { x.strokeStyle = c.accent; x.lineWidth = 2.5; x.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3); x.lineWidth = 1; }
        else if (s.ticker === selected) { x.strokeStyle = c.ink; x.lineWidth = 2; x.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3); x.lineWidth = 1; }
        if (s.vcm && !s.vcm.done && U.t < s.vcm.until) { x.strokeStyle = c.hi; x.setLineDash([3, 3]); x.strokeRect(r.x + 2.5, r.y + 2.5, r.w - 5, r.h - 5); x.setLineDash([]); }
      }
      // sector frames and names (with the sector's cap-weighted move)
      for (const sr of this.secRects) {
        x.strokeStyle = c.stage; x.lineWidth = 3; x.strokeRect(sr.x, sr.y, sr.w, sr.h); x.lineWidth = 1;
        if (!sr.head) continue;
        let wsum = 0, msum = 0; for (const s of sr.list) { wsum += s.cap; msum += s.cap * this.move(U, s); }
        const m = msum / wsum, name = window.STOCKS.SECTORS[U.region][sr.k].toUpperCase();
        x.fillStyle = c.stage; x.fillRect(sr.x + 1, sr.y + 1, sr.w - 2, sr.head);
        x.font = `600 10.5px ${COND}`; x.textAlign = 'left'; x.textBaseline = 'middle';
        x.fillStyle = c.accent; const label = sr.w > 150 ? name : name.split(' ')[0];
        x.fillText(label, sr.x + 5, sr.y + 1 + sr.head / 2);
        x.fillStyle = m >= 0 ? c.up : c.down; x.textAlign = 'right'; x.font = `10.5px ${MONO}`;
        if (sr.w > 110) x.fillText(`${m >= 0 ? '+' : ''}${(m * 100).toFixed(2)}%`, sr.x + sr.w - 5, sr.y + 1 + sr.head / 2);
      }
      // hover tooltip
      const h = this.hit();
      cv.style.cursor = h ? 'pointer' : 'default';
      if (h && this.mouse) {
        const m = (h.price / h.open - 1) * 100;
        const lines = [`${h.ticker} · ${h.name}`, `${h.price.toFixed(h.price < 10 ? 3 : 2)}  ${m >= 0 ? '+' : ''}${m.toFixed(2)}%  · beta ${h.beta.toFixed(2)}`, `${h.sectorName}${h.ticker === focus ? ' · simulated order by order' : ' · click for profile, double-click to simulate'}`];
        x.font = `12px ${COND}`; const tw = Math.max(...lines.map(l => x.measureText(l).width)) + 14;
        const tx = Math.min(W - tw - 6, this.mouse[0] + 14), ty = Math.min(H - 60, Math.max(6, this.mouse[1] - 10));
        x.fillStyle = c.tooltip; x.strokeStyle = c.accent; x.fillRect(tx, ty, tw, 54); x.strokeRect(tx + 0.5, ty + 0.5, tw - 1, 53);
        x.textAlign = 'left'; x.textBaseline = 'top';
        lines.forEach((l, i) => { x.fillStyle = i === 0 ? c.ink : c.muted; x.font = i === 0 ? `600 12px ${COND}` : `11.5px ${i === 1 ? MONO : COND}`; x.fillText(l, tx + 7, ty + 5 + i * 16); });
      }
    }
  }
  window.MapView = MapView;
  window.squarify = squarify;
})();
