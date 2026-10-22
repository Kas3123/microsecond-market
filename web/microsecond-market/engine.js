// Event-driven market engine: microsecond clock, latency network, order books, fees, circuit breakers.
(function () {
  'use strict';
  const { PLACES, MEDIA, HK_BANDS, REGIONS } = window.MM;
  const PIPS = 1000;           // internal price units per currency unit (1 pip = 0.001)
  const SEC = 1e6;             // microseconds per second

  function distKm(a, b) {
    const R = 6371.0088, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const latCache = new Map();
  function linkUs(from, to, medium) {
    if (from === to) return MEDIA.crossconnect.fixedUs;
    const key = from + '|' + to + '|' + medium;
    let v = latCache.get(key);
    if (v === undefined) {
      const m = MEDIA[medium] || MEDIA.metrofiber;
      v = distKm(PLACES[from], PLACES[to]) * m.route / m.speed * SEC + m.fixedUs;
      latCache.set(key, v);
    }
    return v;
  }

  function makeRng(seed) {
    let a = seed >>> 0;
    const r = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.gauss = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
    r.exp = (mean) => -Math.log(1 - r()) * mean;
    return r;
  }

  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    peekT() { return this.a.length ? this.a[0].t : Infinity; }
    less(i, j) { const x = this.a[i], y = this.a[j]; return x.t < y.t || (x.t === y.t && x.s < y.s); }
    push(e) {
      const a = this.a; a.push(e); let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && this.less(l, m)) m = l;
          if (r < a.length && this.less(r, m)) m = r;
          if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m;
        }
      }
      return top;
    }
  }

  // A data feed published at one place. Each subscriber sees the latest state that existed `lat` µs ago.
  class Feed {
    constructor(sim, place) { this.sim = sim; this.place = place; this.hist = []; this.subs = []; }
    publish(state) {
      state.t = this.sim.now;
      const h = this.hist; h.push(state);
      if (h.length > 4000) h.splice(0, 2000);
      const sim = this.sim;
      for (const s of this.subs) {
        if (!s.pending && !s.dead) {
          s.pending = true; sim.at(sim.now + s.lat, () => this.deliver(s));
          if (sim.recordFlows) sim.recordFlow(this.place, s.agent.place, sim.now, sim.now + s.lat, this.isLead ? 'lead' : 'md', s.agent.cat, s.agent.key);
        }
      }
    }
    subscribe(agent, lat, cb) {
      const s = { agent, lat, cb, pending: false, last: null, dead: false }; this.subs.push(s);
      if (this.hist.length) { s.pending = true; this.sim.at(this.sim.now + lat, () => this.deliver(s)); } // current state, after the travel delay
      return s;
    }
    unsubscribe(agent) { for (const s of this.subs) if (s.agent === agent) s.dead = true; this.subs = this.subs.filter(s => !s.dead); }
    latest() { return this.hist[this.hist.length - 1]; }
    deliver(s) {
      s.pending = false;
      if (s.dead) return;
      const cutoff = this.sim.now - s.lat + 1e-6, h = this.hist;
      let i = h.length - 1;
      while (i >= 0 && h[i].t > cutoff) i--;
      if (i >= 0 && h[i] !== s.last) { s.last = h[i]; s.cb(h[i]); }
      if (i < h.length - 1) { s.pending = true; this.sim.at(h[i + 1].t + s.lat, () => this.deliver(s)); }
    }
  }

  function insertSorted(arr, v, desc) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (desc ? arr[m] > v : arr[m] < v) lo = m + 1; else hi = m; }
    arr.splice(lo, 0, v);
  }
  function removeSorted(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }

  let ORDER_ID = 1;

  class Venue {
    constructor(sim, cfg) {
      Object.assign(this, { sim, id: cfg.id, name: cfg.name, place: cfg.place, matchUs: cfg.matchUs, capacity: cfg.capacity,
        feeType: cfg.feeType, makerFee: cfg.maker, takerFee: cfg.taker });
      this.speedBumpUs = 0; this.busyUntil = 0; this.queueUs = 0;
      this.bids = new Map(); this.asks = new Map(); this.bidPx = []; this.askPx = [];
      this.orders = new Map(); this.trades = []; this.tradeSeq = 0;
      this.feed = new Feed(sim, cfg.place);
      this.msgs = 0; this.cancels = 0; this.nTrades = 0; this.volume = 0;
      this.recentFills = new Map();
      this.prints = []; this.band = null; this.halted = false; this.haltUntil = 0; this.limitSince = null;
    }
    get rules() { return this.sim.rules; }
    tickAt(p) { // tick for a price "over lo up to hi"
      if (this.rules.tick === 'us') return this.rules.halfPenny ? 5 : 10;
      const x = p / PIPS;
      for (const [lo, hi, t] of HK_BANDS) if (x > lo && x <= hi + 1e-9) return Math.round(t * PIPS);
      return 5000;
    }
    up(p) { return p + this.tickAt(p + 0.5); }
    down(p) { return p - this.tickAt(p - 0.5); }
    roundDown(p) { const t = this.tickAt(p); return Math.floor(p / t + 1e-9) * t; }
    roundUp(p) { const t = this.tickAt(p); return Math.ceil(p / t - 1e-9) * t; }
    bestBid() { return this.bidPx.length ? this.bidPx[0] : null; }
    bestAsk() { return this.askPx.length ? this.askPx[0] : null; }
    mid() {
      const b = this.bestBid(), a = this.bestAsk();
      if (b != null && a != null) return (a + b) / 2;
      return b != null ? b : a != null ? a : this.lastPx || this.sim.startPx;
    }
    visQty(lvl) { let s = 0; for (const o of lvl) s += o.display ? o.vis : o.rem; return s; }

    // Message arrives at the exchange gateway; it waits behind earlier messages, then the matcher runs.
    arrive(msg) {
      const now = this.sim.now;
      const start = Math.max(now, this.busyUntil);
      this.busyUntil = start + 1000 / this.capacity;
      this.queueUs = this.queueUs * 0.995 + (start - now) * 0.005;
      this.msgs++;
      this.sim.counters.msgs++;
      this.sim.at(start + this.matchUs, () => this.process(msg));
    }
    process(m) {
      if (m.type === 'cancel') { this.cancel(m.order, false); return; }
      if (m.type === 'replace') {
        if (!this.cancel(m.old, true)) { m.order.state = 'rejected'; this.report(m.order, 'rejected'); return; }
        this.report(m.old, 'replaced'); // tell the owner the old order is gone
      }
      this.add(m.order);
    }
    add(o) {
      const lot = this.rules.lot || 1;
      o.qty = Math.floor(o.qty / lot) * lot; o.rem = o.qty;
      if (o.qty <= 0) { o.state = 'rejected'; this.report(o, 'rejected'); return; }
      if (o.market) o.px = o.side > 0 ? Infinity : 0;
      else {
        o.px = o.side > 0 ? this.roundDown(o.px) : this.roundUp(o.px);
        if (!(o.px > 0)) { o.state = 'rejected'; this.report(o, 'rejected'); return; } // prices must be positive
        // LULD: a buy priced above the upper band (or a sell below the lower band) is repriced to the band.
        const B = this.rules.bandOn && this.rules.band === 'LULD' ? this.band : null;
        if (B) { if (o.side > 0 && o.px > B.hi) o.px = this.roundDown(B.hi); else if (o.side < 0 && o.px < B.lo) o.px = this.roundUp(B.lo); }
      }
      if (o.display) o.vis = Math.min(o.display, o.rem);
      if (o.tif === 'POST') {
        const opp = o.side > 0 ? this.bestAsk() : this.bestBid();
        if (opp != null && (o.side > 0 ? o.px >= opp : o.px <= opp)) { o.state = 'rejected'; this.report(o, 'rejected'); return; }
      }
      const seq0 = this.tradeSeq;
      if (!this.halted) this.match(o);
      if (o.rem > 0) {
        if (o.tif === 'IOC' || o.market) {
          o.state = 'expired'; this.report(o, 'expired');
          if (this.tradeSeq === seq0) return; // nothing traded and nothing rests: the book is unchanged, so no new market data
        } else this.rest(o);
      } else o.state = 'filled';
      this.afterChange();
    }
    match(o) {
      const book = o.side > 0 ? this.asks : this.bids, pxs = o.side > 0 ? this.askPx : this.bidPx;
      while (o.rem > 0 && pxs.length) {
        const px = pxs[0];
        if (o.side > 0 ? px > o.px : px < o.px) break;
        if (!this.bandAllows(px)) break;
        const lvl = book.get(px);
        while (o.rem > 0 && lvl.length) {
          const r = lvl[0];
          const avail = r.display ? r.vis : r.rem;
          const q = Math.min(o.rem, avail);
          this.fill(r, o, px, q);
          if (r.display) {
            r.vis -= q;
            if (r.rem <= 0) { lvl.shift(); this.orders.delete(r.id); r.state = 'filled'; }
            else if (r.vis <= 0) { r.vis = Math.min(r.display, r.rem); lvl.shift(); lvl.push(r); } // refill loses priority
          } else if (r.rem <= 0) { lvl.shift(); this.orders.delete(r.id); r.state = 'filled'; }
        }
        if (!lvl.length) { book.delete(px); pxs.shift(); }
      }
    }
    fill(maker, taker, px, q) {
      const sim = this.sim, now = sim.now;
      maker.rem -= q; taker.rem -= q;
      const tr = { t: now, px, q, side: taker.side, mk: maker.agent, tk: taker.agent, venue: this.id, seq: ++this.tradeSeq };
      this.trades.push(tr); if (this.trades.length > 6000) this.trades.splice(0, 3000);
      this.nTrades++; this.volume += q; this.lastPx = px;
      this.prints.push([now, px]);
      sim.charge(maker.agent, this, 'maker', px, q);
      sim.charge(taker.agent, this, 'taker', px, q);
      maker.agent.applyFill(maker, px, q, this, taker.agent, 'maker');
      taker.agent.applyFill(taker, px, q, this, maker.agent, 'taker');
      this.report(maker, 'fill', px, q); this.report(taker, 'fill', px, q);
      this.recentFills.set(maker.id, { t: now, by: taker.agent, px, q });
      if (this.recentFills.size > 3000) this.recentFills.delete(this.recentFills.keys().next().value);
      sim.onTrade(this, tr);
    }
    rest(o) {
      const book = o.side > 0 ? this.bids : this.asks, pxs = o.side > 0 ? this.bidPx : this.askPx;
      let lvl = book.get(o.px);
      if (!lvl) { lvl = []; book.set(o.px, lvl); insertSorted(pxs, o.px, o.side > 0); }
      lvl.push(o); this.orders.set(o.id, o); o.state = 'live'; o.restT = this.sim.now;
      this.report(o, 'ack');
    }
    cancel(o, silent) {
      const r = this.orders.get(o.id);
      if (!r) {
        const rf = this.recentFills.get(o.id);
        if (rf && this.sim.now - rf.t < 50000) this.sim.raceLost(this, o, rf);
        if (!silent) this.report(o, 'cancelReject');
        return false;
      }
      const book = r.side > 0 ? this.bids : this.asks, pxs = r.side > 0 ? this.bidPx : this.askPx;
      const lvl = book.get(r.px); const i = lvl.indexOf(r); if (i >= 0) lvl.splice(i, 1);
      if (!lvl.length) { book.delete(r.px); removeSorted(pxs, r.px); }
      this.orders.delete(r.id); r.state = 'cancelled'; this.cancels++; this.sim.counters.cancels++;
      if (!silent) { this.report(r, 'cancelled'); this.afterChange(); }
      return true;
    }
    report(o, kind, px, q) {
      const ag = o.agent;
      const lat = linkUs(this.place, ag.place, ag.linkFor(this)), sim = this.sim;
      sim.at(sim.now + lat, () => ag.onExec({ o, kind, px, q, venue: this }));
      if (sim.recordFlows) sim.recordFlow(this.place, ag.place, sim.now, sim.now + lat, kind === 'fill' ? 'fill' : 'ack', ag.cat, ag.key);
    }
    snapshot() {
      const lv = (pxs, book) => pxs.slice(0, 5).map(p => [p, this.visQty(book.get(p))]);
      const bids = lv(this.bidPx, this.bids), asks = lv(this.askPx, this.asks);
      return { bid: bids.length ? bids[0][0] : null, bidQty: bids.length ? bids[0][1] : 0,
        ask: asks.length ? asks[0][0] : null, askQty: asks.length ? asks[0][1] : 0, bids, asks,
        tradeSeq: this.tradeSeq, halted: this.halted, band: this.band ? { lo: this.band.lo, hi: this.band.hi } : null };
    }
    tradesSince(seq) {
      const tr = this.trades; if (!tr.length) return [];
      const first = tr[0].seq; const i = Math.max(0, seq - first + 1);
      return tr.slice(i);
    }
    afterChange() { this.checkBands(); this.feed.publish(this.snapshot()); }

    // ---------- circuit breakers ----------
    bandAllows(px) {
      const rules = this.rules;
      if (!rules.bandOn) return true;
      const session = (this.sim.clockBase || 0) + this.sim.now < 150 * 60 * SEC ? 0 : 1; // morning (to 12:00) or afternoon session
      if (rules.band === 'VCM' && !this.band && this.vcmSession !== session) { // VCM triggers at most once per session
        const ref = this.refPrice(300 * SEC);
        if (Math.abs(px - ref) / ref > rules.bandPct / 100) {
          const p = rules.bandPct / 100; this.vcmSession = session;
          this.band = { lo: ref * (1 - p), hi: ref * (1 + p), until: this.sim.now + 300 * SEC, kind: 'VCM' };
          this.sim.addLog('rule', `${this.name}: Volatility Control Mechanism triggered. A trade at ${this.sim.fmtPx(px)} would be ${(Math.abs(px - ref) / ref * 100).toFixed(1)}% from the price 5 minutes ago. For 5 minutes trading is allowed only between ${this.sim.fmtPx(this.band.lo)} and ${this.sim.fmtPx(this.band.hi)}.`, 'manip');
          this.sim.at(this.band.until, () => { this.band = null; this.sim.addLog('rule', `${this.name}: VCM cooling-off ended. Trading continues without a band; the VCM can trigger only once per trading session.`); });
        }
      }
      return !this.band || (px >= this.band.lo - 1e-6 && px <= this.band.hi + 1e-6);
    }
    refPrice(windowUs) {
      const cut = this.sim.now - windowUs, pr = this.prints;
      while (pr.length > 2 && pr[0][0] < this.sim.now - 400 * SEC) pr.shift();
      if (this.rules.band === 'VCM') { // price about 5 minutes ago
        for (let i = pr.length - 1; i >= 0; i--) if (pr[i][0] <= cut) return pr[i][1];
        return pr.length ? pr[0][1] : this.sim.startPx;
      }
      let s = 0, n = 0; for (const [t, p] of pr) if (t >= cut) { s += p; n++; }
      return n ? s / n : this.sim.startPx;
    }
    checkBands() {
      const rules = this.rules, now = this.sim.now;
      if (!rules.bandOn || rules.band !== 'LULD' || this.halted) return;
      if (!this.band || now - this.band.set > 30 * SEC) {
        const ref = this.refPrice(300 * SEC), p = rules.bandPct / 100;
        this.band = { lo: ref * (1 - p), hi: ref * (1 + p), set: now, kind: 'LULD' };
      }
      const b = this.bestBid(), a = this.bestAsk();
      const limit = (a != null && a <= this.band.lo + 1e-6) || (b != null && b >= this.band.hi - 1e-6);
      if (!limit) { this.limitSince = null; return; }
      if (this.limitSince == null) {
        this.limitSince = now;
        this.sim.addLog('rule', `${this.name}: Limit state. The ${a != null && a <= this.band.lo + 1e-6 ? 'best offer is at the lower' : 'best bid is at the upper'} LULD band (${this.sim.fmtPx(a != null && a <= this.band.lo + 1e-6 ? this.band.lo : this.band.hi)}). If it lasts 15 seconds, trading pauses for 5 minutes.`, 'manip');
        this.sim.at(now + 15 * SEC + 1, () => this.checkBands());
      } else if (now - this.limitSince >= 15 * SEC) {
        this.halted = true; this.haltUntil = now + 300 * SEC; this.limitSince = null;
        this.sim.addLog('rule', `${this.name}: LULD trading pause for 5 minutes. Orders can still be entered and cancelled; nothing executes.`, 'manip');
        this.sim.at(this.haltUntil, () => this.resume());
      }
    }
    resume() {
      this.halted = false; this.band = null; this.prints = this.prints.slice(-50);
      // Reopening: match any crossed resting orders at the earlier order's price.
      while (this.bidPx.length && this.askPx.length && this.bidPx[0] >= this.askPx[0]) {
        const b = this.bids.get(this.bidPx[0])[0], a = this.asks.get(this.askPx[0])[0];
        const px = b.restT <= a.restT ? b.px : a.px, q = Math.min(b.display ? b.vis : b.rem, a.display ? a.vis : a.rem);
        const taker = b.restT <= a.restT ? a : b, maker = taker === a ? b : a;
        this.fill(maker, taker, px, q);
        for (const o of [b, a]) if (o.rem <= 0) this.removeFilled(o); else if (o.display && o.vis <= 0) o.vis = Math.min(o.display, o.rem);
      }
      this.sim.addLog('rule', `${this.name}: trading resumed after the pause.`);
      this.afterChange();
    }
    removeFilled(o) {
      const book = o.side > 0 ? this.bids : this.asks, pxs = o.side > 0 ? this.bidPx : this.askPx;
      const lvl = book.get(o.px); if (!lvl) return;
      const i = lvl.indexOf(o); if (i >= 0) lvl.splice(i, 1);
      if (!lvl.length) { book.delete(o.px); removeSorted(pxs, o.px); }
      this.orders.delete(o.id); o.state = 'filled';
    }

    // Depth by participant category around a centre price, for the 3D view.
    depthByCat(center, half, cats) {
      const out = { bids: [], asks: [] };
      for (let i = -half; i <= half; i++) {
        const px = center + i * this.tickAt(center);
        for (const [side, book] of [['bids', this.bids], ['asks', this.asks]]) {
          const lvl = book.get(px); const row = new Float32Array(cats.length);
          if (lvl) for (const o of lvl) row[cats.indexOf(o.agent.cat)] += o.display ? o.vis : o.rem;
          out[side].push(row);
        }
      }
      return out;
    }
  }

  class Sim {
    constructor(regionId, seed = 11, stock = null) {
      const region = REGIONS[regionId];
      this.region = region; this.regionId = regionId;
      // the stock simulated order by order (see stocks.js / universe.js)
      const st = this.stock = stock || window.Universe.stockInfo(regionId, window.STOCKS.DEFAULT[regionId]);
      this.rules = Object.assign({ bandOn: true, halfPenny: false, stubOk: false }, region.rules, { lot: st.lot || region.rules.lot });
      this.now = 0; this.heap = new Heap(); this.seq = 0; this.rand = makeRng(seed);
      this.startPx = Math.round(st.price * PIPS);
      this.venues = region.venues.map(v => new Venue(this, v));
      this.venueById = Object.fromEntries(this.venues.map(v => [v.id, v]));
      this.leadFeed = new Feed(this, region.leadPlace); this.leadFeed.isLead = true;
      // V is the index futures, scaled to start at the stock's price. F = what the futures imply for this stock
      // (beta times the index move). Stock value Vs = F x exp(idio): idio is company-specific, a random walk plus
      // permanent price impact from aggressive trading (bp per million of currency traded; less in liquid stocks).
      this.V = this.startPx; this.beta = st.beta; this.lastLeadPub = this.startPx; this.lastLeadV = this.V;
      this.futTick = (regionId === 'hk' ? 0.5 : 0.12) / 1e4; // one futures tick as a fraction of the index
      this.idio = 0; this.impactBpPerM = (regionId === 'hk' ? 0.3 : 1.0) / st.L;
      this.sigmaPerUs = region.dailyVolPct / 100 / Math.sqrt(23400 * SEC);      // index
      this.idioSigmaPerUs = st.idioVol / 100 / Math.sqrt(23400 * SEC);          // company-specific
      this.jumpPerSec = 1 / 90; this.jumpPct = 0.0015;
      this.agents = []; this.logs = []; this.counters = { msgs: 0, cancels: 0, trades: 0 };
      this.samples = []; this.tape = []; this.offEx = [];
      this.catVolume = {}; this.hftVolume = 0; this.totalVolume = 0;
      this.exVol = 0; this.offVol = 0; this.coarse = [];
      this.volMult = 1; // scales how often outside investors (retail, funds) send orders
      this.listeners = { log: [] };
    }
    // Message-flow recorder for the network view (off unless that view is open).
    recordFlow(from, to, t0, t1, kind, cat, key, w = 1) {
      const B = this.flowBuf || (this.flowBuf = new Array(12000));
      B[this.flowN % B.length] = { from, to, t0, t1, kind, cat, key, w };
      this.flowN = (this.flowN || 0) + 1;
      const lk = from + '>' + to; this.linkMsgs = this.linkMsgs || {}; this.linkMsgs[lk] = (this.linkMsgs[lk] || 0) + w;
    }
    at(t, fn) { this.heap.push({ t, s: this.seq++, fn }); }
    after(dt, fn) { this.at(this.now + dt, fn); }
    get F() { return this.startPx * Math.pow(this.V / this.startPx, this.beta); }
    tick() { return this.venues[0].tickAt(this.F); }
    fmtPx(p) { // show sub-penny prices (wholesaler price improvement, half-penny ticks) with 3 decimals
      const d = this.rules.tick === 'us' ? (Math.abs(Math.round(p) % 10) ? 3 : 2) : 3;
      return this.region.currency + (p / PIPS).toFixed(d);
    }
    fmtUs(us) { return us < 1000 ? us.toFixed(us < 10 ? 2 : 1) + ' µs' : us < 1e6 ? (us / 1000).toFixed(us < 1e4 ? 2 : 1) + ' ms' : (us / 1e6).toFixed(2) + ' s'; }
    lat(from, to, medium) { return linkUs(from, to, medium); }

    start() {
      const stepUs = 2000;
      const step = () => {
        const z = this.rand.gauss();
        this.V *= Math.exp(this.sigmaPerUs * Math.sqrt(stepUs) * z);
        this.idio += this.idioSigmaPerUs * Math.sqrt(stepUs) * this.rand.gauss();
        if (this.rand() < this.jumpPerSec * stepUs / SEC) this.V *= 1 + (this.rand() < 0.5 ? -1 : 1) * this.jumpPct * (0.5 + this.rand());
        // the futures price moves on its own tick grid (index points), whatever the stock's price
        if (Math.abs(this.V / this.lastLeadV - 1) >= this.futTick) { this.lastLeadV = this.V; this.lastLeadPub = this.F; this.leadFeed.publish({ F: this.lastLeadPub }); }
        this.after(stepUs, step);
      };
      this.leadFeed.publish({ F: this.F });
      this.after(stepUs, step);
      this.sampleEvery = 50000;
      const sample = () => { this.sample(); this.after(this.sampleEvery, sample); };
      this.after(0, sample);
      // one sample per second, kept for hours, for long chart windows
      const coarse = () => { const s = this.samples[this.samples.length - 1]; if (s) { this.coarse.push(s); if (this.coarse.length > 30000) this.coarse.splice(0, 5000); } this.after(SEC, coarse); };
      this.after(SEC, coarse);
      for (const v of this.venues) v.afterChange();
      for (const a of this.agents) a.attach();
    }
    shock(pct) {
      this.V *= 1 + pct; this.lastLeadV = this.V; this.lastLeadPub = this.F; this.leadFeed.publish({ F: this.F });
      this.addLog('news', `${this.region.leadLabel}: ${(pct * 100).toFixed(2)}% on news. With beta ${this.beta.toFixed(2)}, ${this.stock.ticker} should move about ${(this.beta * pct * 100).toFixed(2)}%, but each firm learns it only when the futures data reaches it.`);
    }
    runTo(target, budget) {
      let n = 0;
      while (this.heap.size && this.heap.peekT() <= target) {
        if (n >= budget) return false;
        const e = this.heap.pop(); this.now = e.t; e.fn(); n++;
      }
      this.now = target; return true;
    }

    // ---------- accounting ----------
    charge(agent, venue, role, px, q) {
      let fee;
      if (venue.feeType === 'pershare') fee = (role === 'maker' ? venue.makerFee : venue.takerFee) * q;
      else fee = (role === 'maker' ? venue.makerFee : venue.takerFee) / 1e4 * px / PIPS * q;
      const stamp = this.rules.stampBps && !agent.stampExempt ? this.rules.stampBps / 1e4 * px / PIPS * q : 0;
      agent.fees += fee; agent.stamp += stamp; agent.cash -= fee + stamp;
    }
    get Vs() { return this.F * Math.exp(this.idio); }
    // company news: changes the stock's value but not the index futures, so it must be traded into the price
    companyNews(pct, why) {
      this.idio += Math.log(1 + pct);
      this.addLog('news', `${this.stock.ticker}: ${why || 'company news'} (${pct > 0 ? '+' : ''}${(pct * 100).toFixed(1)}% in value). The futures don't move, so market makers only find out from the orders that hit them.`);
    }
    onTrade(venue, tr) {
      this.counters.trades++;
      if (venue.id !== 'TRF') this.idio += tr.side * tr.q * tr.px / PIPS / 1e6 * this.impactBpPerM / 1e4;
      for (const a of [tr.mk, tr.tk]) { this.catVolume[a.cat] = (this.catVolume[a.cat] || 0) + tr.q; if (a.isHft) this.hftVolume += tr.q; }
      this.totalVolume += 2 * tr.q;
      if (venue.id === 'TRF') this.offVol += tr.q; else this.exVol += tr.q;
      this.tape.push(tr); if (this.tape.length > 4000) this.tape.splice(0, 2000);
    }
    // Wholesaler fills a retail order off-exchange (reported to a FINRA trade reporting facility).
    offExchangeFill(maker, taker, order, px) {
      const q = order.qty, TRF = this.trf || (this.trf = { id: 'TRF', name: 'Off-exchange', place: 'secaucus' });
      order.rem = 0; order.known = 'done';
      const tr = { t: this.now, px, q, side: order.side, mk: maker, tk: taker, venue: 'TRF', seq: 0 };
      maker.applyFill({ side: -order.side, agent: maker }, px, q, TRF, taker, 'maker');
      taker.applyFill(order, px, q, TRF, maker, 'taker');
      this.onTrade(TRF, tr); this.offEx.push(tr); if (this.offEx.length > 2000) this.offEx.splice(0, 1000);
    }
    raceLost(venue, o, rf) {
      const ag = o.agent;
      if (!ag.isHft && ag.cat !== 'mm') return;
      if (rf.by === ag) return;
      const gap = this.now - rf.t;
      ag.racesLost = (ag.racesLost || 0) + 1; rf.by.racesWon = (rf.by.racesWon || 0) + 1;
      this.lastRace = { t: this.now, winner: rf.by.name, loser: ag.name, gap, venue: venue.name };
      if (this.rand() < 0.25 || gap < 20) {
        this.addLog('race', `${rf.by.name} hit ${ag.name}'s stale ${o.side > 0 ? 'bid' : 'offer'} on ${venue.name} at ${this.fmtPx(rf.px)}. ${ag.name}'s cancel arrived ${this.fmtUs(gap)} too late.`, rf.by.cat);
      }
    }
    nbbo() {
      let bid = null, ask = null;
      for (const v of this.venues) {
        const b = v.bestBid(), a = v.bestAsk();
        if (b != null && (bid == null || b > bid)) bid = b;
        if (a != null && (ask == null || a < ask)) ask = a;
      }
      return { bid, ask, mid: bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask ?? this.F) };
    }
    // Price used to value positions: the mid when the market is orderly, fair value when the book is broken.
    markPx() {
      const nb = this.nbbo();
      if (nb.bid != null && nb.ask != null && (nb.ask - nb.bid) / nb.mid < 0.02) return nb.mid;
      return this.Vs;
    }
    sample() {
      const nb = this.nbbo();
      const s = { t: this.now, V: this.V, F: this.lastLeadPub, nb, venues: this.venues.map(v => {
        let d = 0; for (const p of v.bidPx.slice(0, 5)) d += v.visQty(v.bids.get(p)); for (const p of v.askPx.slice(0, 5)) d += v.visQty(v.asks.get(p));
        return { bid: v.bestBid(), ask: v.bestAsk(), mid: v.mid(), depth: d, queueUs: v.queueUs, halted: v.halted, band: v.band };
      }), msgs: this.counters.msgs, cancels: this.counters.cancels, trades: this.counters.trades, vol: this.exVol, off: this.offVol };
      if (this.sampleHook) this.sampleHook(s);
      this.samples.push(s); if (this.samples.length > 6000) this.samples.splice(0, 1000);
    }
    addLog(kind, text, cat) {
      const e = { t: this.now, kind, text, cat };
      this.logs.push(e); if (this.logs.length > 400) this.logs.splice(0, 200);
      for (const f of this.listeners.log) f(e);
    }
    agentByKey(k) { return this.agents.find(a => a.key === k); }
    newOrderId() { return ORDER_ID++; }
  }

  window.Engine = { Sim, Venue, Feed, linkUs, distKm, PIPS, SEC, makeRng };
})();
