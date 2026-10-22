// Order-flow network: every location, with each message animated along its real route.
// Two layouts: a schematic map, and a latency map where distance from the exchange is the one-way delay (log scale).
(function () {
  'use strict';
  const { CATS, PLACES } = window.MM;
  const { linkUs } = window.Engine;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // Schematic positions (0..1). Roughly geographic, not to scale; link labels carry the real numbers.
  const LAYOUT = {
    us: { aurora: [0.07, 0.28], ohio: [0.07, 0.80], boston: [0.93, 0.13], london: [0.93, 0.86], mahwah: [0.50, 0.14], secaucus: [0.62, 0.48], manhattan: [0.83, 0.48], carteret: [0.50, 0.84] },
    hk: { tko: [0.66, 0.46], central: [0.40, 0.66], shatin: [0.44, 0.18], singapore: [0.08, 0.86], tokyo: [0.93, 0.14] },
  };
  const KIND_FILTER = { new: 'orders', replace: 'orders', stuff: 'orders', cancel: 'cancels', fill: 'fills', ack: 'acks', md: 'md', lead: 'lead' };
  const SHORT = { crossconnect: 'cross-connect', mmwave: 'radio', metrofiber: 'fiber', longfiber: 'fiber', microwave: 'microwave', subsea: 'subsea', internet: 'internet' };
  const DENSITY = { low: 6, medium: 18, high: 45 };
  const TOP = 46; // room for the two caption lines

  // message colour when colouring by type
  const typeCol = (c, kind) => ({ new: c.ink, replace: c.ink, stuff: c.down, cancel: c.muted, fill: c.up, ack: c.dim, md: c.info, lead: c.fair }[kind] || c.ink);

  class NetView {
    constructor(canvas) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.filters = { orders: true, cancels: true, fills: true, acks: false, md: true, lead: true };
      this.opts = Object.assign({}, window.Theme.prefs.flow);
      this.parts = []; this.lastN = 0; this.rates = {}; this.prevCounts = {}; this.rateT = 0; this.hover = null; this.mouse = null;
      canvas.addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); this.mouse = [e.clientX - r.left, e.clientY - r.top]; });
      canvas.addEventListener('pointerleave', () => { this.mouse = null; });
      canvas.addEventListener('click', () => { if (this.hover && this.hover.venue && this.onVenueClick) this.onVenueClick(this.hover.venue); });
    }
    configure(o) { this.opts = Object.assign({}, o); this.parts = []; }
    attach(sim) { this.sim = sim; this.parts = []; this.lastN = sim.flowN || 0; this.rates = {}; this.prevCounts = {}; }

    // ---------- geometry ----------
    // fastest one-way delay from a place to the centre exchange, over the links firms actually use
    delayTo(place, center) {
      const sim = this.sim, cv = sim.venues.find(v => v.place === center);
      let best = Infinity;
      const tryM = m => { if (m) best = Math.min(best, linkUs(place, center, m)); };
      for (const ag of sim.agents) {
        if (ag.place === place && cv) tryM(ag.linkFor(cv));
        if (ag.place === center) { const v = sim.venues.find(x => x.place === place); if (v) tryM(ag.linkFor(v)); if (place === sim.region.leadPlace) tryM(ag.leadMedium); }
      }
      return isFinite(best) ? best : linkUs(place, center, 'longfiber');
    }
    layout(W, H) {
      const sim = this.sim, L = LAYOUT[sim.regionId], pad = 70, o = this.opts;
      const pos = {};
      for (const [k, [x, y]] of Object.entries(L)) pos[k] = [pad + x * (W - 2 * pad), TOP + 8 + y * (H - TOP - 60)];
      let rings = null;
      if (o.layout === 'latency') {
        const center = sim.venues[sim.venues.length - 1].place, sc = pos[center];
        // an ellipse fills the wide stage: 10 µs at the centre ring, 100 ms at the edge, log scale
        const cx = W / 2, cy = TOP + (H - TOP) / 2 + 6, Rx = Math.max(80, W / 2 - 90), Ry = Math.max(60, (H - TOP) / 2 - 40);
        // places keep their rough compass order around the exchange, spaced evenly so labels don't collide
        const inUse = new Set([sim.region.leadPlace, ...sim.venues.map(v => v.place), ...sim.agents.map(ag => ag.place)]);
        const around = Object.keys(L).filter(k => k !== center && inUse.has(k))
          .map(k => [k, (Math.atan2(pos[k][1] - sc[1], pos[k][0] - sc[0]) + Math.PI * 2.5) % (Math.PI * 2)]).sort((p, q) => p[1] - q[1]);
        const lat = {};
        around.forEach(([k], i) => {
          const us = this.delayTo(k, center), ang = -Math.PI / 2 + (i + 0.5) * 2 * Math.PI / around.length;
          const f = this.radial(us);
          lat[k] = [cx + Math.cos(ang) * Rx * f, cy + Math.sin(ang) * Ry * f];
        });
        for (const k of Object.keys(L)) if (!lat[k] && k !== center) lat[k] = [-999, -999];
        lat[center] = [cx, cy];
        Object.assign(pos, lat);
        rings = { cx, cy, Rx, Ry, center };
      }
      const venuePlaces = new Set(sim.venues.map(v => v.place)); venuePlaces.add(sim.region.leadPlace);
      const atPlace = {};
      for (const a of sim.agents) (atPlace[a.place] = atPlace[a.place] || []).push(a);
      const dots = {};
      for (const [pl, list] of Object.entries(atPlace)) {
        if (!pos[pl]) continue;
        const r0 = venuePlaces.has(pl) ? 30 : 20, n = list.length;
        list.forEach((a, i) => {
          const ang = -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, n), r = r0 + (n > 10 ? (i % 2) * 9 : 0);
          dots[a.key] = [pos[pl][0] + Math.cos(ang) * r, pos[pl][1] + Math.sin(ang) * r, a];
        });
      }
      // links actually in use
      const links = new Map();
      const add = (a, b, m) => {
        if (a === b || !pos[a] || !pos[b] || !m) return;
        const k = [a, b].sort().join('|') + '|' + m;
        if (!links.has(k)) links.set(k, { a, b, m, us: linkUs(a, b, m) });
      };
      for (const ag of sim.agents) {
        if (!ag.enabled) continue;
        for (const v of sim.venues) add(ag.place, v.place, ag.linkFor(v));
        if (ag.leadMedium) add(sim.region.leadPlace, ag.place, ag.leadMedium);
      }
      const wh = sim.agentByKey('wholesale'), rt = sim.agentByKey('retail');
      if (wh && rt && wh.enabled && rt.enabled && sim.regionId === 'us') add(rt.place, wh.place, 'internet');
      // separate parallel links between the same two places
      const byPair = {};
      for (const L2 of links.values()) { const p = [L2.a, L2.b].sort().join('|'); (byPair[p] = byPair[p] || []).push(L2); }
      const base = o.layout === 'latency' ? 0 : 0.06;
      for (const list of Object.values(byPair)) list.forEach((L2, i) => { L2.bend = (i - (list.length - 1) / 2) * 0.22 + base; });
      this.geo = { pos, dots, links, venuePlaces, rings };
    }
    // latency map radius (0..1) for a one-way delay: 10 µs at the centre, 100 ms at the edge, compressed near the centre
    radial(us) { return Math.sqrt(clamp((Math.log10(Math.max(1, us)) - 1) / 4, 0.02, 1)); }
    curve(a, b, bend) {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
      return [a, [mx - dy * bend, my + dx * bend], b];
    }
    at(cv, t) {
      const [a, c, b] = cv, u = 1 - t;
      return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
    }
    findLink(from, to, medium) { return this.geo.links.get([from, to].sort().join('|') + '|' + medium); }
    // A message's route: firm dot -> its building, along the drawn link between buildings, building -> firm dot.
    // Each piece is [start, control, end]; the drawn link is followed exactly so particles never leave the line.
    route(f) {
      const g = this.geo, sim = this.sim, ag = sim.agentByKey(f.key);
      const A = g.pos[f.from], B = g.pos[f.to];
      if (!A || !B) return null;
      const dot = this.opts.firms ? g.dots[f.key] : null;
      const outbound = ag && ag.place === f.from && f.kind !== 'lead' && f.kind !== 'md' && f.kind !== 'fill' && f.kind !== 'ack';
      const segs = [];
      const line = (p, q) => [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], q];
      if (outbound && dot) segs.push(line(dot, A));
      if (f.from !== f.to) {
        let medium = 'crossconnect';
        if (ag) {
          if (f.kind === 'lead') medium = ag.leadMedium;
          else { const v = sim.venues.find(x => x.place === f.from || x.place === f.to); medium = v ? ag.linkFor(v) : 'internet'; }
        }
        const L = this.findLink(f.from, f.to, medium) || this.findLink(f.from, f.to, 'internet');
        const bend = L ? L.bend * (L.a === f.from ? 1 : -1) : 0;
        segs.push(this.curve(A, B, bend));
      }
      if (!outbound && dot) segs.push(line(B, dot));
      if (!segs.length) return null;
      const len = segs.map(s => (Math.hypot(s[2][0] - s[0][0], s[2][1] - s[0][1]) + Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) + Math.hypot(s[2][0] - s[1][0], s[2][1] - s[1][1])) / 2 + 1e-6);
      return { segs, len, total: len.reduce((a, b) => a + b, 0) };
    }
    pointAt(rt, t) {
      let d = clamp(t, 0, 1) * rt.total;
      for (let i = 0; i < rt.segs.length; i++) {
        if (d <= rt.len[i] || i === rt.segs.length - 1) return this.at(rt.segs[i], clamp(d / rt.len[i], 0, 1));
        d -= rt.len[i];
      }
      return rt.segs[0][0];
    }

    // ---------- drawing ----------
    draw(dt, speed) {
      const cv = this.c, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const x = this.ctx, c = window.Theme.c, o = this.opts; x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.fillStyle = c.stage; x.fillRect(0, 0, W, H);
      this.layout(W, H);
      const sim = this.sim, g = this.geo;
      this.updateRates();
      const MONO = '"IBM Plex Mono", ui-monospace, monospace', COND = '"IBM Plex Sans Condensed", "Arial Narrow", sans-serif';

      // latency rings
      if (g.rings) {
        const { cx, cy, Rx, Ry } = g.rings;
        x.font = `10.5px ${MONO}`; x.textAlign = 'left'; x.textBaseline = 'bottom';
        [['100 µs', 100], ['1 ms', 1e3], ['10 ms', 1e4], ['100 ms', 1e5]].forEach(([lab, us]) => {
          const f = this.radial(us);
          x.strokeStyle = c.grid2; x.setLineDash([2, 5]); x.beginPath(); x.ellipse(cx, cy, Rx * f, Ry * f, 0, 0, 7); x.stroke(); x.setLineDash([]);
          x.fillStyle = c.dim; x.fillText(lab, cx + 4, cy - Ry * f - 2);
        });
      }

      // links (labels: long routes first, skip any label that would overlap one already placed)
      const placed = [];
      const free = (bx, by, bw, bh) => !placed.some(r => bx < r[0] + r[2] && bx + bw > r[0] && by < r[1] + r[3] && by + bh > r[1]);
      for (const p of Object.values(g.pos)) placed.push([p[0] - 18, p[1] - 18, 36, 36]);
      const sorted = [...g.links.values()].sort((p, q) => q.us - p.us);
      for (const L of sorted) {
        const crv = this.curve(g.pos[L.a], g.pos[L.b], L.bend), col = c.media[L.m] || c.info;
        const rate = (this.rates[L.a + '>' + L.b] || 0) + (this.rates[L.b + '>' + L.a] || 0);
        x.strokeStyle = col;
        if (o.weight) { x.globalAlpha = 0.32 + Math.min(0.5, Math.log10(1 + rate) / 6); x.lineWidth = 1 + Math.min(6, Math.log10(1 + rate) * 1.4); }
        else { x.globalAlpha = 0.5; x.lineWidth = 1.2; }
        x.beginPath(); x.moveTo(crv[0][0], crv[0][1]); x.quadraticCurveTo(crv[1][0], crv[1][1], crv[2][0], crv[2][1]); x.stroke();
        x.globalAlpha = 1; x.lineWidth = 1;
        if (!o.delays) continue;
        const m = this.at(crv, 0.5), label = `${SHORT[L.m] || L.m} ${sim.fmtUs(L.us)}`;
        x.font = `10.5px ${MONO}`;
        const tw = x.measureText(label).width + 8, bx = m[0] - tw / 2, by = m[1] - 15;
        if (free(bx, by, tw, 14)) {
          placed.push([bx, by, tw, 14]);
          x.fillStyle = window.Theme.alpha(c.stage, 0.85); x.fillRect(bx, by, tw, 14);
          x.strokeStyle = window.Theme.alpha(col, 0.35); x.strokeRect(bx + 0.5, by + 0.5, tw - 1, 13);
          x.fillStyle = col; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(label, m[0], by + 7);
        }
      }

      // particles
      const now = sim.now, trueTime = speed <= 0.01;
      const shown = f => this.filters[KIND_FILTER[f.kind] || 'orders'];
      const Bf = sim.flowBuf, N = sim.flowN || 0;
      let drawn = 0;
      if (trueTime && Bf) {
        for (let i = N - 1; i >= Math.max(0, N - Bf.length) && drawn < 2500; i--) {
          const f = Bf[i % Bf.length]; if (!f) break;
          if (f.t0 < now - 200000) break;
          if (f.t0 > now || f.t1 < now || !shown(f)) continue;
          const rt = this.route(f); if (!rt) continue;
          this.mark(x, c, f, rt, (now - f.t0) / Math.max(1e-9, f.t1 - f.t0));
          drawn++;
        }
        this.lastN = N; this.parts = [];
      } else if (Bf) {
        const fresh = [];
        for (let i = Math.max(this.lastN, N - Bf.length); i < N; i++) { const f = Bf[i % Bf.length]; if (f && shown(f)) fresh.push(f); }
        this.lastN = N;
        const budget = DENSITY[o.density] || 18, p = Math.min(1, budget / Math.max(1, fresh.length));
        for (const f of fresh) if (Math.random() < p) {
          const dur = Math.max(0.4, Math.min(1.8, 0.4 + 0.22 * Math.log10(1 + (f.t1 - f.t0))));
          this.parts.push({ f, age: 0, dur });
        }
        const cap = budget * 50;
        if (this.parts.length > cap) this.parts.splice(0, this.parts.length - cap);
        for (const q of this.parts) {
          q.age += dt; const rt = this.route(q.f); if (!rt) continue;
          this.mark(x, c, q.f, rt, Math.min(1, q.age / q.dur));
        }
        this.parts = this.parts.filter(q => q.age < q.dur);
      }

      // nodes
      this.hover = null;
      for (const [pl, p] of Object.entries(g.pos)) {
        const isVenue = g.venuePlaces.has(pl), hasAgents = Object.values(g.dots).some(d => d[2].place === pl);
        if (!isVenue && !hasAgents) continue;
        const r = isVenue ? 12 : 6;
        x.fillStyle = isVenue ? c.node : c.nodeDim;
        if (window.Theme.prefs.theme === 'terminal') x.fillRect(p[0] - r, p[1] - r, 2 * r, 2 * r); // square nodes in the terminal theme
        else { x.beginPath(); x.arc(p[0], p[1], r, 0, 7); x.fill(); }
        const venue = sim.venues.find(v => v.place === pl);
        if (venue) { // processing-queue gauge
          const fr = Math.min(1, venue.queueUs / 100);
          x.strokeStyle = c.grid2; x.lineWidth = 3; x.beginPath(); x.arc(p[0], p[1], r + 7, 0, 7); x.stroke();
          x.strokeStyle = fr > 0.5 ? c.down : c.up; x.beginPath(); x.arc(p[0], p[1], r + 7, -Math.PI / 2, -Math.PI / 2 + Math.max(0.04, fr) * 2 * Math.PI); x.stroke(); x.lineWidth = 1;
        }
        if (o.captions) {
          const P = PLACES[pl];
          const title = venue ? venue.name + (pl === sim.region.leadPlace ? ' + futures' : '') : pl === sim.region.leadPlace ? 'Futures exchange' : P.name;
          x.font = `600 11.5px ${COND}`; x.fillStyle = c.ink; x.textAlign = 'center'; x.textBaseline = 'top';
          const ly = p[1] + (isVenue ? 42 : 28);
          x.fillText(title.toUpperCase(), p[0], ly);
          x.font = `10.5px ${MONO}`; x.fillStyle = c.muted;
          const sub = g.rings && pl !== g.rings.center ? `${sim.fmtUs(this.delayTo(pl, g.rings.center))} to ${sim.venues[sim.venues.length - 1].name}` : P.area + (venue ? ` · queue ${sim.fmtUs(venue.queueUs)}` : '');
          x.fillText(sub, p[0], ly + 14);
        }
        if (this.mouse && Math.hypot(this.mouse[0] - p[0], this.mouse[1] - p[1]) < r + 6 && venue) this.hover = { venue: venue.id, text: `${venue.name}: click to see its order book` };
      }
      if (o.firms) for (const [, [dx, dy, a]] of Object.entries(g.dots)) {
        x.fillStyle = CATS[a.cat].color; x.globalAlpha = a.enabled ? 1 : 0.25;
        x.beginPath(); x.arc(dx, dy, a.cat === 'you' ? 5.5 : 4.5, 0, 7); x.fill(); x.globalAlpha = 1;
        if (a.cat === 'you') { x.strokeStyle = c.accent; x.lineWidth = 2; x.stroke(); x.lineWidth = 1; }
        if (this.mouse && Math.hypot(this.mouse[0] - dx, this.mouse[1] - dy) < 7) {
          const v0 = sim.venues[0];
          this.hover = { text: `${a.name}${a.enabled ? '' : ' (off)'} · ${window.MM.HARDWARE[a.hw].label} · to ${v0.name} ${sim.fmtUs(a.hwUs + a.latTo(v0))}${a.leadMedium ? ` · hears futures after ${sim.fmtUs(a.leadLat())}` : ''}` };
        }
      }
      if (this.hover && this.mouse) {
        x.font = `12px ${COND}`; const tw = x.measureText(this.hover.text).width;
        const tx = Math.min(W - tw - 16, this.mouse[0] + 12), ty = Math.max(8, this.mouse[1] - 30);
        x.fillStyle = c.tooltip; x.strokeStyle = c.accent; x.fillRect(tx, ty, tw + 12, 22); x.strokeRect(tx + 0.5, ty + 0.5, tw + 11, 21);
        x.fillStyle = c.ink; x.textAlign = 'left'; x.textBaseline = 'middle'; x.fillText(this.hover.text, tx + 6, ty + 11);
        cv.style.cursor = this.hover.venue ? 'pointer' : 'default';
      } else cv.style.cursor = 'default';

      // mode label
      x.font = `600 11.5px ${COND}`; x.textAlign = 'left'; x.textBaseline = 'top';
      x.fillStyle = trueTime ? c.up : c.hi;
      x.fillText(trueTime ? `TRUE TIMING · ${drawn} MESSAGES IN FLIGHT${drawn < 5 ? ' · CALM MARKETS ARE QUIET AT THIS SCALE: PRESS NEWS SHOCK TO START A RACE' : ''}` : 'SAMPLED TRAFFIC · NOT TO TIME SCALE · SET SPEED TO 1/100 OR 1/1000 FOR TRUE TIMING', 12, 10);
      x.fillStyle = c.dim; x.font = `11px ${COND}`;
      x.fillText(g.rings ? `Latency map: distance from ${sim.venues[sim.venues.length - 1].name} shows the one-way delay (rings marked); places are spread around it for readability.`
        : 'Schematic map, not to scale. Line labels give real one-way delays; thicker lines carry more messages.', 12, 26);
    }
    // draw one message at fraction t of its route; comets also draw a fading tail about 40 px long
    mark(x, c, f, rt, t) {
      const tail = Math.min(0.35, 42 / rt.total);
      const o = this.opts, col = o.color === 'type' ? typeCol(c, f.kind) : (f.kind === 'fill' ? c.up : f.kind === 'lead' ? c.fair : f.kind === 'ack' ? c.dim : CATS[f.cat] ? CATS[f.cat].color : c.ink);
      const p = this.pointAt(rt, t);
      if (o.particles === 'comets' && f.kind !== 'ack') {
        x.strokeStyle = col; x.lineWidth = 2;
        let prev = p;
        for (let i = 1; i <= 5; i++) {
          const q = this.pointAt(rt, t - tail * i / 5);
          x.globalAlpha = 0.55 * (1 - i / 6); x.beginPath(); x.moveTo(prev[0], prev[1]); x.lineTo(q[0], q[1]); x.stroke(); prev = q;
        }
        x.globalAlpha = 1; x.lineWidth = 1;
      }
      if (o.particles === 'minimal') { x.fillStyle = col; x.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3); return; }
      switch (f.kind) {
        case 'new': case 'replace': x.fillStyle = col; x.beginPath(); x.arc(p[0], p[1], 3.2, 0, 7); x.fill(); break;
        case 'stuff': x.fillStyle = c.down; for (let i = 0; i < 4; i++) { x.beginPath(); x.arc(p[0] + (Math.random() - 0.5) * 10, p[1] + (Math.random() - 0.5) * 10, 1.6, 0, 7); x.fill(); } break;
        case 'cancel': x.strokeStyle = col; x.lineWidth = 1.6; x.beginPath(); x.arc(p[0], p[1], 3.6, 0, 7); x.stroke(); x.lineWidth = 1; break;
        case 'fill': x.fillStyle = col; x.fillRect(p[0] - 3, p[1] - 3, 6, 6); break;
        case 'ack': x.fillStyle = col; x.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3); break;
        case 'lead': x.fillStyle = col; x.beginPath(); x.moveTo(p[0], p[1] - 4); x.lineTo(p[0] + 4, p[1]); x.lineTo(p[0], p[1] + 4); x.lineTo(p[0] - 4, p[1]); x.fill(); break;
        default: x.fillStyle = window.Theme.alpha(c.ink, 0.35); x.fillRect(p[0] - 1, p[1] - 1, 2, 2);
      }
    }
    updateRates() {
      const sim = this.sim, now = sim.now, counts = sim.linkMsgs || {};
      if (now - this.rateT < 100000 && this.rateT) return;
      const dtS = Math.max(1e-6, (now - this.rateT) / 1e6);
      for (const [k, v] of Object.entries(counts)) { const r = (v - (this.prevCounts[k] || 0)) / dtS; this.rates[k] = (this.rates[k] || 0) * 0.6 + r * 0.4; }
      this.prevCounts = Object.assign({}, counts); this.rateT = now;
    }
  }
  window.NetView = NetView;
})();
