// Trading agents. Each one acts only on market data that has physically reached its location.
(function () {
  'use strict';
  const { HARDWARE } = window.MM;
  const { linkUs, PIPS, SEC } = window.Engine;
  const MS = 1000;
  const HFT_CATS = new Set(['mm', 'arb', 'stat', 'anticip', 'rebate', 'wholesale', 'manip']);

  class Agent {
    constructor(sim, tpl) {
      Object.assign(this, { sim, key: tpl.key, kind: tpl.kind, cat: tpl.cat, name: tpl.name, place: tpl.place, hw: tpl.hw,
        leadMedium: tpl.lead, links: Object.assign({}, tpl.link), sip: !!tpl.sip, enabled: !!tpl.on,
        p: Object.assign({}, tpl.p), stampExempt: !!tpl.stampExempt });
      this.pos = 0; this.cash = 0; this.fees = 0; this.stamp = 0; this.volume = 0; this.fills = 0; this.notional = 0;
      this.msgs = 0; this.cancelsSent = 0; this.ordersSent = 0; this.racesWon = 0; this.racesLost = 0;
      this.views = {}; this.leadF = null; this.live = new Map(); this.counterVol = {}; this.gen = 0;
    }
    get isHft() { return HFT_CATS.has(this.cat) && (this.hw === 'fpga' || this.hw === 'kbypass'); }
    get hwUs() { return HARDWARE[this.hw].us; }
    linkFor(venue) { return this.links[venue.id] || 'metrofiber'; }
    latTo(venue) { return linkUs(this.place, venue.place, this.linkFor(venue)); }
    leadLat() { return this.leadMedium ? linkUs(this.sim.region.leadPlace, this.place, this.leadMedium) : null; }
    pnl() { return this.cash + this.pos * this.sim.markPx() / PIPS; }

    subscribeFeeds() {
      for (const v of this.sim.venues) v.feed.unsubscribe(this);
      this.sim.leadFeed.unsubscribe(this);
      if (!this.enabled) return;
      for (const v of this.sim.venues) {
        const lat = this.latTo(v) + (this.sip ? this.sim.rules.sipExtraUs : 0);
        v.feed.subscribe(this, lat, snap => { if (this.enabled) { this.views[v.id] = snap; this.onMarket(v, snap); } });
      }
      if (this.leadMedium) this.sim.leadFeed.subscribe(this, this.leadLat(), s => { if (this.enabled) { this.leadF = s.F; this.onLead(s); } });
    }
    attach() { if (!this.enabled) return; this.gen++; this.subscribeFeeds(); this.init(); }
    setEnabled(on) {
      if (on === this.enabled) return;
      this.enabled = on;
      if (on) this.attach(); else { this.gen++; this.cancelAll(); this.subscribeFeeds(); }
    }
    rewire() { this.subscribeFeeds(); }
    loop(nextUs, fn) {
      const g = this.gen;
      const step = () => { if (!this.enabled || g !== this.gen) return; fn(); this.sim.after(nextUs(), step); };
      this.sim.after(nextUs(), step);
    }
    later(us, fn) { const g = this.gen; this.sim.after(us, () => { if (this.enabled && g === this.gen) fn(); }); }

    // ---- messaging ----
    send(venue, msg) {
      this.msgs++;
      const sim = this.sim, t = sim.now + this.hwUs + this.latTo(venue) + venue.speedBumpUs;
      sim.at(t, () => venue.arrive(msg));
      if (sim.recordFlows) sim.recordFlow(this.place, venue.place, sim.now + this.hwUs, t, msg.type, this.cat, this.key);
    }
    order(venue, side, px, qty, tif = 'GTC', extra = {}) {
      const o = Object.assign({ id: this.sim.newOrderId(), agent: this, side, px, qty, rem: qty, tif, venue, state: 'sent', known: 'sent', sentT: this.sim.now, kRem: qty }, extra);
      this.live.set(o.id, o); this.ordersSent++;
      this.send(venue, { type: 'new', order: o });
      return o;
    }
    market(venue, side, qty, extra = {}) { return this.order(venue, side, null, qty, 'IOC', Object.assign({ market: true }, extra)); }
    cancel(o) { if (o.cancelSent || o.known === 'done') return; o.cancelSent = true; this.cancelsSent++; this.send(o.venue, { type: 'cancel', order: o }); }
    replace(o, px, qty, tif) {
      const n = { id: this.sim.newOrderId(), agent: this, side: o.side, px, qty, rem: qty, tif: tif || o.tif, venue: o.venue, state: 'sent', known: 'sent', sentT: this.sim.now, kRem: qty, slot: o.slot };
      o.cancelSent = true; this.cancelsSent++; this.ordersSent++;
      this.live.set(n.id, n); this.send(o.venue, { type: 'replace', old: o, order: n });
      return n;
    }
    cancelAll(venue) { for (const o of this.live.values()) if (!venue || o.venue === venue) this.cancel(o); }
    onExec(r) {
      const o = r.o;
      if (r.kind === 'ack') { if (o.known === 'sent') o.known = 'live'; }
      else if (r.kind === 'fill') { o.kRem -= r.q; if (o.kRem <= 0) { o.known = 'done'; this.live.delete(o.id); } }
      else { o.known = 'done'; this.live.delete(o.id); }
      this.handleExec(r);
    }
    applyFill(o, px, q, venue, counter, role) {
      this.pos += o.side * q; this.cash -= o.side * px / PIPS * q;
      this.volume += q; this.fills++; this.notional += px / PIPS * q;
      this.counterVol[counter.cat] = (this.counterVol[counter.cat] || 0) + q;
      this.onFill(o, px, q, venue, counter, role);
    }
    bestVenue(side) {
      let best = null, bp = null;
      for (const v of this.sim.venues) {
        const vw = this.views[v.id]; if (!vw || vw.halted) continue;
        const p = side > 0 ? vw.ask : vw.bid; if (p == null) continue;
        if (bp == null || (side > 0 ? p < bp : p > bp)) { bp = p; best = v; }
      }
      return best || this.sim.venues[0];
    }
    viewNbbo() {
      let bid = null, ask = null;
      for (const v of this.sim.venues) { const w = this.views[v.id]; if (!w) continue;
        if (w.bid != null && (bid == null || w.bid > bid)) bid = w.bid; if (w.ask != null && (ask == null || w.ask < ask)) ask = w.ask; }
      return { bid, ask, mid: bid != null && ask != null ? (bid + ask) / 2 : null };
    }
    // Lead-lag: track the stock's recent gap to futures (an average over tauUs), then react to futures *changes*.
    trackBasis(tauUs = SEC) {
      const nb = this.viewNbbo();
      if (this.leadF == null || nb.mid == null || nb.ask - nb.bid > 0.01 * nb.mid) return; // ignore a broken book (one side empty or stub quotes)
      const now = this.sim.now, x = nb.mid - this.leadF;
      if (this.basis == null) this.basis = x;
      else this.basis += (1 - Math.exp(-(now - this.basisT) / tauUs)) * (x - this.basis);
      this.basisT = now;
    }
    // Beyond about 3% from futures, a stock-specific move is treated as an anomaly, not new information.
    leadFair() {
      if (this.leadF == null) return null;
      const cap = 0.03 * this.leadF, b = Math.max(-cap, Math.min(cap, this.basis || 0));
      return this.leadF + b;
    }
    takerCostPerShare(venue, px) {
      const fee = venue.feeType === 'pershare' ? venue.takerFee : venue.takerFee / 1e4 * px / PIPS;
      const stamp = this.sim.rules.stampBps && !this.stampExempt ? this.sim.rules.stampBps / 1e4 * px / PIPS : 0;
      return fee + stamp;
    }
    // hooks
    init() {} onMarket() {} onLead() {} handleExec() {} onFill() {}
  }

  // ---------------------------------------------------------------- market maker
  class MarketMaker extends Agent {
    init() { this.standDownUntil = 0; this.r2 = []; this.lastF = null; this.withdrawn = false; }
    onLead(s) {
      if (this.lastF != null) {
        const r = Math.log(s.F / this.lastF); this.r2.push([this.sim.now, r * r]);
        const cut = this.sim.now - SEC; while (this.r2.length && this.r2[0][0] < cut) this.r2.shift();
      }
      this.lastF = s.F;
      this.checkVol();
      for (const v of this.sim.venues) this.requote(v);
      this.unwind();
    }
    // A 10 s average: its own skewed quotes move the mid, and learning from them too quickly feeds back into its quotes.
    onMarket(v) { this.trackBasis(10 * SEC); this.requote(v); this.unwind(); }
    // Near the inventory limit, cross the spread to sell (or buy back) stock, unless that costs more than 3 ticks.
    unwind() {
      const p = this.p, now = this.sim.now;
      if (Math.abs(this.pos) < 0.6 * p.maxInv || now - (this.lastUnwind || -1e9) < 250 * MS || now < this.standDownUntil) return;
      const side = this.pos > 0 ? -1 : 1, v = this.bestVenue(side), w = this.views[v.id];
      if (!w || w.halted) return;
      const px = side < 0 ? w.bid : w.ask, fair = this.fair(v);
      if (px == null || fair == null || (side < 0 ? px < fair - 3 * v.tickAt(px) : px > fair + 3 * v.tickAt(px))) return;
      this.lastUnwind = now;
      if (now - (this.unwindLogT || -1e9) > 60 * SEC) {
        this.unwindLogT = now;
        this.sim.addLog('withdraw', `${this.name} is near its inventory limit (${this.pos.toLocaleString()} shares) and is crossing the spread to ${side < 0 ? 'sell' : 'buy back'} stock.`, this.cat);
      }
      this.order(v, side, px, Math.min(Math.abs(this.pos), Math.max(p.size, Math.round(p.maxInv / 10))), 'IOC');
    }
    checkVol() {
      let s = 0; for (const [, x] of this.r2) s += x;
      const expVar = (this.sim.beta * this.sim.sigmaPerUs) ** 2 * SEC; // normal futures-implied variance for this stock
      const ratio = Math.sqrt(s / expVar);
      this.volRatio = ratio;
      if (ratio > this.p.withdraw && this.sim.now >= this.standDownUntil) {
        this.standDownUntil = this.sim.now + 1500 * MS;
        this.cancelAll();
        if (!this.withdrawn) this.sim.addLog('withdraw', `${this.name} pulled all quotes: futures volatility is ${ratio.toFixed(1)}× normal (its limit is ${this.p.withdraw}×). The book thins out.`, this.cat);
        this.withdrawn = true;
        this.later(1500 * MS + 1, () => { this.withdrawn = false; for (const v of this.sim.venues) this.requote(v); });
      }
    }
    fair(v) {
      const w = this.views[v.id];
      if (this.p.useLead && this.leadF != null) return this.leadFair();
      if (!w || w.bid == null || w.ask == null || w.ask - w.bid > 0.01 * w.bid) return this.leadFair();
      return (w.bid * w.askQty + w.ask * w.bidQty) / Math.max(1, w.bidQty + w.askQty);
    }
    requote(v) {
      const w = this.views[v.id];
      if (!w) return;
      this.lastAct = this.lastAct || {};
      if (this.sim.now - (this.lastAct[v.id] || -1e9) < 5 && !w.halted) { // throttle, but always re-check shortly after
        if (!this.recheck) { this.recheck = true; this.later(6, () => { this.recheck = false; for (const vv of this.sim.venues) this.requote(vv); }); }
        return;
      }
      this.lastAct[v.id] = this.sim.now;
      if (w.halted || this.sim.now < this.standDownUntil) { this.cancelAll(v); return; }
      const fair = this.fair(v); if (fair == null) return;
      const p = this.p, tick = v.tickAt(fair), lot = this.sim.rules.lot;
      const skew = p.skew * tick * (this.pos / Math.max(lot, p.size));
      let bid = v.roundDown(fair - skew - p.halfSpread * tick - 1e-6);
      let ask = v.roundUp(fair - skew + p.halfSpread * tick + 1e-6);
      // Never lock or cross any exchange's quote (Reg NMS Rule 610): check the best prices it can see everywhere.
      const nb = this.viewNbbo();
      if (nb.ask != null && bid >= nb.ask) bid = v.down(nb.ask);
      if (nb.bid != null && ask <= nb.bid) ask = v.up(nb.bid);
      if (bid <= 0 || ask <= 0) { this.cancelAll(v); return; }
      const want = { 1: [], '-1': [] }, tol = Math.max(1, Math.round(p.halfSpread / 2)) * tick;
      let b = bid, a = ask;
      for (let i = 0; i < p.levels; i++) {
        const size = Math.max(lot, Math.round(p.size * (1 + 0.5 * i) / lot) * lot);
        if (this.pos < p.maxInv) want[1].push([b, size]);
        if (this.pos > -p.maxInv) want[-1].push([a, size]);
        b = v.down(b); a = v.up(a);
      }
      for (const side of [1, -1]) {
        const mine = [...this.live.values()].filter(o => o.venue === v && o.side === side && !o.cancelSent && o.known !== 'done');
        const wantList = want[side];
        for (let i = 0; i < Math.max(mine.length, wantList.length); i++) {
          const o = mine.find(x => x.slot === i), w2 = wantList[i];
          if (!w2) { if (o) this.cancel(o); continue; }
          if (!o) this.order(v, side, w2[0], w2[1], 'POST', { slot: i });
          else if (Math.abs(o.px - w2[0]) >= tol) this.replace(o, w2[0], w2[1], 'POST'); // wide quotes move only when fair value moves enough
        }
        for (const o of mine) if (o.slot >= wantList.length) this.cancel(o);
      }
    }
  }

  // ---------------------------------------------------------------- latency arbitrage
  class LatencyArb extends Agent {
    init() { this.fired = new WeakSet(); this.exitOrder = null; }
    onLead() { this.scan(); }
    onMarket() { this.trackBasis(); this.scan(); }
    scan() {
      const F = this.leadFair(); if (F == null) return;
      const p = this.p;
      for (const v of this.sim.venues) {
        const w = this.views[v.id]; if (!w || w.halted || this.fired.has(w)) continue;
        const tick = v.tickAt(F), inBand = px => !w.band || (px >= w.band.lo - 1e-6 && px <= w.band.hi + 1e-6);
        if (w.ask != null && this.pos < p.maxPos && inBand(w.ask)) {
          const edge = (F - w.ask) / tick - this.takerCostPerShare(v, w.ask) * PIPS / tick;
          if (edge >= p.threshold) {
            const q = Math.min(p.maxSize, w.askQty, p.maxPos - this.pos);
            if (q > 0) { this.fired.add(w); this.order(v, 1, w.ask, q, 'IOC', { snipe: true }); continue; }
          }
        }
        if (w.bid != null && this.pos > -p.maxPos && inBand(w.bid)) {
          const edge = (w.bid - F) / tick - this.takerCostPerShare(v, w.bid) * PIPS / tick;
          if (edge >= p.threshold) {
            const q = Math.min(p.maxSize, w.bidQty, p.maxPos + this.pos);
            if (q > 0) { this.fired.add(w); this.order(v, -1, w.bid, q, 'IOC', { snipe: true }); }
          }
        }
      }
      if (p.crossVenue && this.sim.venues.length > 1) {
        const [A, B] = this.sim.venues, wa = this.views[A.id], wb = this.views[B.id];
        if (wa && wb && !wa.halted && !wb.halted) {
          for (const [hi, lo, wh, wl] of [[A, B, wa, wb], [B, A, wb, wa]]) {
            const okB = (w, px) => !w.band || (px >= w.band.lo - 1e-6 && px <= w.band.hi + 1e-6);
            if (wh.bid != null && wl.ask != null && wh.bid > wl.ask && !this.fired.has(wh) && okB(wh, wh.bid) && okB(wl, wl.ask)) {
              const cost = (this.takerCostPerShare(hi, wh.bid) + this.takerCostPerShare(lo, wl.ask)) * PIPS;
              if (wh.bid - wl.ask > cost) {
                const q = Math.min(p.maxSize, wh.bidQty, wl.askQty);
                this.fired.add(wh); this.fired.add(wl);
                this.order(lo, 1, wl.ask, q, 'IOC', { snipe: true }); this.order(hi, -1, wh.bid, q, 'IOC', { snipe: true });
              }
            }
          }
        }
      }
      this.manageExit();
    }
    manageExit() {
      const F = this.leadFair(); if (F == null) return;
      if (this.sim.venues.every(v => this.views[v.id] && this.views[v.id].halted)) return;
      if (this.sim.now - (this.lastExit || -1e9) < 200) { // throttle: its own exit order changes the book it is reacting to
        if (!this.exitRecheck) { this.exitRecheck = true; this.later(201, () => { this.exitRecheck = false; this.manageExit(); }); }
        return;
      }
      this.lastExit = this.sim.now;
      if (this.exitOrder && (this.exitOrder.known === 'done' || this.exitOrder.cancelSent)) this.exitOrder = null;
      if (this.pos === 0) { this.flatT = this.sim.now; if (this.exitOrder) this.cancel(this.exitOrder); return; }
      const side = this.pos > 0 ? -1 : 1, v = this.bestVenue(-side);
      // Held for over 3 s: stop waiting for a passive exit and cross the spread, unless that is more than 3 ticks from fair.
      if (this.sim.now - (this.flatT || 0) > 3 * SEC) {
        const vx = this.bestVenue(side), wx = this.views[vx.id], tpx = wx ? (side < 0 ? wx.bid : wx.ask) : null;
        if (tpx != null && !wx.halted && Math.abs(tpx - F) <= 3 * vx.tickAt(tpx)) {
          if (this.exitOrder) { this.cancel(this.exitOrder); this.exitOrder = null; }
          this.order(vx, side, tpx, Math.abs(this.pos), 'IOC');
          this.flatT = this.sim.now - 2.5 * SEC; // try again in about half a second if still not flat
          return;
        }
      }
      const px = side < 0 ? v.roundUp(F) : v.roundDown(F);
      const q = Math.abs(this.pos);
      if (!this.exitOrder) this.exitOrder = this.order(v, side, px, q, 'GTC');
      else if (this.exitOrder.px !== px && this.exitOrder.venue === v) this.exitOrder = this.replace(this.exitOrder, px, q, 'GTC');
    }
    onFill() { this.later(1, () => this.manageExit()); }
  }

  // ---------------------------------------------------------------- statistical arbitrage on book imbalance
  class StatArb extends Agent {
    init() { this.holding = null; this.signals = 0; }
    onMarket(v, w) {
      if (this.holding || w.halted || w.bid == null || w.ask == null) return;
      const p = this.p, L = p.depthLevels;
      let bq = 0, aq = 0;
      for (let i = 0; i < L; i++) { if (w.bids[i]) bq += w.bids[i][1]; if (w.asks[i]) aq += w.asks[i][1]; }
      const imb = (bq - aq) / Math.max(1, bq + aq);
      const tick = v.tickAt(w.bid);
      if (w.ask - w.bid > tick + 0.5) return; // only when the spread is one tick
      let side = 0;
      if (imb > p.threshold && this.pos + p.size <= p.maxPos) side = 1;
      else if (imb < -p.threshold && this.pos - p.size >= -p.maxPos) side = -1;
      if (!side) return;
      this.signals++;
      this.order(v, side, side > 0 ? w.ask : w.bid, p.size, 'IOC');
      this.holding = { side, v };
      this.later(p.holdMs * MS, () => this.exit());
    }
    exit() {
      const h = this.holding; this.holding = null;
      if (!h || this.pos === 0) return;
      const side = this.pos > 0 ? -1 : 1, v = this.bestVenue(side), w = this.views[v.id];
      if (!w) return;
      const px = side < 0 ? (w.bid != null ? v.down(w.bid) : null) : (w.ask != null ? v.up(w.ask) : null);
      if (px != null) this.order(v, side, px, Math.abs(this.pos), 'IOC');
      this.later(300 * MS, () => { if (!this.holding && this.pos !== 0) { this.holding = { side: 0, v }; this.exit(); } }); // partly filled: try again
    }
  }

  // ---------------------------------------------------------------- order anticipation
  class Anticipator extends Agent {
    init() { this.seen = {}; this.groups = {}; this.active = null; this.lastLogKey = null; }
    onMarket(v, w) {
      const last = this.seen[v.id] || 0;
      const fresh = v.tradesSince(last).filter(t => t.seq <= w.tradeSeq);
      this.seen[v.id] = w.tradeSeq;
      if (!fresh.length) return;
      // Group fills from one aggressive order: same venue, same time, same side.
      const events = [];
      for (const t of fresh) {
        const e = events[events.length - 1];
        if (e && e.t === t.t && e.side === t.side) e.q += t.q; else events.push({ t: t.t, side: t.side, q: t.q });
      }
      for (const e of events) this.observe(e, v);
      if (this.active) this.manage(v, w);
    }
    observe(e, v) {
      // Large aggressive orders only, grouped by approximate size (a slice that sweeps several levels prints as several trades).
      if (e.q < (this.sim.regionId === 'hk' ? 5000 : 1000)) return;
      const key = e.side + ':' + Math.round(Math.log2(e.q) * 2);
      const g = this.groups[key] || (this.groups[key] = []);
      g.push(e.t); while (g.length && g[0] < this.sim.now - 120 * SEC) g.shift();
      if (this.active || g.length < this.p.minPattern) return;
      const iv = []; for (let i = 1; i < g.length; i++) iv.push(g[i] - g[i - 1]);
      const recent = iv.slice(-(this.p.minPattern - 1));
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
      if (mean < 200 * MS || sd / mean > this.p.maxCv) return;
      this.active = { side: e.side, size: e.q, interval: mean, since: this.sim.now, lastHit: this.sim.now, key };
      this.sim.addLog('detect', `${this.name} spotted a pattern in the public trade feed: ${g.length} aggressive ${e.side > 0 ? 'buys' : 'sells'} of about ${e.q.toLocaleString()} shares, every ${(mean / SEC).toFixed(2)} s (timing varies only ${(sd / mean * 100).toFixed(0)}%). It ${e.side > 0 ? 'buys' : 'sells'} ahead of the remaining slices.`, this.cat);
      const vv = this.bestVenue(e.side), w = this.views[vv.id];
      if (w) this.order(vv, e.side, e.side > 0 ? vv.up(w.ask ?? vv.mid()) : vv.down(w.bid ?? vv.mid()), this.p.size, 'IOC');
    }
    manage(v, w) {
      const a = this.active, g = this.groups[a.key] || [];
      if (g.length && g[g.length - 1] > a.lastHit) a.lastHit = g[g.length - 1];
      if (this.sim.now - a.lastHit > 4 * a.interval) { // the parent order seems finished: flatten
        this.active = null; this.cancelAll();
        if (this.pos) { const side = this.pos > 0 ? -1 : 1, vv = this.bestVenue(side), ww = this.views[vv.id];
          if (ww) this.order(vv, side, side < 0 ? vv.down(ww.bid ?? vv.mid()) : vv.up(ww.ask ?? vv.mid()), Math.abs(this.pos), 'IOC'); }
        return;
      }
      // Offer the position back to the institution a few ticks worse for it.
      if (!this.pos || w.bid == null || w.ask == null) return;
      const side = this.pos > 0 ? -1 : 1;
      const px = side < 0 ? w.ask + (this.p.markupTicks - 1) * v.tickAt(w.ask) : w.bid - (this.p.markupTicks - 1) * v.tickAt(w.bid);
      const mine = [...this.live.values()].find(o => o.venue === v && o.side === side && !o.cancelSent);
      if (!mine) this.order(v, side, px, Math.abs(this.pos), 'GTC');
      else if (mine.px !== px) this.replace(mine, px, Math.abs(this.pos), 'GTC');
    }
  }

  // ---------------------------------------------------------------- rebate capture
  class RebateCapture extends Agent {
    onLead() { for (const v of this.sim.venues) this.quote(v); }
    onMarket(v) { this.trackBasis(); this.quote(v); }
    quote(v) {
      const w = this.views[v.id], F = this.leadFair();
      if (!w || w.bid == null || w.ask == null || F == null || w.halted) return;
      this.lastAct = this.lastAct || {};
      if (this.sim.now - (this.lastAct[v.id] || -1e9) < 50) return; // throttle: at most one decision per 50 µs per exchange
      this.lastAct[v.id] = this.sim.now;
      const tick = v.tickAt(F), c = this.p.cancelTicks * tick;
      const nb = this.viewNbbo();
      for (const side of [1, -1]) {
        let target = side > 0 ? w.bid : w.ask;
        if (side > 0 && nb.ask != null && target >= nb.ask) target = v.down(nb.ask);
        if (side < 0 && nb.bid != null && target <= nb.bid) target = v.up(nb.bid);
        const safe = side > 0 ? F - target > -c + tick * 0.5 : target - F > -c + tick * 0.5;
        const capOk = side > 0 ? this.pos < 5 * this.p.size : this.pos > -5 * this.p.size;
        const mine = [...this.live.values()].find(o => o.venue === v && o.side === side && !o.cancelSent && o.known !== 'done');
        if (!safe || !capOk) { if (mine) this.cancel(mine); continue; }
        if (!mine) this.order(v, side, target, this.p.size, 'POST');
        else if (mine.px !== target) this.replace(mine, target, this.p.size, 'POST');
      }
    }
  }

  // ---------------------------------------------------------------- wholesaler (US retail internalizer)
  class Wholesaler extends Agent {
    init() { this.declined = 0; this.internalized = 0; this.pfofPaid = 0; }
    route(order, from) { // called when a retail order reaches the wholesaler
      this.trackBasis();
      const nb = this.viewNbbo(), F = this.leadFair(), v0 = this.sim.venues[0];
      if (nb.bid == null || nb.ask == null || nb.ask - nb.bid > 0.01 * nb.mid) return from.sendToExchange(order); // broken market: route to the exchange
      const tick = v0.tickAt(nb.mid), side = order.side;
      const toxic = F != null && (side > 0 ? F - nb.ask : nb.bid - F) > this.p.declineTicks * tick;
      if (toxic || (!order.market && (side > 0 ? order.px < nb.ask : order.px > nb.bid))) {
        if (toxic) { this.declined++; if (this.declined % 10 === 1) this.sim.addLog('wholesale', `${this.name} sent a retail ${side > 0 ? 'buy' : 'sell'} to the exchange instead of filling it: futures had already moved ${(Math.abs((side > 0 ? F - nb.ask : nb.bid - F)) / tick).toFixed(1)} ticks against the wholesaler.`, this.cat); }
        return from.sendToExchange(order);
      }
      const pi = Math.round(this.p.pi * PIPS);
      const px = side > 0 ? nb.ask - pi : nb.bid + pi;
      this.sim.offExchangeFill(this, from, order, px);
      this.internalized++;
      const pf = this.p.pfof * order.qty; this.cash -= pf; this.pfofPaid += pf; this.sim.brokerPfof = (this.sim.brokerPfof || 0) + pf;
      this.hedge();
    }
    onLead() { this.hedge(); }
    hedge() {
      if (Math.abs(this.pos) < this.p.hedgeAt || this.hedging) return;
      const side = this.pos > 0 ? -1 : 1, v = this.bestVenue(side), w = this.views[v.id]; if (!w) return;
      const px = side < 0 ? w.bid : w.ask; if (px == null) return;
      this.hedging = true; this.order(v, side, px, Math.round(Math.abs(this.pos) / 2), 'IOC');
      this.later(5 * MS, () => { this.hedging = false; });
    }
  }

  // ---------------------------------------------------------------- retail investors
  class Retail extends Agent {
    init() {
      this.stats = { n: 0, costBps: 0, notional: 0, slipBps: 0, piShares: 0, viaWholesaler: 0, viaExchange: 0 };
      this.midHist = [];
      this.loop(() => this.sim.rand.exp(SEC / Math.max(0.01, this.p.rate * this.sim.volMult)), () => this.arrive());
    }
    onMarket(v, w) { if (w.bid != null && w.ask != null && w.ask - w.bid < 0.01 * w.bid) { this.midHist.push([this.sim.now, (w.bid + w.ask) / 2]); if (this.midHist.length > 400) this.midHist.splice(0, 200); } }
    arrive() {
      const nb = this.viewNbbo();
      if (nb.mid == null) { nb.mid = nb.bid ?? nb.ask; if (nb.mid == null) return; } // one side empty: still trade
      const v0 = this.sim.venues[0], tick = v0.tickAt(nb.mid), lot = this.sim.rules.lot;
      const old = this.midHist.find(m => m[0] >= this.sim.now - 3 * SEC);
      const ret = old ? (nb.mid - old[1]) / tick : 0;
      const pBuy = 0.5 + this.p.chase * Math.max(-0.4, Math.min(0.4, ret / 10));
      const side = this.sim.rand() < pBuy ? 1 : -1;
      let qty = Math.max(1, this.p.avgSize * Math.exp(0.8 * this.sim.rand.gauss() - 0.32));
      qty = Math.max(lot, Math.round(qty / lot) * lot);
      const market = this.sim.rand() < this.p.marketShare;
      const px = market ? null : (side > 0 ? nb.bid ?? nb.mid : nb.ask ?? nb.mid);
      this.submit(side, qty, market, px, nb);
    }
    submit(side, qty, market, px, screen) {
      const o = { id: this.sim.newOrderId(), agent: this, side, qty, rem: qty, market, px, tif: market ? 'IOC' : 'GTC', state: 'sent', known: 'sent', kRem: qty,
        screenMid: screen ? screen.mid : null, screenPx: screen ? (side > 0 ? screen.ask : screen.bid) : null, sentT: this.sim.now };
      const wh = this.sim.regionId === 'us' && this.p.toWholesaler >= 0.5 ? this.sim.agentByKey('wholesale') : null;
      if (wh && wh.enabled) {
        const lat = linkUs(this.place, wh.place, 'internet');
        this.msgs++; this.ordersSent++;
        this.sim.after(lat, () => wh.route(o, this));
        if (this.sim.recordFlows) this.sim.recordFlow(this.place, wh.place, this.sim.now, this.sim.now + lat, 'new', this.cat, this.key);
      } else this.sendToExchange(o);
      return o;
    }
    sendToExchange(o) {
      const v = this.bestVenue(o.side);
      o.venue = v; o.viaExchange = true; this.live.set(o.id, o); this.ordersSent++;
      this.send(v, { type: 'new', order: o });
      if (!o.market) this.later(30 * SEC, () => { if (o.known !== 'done') this.cancel(o); });
    }
    onFill(o, px, q, venue, counter) {
      const mid = this.sim.nbbo().mid, st = this.stats;
      const cost = o.side * (px - mid) / mid * 1e4;
      st.n++; st.costBps += cost * q * px / PIPS; st.notional += q * px / PIPS;
      if (o.market && o.screenPx != null) { st.slipBps += o.side * (px - o.screenPx) / o.screenPx * 1e4 * q * px / PIPS; st.slipNotional = (st.slipNotional || 0) + q * px / PIPS; }
      if (venue && venue.id === 'TRF') st.viaWholesaler += q; else st.viaExchange += q;
      if (this.onPlayerFill) this.onPlayerFill(o, px, q, venue, counter, cost);
    }
  }

  // ---------------------------------------------------------------- momentum and imbalance followers
  class Momentum extends Agent {
    init() { this.hist = []; this.holdUntil = 0; this.coolUntil = 0; }
    onMarket(v, w) {
      if (w.bid == null || w.ask == null || w.halted) return;
      const now = this.sim.now, mid = (w.bid + w.ask) / 2;
      this.hist.push([now, mid]); while (this.hist.length && this.hist[0][0] < now - 15 * SEC) this.hist.shift();
      if (this.pos !== 0 && this.exitAt && now > this.exitAt + 500 * MS) { // exit was only partly filled: try again
        const s = this.pos > 0 ? -1 : 1;
        this.order(v, s, s < 0 ? v.down(w.bid) : v.up(w.ask), Math.abs(this.pos), 'IOC');
        this.exitAt = now; return;
      }
      if (this.pos !== 0 || now < this.coolUntil) return;
      const p = this.p, tick = v.tickAt(mid);
      const past = this.hist.find(h => h[0] >= now - p.lookbackMs * MS);
      const move = past ? (mid - past[1]) / tick : 0;
      let bq = 0, aq = 0; for (const l of w.bids) bq += l[1]; for (const l of w.asks) aq += l[1];
      let side = 0, why = '';
      if (move >= p.triggerTicks) { side = 1; why = `price up ${move.toFixed(0)} ticks`; }
      else if (move <= -p.triggerTicks) { side = -1; why = `price down ${(-move).toFixed(0)} ticks`; }
      else if (bq > p.imbalanceRatio * aq && aq > 0) { side = 1; why = `visible bids ${(bq / aq).toFixed(1)}× asks`; }
      else if (aq > p.imbalanceRatio * bq && bq > 0) { side = -1; why = `visible asks ${(aq / bq).toFixed(1)}× bids`; }
      if (!side) return;
      this.lastWhy = why;
      this.order(v, side, side > 0 ? v.up(w.ask) : v.down(w.bid), p.size, 'IOC');
      this.coolUntil = now + 500 * MS; this.exitAt = now + p.holdMs * MS;
      this.later(p.holdMs * MS, () => {
        if (!this.pos) return;
        const s = this.pos > 0 ? -1 : 1, vv = this.bestVenue(s), ww = this.views[vv.id]; if (!ww) return;
        this.order(vv, s, s < 0 ? vv.down(ww.bid ?? vv.mid()) : vv.up(ww.ask ?? vv.mid()), Math.abs(this.pos), 'IOC');
        this.coolUntil = this.sim.now + 1000 * MS;
      });
    }
  }

  // ---------------------------------------------------------------- fundamental fund
  class Fundamental extends Agent {
    init() { this.loop(() => this.p.everyMs * MS * (0.7 + 0.6 * this.sim.rand()) / this.sim.volMult, () => this.check()); }
    check() {
      const nb = this.viewNbbo(); if (nb.bid == null || nb.ask == null) return;
      const v0 = this.sim.venues[0], tick = v0.tickAt(nb.mid), p = this.p;
      const est = this.sim.Vs + p.noiseTicks * tick * this.sim.rand.gauss();
      // Value investors buy more the cheaper the stock looks: both the order size and the position it will hold
      // grow with the mispricing, so a large sale is eventually absorbed instead of draining every buyer.
      const base = p.maxPos || 5 * p.size, cheap = (est - nb.ask) / tick, rich = (nb.bid - est) / tick;
      if (cheap >= p.threshold && this.pos < base * cheap / p.threshold) { const v = this.bestVenue(1); this.order(v, 1, v.up(nb.ask), Math.round(p.size * Math.min(5, cheap / p.threshold)), 'IOC'); }
      else if (rich >= p.threshold && this.pos > -base * rich / p.threshold) { const v = this.bestVenue(-1); this.order(v, -1, v.down(nb.bid), Math.round(p.size * Math.min(5, rich / p.threshold)), 'IOC'); }
    }
  }

  // ---------------------------------------------------------------- institutional execution algorithms
  class Institution extends Agent {
    init() { this.parent = null; }
    launch(cfg) {
      this.cancelAll();
      const nb = this.sim.nbbo(), lot = this.sim.rules.lot;
      const P = this.parent = Object.assign({ side: -1, qty: 200000, algo: 'TWAP', durationS: 120, pov: 0.1, display: 2000, limitBps: 50 }, cfg,
        { arrivalMid: nb.mid, start: this.sim.now, filled: 0, cost: 0, slices: 0, counter: {}, done: false, startFills: this.fills });
      P.qty = Math.round(P.qty / lot) * lot;
      this.posAtStart = this.pos;
      const algoText = { TWAP: 'equal slices at a fixed interval', VWAP: 'slices sized to recent market volume', POV: `${Math.round(P.pov * 100)}% of market volume`, ICEBERG: `a resting order showing only ${P.display.toLocaleString()} shares`, STEALTH: 'random sizes, timing and venues' }[P.algo];
      this.sim.addLog('inst', `${this.name} starts to ${P.side > 0 ? 'buy' : 'sell'} ${P.qty.toLocaleString()} shares with ${P.algo} (${algoText}). Arrival price ${this.sim.fmtPx(P.arrivalMid)}.`, this.cat);
      const g = ++this.gen;
      const alive = () => this.enabled && g === this.gen && this.parent === P && !P.done;
      const remaining = () => P.qty - Math.abs(this.pos - this.posAtStart);
      const slice = (q, aggressive, venue) => {
        q = Math.round(Math.min(q, remaining()) / lot) * lot; if (q <= 0) return;
        const v = venue || this.bestVenue(P.side), w = this.views[v.id];
        if (!w) return;
        P.slices++;
        if (aggressive) {
          if (P.noLimit) this.market(v, P.side, q);
          else { const ref = P.side > 0 ? (w.ask ?? v.mid()) : (w.bid ?? v.mid()); this.order(v, P.side, P.side > 0 ? v.up(v.up(ref)) : v.down(v.down(ref)), q, 'IOC'); }
        } else {
          const px = P.side > 0 ? (w.bid ?? v.mid()) : (w.ask ?? v.mid());
          const o = this.order(v, P.side, px, q, 'GTC', P.algo === 'ICEBERG' ? { display: P.display } : {});
          if (P.algo !== 'ICEBERG') this.later(3 * SEC, () => this.cancel(o));
        }
      };
      const tick = () => {
        if (!alive()) return;
        if (remaining() <= 0 || this.sim.now - P.start > P.durationS * SEC * 1.6) return this.finish();
        let next = 1 * SEC;
        if (P.algo === 'TWAP') { // equal slices; a missed slice is caught up next time (capped at 3 slices)
          const n = Math.max(10, Math.round(P.durationS / 2)); next = P.durationS * SEC / n;
          const behind = Math.min(1, (this.sim.now - P.start) / (P.durationS * SEC)) * P.qty - (P.qty - remaining());
          slice(Math.max(P.qty / n, Math.min(3 * P.qty / n, behind)), true);
        }
        else if (P.algo === 'VWAP') {
          const n = Math.max(10, Math.round(P.durationS / 2)); next = P.durationS * SEC / n;
          const vol = this.recentVolume(10 * SEC), avg = this.avgVol || vol; this.avgVol = 0.9 * avg + 0.1 * vol;
          slice(P.qty / n * Math.max(0.5, Math.min(2, vol / Math.max(1, avg))), true);
        } else if (P.algo === 'POV') { next = 1 * SEC; slice(Math.max(P.minClip || 0, P.pov * this.recentVolume(1 * SEC)), true); }
        else if (P.algo === 'ICEBERG') {
          next = 1 * SEC;
          const mine = [...this.live.values()].filter(o => !o.cancelSent && o.known !== 'done');
          const v = this.bestVenue(-P.side), w = this.views[v.id];
          const touch = w ? (P.side > 0 ? w.bid : w.ask) : null;
          if (!mine.length) slice(remaining(), false, v);
          else if (touch != null && Math.abs(mine[0].px - touch) >= 2 * v.tickAt(touch)) { for (const o of mine) this.cancel(o); }
          if (this.sim.now - P.start > P.durationS * SEC) slice(remaining(), true);
        } else { // STEALTH
          next = this.sim.rand.exp(P.durationS * SEC / 60);
          const venues = this.sim.venues, v = venues[Math.floor(this.sim.rand() * venues.length)];
          slice(P.qty / 60 * (0.4 + 1.2 * this.sim.rand()), this.sim.rand() < 0.5, v);
        }
        this.sim.after(next, tick);
      };
      this.sim.after(1, tick);
    }
    recentVolume(us) {
      let q = 0; const cut = this.sim.now - us, tape = this.sim.tape;
      for (let i = tape.length - 1; i >= 0 && tape[i].t >= cut; i--) if (tape[i].mk !== this && tape[i].tk !== this) q += tape[i].q;
      return q;
    }
    onFill(o, px, q, venue, counter) {
      const P = this.parent; if (!P || P.done) return;
      P.filled += q; P.cost += px * q; P.counter[counter.cat] = (P.counter[counter.cat] || 0) + q;
    }
    shortfallBps() { const P = this.parent; if (!P || !P.filled) return null; const avg = P.cost / P.filled; return P.side * (avg - P.arrivalMid) / P.arrivalMid * 1e4; }
    finish() {
      const P = this.parent; if (!P || P.done) return;
      P.done = true; this.cancelAll();
      const sf = this.shortfallBps();
      const top = Object.entries(P.counter).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, q]) => `${window.MM.CATS[c].label} ${(q / P.filled * 100).toFixed(0)}%`).join(', ');
      this.sim.addLog('inst', `${this.name} finished ${P.algo}: filled ${P.filled.toLocaleString()} of ${P.qty.toLocaleString()} shares, implementation shortfall ${sf == null ? '–' : sf.toFixed(1) + ' bp'}. Traded mostly with: ${top || 'nobody'}.`, this.cat);
    }
  }

  // ---------------------------------------------------------------- manipulation (for demonstration)
  class Spoofer extends Agent {
    init() { this.dir = 1; this.cycles = 0; this.fakeCancelled = 0; this.fakeFilled = 0; this.fakes = []; this.loop(() => this.p.cycleMs * MS, () => this.cycle()); }
    target() { return this.sim.venues[this.sim.venues.length - 1]; }
    cycle() {
      const v = this.target(), w = this.views[v.id];
      if (!w || w.bid == null || w.ask == null || w.halted) return;
      const p = this.p, dir = this.dir; this.dir = -this.dir; this.cycles++;
      // dir = +1: fake bids 2+ ticks below the best bid make the book look bid-heavy; the real order sells at the ask.
      let px = dir > 0 ? v.down(v.down(w.bid)) : v.up(v.up(w.ask));
      this.fakes = [];
      for (let i = 0; i < p.layers; i++) { this.fakes.push(this.order(v, dir, px, p.spoofSize, 'GTC', { fake: true })); px = dir > 0 ? v.down(px) : v.up(px); }
      const real = this.order(v, -dir, dir > 0 ? w.ask : w.bid, p.realSize, 'GTC');
      this.later(p.cycleMs * 0.6 * MS, () => { this.pullFakes(); this.cancel(real); });
      if (this.cycles % 4 === 0) {
        const otr = this.ordersSent / Math.max(1, this.fills);
        this.sim.addLog('manip', `${this.name}: ${this.fakeCancelled} fake orders cancelled before they could fill, ${this.fills} real fills. Order-to-trade ratio ${otr.toFixed(0)}:1. Surveillance looks for exactly this: large orders that never trade, on the opposite side of the trades that do.`, this.cat);
      }
    }
    pullFakes() { for (const o of this.fakes) if (!o.cancelSent && o.known !== 'done') { this.fakeCancelled++; this.cancel(o); } this.fakes = []; }
    onMarket(v, w) { // pull a fake order the moment the price comes within one tick of it
      if (v !== this.target() || !this.fakes.length) return;
      for (const o of this.fakes) {
        if (o.cancelSent || o.known === 'done') continue;
        const near = o.side > 0 ? (w.bid != null && w.bid <= v.up(o.px)) : (w.ask != null && w.ask >= v.down(o.px));
        if (near) { this.fakeCancelled++; this.cancel(o); }
      }
    }
    onFill(o) { if (o.fake) this.fakeFilled++; }
  }
  class Igniter extends Agent {
    init() { this.dir = 1; this.loop(() => this.p.cycleMs * MS, () => this.cycle()); }
    cycle() {
      const v = this.bestVenue(this.dir), w = this.views[v.id]; if (!w || w.ask == null || w.bid == null || w.halted) return;
      const dir = this.dir; this.dir = -this.dir; const p = this.p;
      let px = dir > 0 ? w.ask : w.bid; for (let i = 0; i < p.sweepTicks; i++) px = dir > 0 ? v.up(px) : v.down(px);
      this.order(v, dir, px, p.burst, 'IOC');
      this.sim.addLog('manip', `${this.name} fires ${p.burst.toLocaleString()} shares of aggressive ${dir > 0 ? 'buys' : 'sells'} through ${p.sweepTicks} price levels to start a move.`, this.cat);
      this.later(p.exitMs * MS, () => {
        if (!this.pos) return;
        const s = this.pos > 0 ? -1 : 1, vv = this.bestVenue(s), ww = this.views[vv.id]; if (!ww) return;
        this.order(vv, s, s < 0 ? (ww.bid ?? vv.mid()) : (ww.ask ?? vv.mid()), Math.abs(this.pos), 'IOC');
        this.later(800 * MS, () => { if (this.pos) { const s2 = this.pos > 0 ? -1 : 1, v2 = this.bestVenue(s2), w2 = this.views[v2.id]; if (w2) this.order(v2, s2, s2 < 0 ? v2.down(w2.bid ?? v2.mid()) : v2.up(w2.ask ?? v2.mid()), Math.abs(this.pos), 'IOC'); } });
      });
    }
  }
  class Stuffer extends Agent {
    init() {
      const v = this.sim.venues[this.sim.venues.length - 1];
      this.target = v;
      this.loop(() => 1 * MS, () => { // load is applied in bulk rather than as millions of individual messages
        const now = this.sim.now, backlog = Math.max(0, v.busyUntil - now);
        // The gateway buffers at most 50 ms of messages; beyond that it rejects this firm's excess (a throttle).
        const n = Math.max(0, Math.min(this.p.perMs, (50 * MS - backlog) * v.capacity / 1000 + v.capacity));
        if (n < this.p.perMs && !this.throttled) { this.throttled = true; this.sim.addLog('manip', `${v.name}'s gateway is full (50 ms of messages waiting) and starts rejecting ${this.name}'s excess messages. Everyone else still waits up to 50 ms.`, this.cat); }
        v.busyUntil = Math.max(v.busyUntil, now) + n * 1000 / v.capacity;
        if (this.sim.recordFlows) this.sim.recordFlow(this.place, v.place, now, now + this.latTo(v), 'stuff', this.cat, this.key, this.p.perMs);
        v.msgs += n; this.msgs += this.p.perMs; this.sim.counters.msgs += n; this.sim.counters.cancels += n / 2; v.cancels += n / 2;
      });
      this.sim.addLog('manip', `${this.name} floods ${v.name} with ${this.p.perMs} messages per millisecond (its capacity is about ${v.capacity}). Every other order now waits in line.`, this.cat);
    }
  }
  class StubQuoter extends Agent {
    init() { this.loop(() => 1 * SEC, () => this.refresh()); this.later(1, () => this.refresh()); }
    refresh() {
      if (!this.sim.rules.stubOk) { this.cancelAll(); return; }
      for (const v of this.sim.venues) {
        const mine = [...this.live.values()].filter(o => o.venue === v && !o.cancelSent && o.known !== 'done');
        if (!mine.some(o => o.side > 0)) this.order(v, 1, 10, 100, 'GTC');
        if (!mine.some(o => o.side < 0)) this.order(v, -1, this.sim.startPx * 3, 100, 'GTC');
      }
    }
  }

  // The player's own retail account: same routing and measurement as Retail, but only trades when told to.
  class PlayerRetail extends Retail {
    init() { this.stats = { n: 0, costBps: 0, notional: 0, slipBps: 0, piShares: 0, viaWholesaler: 0, viaExchange: 0 }; this.midHist = []; }
  }

  const KINDS = { PlayerRetail, MarketMaker, LatencyArb, StatArb, Anticipator, RebateCapture, Wholesaler, Retail, Momentum, Fundamental, Institution, Spoofer, Igniter, Stuffer, StubQuoter };
  window.Agents = { Agent, KINDS };
})();
