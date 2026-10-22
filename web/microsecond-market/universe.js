// The whole market: every stock in the index, moving together.
// One stock at a time is simulated order by order (engine.js). The rest follow a lighter model driven by the same
// index futures: price = open x exp(beta x index move + sector move + company move), reached with a lag that depends
// on how heavily the stock is traded. Their spreads and volumes here are model estimates, not simulated orders.
(function () {
  'use strict';
  const { HK_BANDS } = window.MM;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const INDEX_VOL = { us: 1.3, hk: 1.5 };   // index daily volatility, % (matches config.js)
  const SECTOR_VOL = 0.5;                   // sector factor daily volatility, %
  const DAY_S = 23400;
  // reference stock the agent settings were tuned on: price, tick in bp, daily traded value, typical spread (bp)
  const REF = {
    us: { price: 100, tickBp: 1.0, adv: 3e9, spreadBp: 1.0, hft: [30, 25], tau: [3.0, 0.8, 0.15, 0.03] },
    hk: { price: 80, tickBp: 6.25, adv: 1.2e9, spreadBp: 3.0, hft: [15, 20], tau: [6.0, 1.6, 0.4, 0.08] },
  };
  const HIST = 1800; // one price per second for the last 30 minutes

  function tickOf(region, p) {
    if (region === 'us') return 0.01;
    for (const [lo, hi, t] of HK_BANDS) if (p > lo && p <= hi + 1e-9) return t;
    return 5;
  }
  // Derived trading characteristics of a stock (all estimates from size, price and popularity).
  function enrich(s0) {
    const s = Object.assign({}, s0), R = REF[s.region];
    s.idioVol = s0.idio; delete s.idio;          // the stock's own daily volatility, %
    const turnover = (s.cap >= 1000 ? 0.0045 : s.cap >= 200 ? 0.006 : s.cap >= 50 ? 0.008 : 0.011) * (s.retail ? 1.8 : 1) * (s.region === 'hk' ? 0.7 : 1);
    s.advN = s.cap * 1e9 * turnover;            // value traded per day
    s.adv = s.advN / s.price;                    // shares traded per day
    s.L = clamp(Math.sqrt(s.advN / R.adv), 0.2, 3.5); // liquidity relative to the reference stock
    s.tier = s.L >= 1.5 ? 4 : s.L >= 0.8 ? 3 : s.L >= 0.45 ? 2 : 1;
    s.tick = tickOf(s.region, s.price); s.tickBp = s.tick / s.price * 1e4;
    s.spreadTicks = Math.max(1, Math.round(R.spreadBp / s.L / s.tickBp));
    s.spreadBp = s.spreadTicks * s.tickBp;
    s.hftShare = R.hft[0] + R.hft[1] * Math.min(1, s.L / 2);
    s.tau = R.tau[s.tier - 1];                   // seconds to absorb a futures move
    s.fragility = 1 / Math.pow(s.L, 0.7);
    s.sizeScale = s.L * R.price / s.price;       // share sizes relative to the reference stock
    s.tickK = R.tickBp / s.tickBp;               // tick-denominated settings relative to the reference stock
    s.totalVol = Math.sqrt((s.beta * INDEX_VOL[s.region]) ** 2 + s.idioVol ** 2);
    s.sectorName = window.STOCKS.SECTORS[s.region][s.sector];
    return s;
  }
  function stockInfo(region, ticker) { const s = window.STOCKS.list[region].find(x => x.ticker === ticker); return s ? enrich(s) : null; }

  function rng(seed) {
    let a = seed >>> 0;
    const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    f.gauss = () => { let u = 0; while (!u) u = f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * f()); };
    return f;
  }

  class Universe {
    constructor(region, seed = 1) {
      this.region = region; this.rand = rng(seed * 7919 + 13);
      this.idx = window.STOCKS.INDEX[region];
      this.stocks = window.STOCKS.list[region].map(enrich);
      this.by = new Map(this.stocks.map(s => [s.ticker, s]));
      const capTot = this.stocks.reduce((a, s) => a + s.cap, 0);
      for (const s of this.stocks) {
        Object.assign(s, { w: s.cap / capTot, p0: s.price, open: s.price, hi: s.price, lo: s.price, idio: 0, disl: 0, vol: 0, act: 1, volBase: 0,
          hist: new Float32Array(HIST).fill(s.price), vcm: null });
      }
      this.sectors = {}; for (const k of Object.keys(window.STOCKS.SECTORS[region])) this.sectors[k] = 0;
      this.t = 0; this.r = 0; this.sec = 0; this.hn = 0; this.crash = null;
      this.futHist = new Float32Array(HIST).fill(this.idx.base); this.cashHist = new Float32Array(HIST).fill(this.idx.base);
      this.focus = null;
    }
    get(t) { return this.by.get(t); }
    futures() { return this.idx.base * Math.exp(this.r); }
    cash() { let x = 0; for (const s of this.stocks) x += s.w * s.price / s.p0; return this.idx.base * x; }
    breadth() { let up = 0, dn = 0; for (const s of this.stocks) { if (s.price > s.open * 1.00005) up++; else if (s.price < s.open * 0.99995) dn++; } return { up, dn }; }
    // A stock becomes the order-by-order simulation: its price now comes from the engine.
    setFocus(ticker) {
      if (this.focus) this.release(this.focus);
      const s = this.get(ticker); this.focus = ticker; s.volBase = s.vol;
    }
    // Hand a stock back to the model at its last simulated price, without a jump.
    release(ticker) {
      const s = this.get(ticker); if (!s) return;
      s.idio = Math.log(s.price / s.p0) - s.beta * this.r - this.sectors[s.sector] - s.disl;
      if (this.focus === ticker) this.focus = null;
    }
    // Move the market forward to time t (µs since the open) with index futures log return r.
    // focus = { price, volume } for the simulated stock.
    advance(t, r, focus) {
      const dtAll = (t - this.t) / 1e6;
      if (!(dtAll > 0)) { this.r = r; return; }
      const steps = Math.min(240, Math.max(1, Math.ceil(dtAll / 1))), h = dtAll / steps, sq = Math.sqrt(h / DAY_S);
      const r0 = this.r, fs = this.focus ? this.get(this.focus) : null;
      for (let k = 1; k <= steps; k++) {
        const tk = this.t + h * 1e6, rk = r0 + (r - r0) * k / steps;
        for (const key in this.sectors) this.sectors[key] += SECTOR_VOL / 100 * sq * this.rand.gauss();
        const a = 1 - Math.exp(-h / 1); // smoothing for the activity measure
        for (const s of this.stocks) {
          const before = s.price;
          if (s === fs && focus) s.price = focus.price;
          else {
            s.idio += s.idioVol / 100 * sq * this.rand.gauss(); // company-specific random walk (log)
            s.disl = this.dislocation(s, tk);
            const target = s.p0 * Math.exp(s.beta * rk + this.sectors[s.sector] + s.idio + s.disl);
            s.price += (target - s.price) * (1 - Math.exp(-h / s.tau));
            this.vcmCheck(s, tk);
          }
          if (s.price > s.hi) s.hi = s.price; if (s.price < s.lo) s.lo = s.price;
          // volume estimate: normal pace, faster when the price is moving
          const m = Math.abs(Math.log(s.price / before)) / (s.totalVol / 100 * sq + 1e-12);
          s.act += a * (Math.min(6, m) - s.act);
          if (s === fs && focus) s.vol = s.volBase + focus.volume;
          else s.vol += s.adv / DAY_S * h * (this.volMult || 1) * (0.55 + 0.45 * Math.min(5, m));
        }
        this.t = tk; this.r = rk;
        while (this.t >= (this.sec + 1) * 1e6) { // one history point per second
          this.sec++; const i = this.sec % HIST;
          for (const s of this.stocks) s.hist[i] = s.price;
          this.futHist[i] = this.futures(); this.cashHist[i] = this.cash(); this.hn = Math.min(HIST, this.hn + 1);
        }
      }
    }
    // last n seconds of history (oldest first)
    series(arr, n) { n = Math.min(n, this.hn + 1); const out = new Float32Array(n); for (let j = 0; j < n; j++) out[j] = arr[(this.sec - n + 1 + j + HIST * 4) % HIST]; return out; }
    // ---- events ----
    sectorNews(sector, pct) { this.sectors[sector] += Math.log(1 + pct); }
    stockNews(ticker, pct) { const s = this.get(ticker); if (s) s.idio += Math.log(1 + pct); }
    // Flash crash: a temporary liquidity hole, deepest in thinly traded stocks. With LULD bands, no stock can fall
    // more than its band; without them a few of the thinnest stocks briefly trade near zero against stub quotes.
    flashCrash(luld) {
      const victims = luld ? [] : [...this.stocks].filter(s => s.ticker !== this.focus).sort((p, q) => q.fragility - p.fragility).slice(0, 2).map(s => s.ticker);
      this.crash = { t0: this.t, luld, victims };
      return victims;
    }
    dislocation(s, t) {
      const C = this.crash; if (!C) return 0;
      const x = (t - C.t0) / 1e6; if (x < 0) return 0;
      const shape = x < 40 ? x / 40 : x < 100 ? 1 : Math.exp(-(x - 100) / 180);
      if (shape < 1e-4) { if (x > 600) this.crash = null; return 0; }
      let d = -0.06 * s.fragility * shape;
      if (C.victims.includes(s.ticker) && x > 45 && x < 65) d = Math.log(0.05); // a print against a stub quote
      if (C.luld) d = Math.max(d, Math.log(1 - (s.tier >= 3 ? 0.05 : 0.10)));
      return d;
    }
    // Hong Kong Volatility Control Mechanism: a ±10% band for 5 minutes, at most once per session.
    vcmCheck(s, t) {
      if (this.region !== 'hk') return;
      const ref = s.hist[(this.sec - 300 + HIST * 4) % HIST] || s.open;
      if (s.vcm && t > s.vcm.until) { s.vcm.done = true; }
      if (!s.vcm && Math.abs(s.price / ref - 1) > 0.10) s.vcm = { until: t + 300e6, lo: ref * 0.9, hi: ref * 1.1 };
      if (s.vcm && !s.vcm.done) s.price = clamp(s.price, s.vcm.lo, s.vcm.hi);
    }
  }
  window.Universe = { Universe, enrich, stockInfo, tickOf, INDEX_VOL, REF };
})();
