// Page controller: main loop, controls, charts, panels, role play.
(function () {
  'use strict';
  const { CATS, PLACES, MEDIA, HARDWARE, P, AGENTS, EXPLAIN, SCENARIOS } = window.MM;
  const { linkUs, PIPS, SEC } = window.Engine;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const SCHEMA = { MarketMaker: 'mm', LatencyArb: 'arb', StatArb: 'stat', Anticipator: 'anticip', RebateCapture: 'rebate', Wholesaler: 'wholesale', Retail: 'retail', PlayerRetail: 'retail', Momentum: 'momentum', Fundamental: 'fund', Spoofer: 'spoof', Igniter: 'ignite', Stuffer: 'stuff', StubQuoter: 'stub', Institution: 'inst' };
  const LOCS = { us: ['carteret', 'mahwah', 'secaucus', 'manhattan', 'aurora', 'boston', 'ohio', 'london'], hk: ['tko', 'central', 'shatin', 'singapore', 'tokyo'] };
  const LINK_OPTS = ['crossconnect', 'mmwave', 'metrofiber', 'longfiber', 'microwave', 'subsea', 'internet'];
  const TH = window.Theme;
  const S = { region: 'us', speed: 1, paused: false, view: 'book', role: 'watch', impact: null, logFilter: 'all', open: new Set(), player: {}, results: [], vol: 1, skip: null, logQ: [], actual: null,
    uni: null, focus: null, clockBase: 0, rBase: 0, mapSel: null, mapMode: 'heat', tableSort: ['cap', -1] };
  let renderer = null, book = null, globe = null, net = null, mapv = null;

  // ---------------------------------------------------------------- formatting
  const cur = () => S.sim.region.currency;
  function money(x, sign = true) {
    const a = Math.abs(x), s = x < 0 ? '−' : sign && x > 0 ? '+' : '';
    const v = a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(a >= 100 ? 0 : 2);
    return s + cur() + v;
  }
  function fmtClock(us) {
    const t = 34200e6 + us, s = Math.floor(t / 1e6), frac = Math.floor(t % 1e6);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0'), mm = String(Math.floor(s / 60) % 60).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
    const f = String(frac).padStart(6, '0');
    return `${hh}:${mm}:${ss}.${f.slice(0, 3)} ${f.slice(3)}`;
  }
  const clk = us => fmtClock(S.clockBase + us); // market clock: continues when you switch the simulated stock
  const fmtUs = us => S.sim.fmtUs(us);
  const fmtSpan = us => us < 1e6 ? fmtUs(us) : us < 60e6 ? +(us / 1e6).toFixed(1) + ' s' : us < 3600e6 ? (us / 60e6).toFixed(us % 60e6 ? 1 : 0) + ' min' : (us / 3600e6).toFixed(us % 3600e6 ? 1 : 0) + ' h';
  const fmtShares = q => q >= 1e6 ? (q / 1e6).toFixed(2) + 'M' : q >= 1e4 ? (q / 1e3).toFixed(1) + 'k' : Math.round(q).toLocaleString();
  const fmtX = x => (x >= 10 ? Math.round(x).toLocaleString() : x.toFixed(x >= 1 ? 1 : 3)) + '×';

  // ---------------------------------------------------------------- graphics
  function initGfx() {
    const stage = $('stage');
    net = new window.NetView($('netCanvas'));
    net.onVenueClick = id => { setView('book'); if (book) { book.setVenue(id); buildVenueSeg(); } };
    mapv = new window.MapView($('mapCanvas'));
    mapv.onPick = t => selectStock(t);
    mapv.onOpen = t => simulateStock(t);
    if (!window.THREE) {
      stage.insertAdjacentHTML('beforeend', '<p class="muted" style="position:absolute;inset:auto 0 0 0;padding:20px">The 3D library didn’t load, so the 3D views are off. The simulation, charts and controls still work. Check your connection and reload.</p>');
      return;
    }
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    stage.prepend(renderer.domElement);
    book = new Viz.BookView(renderer.domElement, $('labels'));
    globe = new Viz.GlobeView(renderer.domElement, $('labels'));
    book.orbit.active = true;
    // click (not drag) on the book selects a price level and shows its queue
    let down = null;
    renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    renderer.domElement.addEventListener('pointerup', e => {
      if (!down || S.view !== 'book') return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), quick = performance.now() - down.t < 500; down = null;
      if (moved > 5 || !quick || e.button !== 0) return;
      const r = renderer.domElement.getBoundingClientRect();
      const px = book.pick((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      S.selOpen = px != null; renderQueue();
    });
    const resize = () => {
      const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false);
      for (const v of [book, globe]) { v.camera.aspect = w / Math.max(1, h); v.camera.updateProjectionMatrix(); }
      if (!book.orbit.manual) book.setCamera(TH.prefs.book.camera, true); // fit the chosen camera to the new stage shape
    };
    resize(); new ResizeObserver(resize).observe(stage);
  }

  // ---------------------------------------------------------------- simulation lifecycle
  // Start (or switch) the order-by-order simulation. keep = stay in the same market session and only change the stock.
  function newSim(region, ticker, keep) {
    const fresh = !keep || !S.uni || S.uni.region !== region || !S.sim;
    if (fresh) { S.uni = new window.Universe.Universe(region, 1 + Math.floor(Math.random() * 1e6)); S.clockBase = 0; S.rBase = 0; S.mapSel = null; }
    else { S.clockBase += S.sim.now; S.rBase += Math.log(S.sim.V / S.sim.startPx); } // carry the clock and the index move forward
    if (!ticker || !S.uni.get(ticker)) ticker = window.STOCKS.DEFAULT[region];
    S.uni.setFocus(ticker); S.focus = ticker;
    S.region = region; S.player = {}; S.results = []; S.impact = null;
    const sim = S.sim = buildSim(region, 7 + Math.floor(Math.random() * 100000), Object.assign({}, S.uni.get(ticker)));
    sim.clockBase = S.clockBase;
    sim.volMult = S.vol; S.skip = null; S.logQ = []; renderSkip();
    sim.sampleHook = s => {
      const r = sim.agentByKey('retail');
      s.rc = r && r.stats ? r.stats.costBps : 0; s.rn = r && r.stats ? r.stats.notional : 0;
      let hp = 0; for (const a of sim.agents) if (a.isHft) hp += a.pnl(); s.hftPnl = hp;
      const mm = sim.agentByKey('mmFast'); s.fair = mm && mm.enabled ? mm.leadFair() : null;
      let won = 0; for (const a of sim.agents) won += a.racesWon; s.races = won;
    };
    sim.listeners.log.push(addLog);
    setSampleEvery();
    if (book) book.attach(sim, sim.venues[sim.venues.length - 1].id);
    sim.recordFlows = S.view === 'net'; net.attach(sim); S.selOpen = false; renderQueue();
    for (const b of document.querySelectorAll('#regionSeg button')) b.setAttribute('aria-pressed', String(b.dataset.region === region));
    buildVenueSeg(); buildScenarios(); buildRules(); buildAgents(); buildRole(); buildLegend(); buildInset();
    $('log').innerHTML = ''; renderImpact(); setBanner('calm');
    if (globe && S.view === 'globe') globe.focus(region);
    buildSectorSel(); buildStockList(); buildStockPanel(); renderCard(); updateIndexBox();
    if (!fresh) sim.addLog('rule', `Now simulating ${ticker} (${sim.stock.name}) order by order, starting from its market price ${sim.fmtPx(sim.startPx)}. Its order book, participants and P&L start fresh; the market clock and the index carry on.`);
  }
  // Chart window: automatic (follows the speed) or chosen. Long windows use one sample per second.
  function chartWin() {
    const v = $('winSel').value, sp = S.speed;
    if (v === 'all') return Math.max(30e6, S.sim ? S.sim.now : 0);
    if (v !== 'auto') return Number(v) * 1e6;
    return sp === Infinity ? 1800e6 : sp >= 60 ? 600e6 : sp >= 20 ? 300e6 : sp >= 5 ? 120e6 : sp >= 1 ? 30e6 : clamp(30e6 * sp, 30e3, 30e6);
  }
  function setSampleEvery() {
    const win = chartWin();
    S.winUs = win; if (S.sim) S.sim.sampleEvery = Math.max(20, Math.min(win, 120e6) / 600);
    $('priceWin').textContent = $('winSel').value === 'all' ? `${fmtSpan(win)} since 09:30` : `last ${fmtSpan(win)}`;
  }

  // ---------------------------------------------------------------- main loop
  let last = performance.now(); const acc = { slice: 0, chart: 0, panel: 0 };
  // Some embedded viewers pause animation frames; a timer keeps the market running when that happens.
  setInterval(() => { if (performance.now() - last > 300) step(performance.now()); }, 100);
  function frame(ts) { step(ts); requestAnimationFrame(frame); }
  // Run the market for at most `ms` of real time, so the page stays responsive at any speed.
  function runFor(sim, target, ms) {
    const end = performance.now() + ms;
    do { if (sim.runTo(target, 3000)) return true; } while (performance.now() < end);
    return false;
  }
  const rate = { sim: 0, wall: 0 };
  function showRate() {
    const el = $('lag'), x = S.actual;
    if (S.paused || S.skip || x == null) { el.hidden = true; return; }
    if (S.speed === Infinity) { el.hidden = false; el.className = 'lag info'; el.textContent = `Max speed: ${fmtX(x)} real time`; return; }
    el.hidden = x >= S.speed * 0.85; el.className = 'lag';
    el.textContent = `Your computer can only run this at ${fmtX(x)}`;
  }
  function step(ts) {
    const gap = Math.max(0, (ts - last) / 1000); last = ts;
    const dt = Math.min(gap > 0.25 ? 0.5 : 0.1, gap); // the backup timer fires about every 0.3 s
    const sim = S.sim;
    if (S.skip) runSkip();
    else if (!S.paused) {
      const t0 = sim.now;
      runFor(sim, S.speed === Infinity ? Infinity : sim.now + dt * 1e6 * S.speed, S.speed >= 60 ? 70 : S.speed >= 20 ? 45 : 60);
      rate.sim += sim.now - t0; rate.wall += dt;
      if (rate.wall >= 0.5) { S.actual = rate.sim / 1e6 / rate.wall; rate.sim = rate.wall = 0; showRate(); }
    }
    advanceUniverse();
    flushLog();
    acc.slice += dt; acc.chart += dt; acc.panel += dt; acc.map = (acc.map || 0) + dt;
    if (renderer) {
      if (acc.slice >= 0.1) { acc.slice = 0; if (S.view === 'book' && !S.paused) book.pushSlice(); }
      const st = $('stage'), w = st.clientWidth, h = st.clientHeight;
      if (S.view === 'book' || S.view === 'globe') { const v = S.view === 'book' ? book : globe; v.update(dt, w, h); renderer.render(v.scene, v.camera); }
    }
    if (S.view === 'net') net.draw(dt, S.speed);
    if (S.view === 'map' && acc.map >= 0.1) { acc.map = 0; if (S.mapMode === 'heat') mapv.draw(S.uni, S.focus, S.mapSel); }
    if (acc.chart >= 0.25) { acc.chart = 0; drawPrice(); updateTiles(); updateTape(); if (S.selOpen && S.view === 'book') renderQueue(); }
    if (acc.panel >= 0.5) { acc.panel = 0; updatePnl(); updateAgentsLive(); updateRoleLive(); updateWinLose(); checkImpact(); updateStatus(); updateIndexBox(); refreshCards(); if (S.view === 'map' && S.mapMode === 'table') renderMapTable(); }
    $('clock').textContent = clk(sim.now);
  }

  // ---------------------------------------------------------------- metrics
  function metrics(t0, t1) {
    const ss = S.sim.samples.filter(s => s.t >= t0 && s.t <= t1);
    if (ss.length < 4) return null;
    let sp = 0, ns = 0, dep = 0, r2 = 0, q = 0;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      if (s.nb.bid != null && s.nb.ask != null && s.nb.ask > s.nb.bid) { sp += (s.nb.ask - s.nb.bid) / s.nb.mid * 1e4; ns++; }
      dep += s.venues.reduce((a, v) => a + v.depth, 0);
      q += Math.max(...s.venues.map(v => v.queueUs));
      if (i) { const r = Math.log(s.nb.mid / ss[i - 1].nb.mid); if (isFinite(r)) r2 += r * r; }
    }
    const a = ss[0], b = ss[ss.length - 1], dtS = Math.max(1e-6, (b.t - a.t) / SEC);
    const dTr = b.trades - a.trades, dOn = (b.vol || 0) - (a.vol || 0), dOff = (b.off || 0) - (a.off || 0);
    return {
      volume: (dOn + dOff) / dtS * 60, offShare: dOn + dOff > 0 ? dOff / (dOn + dOff) : 0,
      spread: ns ? sp / ns : null, depth: dep / ss.length, vol: Math.sqrt(r2 / dtS * 60) * 1e4,
      msgs: (b.msgs - a.msgs) / dtS, cpt: dTr > 0 ? (b.cancels - a.cancels) / dTr : null, queue: q / ss.length,
      retail: b.rn - a.rn > 0 ? (b.rc - a.rc) / (b.rn - a.rn) : null, hft: (b.hftPnl - a.hftPnl) / dtS * 60, races: b.races - a.races,
    };
  }
  function updateTiles() {
    const sim = S.sim, m = S.lastMetrics = metrics(sim.now - Math.min(S.winUs / 3, 60e6), sim.now) || {};
    const nb = sim.nbbo(), tick = sim.venues[0].tickAt(nb.mid);
    const inst = [S.player.inst, sim.agentByKey('inst')].find(a => a && a.parent);
    const sf = inst ? inst.shortfallBps() : null;
    const hftShare = sim.totalVolume ? sim.hftVolume / sim.totalVolume : 0;
    const qmax = Math.max(...sim.venues.map(v => v.queueUs));
    const T = [
      ['Spread', m.spread != null ? m.spread.toFixed(2) + ' bp' : '–', nb.bid != null && nb.ask != null ? `${((nb.ask - nb.bid) / tick).toFixed(0)} tick(s) now` : 'one side empty'],
      ['Volume', m.volume != null ? fmtShares(m.volume) + '/min' : '–', sim.regionId === 'us' && m.volume ? `shares; ${(m.offShare * 100).toFixed(0)}% off-exchange` : 'shares traded'],
      ['Visible depth', m.depth != null ? Math.round(m.depth).toLocaleString() : '–', 'shares, 5 levels each side'],
      ['Volatility', m.vol != null ? m.vol.toFixed(1) + ' bp' : '–', 'per minute'],
      ['Messages', m.msgs != null ? Math.round(m.msgs).toLocaleString() + '/s' : '–', m.cpt != null ? `${m.cpt.toFixed(0)} cancels per trade` : ''],
      ['Exchange queue', fmtUs(qmax), 'wait before matching'],
      ['HFT share', (hftShare * 100).toFixed(0) + '%', 'of volume since open'],
      ['Retail cost', m.retail != null ? m.retail.toFixed(2) + ' bp' : '–', 'vs mid price, per trade'],
      ['Institution', sf != null ? sf.toFixed(1) + ' bp' : '–', sf != null ? 'implementation shortfall' : 'no big order running'],
      ['Stale quotes hit', (sim.agents.reduce((a, x) => a + x.racesWon, 0)).toLocaleString(), 'latency races lost by makers'],
    ];
    $('tiles').innerHTML = T.map(([k, v, s]) => `<div class="tile"><span>${k}</span><b>${v}</b><small>${s}</small></div>`).join('');
  }

  // ---------------------------------------------------------------- price chart
  function drawPrice() {
    setSampleEvery();
    const c = $('priceChart'), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = 270;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = H * dpr; c.style.height = H + 'px'; }
    const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
    const C = TH.c, venueCol = id => id === 'NYSE' ? C.info : C.ink, offCol = CATS.wholesale.color;
    const sim = S.sim, t1 = sim.now, t0 = t1 - S.winUs, long = S.winUs > 150e6 && sim.coarse.length > 2;
    const L = 62, R = 8, T = 18, B = 20, VH = 40, PB = H - B - VH - 22; // PB = bottom of the price area; volume bars below
    let ss = (long ? sim.coarse : sim.samples).filter(s => s.t >= t0);
    const thin = Math.floor(ss.length / Math.max(1, W - L - R)); // about one point per pixel
    if (thin > 1) ss = ss.filter((s, i) => i % thin === 0 || i === ss.length - 1);
    const trades = long ? [] : sim.tape.filter(t => t.t >= t0);
    if (ss.length < 2) return;
    let lo = Infinity, hi = -Infinity;
    const use = v => { if (v != null && isFinite(v) && v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
    for (const s of ss) { use(s.nb.bid); use(s.nb.ask); use(s.fair); }
    const med = ss[ss.length - 1].nb.mid;
    for (const t of trades) if (Math.abs(t.px - med) / med < 0.5) use(t.px);
    if (!isFinite(lo)) return;
    const pad = Math.max((hi - lo) * 0.08, sim.venues[0].tickAt(med) * 2); lo -= pad; hi += pad;
    const X = t => L + (W - L - R) * (t - t0) / (t1 - t0), Y = p => T + (PB - T) * (1 - (p - lo) / (hi - lo));
    x.font = '11px "IBM Plex Mono", monospace'; x.textBaseline = 'middle';
    const tk = sim.venues[0].tickAt(med), step = Math.max(1, Math.ceil((hi - lo) / 4 / tk)) * tk; // gridlines on whole ticks
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      const y = Y(p);
      x.strokeStyle = C.grid; x.beginPath(); x.moveTo(L, y); x.lineTo(W - R, y); x.stroke();
      x.fillStyle = C.dim; x.textAlign = 'right'; x.fillText(sim.fmtPx(p), L - 6, y);
    }
    x.textAlign = 'center'; x.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const t = t0 + (t1 - t0) * i / 4;
      const lab = i === 4 ? 'now' : S.winUs >= 600e6 ? (t >= 0 ? clk(t).slice(0, 5) : '') : '−' + fmtSpan(t1 - t);
      x.fillText(lab, X(t), H - B + 4);
    }
    // halts and bands
    const dtS = long ? SEC * Math.max(1, thin) : sim.sampleEvery * Math.max(1, thin);
    for (let vi = 0; vi < sim.venues.length; vi++) {
      x.fillStyle = TH.alpha(C.down, 0.1);
      for (const s of ss) if (s.venues[vi].halted) x.fillRect(X(s.t), T, Math.max(1, (W - L - R) * dtS / (t1 - t0)), H - T - B);
      x.strokeStyle = TH.alpha(C.down, 0.6); x.setLineDash([4, 4]);
      for (const k of ['lo', 'hi']) { x.beginPath(); let on = false; for (const s of ss) { const b = s.venues[vi].band; if (b && b[k] > lo && b[k] < hi) { const px = X(s.t), py = Y(b[k]); on ? x.lineTo(px, py) : x.moveTo(px, py); on = true; } else on = false; } x.stroke(); }
      x.setLineDash([]);
    }
    // NBBO band
    x.fillStyle = TH.alpha(C.accent, 0.14); x.beginPath();
    const ok = ss.filter(s => s.nb.bid != null && s.nb.ask != null);
    ok.forEach((s, i) => { const px = X(s.t), py = Y(clamp(s.nb.ask, lo, hi)); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    [...ok].reverse().forEach(s => x.lineTo(X(s.t), Y(clamp(s.nb.bid, lo, hi)))); x.closePath(); x.fill();
    const line = (get, color, w = 1.4, dash) => {
      x.strokeStyle = color; x.lineWidth = w; x.setLineDash(dash || []); x.beginPath(); let on = false;
      for (const s of ss) { const v = get(s); if (v == null || !isFinite(v) || v <= lo || v >= hi) { on = false; continue; } const px = X(s.t), py = Y(v); on ? x.lineTo(px, py) : x.moveTo(px, py); on = true; }
      x.stroke(); x.setLineDash([]); x.lineWidth = 1;
    };
    sim.venues.forEach((v, i) => line(s => s.venues[i].mid, venueCol(v.id), 1.3));
    line(s => s.fair, C.fair, 1.2, [5, 3]);
    for (const t of trades) {
      if (t.px <= lo || t.px >= hi) continue;
      x.fillStyle = CATS[t.tk.cat].color; x.beginPath(); x.arc(X(t.t), Y(t.px), 1.6 + Math.min(5, Math.sqrt(t.q) / 18), 0, 7); x.fill();
      if (t.venue === 'TRF') { x.strokeStyle = C.stage; x.stroke(); }
    }
    // volume strip: shares traded per bar, on exchanges and (US) off-exchange at the wholesaler
    const nbk = Math.max(10, Math.min(60, Math.floor((W - L - R) / 7))), bw = (t1 - t0) / nbk;
    const on = new Float64Array(nbk), off = new Float64Array(nbk);
    for (let i = 1; i < ss.length; i++) {
      const a = ss[i - 1], b = ss[i]; if (a.vol == null || b.vol == null) continue;
      const k = Math.min(nbk - 1, Math.floor((b.t - t0) / bw)); if (k < 0) continue;
      on[k] += b.vol - a.vol; off[k] += b.off - a.off;
    }
    let vmax = 0; for (let k = 0; k < nbk; k++) vmax = Math.max(vmax, on[k] + off[k]);
    const VB = H - B - 2, pw = (W - L - R) / nbk;
    x.strokeStyle = C.grid2; x.beginPath(); x.moveTo(L, VB + 0.5); x.lineTo(W - R, VB + 0.5); x.stroke();
    if (vmax > 0) for (let k = 0; k < nbk; k++) {
      const h1 = on[k] / vmax * VH, h2 = off[k] / vmax * VH, bx = L + k * pw + 1, w = Math.max(1, pw - 2);
      x.fillStyle = TH.alpha(C.muted, 0.7); x.fillRect(bx, VB - h1, w, h1);
      x.fillStyle = TH.alpha(offCol, 0.6); x.fillRect(bx, VB - h1 - h2, w, h2);
    }
    x.textAlign = 'right'; x.textBaseline = 'top'; x.fillStyle = C.dim;
    x.fillText(vmax > 0 ? fmtShares(vmax) : '0', L - 6, VB - VH - 5);
    x.textAlign = 'left'; x.font = '11px "IBM Plex Sans Condensed", sans-serif';
    const vl = [`Volume per ${fmtSpan(bw)}`, ['Exchanges', TH.alpha(C.muted, 0.9)]];
    if (sim.regionId === 'us') vl.push(['Off-exchange (wholesaler)', TH.alpha(offCol, 0.85)]);
    const ly = VB - VH - 15;
    let vx = L + 2; x.fillStyle = C.muted; x.fillText(vl[0], vx, ly); vx += x.measureText(vl[0]).width + 12;
    for (const [n, col] of vl.slice(1)) { if (vx + x.measureText(n).width + 14 > W - R) break; x.fillStyle = col; x.fillRect(vx, ly + 3, 9, 7); x.fillStyle = C.muted; x.fillText(n, vx + 13, ly); vx += x.measureText(n).width + 24; }
    x.font = '11px "IBM Plex Mono", monospace';
    // legend
    x.textAlign = 'left'; x.textBaseline = 'middle'; let lx = L;
    const leg = [...sim.venues.map(v => [v.name, venueCol(v.id)]), ['Fair value (futures)', C.fair], ['Bid–ask', TH.alpha(C.accent, 0.6)]];
    if (!long) leg.push(['Trades', C.ink]);
    for (const [n, col] of leg) {
      if (lx + x.measureText(n).width + 16 > W - R) break;
      x.fillStyle = col; if (n === 'Trades') { x.beginPath(); x.arc(lx + 5, 9, 3, 0, 7); x.fill(); } else x.fillRect(lx, 7, 12, 3);
      x.fillStyle = C.muted; x.fillText(n, lx + 16, 9); lx += x.measureText(n).width + 28;
    }
  }

  // ---------------------------------------------------------------- P&L bars and winners
  function updatePnl() {
    const sim = S.sim;
    const rows = sim.agents.filter(a => a.enabled || a.fills > 0).map(a => [a, a.pnl()]).sort((a, b) => b[1] - a[1]);
    const mx = Math.max(1, ...rows.map(r => Math.abs(r[1])));
    $('pnlBars').innerHTML = rows.map(([a, v]) => {
      const w = Math.abs(v) / mx * 50, left = v >= 0 ? 50 : 50 - w;
      return `<div class="bar"><span class="nm" title="${esc(a.name)}"><i style="background:${CATS[a.cat].color}"></i>${esc(a.name)}</span>
        <span class="track"><span class="zero"></span><b style="left:${left}%;width:${w}%;background:${v >= 0 ? 'var(--good)' : 'var(--bad)'}"></b></span>
        <span class="v ${v >= 0 ? 'pos' : 'neg'}">${money(v)}</span></div>`;
    }).join('');
  }
  function updateWinLose() {
    const sim = S.sim, by = {};
    for (const a of sim.agents) { const k = a.cat; (by[k] = by[k] || { pnl: 0, n: 0 }); by[k].pnl += a.pnl(); by[k].n++; }
    const out = [];
    const line = (name, v, note) => out.push(`<div><span>${name}${note ? `<br><span class="dim" style="font-size:12px">${note}</span>` : ''}</span><b class="${v >= 0 ? 'pos' : 'neg'}">${money(v)}</b></div>`);
    let hft = 0; for (const a of sim.agents) if (a.isHft && a.cat !== 'wholesale' && a.cat !== 'manip') hft += a.pnl();
    line('HFT firms (makers, arbs, stat-arb)', hft);
    const r = sim.agentByKey('retail');
    if (r && r.stats) {
      const st = r.stats, cost = st.notional ? st.costBps / st.notional : 0, tot = st.viaWholesaler + st.viaExchange;
      line('Retail investors', r.pnl(), `paid ${cost.toFixed(2)} bp vs the mid per trade${tot && sim.regionId === 'us' ? `; ${(st.viaWholesaler / tot * 100).toFixed(0)}% filled off-exchange by the wholesaler` : ''}`);
    }
    const wh = sim.agentByKey('wholesale');
    if (wh) line('Wholesaler', wh.pnl(), `paid brokers ${money(wh.pfofPaid || 0, false)} for retail flow`);
    for (const inst of [sim.agentByKey('inst'), S.player.inst]) if (inst && inst.parent && inst.parent.filled) {
      const P2 = inst.parent, sf = inst.shortfallBps(), dollars = sf / 1e4 * P2.filled * P2.arrivalMid / PIPS;
      line(inst.name, -dollars, `shortfall ${sf.toFixed(1)} bp on ${P2.filled.toLocaleString()} shares (${P2.algo})`);
    }
    if (by.momentum) line('Momentum followers', by.momentum.pnl);
    if (by.fund) line('Fundamental fund', by.fund.pnl);
    if (by.manip && sim.agents.some(a => a.cat === 'manip' && (a.enabled || a.fills))) line('Manipulators', by.manip.pnl);
    let exch = 0, stamp = 0; for (const a of sim.agents) { exch += a.fees; stamp += a.stamp; }
    line('Exchanges (fees minus rebates)', exch);
    if (stamp) line('Hong Kong government (stamp duty)', stamp);
    if (sim.brokerPfof) line('Retail brokers (payment for order flow)', sim.brokerPfof);
    $('winlose').innerHTML = out.join('');
  }

  // ---------------------------------------------------------------- log
  const KIND_GROUP = { race: 'race', manip: 'manip', rule: 'rule', news: 'rule', inst: 'orders', detect: 'orders', wholesale: 'orders', withdraw: 'liquidity' };
  // Log lines are queued and drawn once per frame (at high speed hundreds arrive per frame).
  function addLog(e) { S.logQ.push(e); if (S.logQ.length > 400) S.logQ.splice(0, S.logQ.length - 150); }
  function flushLog() {
    if (!S.logQ.length) return;
    const q = S.logQ; S.logQ = [];
    const log = $('log'), frag = document.createDocumentFragment();
    for (let i = q.length - 1, n = 0; i >= 0 && n < 120; i--) {
      const e = q[i], g = KIND_GROUP[e.kind] || 'other';
      if (S.logFilter !== 'all' && S.logFilter !== g) continue;
      const el = document.createElement('div'), col = e.cat && CATS[e.cat] ? CATS[e.cat].color : TH.c.line2;
      el.innerHTML = `<time>${clk(e.t).slice(3, 12)}</time><p style="border-color:${col}">${esc(e.text)}</p>`;
      frag.appendChild(el); n++;
    }
    log.prepend(frag); while (log.children.length > 120) log.lastChild.remove();
  }
  function buildLogFilters() {
    const F = [['all', 'All'], ['race', 'Races'], ['liquidity', 'Liquidity'], ['orders', 'Big orders'], ['manip', 'Manipulation'], ['rule', 'Rules & news']];
    $('logFilters').innerHTML = F.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${k === S.logFilter}">${l}</button>`).join('');
    $('logFilters').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      S.logFilter = b.dataset.f; buildLogFilters(); $('log').innerHTML = '';
      for (const ev of S.sim.logs.slice(-120)) addLog(ev);
    };
  }

  // ---------------------------------------------------------------- impact card
  function startImpact(label) {
    const sim = S.sim, win = clamp(15e6 * Math.min(1, S.speed), 0.3e6, 15e6);
    const I = S.impact = { label, t0: sim.now, win, before: metrics(sim.now - win, sim.now), after: null };
    // measure "after" at that exact market time, so it also works when skipping ahead
    sim.at(I.t0 + I.win, () => { if (!I.after) { I.after = metrics(I.t0, I.t0 + I.win) || {}; if (S.impact === I) renderImpact(); } });
    renderImpact();
  }
  let impactTimer = null;
  function impactSoon(label) { clearTimeout(impactTimer); impactTimer = setTimeout(() => startImpact(label), 600); }
  function checkImpact() {
    const I = S.impact; if (!I || I.after) return;
    if (S.sim.now >= I.t0 + I.win) I.after = metrics(I.t0, I.t0 + I.win);
    renderImpact();
  }
  function renderImpact() {
    const I = S.impact, el = $('impact');
    if (!I) { el.innerHTML = '<p class="muted" style="margin:0">Turn a strategy on or off, change a rule, or run a scenario. This card compares the market before and after.</p>'; return; }
    if (!I.after) { const left = Math.max(0, I.t0 + I.win - S.sim.now); el.innerHTML = `<p style="margin:0"><b>${esc(I.label)}</b></p><p class="muted" style="margin:4px 0 0">Measuring the next ${fmtUs(I.win)} of trading… ${fmtUs(left)} to go.</p>`; return; }
    const b = I.before, a = I.after;
    const rows = [['Volume (shares)', 'volume', '/min', 0, 0], ['Spread', 'spread', ' bp', -1, 2], ['Visible depth', 'depth', '', 1, 0], ['Volatility', 'vol', ' bp/min', -1, 1], ['Messages', 'msgs', '/s', 0, 0], ['Exchange queue', 'queue', ' µs', -1, 1], ['Retail cost', 'retail', ' bp', -1, 2], ['HFT profit rate', 'hft', '/min', 0, 0], ['Stale quotes hit', 'races', '', 0, 0]];
    const cell = (v, u, d, money_) => v == null ? '–' : (money_ ? money(v) : (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(d))) + (money_ ? '' : u);
    el.innerHTML = `<p style="margin:0 0 6px"><b>${esc(I.label)}</b> <span class="dim">(${fmtUs(I.win)} before vs after)</span></p>
      <table class="impact"><tr><th></th><th>Before</th><th>After</th><th>Change</th></tr>${rows.map(([n, k, u, good, d]) => {
        const bv = b ? b[k] : null, av = a ? a[k] : null, isMoney = k === 'hft';
        let ch = '–', cls = '';
        if (bv != null && av != null) {
          const diff = av - bv; ch = (diff > 0 ? '+' : diff < 0 ? '−' : '') + (isMoney ? money(Math.abs(diff), false) : (Math.abs(diff) >= 1000 ? Math.round(Math.abs(diff)).toLocaleString() : Math.abs(diff).toFixed(d)));
          if (good && Math.abs(diff) > 1e-9) cls = (diff * good > 0) ? 'pos' : 'neg';
        }
        return `<tr><td>${n}</td><td>${cell(bv, u, d, isMoney)}</td><td>${cell(av, u, d, isMoney)}</td><td class="${cls}">${ch}</td></tr>`;
      }).join('')}</table>`;
  }

  // ---------------------------------------------------------------- top controls
  function buildVenueSeg() {
    const seg = $('venueSeg'), sim = S.sim;
    seg.innerHTML = sim.venues.map(v => `<button data-v="${v.id}" aria-pressed="${book && book.venue === v}">${v.name}</button>`).join('');
    seg.onclick = e => { const b = e.target.closest('button'); if (!b || !book) return; book.setVenue(b.dataset.v); S.selOpen = false; renderQueue(); buildVenueSeg(); };
  }
  function buildScenarios() {
    $('scenarioSel').innerHTML = SCENARIOS[S.region].map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
  }
  function setBanner(id) {
    const s = SCENARIOS[S.region].find(x => x.id === id);
    const st = S.sim.stock;
    $('bannerText').innerHTML = `${esc(s.label)}: ${esc(s.text)} <span class="dim">Simulating ${esc(st.ticker)} (${esc(st.name)}, a made-up ${esc(st.sectorName.toLowerCase())} stock) order by order.</span>`;
  }
  function applyScenario(id) {
    const sim = S.sim, A = k => sim.agentByKey(k);
    if (id === 'calm') { newSim(S.region, S.focus); setBanner('calm'); return; }
    setBanner(id);
    const label = 'Scenario: ' + SCENARIOS[S.region].find(x => x.id === id).label;
    startImpact(label);
    window.applyScenarioToSim(sim, id);
    if (id === 'race') { S.speed = 0.01; $('speedSel').value = '0.01'; setSampleEvery(); setView('globe'); if (globe) globe.focus('us'); }
    if ((id === 'flash' || id === 'flashLuld') && S.uni) marketCrash(id === 'flashLuld');
    buildRules(); buildAgents();
  }
  function setView(v) {
    S.view = v;
    for (const b of document.querySelectorAll('#viewSeg button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    $('venueSeg').hidden = v !== 'book'; $('focusSeg').hidden = v !== 'globe'; $('scaleCtl').hidden = v !== 'globe';
    $('netCanvas').hidden = v !== 'net'; $('flowFilters').hidden = v !== 'net';
    $('mapCtl').hidden = v !== 'map'; $('mapEvents').hidden = v !== 'map';
    $('mapCanvas').hidden = v !== 'map' || S.mapMode !== 'heat'; $('mapTable').hidden = v !== 'map' || S.mapMode !== 'table';
    $('stockCard').hidden = v !== 'map' || !S.mapSel;
    if (v === 'map' && S.mapMode === 'table') renderMapTable(true);
    if (renderer) renderer.domElement.style.visibility = v === 'net' || v === 'map' ? 'hidden' : 'visible';
    $('queuePanel').hidden = v !== 'book' || !S.selOpen;
    $('hint').textContent = v === 'book' ? 'Click a price to see its queue · drag to orbit · click then scroll (or pinch) to zoom · shift-drag to pan'
      : v === 'globe' ? 'Drag to orbit · click then scroll (or pinch) to zoom' : v === 'map' ? 'Click a stock for its profile · double-click to simulate it order by order'
      : 'Hover a dot to see a firm · click an exchange to open its order book';
    if (S.sim) { S.sim.recordFlows = v === 'net'; if (v === 'net') net.attach(S.sim); }
    if ((v === 'net' || v === 'map') && book) { book.labels.hideAll(); globe.labels.hideAll(); }
    $('legend').hidden = v !== 'book' || !S.keyOpen; $('keyBtn').hidden = v !== 'book'; $('inset').hidden = v !== 'globe' || !!S.insetHidden;
    $('viewBtn').hidden = v === 'globe' || v === 'map'; if (v === 'globe' || v === 'map') toggleViewPop(false); else if (!$('viewPop').hidden) renderViewPop();
    if (book) { book.orbit.active = v === 'book'; globe.orbit.active = v === 'globe'; (v === 'book' ? globe : book).labels.hideAll(); }
  }
  function buildLegend() {
    const C = TH.c, o = TH.prefs.book, cats = new Set(S.sim.agents.map(a => a.cat)); cats.add('you');
    const heatOn = o.color === 'heat' || (o.style === 'heatmap' && o.color !== 'side');
    let items = '';
    if (o.color === 'participant' && o.style !== 'heatmap') items += [...cats].map(c => `<span><i style="background:${CATS[c].color}"></i>${CATS[c].label}</span>`).join('');
    if (heatOn) items += '<span style="grid-column:1/-1"><i style="width:80px;background:linear-gradient(90deg,#0B2A55,#1E5FC2,#00B8D9,#FFD84D,#FFFFFF)"></i>Resting size: small → large</span>';
    else items += `<span><i style="background:${C.bid}"></i>Bids${o.color === 'participant' ? ' (history)' : ''}</span><span><i style="background:${C.ask}"></i>Asks${o.color === 'participant' ? ' (history)' : ''}</span>`;
    if (o.lines) items += `<span><i class="ln" style="background:${C.accent}"></i>Mid price</span><span><i class="ln" style="background:${C.fair}"></i>Fair value (futures)</span>`;
    $('legend').innerHTML = items;
  }
  function buildInset() {
    const us = S.region === 'us';
    const pts = us ? ['mahwah', 'secaucus', 'manhattan', 'carteret'] : ['tko', 'central', 'shatin'];
    const pairs = us ? [['carteret', 'mahwah', ['mmwave', 'metrofiber'], 'Nasdaq ↔ NYSE'], ['carteret', 'secaucus', ['metrofiber'], 'Nasdaq ↔ NY4'], ['secaucus', 'mahwah', ['metrofiber'], 'NY4 ↔ NYSE'], ['manhattan', 'carteret', ['metrofiber'], 'Manhattan → Nasdaq']]
      : [['central', 'tko', ['metrofiber'], 'Central → HKEX'], ['shatin', 'tko', ['internet'], 'Home → HKEX']];
    const lat0 = pts.reduce((a, k) => a + PLACES[k].lat, 0) / pts.length, lon0 = pts.reduce((a, k) => a + PLACES[k].lon, 0) / pts.length;
    const cosl = Math.cos(lat0 * Math.PI / 180);
    const lonSpan = Math.max(...pts.map(p => PLACES[p].lon)) - Math.min(...pts.map(p => PLACES[p].lon));
    const latSpan = Math.max(...pts.map(p => PLACES[p].lat)) - Math.min(...pts.map(p => PLACES[p].lat));
    const k = Math.min(200 / Math.max(1e-3, lonSpan * cosl), 120 / Math.max(1e-3, latSpan)), cx = 150, cy = 75;
    const xy = p => [cx + (PLACES[p].lon - lon0) * cosl * k, cy - (PLACES[p].lat - lat0) * k];
    const dist = (a, b) => window.Engine.distKm(PLACES[a], PLACES[b]);
    const mname = { mmwave: 'radio', metrofiber: 'fiber', internet: 'home internet', subsea: 'subsea', microwave: 'microwave', longfiber: 'fiber' };
    let svg = `<svg viewBox="0 0 300 150" role="img" aria-label="Map of ${us ? 'New Jersey' : 'Hong Kong'} data centers">`;
    for (const [a, b] of pairs) { const [x1, y1] = xy(a), [x2, y2] = xy(b); svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${TH.c.line2}" stroke-width="1.5"/>`; }
    const placed = [];
    for (const p of pts) {
      const [x, y] = xy(p), left = x < cx;
      let ty = y + 4; while (placed.some(q => Math.abs(q - ty) < 12)) ty += 12; placed.push(ty); // keep labels apart
      svg += `<circle cx="${x}" cy="${y}" r="4" fill="${PLACES[p].venue ? TH.c.node : TH.c.ink}"/><text class="nm" x="${left ? x - 8 : x + 8}" y="${ty}" text-anchor="${left ? 'end' : 'start'}">${esc(PLACES[p].name)}</text>`;
    }
    svg += '</svg>';
    const far = us ? [['aurora', 'carteret', ['microwave', 'longfiber'], 'Chicago → New Jersey'], ['london', 'carteret', ['subsea'], 'London → New Jersey'], ['tko', 'carteret', ['subsea'], 'Hong Kong → New Jersey']]
      : [['singapore', 'tko', ['subsea'], 'Singapore → HKEX'], ['tokyo', 'tko', ['subsea'], 'Tokyo → HKEX'], ['carteret', 'tko', ['subsea'], 'New Jersey → HKEX']];
    const rows = [...pairs, ...far].map(([a, b, ms, label]) => `<tr><td>${esc(label)}</td><td>${dist(a, b).toLocaleString(undefined, { maximumFractionDigits: 0 })} km</td><td>${ms.map(m => `${mname[m]} ${fmtUs(linkUs(a, b, m))}`).join('<br>')}</td></tr>`).join('');
    $('inset').innerHTML = `<h4 style="display:flex;justify-content:space-between;align-items:center">${us ? 'New Jersey data centers' : 'Hong Kong'} · one-way delay <button class="btn sm" type="button" id="insetHide">Hide</button></h4>${svg}<table class="res"><tbody>${rows}</tbody></table>`;
    $('insetHide').onclick = () => { S.insetHidden = true; $('inset').hidden = true; };
  }

  // ---------------------------------------------------------------- theme and view options
  function applyThemeEverywhere(c) {
    if (book) book.applyTheme(c);
    if (globe) globe.applyTheme(c);
    buildFlowFilters();
    if (S.sim) { buildLegend(); buildInset(); drawPrice(); tapeSig = ''; updateTape(); }
    $('themeSel').value = TH.prefs.theme; $('modeSel').value = TH.prefs.mode;
  }
  const VIEW_OPTS = {
    book: [
      ['camera', 'Camera', [['perspective', 'Perspective'], ['front', 'Front'], ['top', 'Top'], ['side', 'Side']]],
      ['style', 'Style', [['bars', '3D bars'], ['heatmap', 'Heatmap']]],
      ['color', 'Colour by', [['participant', 'Participant'], ['side', 'Bid / ask'], ['heat', 'Size']]],
      ['range', 'Price range', [[10, '±10 ticks'], [20, '±20'], [40, '±40']]],
      ['history', 'History', [[35, 'Short'], [70, 'Normal'], [120, 'Long']]],
      ['scale', 'Bar height', [['sqrt', '√ size'], ['linear', 'Linear'], ['log', 'Log']]],
    ],
    bookChecks: [['labels', 'Price labels'], ['lines', 'Mid and fair lines'], ['sparks', 'Trade sparks'], ['spin', 'Auto-rotate']],
    flow: [
      ['layout', 'Layout', [['schematic', 'Schematic'], ['latency', 'Latency map']]],
      ['particles', 'Messages', [['dots', 'Dots'], ['comets', 'Comets'], ['minimal', 'Minimal']]],
      ['density', 'Density', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]],
      ['color', 'Colour by', [['participant', 'Firm'], ['type', 'Message type']]],
    ],
    flowChecks: [['delays', 'Delay labels'], ['firms', 'Firms'], ['weight', 'Busy lines thicker'], ['captions', 'Place names']],
  };
  const VIEW_NOTES = {
    perspective: 'Drag to orbit, shift-drag to pan. Click a price to pull out its queue.',
    front: 'Front: today’s book as a depth profile, bids left and asks right.',
    top: 'Top: resting size over time as a heatmap. Time runs up the screen.',
    side: 'Side: how the size at each price changed over time.',
    schematic: 'Rough geography, not to scale. Labels give the real one-way delays.',
    latency: 'Distance from the exchange shows the one-way delay; the rings mark 100 µs, 1 ms, 10 ms and 100 ms.',
  };
  function renderViewPop() {
    const el = $('viewPop'), kind = S.view === 'net' ? 'flow' : 'book', p = TH.prefs[kind];
    const rows = VIEW_OPTS[kind].map(([k, label, opts]) => `<div class="vrow"><span class="lab">${label}</span><div class="seg" data-k="${k}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${p[k] === v}">${esc(l)}</button>`).join('')}</div></div>`).join('');
    const checks = VIEW_OPTS[kind + 'Checks'].map(([k, l]) => `<label><input type="checkbox" data-c="${k}" ${p[k] ? 'checked' : ''}>${esc(l)}</label>`).join('');
    el.innerHTML = `<div class="vh"><span>${kind === 'book' ? 'Order book view' : 'Order flow view'}</span><button class="btn sm" type="button" data-close>Close</button></div>
      <div class="vb">${rows}<div class="vrow"><span class="lab">Show</span><div class="vchecks">${checks}</div></div>
      <p class="vnote">${esc(VIEW_NOTES[kind === 'book' ? p.camera : p.layout] || '')}</p>
      <div class="row"><button class="btn sm" type="button" data-reset>Reset to defaults</button></div></div>`;
  }
  function setViewOpt(kind, k, v) {
    TH.setView(kind, k, v);
    if (kind === 'book' && book) { book.configure(TH.prefs.book); if (k === 'camera') book.setCamera(v); buildLegend(); }
    if (kind === 'flow') net.configure(TH.prefs.flow);
    if (!$('viewPop').hidden) renderViewPop();
  }
  function toggleViewPop(open) {
    const el = $('viewPop');
    if (open == null) open = el.hidden;
    if (S.view === 'globe' || S.view === 'map') open = false;
    el.hidden = !open; $('viewBtn').setAttribute('aria-expanded', String(open));
    if (open) renderViewPop();
  }

  // ---------------------------------------------------------------- time and sales
  const seenTape = new WeakSet();
  let tapeSig = '';
  function updateTape() {
    const sim = S.sim, tape = sim.tape, n = tape.length;
    const sig = n ? `${n}:${tape[n - 1].t}:${tape[n - 1].q}` : '0';
    if (sig === tapeSig) return;
    tapeSig = sig;
    const big = sim.regionId === 'hk' ? 20000 : 3000, rows = [];
    for (let i = n - 1; i >= 0 && rows.length < 60; i--) {
      const t = tape[i], fresh = !seenTape.has(t); seenTape.add(t);
      const v = t.venue === 'TRF' ? 'Off-exch' : sim.venueById[t.venue] ? sim.venueById[t.venue].name : t.venue;
      const cls = t.side > 0 ? 'pos' : 'neg';
      rows.push(`<tr class="${fresh && rows.length < 15 ? 'new' : ''}${t.q >= big ? ' big' : ''}"><td>${clk(t.t).slice(0, 12)}</td><td class="l">${esc(v)}</td><td class="${cls}">${(t.px / PIPS).toFixed(sim.rules.tick === 'us' && t.px % 10 ? 3 : sim.rules.tick === 'us' ? 2 : 3)}</td><td>${t.q.toLocaleString()}</td><td class="${cls}">${t.side > 0 ? 'BUY' : 'SELL'}</td><td class="l"><i class="cdot" style="background:${CATS[t.tk.cat].color}"></i>${esc(CATS[t.tk.cat].label)}</td></tr>`);
    }
    $('tape').innerHTML = `<table><thead><tr><th>Time</th><th class="l">Venue</th><th>Price</th><th>Size</th><th>Side</th><th class="l">Aggressor</th></tr></thead><tbody>${rows.join('') || '<tr><td class="l" colspan="6">No trades yet.</td></tr>'}</tbody></table>`;
  }

  // ---------------------------------------------------------------- status bar
  function updateStatus() {
    const sim = S.sim; if (!sim) return;
    const halted = sim.venues.filter(v => v.halted), vcm = sim.venues.some(v => v.band && v.band.kind === 'VCM');
    let st, cls;
    if (S.skip) { st = 'SKIPPING AHEAD'; cls = 'warnc'; }
    else if (S.paused) { st = 'PAUSED'; cls = 'warnc'; }
    else if (halted.length) { st = `TRADING PAUSE · ${halted.map(v => v.name.toUpperCase()).join(', ')}`; cls = 'badc'; }
    else if (vcm) { st = 'VCM COOLING-OFF'; cls = 'warnc'; }
    else { st = 'LIVE'; cls = 'ok'; }
    $('sbState').textContent = '● ' + st; $('sbState').className = cls;
    $('mktState').textContent = st; $('mktState').className = 'state' + (cls === 'badc' ? ' halt' : cls === 'warnc' ? ' paused' : '');
    $('sbRegion').innerHTML = `MKT <b>${sim.regionId === 'us' ? 'US · NYSE + NASDAQ' : 'HK · HKEX'}</b> · SIM <b>${esc(sim.stock.ticker)}</b>`;
    $('sbSpeed').innerHTML = `SPEED <b>${S.speed === Infinity ? 'MAX' : fmtX(S.speed)}</b>${S.actual != null && !S.paused ? ` · actual ${fmtX(S.actual)}` : ''}`;
    $('sbVol').innerHTML = `VOLUME <b>${fmtX(S.vol)}</b>`;
    const m = S.lastMetrics;
    $('sbMsgs').innerHTML = `MSG/S <b>${m && m.msgs != null ? Math.round(m.msgs).toLocaleString() : '–'}</b>`;
  }

  // ---------------------------------------------------------------- command line
  const SCN_ALIAS = { calm: 'calm', news: 'news', twap: 'instTwap', stealth: 'instStealth', flash: 'flash', luld: 'flashLuld', spoof: 'spoof', ignite: 'ignite', stuff: 'stuff', race: 'race', stamp: 'stamp', vcm: 'vcm' };
  const COMMANDS = [
    ['HELP', 'List all commands'],
    ['US', 'US market: NYSE and Nasdaq'], ['HK', 'Hong Kong market: HKEX'],
    ['BOOK', 'Show the 3D order book'], ['FLOW', 'Show the order-flow map'], ['GLOBE', 'Show the latency globe'], ['MAP', 'Show the market map of every stock'],
    ['ELCT', 'Type any ticker to see that stock’s profile'], ['SIM ELCT', 'Simulate a stock order by order'], ['SECTOR TECH -3', 'Sector news: move a sector by N%'],
    ['NEWS', 'Scenario: futures fall 0.8%'], ['TWAP', 'Scenario: institution sells in even slices'], ['STEALTH', 'Scenario: institution sells, randomized'],
    ['FLASH', 'Scenario: 2010 flash crash, no bands (US)'], ['LULD', 'Scenario: the same crash with LULD bands (US)'], ['SPOOF', 'Scenario: spoofing attack'],
    ['IGNITE', 'Scenario: momentum ignition (US)'], ['STUFF', 'Scenario: quote stuffing (US)'], ['RACE', 'Scenario: microwave vs fiber race (US)'],
    ['STAMP', 'Scenario: stamp duty exemption (HK)'], ['VCM', 'Scenario: volatility control mechanism (HK)'], ['CALM', 'Restart with a calm market'],
    ['SKIP 10', 'Skip ahead N minutes (SKIP 1H for an hour)'], ['SPEED 60', 'Speed: 1/1000, 1/100, 1/10, 1, 5, 20, 60 or MAX'], ['VOL 5', 'Volume: 0.25, 0.5, 1, 2, 5 or 10'],
    ['PAUSE', 'Pause the market'], ['PLAY', 'Resume'], ['RESTART', 'Restart the market'],
    ['TOP', 'Book camera: top-down heatmap'], ['FRONT', 'Book camera: depth profile'], ['SIDE', 'Book camera: from the side'], ['PERSP', 'Book camera: perspective'],
    ['HEATMAP', 'Book style: heatmap'], ['BARS', 'Book style: 3D bars'],
    ['LATENCY', 'Flow layout: latency map'], ['SCHEMATIC', 'Flow layout: schematic map'],
    ['THEME SLATE', 'Theme: TERMINAL or SLATE'], ['CVD', 'Colour-blind-safe colours on or off'],
  ];
  function runCommand(raw) {
    const s = raw.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!s) return null;
    const [c, a = ''] = s.split(' ');
    if (c === 'HELP' || c === '?') return 'help';
    if (c === 'US' || c === 'HK') { const r = c.toLowerCase(); if (S.region !== r) { newSim(r); if (globe) globe.focus(r); } return `Market: ${c === 'US' ? 'NYSE and Nasdaq' : 'HKEX'}`; }
    if (c === 'MAP') { setView('map'); return 'View: market map'; }
    if (c === 'SIM' && S.uni.get(a)) { simulateStock(a); setView('book'); return `Simulating ${a} order by order.`; }
    if (c === 'SECTOR') {
      const parts = s.split(' '), pct = parseFloat(parts[2]) / 100, key = Object.keys(window.STOCKS.SECTORS[S.region]).find(k => k.toUpperCase() === parts[1] || window.STOCKS.SECTORS[S.region][k].toUpperCase().startsWith(parts[1] || '?'));
      if (!key || !isFinite(pct)) return `Usage: SECTOR ${Object.keys(window.STOCKS.SECTORS[S.region]).join('|').toUpperCase()} -3`;
      sectorNews(key, pct); setView('map'); return `${window.STOCKS.SECTORS[S.region][key]}: ${pct > 0 ? '+' : ''}${(pct * 100).toFixed(1)}%.`;
    }
    if (S.uni && S.uni.get(c) && !a) { setView('map'); selectStock(c); return `${c}: ${S.uni.get(c).name}.`; }
    if (c === 'BOOK' || c === 'FLOW' || c === 'GLOBE') { const v = { BOOK: 'book', FLOW: 'net', GLOBE: 'globe' }[c]; setView(v); if (v === 'globe' && globe) globe.focus(S.region); return `View: ${c.toLowerCase()}`; }
    const scn = SCN_ALIAS[c.toLowerCase()];
    if (scn) {
      const sc = SCENARIOS[S.region].find(x => x.id === scn);
      if (!sc) return `${c} is not available in the ${S.region === 'us' ? 'US' : 'Hong Kong'} market.`;
      $('scenarioSel').value = scn; applyScenario(scn); return `Scenario: ${sc.label}`;
    }
    if (c === 'SKIP') {
      let m = parseFloat(a || '1'); if (/H$/.test(a)) m *= 60;
      if (!(m > 0) || m > 600) return 'Usage: SKIP 10 (minutes) or SKIP 1H.';
      if (S.skip) return 'Already skipping ahead.';
      startSkip(m * 60); return `Skipping ahead ${fmtSpan(m * 60e6)}.`;
    }
    if (c === 'SPEED') {
      const v = { MAX: 'max', '1/1000': '0.001', '1/100': '0.01', '1/10': '0.1' }[a] || String(parseFloat(a));
      const opt = [...$('speedSel').options].find(o => o.value === v);
      if (!opt) return 'Usage: SPEED 1/1000, 1/100, 1/10, 1, 5, 20, 60 or MAX.';
      $('speedSel').value = v; $('speedSel').dispatchEvent(new Event('change')); return `Speed: ${opt.textContent}.`;
    }
    if (c === 'VOL' || c === 'VOLUME') {
      const opt = [...$('volSel').options].find(o => o.value === String(parseFloat(a)));
      if (!opt) return 'Usage: VOL 0.25, 0.5, 1, 2, 5 or 10.';
      $('volSel').value = opt.value; $('volSel').dispatchEvent(new Event('change')); return `Volume: ${opt.textContent}.`;
    }
    if (c === 'PAUSE' || c === 'PLAY') { if (S.paused !== (c === 'PAUSE')) $('playBtn').click(); return c === 'PAUSE' ? 'Paused.' : 'Running.'; }
    if (c === 'RESTART') { newSim(S.region, S.focus); return 'Market restarted.'; }
    const cam = { TOP: 'top', FRONT: 'front', SIDE: 'side', PERSP: 'perspective', PERSPECTIVE: 'perspective' }[c];
    if (cam) { setView('book'); setViewOpt('book', 'camera', cam); return `Book camera: ${cam}.`; }
    if (c === 'HEATMAP' || c === 'BARS') {
      setView('book'); setViewOpt('book', 'style', c === 'HEATMAP' ? 'heatmap' : 'bars');
      if (c === 'HEATMAP' && TH.prefs.book.camera === 'perspective') setViewOpt('book', 'camera', 'top');
      return `Book style: ${c === 'HEATMAP' ? 'heatmap' : '3D bars'}.`;
    }
    if (c === 'LATENCY' || c === 'SCHEMATIC') { setView('net'); setViewOpt('flow', 'layout', c.toLowerCase()); return `Flow layout: ${c === 'LATENCY' ? 'latency map' : 'schematic'}.`; }
    if (c === 'THEME') { const t = a.toLowerCase(); if (!TH.THEMES[t]) return 'Usage: THEME TERMINAL or THEME SLATE.'; TH.set('theme', t); return `Theme: ${TH.THEMES[t].label}.`; }
    if (c === 'CVD' || c === 'COLORS' || c === 'COLOURS') {
      const on = a ? a === 'ON' || a === 'CVD' : TH.prefs.mode !== 'cvd';
      TH.set('mode', on ? 'cvd' : 'classic'); return on ? 'Colour-blind-safe colours on.' : 'Green and red colours.';
    }
    return `Unknown command "${raw.trim()}". Type HELP for the list.`;
  }
  function wireCommand() {
    const inp = $('cmd'), list = $('cmdList');
    let sel = -1, shown = [], msgTimer = null;
    const render = () => {
      const f = inp.value.trim().toUpperCase().split(' ')[0];
      shown = COMMANDS.filter(([c]) => !f || c.startsWith(f));
      if (!shown.length) { list.hidden = true; return; }
      sel = Math.min(sel, shown.length - 1);
      list.innerHTML = shown.map(([c, d], i) => `<div role="option" data-c="${c}" aria-selected="${i === sel}"><b>${c}</b><span>${esc(d)}</span></div>`).join('');
      list.hidden = false;
    };
    const say = msg => {
      list.innerHTML = `<div class="msg">${esc(msg)}</div>`; list.hidden = false;
      clearTimeout(msgTimer); msgTimer = setTimeout(() => { if (document.activeElement !== inp) list.hidden = true; }, 3500);
    };
    const run = txt => {
      const r = runCommand(txt);
      inp.value = ''; sel = -1;
      if (r === 'help') { inp.focus(); render(); return; }
      if (r) say(r); else list.hidden = true;
    };
    inp.addEventListener('input', () => { sel = -1; render(); });
    inp.addEventListener('focus', render);
    inp.addEventListener('blur', () => setTimeout(() => { if (!list.querySelector('.msg')) list.hidden = true; }, 150));
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) render(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length); render(); }
      else if (e.key === 'Escape') { list.hidden = true; inp.blur(); }
    });
    list.addEventListener('pointerdown', e => { const d = e.target.closest('[data-c]'); if (d) { e.preventDefault(); run(d.dataset.c); } });
    $('cmdForm').addEventListener('submit', e => { e.preventDefault(); run(sel >= 0 && shown[sel] ? shown[sel][0] : inp.value); });
  }

  // ---------------------------------------------------------------- the whole market
  // Every stock moves with the same index futures; the simulated stock's price comes from its order book.
  function advanceUniverse() {
    const sim = S.sim, U = S.uni; if (!U) return;
    const nb = sim.nbbo(), two = nb.bid != null && nb.ask != null && nb.ask - nb.bid < 0.02 * nb.mid;
    const px = two ? nb.mid : (sim.venues.find(v => v.lastPx) || {}).lastPx || sim.F;
    U.volMult = S.vol;
    U.advance(S.clockBase + sim.now, S.rBase + Math.log(sim.V / sim.startPx), { price: px / PIPS, volume: sim.exVol + sim.offVol });
  }
  const pct = (x, d = 2) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
  const ccy = () => (S.region === 'hk' ? 'HK$' : '$');
  const pxs = p => p.toFixed(p < 10 ? 3 : 2);
  function updateIndexBox() {
    const U = S.uni; if (!U) return;
    const cash = U.cash(), fut = U.futures(), b = U.breadth(), ch = cash / U.idx.base - 1, f = U.get(S.focus), fch = f.price / f.open - 1;
    $('idxBox').innerHTML = `<span><span class="k">${esc(U.idx.name)}</span><b>${cash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> <span class="${ch >= 0 ? 'pos' : 'neg'}">${pct(ch)}</span></span>
      <span title="Index futures lead; the stocks catch up"><span class="k">FUT</span><b>${fut.toFixed(1)}</b></span>
      <span title="Stocks up / down since the open"><span class="pos">▲${b.up}</span> <span class="neg">▼${b.dn}</span></span>
      <button class="simchip" id="simChip" type="button" title="The stock simulated order by order: click for its profile">SIM ${esc(f.ticker)} ${pxs(f.price)} <span class="${fch >= 0 ? 'pos' : 'neg'}">${pct(fch)}</span></button>`;
  }
  function buildSectorSel() { const S2 = window.STOCKS.SECTORS[S.region]; $('secSel').innerHTML = Object.entries(S2).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(''); }
  function buildStockList() { $('stockList').innerHTML = S.uni.stocks.map(s => `<option value="${s.ticker}">${esc(s.name)}</option>`).join(''); }
  function selectStock(t) {
    if (!S.uni.get(t)) return;
    S.mapSel = t; renderCard();
    if (S.view === 'map' && S.mapMode === 'table') renderMapTable(true);
  }
  function simulateStock(t) {
    if (!S.uni.get(t)) return;
    if (t !== S.focus) newSim(S.region, t, true);
    S.mapSel = t; renderCard();
  }
  // news
  function newsSize(s) { return Math.max(1, Math.round(2 * s.idioVol * 10) / 10) / 100; }
  function companyNews(t, p) {
    const s = S.uni.get(t), why = p > 0 ? 'good company news' : 'bad company news';
    if (t === S.focus) S.sim.companyNews(p, why);
    else { S.uni.stockNews(t, p); S.sim.addLog('news', `${t} (${s.name}): ${why}, ${pct(p, 1)} in value. Only ${t} moves; the index futures barely notice.`); }
    startImpact(`${t} ${why}`);
  }
  function sectorNews(key, p) {
    const name = window.STOCKS.SECTORS[S.region][key];
    S.uni.sectorNews(key, p);
    if (S.uni.get(S.focus).sector === key) S.sim.companyNews(p, `${name} sector news`);
    else S.sim.addLog('news', `${name} sector news: ${pct(p, 1)} for every stock in the sector (watch them move together on the market map).`);
    startImpact(`${name} sector ${pct(p, 1)}`);
  }
  function marketCrash(luld) {
    const v = S.uni.flashCrash(luld);
    S.sim.addLog('rule', luld ? 'Across the market, LULD bands stop any stock from trading more than 5–10% below its recent average, so the crash is capped everywhere.'
      : `Across the market there are no bands: liquidity vanishes in thinly traded stocks first, and ${v.join(' and ')} briefly trade near zero against stub quotes, as Accenture did on 6 May 2010.`);
  }
  // stock card (market map) and the simulated stock's panel
  function stockStatic(s, inPanel) {
    const d = window.Profiles.describeStock(s, S.uni), isFocus = s.ticker === S.focus, n = newsSize(s);
    return `<div class="sc-h"><div><div class="sc-t">${esc(s.ticker)}</div><div class="sc-n">${esc(s.name)}</div><div class="sc-s">${esc(s.sectorName)}${isFocus ? ' · simulated order by order' : ''}</div></div>${inPanel ? '' : '<button class="btn sm" type="button" data-close>Close</button>'}</div>
      <div class="sc-b"><div data-live></div><canvas class="spark" height="70" style="width:100%;height:70px"></canvas>
      <div class="row">${isFocus ? (inPanel ? '<button class="btn sm" type="button" data-map>Market map</button>' : '<span class="dim" style="font-size:12px">Being simulated order by order.</span>') : '<button class="btn primary sm" type="button" data-sim>Simulate order by order</button>'}
        <button class="btn sm" type="button" data-news="${n}">Good news +${(n * 100).toFixed(1)}%</button><button class="btn sm" type="button" data-news="${-n}">Bad news −${(n * 100).toFixed(1)}%</button></div>
      ${d.paragraphs.map(p => `<p class="sc-p">${p}</p>`).join('')}
      <ul class="sc-ul">${d.bullets.map(b => `<li>${b}</li>`).join('')}</ul>
      <p class="sc-est">A made-up company. Size, beta and volatility are illustrative. For stocks not being simulated, spread, volume and reaction speed are estimates from a simple model.</p></div>`;
  }
  function stockLive(s) {
    const isFocus = s.ticker === S.focus, ch = s.price / s.open - 1, U = S.uni, idxCh = U.futures() / U.idx.base - 1, c = ccy();
    let spread = s.spreadBp * (1 + 0.3 * Math.max(0, s.act - 1)), est = ' (est.)';
    if (isFocus) { const m = S.lastMetrics; if (m && m.spread != null) { spread = m.spread; est = ''; } }
    const cells = [['Market value', window.Profiles.big(s.cap * 1e9, s.region)], ['Index weight', (s.w * 100).toFixed(2) + '%'],
      ['Beta', s.beta.toFixed(2)], ['Own volatility', s.idioVol.toFixed(1) + '% / day'],
      ['Volume today' + (isFocus ? '' : ' (est.)'), window.Profiles.shares(s.vol)], ['Normal day', window.Profiles.shares(s.adv) + ' sh'],
      ['Tick', `${c}${s.tick < 0.01 ? s.tick.toFixed(3) : s.tick.toFixed(2)} (${s.tickBp.toFixed(2)} bp)`], ['Spread' + est, spread.toFixed(2) + ' bp'],
      ['Reacts to futures in', s.tau < 1 ? Math.round(s.tau * 1000) + ' ms' : s.tau.toFixed(0) + ' s'], ['HFT share (est.)', Math.round(s.hftShare) + '%'],
      ['Move vs index', pct(ch - s.beta * idxCh)], [s.region === 'hk' ? 'Board lot' : 'Retail interest', s.region === 'hk' ? s.lot.toLocaleString() + ' sh' : s.retail ? 'High' : 'Normal']];
    return `<div class="sc-px"><span>${c}${pxs(s.price)}</span><small class="${ch >= 0 ? 'pos' : 'neg'}">${pct(ch)}</small><small class="dim">day ${pxs(s.lo)}–${pxs(s.hi)}</small></div>
      <div class="sc-grid">${cells.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
  }
  // last 10 minutes: the stock vs what the index futures alone would imply (beta x index move)
  function sparkline(cv, s) {
    const U = S.uni, n = Math.min(600, U.hn + 1); if (n < 3 || !cv) return;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 70;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = H * dpr; }
    const x = cv.getContext('2d'), C = TH.c; x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
    const st = U.series(s.hist, n), fu = U.series(U.futHist, n);
    const a = Array.from(st, v => v / st[0] - 1), b = Array.from(fu, v => s.beta * (v / fu[0] - 1));
    let lo = Math.min(...a, ...b, 0), hi = Math.max(...a, ...b, 0); const pad = Math.max(1e-4, (hi - lo) * 0.1); lo -= pad; hi += pad;
    const X = i => 4 + (W - 8) * i / (n - 1), Y = v => 4 + (H - 18) * (1 - (v - lo) / (hi - lo));
    x.strokeStyle = C.grid2; x.beginPath(); x.moveTo(4, Y(0)); x.lineTo(W - 4, Y(0)); x.stroke();
    const line = (arr, col, dash) => { x.strokeStyle = col; x.lineWidth = 1.5; x.setLineDash(dash || []); x.beginPath(); arr.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v))); x.stroke(); x.setLineDash([]); x.lineWidth = 1; };
    line(b, C.fair, [4, 3]); line(a, C.ink);
    x.font = '10.5px "IBM Plex Sans Condensed", sans-serif'; x.textBaseline = 'bottom'; x.textAlign = 'left';
    x.fillStyle = C.ink; x.fillText(`${s.ticker} ${pct(a[a.length - 1])}`, 4, H - 1);
    x.fillStyle = C.fair; x.fillText(`index × beta ${pct(b[b.length - 1])}`, 90, H - 1);
    x.fillStyle = C.dim; x.textAlign = 'right'; x.fillText(`last ${n >= 60 ? Math.round(n / 60) + ' min' : n + ' s'}`, W - 4, H - 1);
  }
  function renderCard() {
    const el = $('stockCard'), s = S.mapSel && S.uni.get(S.mapSel);
    if (!s) { el.hidden = true; return; }
    el.innerHTML = stockStatic(s, false); el.hidden = S.view !== 'map'; refreshCards();
  }
  function buildStockPanel() {
    $('stockPanel').innerHTML = stockStatic(S.uni.get(S.focus), true);
    $('stockPanelWrap').querySelector('summary').textContent = `Simulated stock · ${S.focus}`;
    refreshCards();
  }
  function refreshCards() {
    if (!S.uni) return;
    for (const [el, t] of [[$('stockCard'), S.mapSel], [$('stockPanel'), S.focus]]) {
      if (!t || (el.id === 'stockCard' && el.hidden)) continue;
      const s = S.uni.get(t), live = el.querySelector('[data-live]'); if (!s || !live) continue;
      live.innerHTML = stockLive(s); sparkline(el.querySelector('canvas.spark'), s);
    }
  }
  function cardClick(e, t) {
    const b = e.target.closest('button'); if (!b || !t) return;
    if (b.hasAttribute('data-close')) { S.mapSel = null; renderCard(); if (S.mapMode === 'table') renderMapTable(true); }
    else if (b.hasAttribute('data-sim')) simulateStock(t);
    else if (b.hasAttribute('data-map')) { setView('map'); selectStock(t); }
    else if (b.dataset.news) companyNews(t, Number(b.dataset.news));
  }
  // table view of every stock
  const TCOLS = [
    ['ticker', 'Ticker', s => s.ticker, v => v, 'l'], ['name', 'Name', s => s.name, v => esc(v), 'l nm'], ['sector', 'Sector', s => s.sectorName, v => esc(v.split(' ')[0]), 'l nm'],
    ['price', 'Last', s => s.price, v => pxs(v)], ['chg', 'Chg', s => s.price / s.open - 1, v => `<span class="${v >= 0 ? 'pos' : 'neg'}">${pct(v)}</span>`],
    ['rel', 'Vs index', s => s.price / s.open - 1 - s.beta * (S.uni.futures() / S.uni.idx.base - 1), v => `<span class="${v >= 0 ? 'pos' : 'neg'}">${pct(v)}</span>`],
    ['beta', 'Beta', s => s.beta, v => v.toFixed(2)], ['tau', 'Reacts in', s => s.tau, v => v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(0) + ' s'],
    ['spread', 'Spread bp', s => s.spreadBp * (1 + 0.3 * Math.max(0, s.act - 1)), v => v.toFixed(2)], ['vol', 'Volume', s => s.vol, v => window.Profiles.shares(v)],
    ['cap', 'Mkt value', s => s.cap, v => window.Profiles.big(v * 1e9, S.region).replace(' trillion', 'T').replace(' billion', 'B')], ['hft', 'HFT %', s => s.hftShare, v => Math.round(v)],
  ];
  let tableSig = '';
  function renderMapTable(force) {
    const el = $('mapTable'); if (el.hidden && !force) return;
    const [k, dir] = S.tableSort, col = TCOLS.find(c => c[0] === k) || TCOLS[10];
    const rows = [...S.uni.stocks].sort((a, b) => { const x = col[2](a), y = col[2](b); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; });
    const head = `<thead><tr>${TCOLS.map(c => `<th data-k="${c[0]}" class="${(c[4] || '').split(' ')[0]}"${c[0] === k ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c[1]}${c[0] === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>`;
    const body = rows.map(s => `<tr data-t="${s.ticker}" class="${s.ticker === S.focus ? 'focus' : ''}${s.ticker === S.mapSel ? ' sel' : ''}">${TCOLS.map(c => `<td class="${c[4] || ''}">${c[3](c[2](s))}</td>`).join('')}</tr>`).join('');
    const sc = el.scrollTop; el.innerHTML = `<table>${head}<tbody>${body}</tbody></table>`; el.scrollTop = sc;
    void tableSig;
  }
  // full participant profile
  function openProfile(a) {
    const per = window.Profiles.person(a.key, S.region);
    if (!per) { openExplain(a.kind); return; }
    const fav = window.Profiles.favourites(a.key, S.uni.stocks, 8);
    $('mTitle').textContent = a.name;
    const rows = [['Who they are', per.who], ['What they trade', per.what], ['Why', per.why], ['How', per.how], ['Their risk', per.risk], ['Who it helps', per.helps], ['Who pays', per.hurts], ['In the real world', per.real], ['Legal status', per.legal]];
    $('mBody').className = 'prof';
    $('mBody').innerHTML = `<dd class="sc-s" style="margin:0">${esc(per.role)}</dd>` +
      rows.filter(r => r[1]).map(([t, v]) => `<dt>${t}</dt><dd class="${t === 'Legal status' && /illegal|banned/i.test(v) ? 'legal' : ''}">${esc(v)}</dd>`).join('') +
      (fav.length ? `<dt>Most active in (click to see the stock)</dt><dd><div class="chips">${fav.map(s => `<button class="chip" type="button" data-t="${s.ticker}" title="${esc(s.name)}">${s.ticker}</button>`).join('')}</div></dd>` : '') +
      `<dt>Speed and location</dt><dd class="lat">${latText(a)}</dd><dt>Right now, in ${esc(S.focus)}</dt><dd class="live" id="profLive"></dd>`;
    const live = () => { const el = $('profLive'); if (!el || $('modal').hidden) return; el.textContent = `${a.enabled ? '' : '(switched off) '}Position ${a.pos.toLocaleString()} shares · P&L ${money(a.pnl())} · ${a.fills.toLocaleString()} fills · ${a.msgs.toLocaleString()} messages${a.fills ? ` (${Math.round(a.msgs / a.fills)} per fill)` : ''} · stale-quote races won ${a.racesWon}, lost ${a.racesLost}`; setTimeout(live, 500); };
    $('modal').hidden = false; live(); $('mClose').focus();
  }

  // ---------------------------------------------------------------- skip ahead
  function startSkip(sec) {
    S.skip = { from: S.sim.now, to: S.sim.now + sec * SEC, sec, wall: performance.now() };
    renderSkip();
  }
  function runSkip() {
    if (runFor(S.sim, S.skip.to, 150)) finishSkip(false); else renderSkip();
  }
  function finishSkip(stopped) {
    const K = S.skip; if (!K) return;
    S.skip = null;
    const done = S.sim.now - K.from, took = (performance.now() - K.wall) / 1000;
    // show the stretch that was skipped on the chart
    const ws = $('winSel');
    if (ws.value === 'auto' && chartWin() < done) ws.value = done > 900e6 ? '3600' : done > 150e6 ? '600' : '120';
    setSampleEvery(); drawPrice(); updateTiles();
    renderSkip(`${stopped ? 'Stopped after' : 'Skipped'} ${fmtSpan(done)} of trading in ${took.toFixed(1)} s.`);
  }
  let skipMsgTimer = null;
  function renderSkip(msg) {
    const K = S.skip, el = $('skipInfo');
    for (const b of document.querySelectorAll('#skipCtl button')) b.disabled = !!K;
    clearTimeout(skipMsgTimer);
    if (K) {
      const f = clamp((S.sim.now - K.from) / (K.to - K.from), 0, 1);
      el.hidden = false; $('skipStop').hidden = false; $('skipBar').parentNode.hidden = false;
      $('skipBar').style.width = (f * 100).toFixed(1) + '%';
      $('skipTxt').textContent = `Skipping ahead… ${fmtSpan(S.sim.now - K.from)} of ${fmtSpan(K.to - K.from)}`;
      $('lag').hidden = true;
    } else if (msg) {
      el.hidden = false; $('skipStop').hidden = true; $('skipBar').parentNode.hidden = true; $('skipTxt').textContent = msg;
      skipMsgTimer = setTimeout(() => { el.hidden = true; }, 5000);
    } else el.hidden = true;
  }

  // ---------------------------------------------------------------- queue inspector
  function renderQueue() {
    const el = $('queuePanel');
    if (!book || !S.selOpen || S.view !== 'book') { el.hidden = true; return; }
    const qi = book.queueInfo();
    if (!qi) { el.hidden = true; return; }
    el.hidden = false;
    const sim = S.sim, now = sim.now;
    const vis = o => (o.display ? o.vis : o.rem);
    const tot = qi.orders.reduce((a, o) => a + vis(o), 0);
    let ahead = 0;
    const rows = qi.orders.map((o, i) => {
      const a = o.agent, mine = a.cat === 'you';
      const tags = [o.display ? `iceberg: shows ${o.display.toLocaleString()} of ${o.rem.toLocaleString()}` : '', o.fake ? 'fake: will cancel' : ''].filter(Boolean).join(' · ');
      const row = `<tr class="${mine ? 'you' : ''}"><td>${i + 1}</td><td style="text-align:left;white-space:normal;font-family:var(--cond)"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${CATS[a.cat].color};margin-right:5px"></i>${esc(a.name)}${tags ? `<br><span class="tag">${esc(tags)}</span>` : ''}</td><td>${vis(o).toLocaleString()}</td><td>${ahead.toLocaleString()}</td><td>${fmtUs(now - (o.restT || now))}</td></tr>`;
      ahead += vis(o); return row;
    }).join('');
    const mineIdx = qi.orders.findIndex(o => o.agent.cat === 'you');
    let mineTxt = '';
    if (mineIdx >= 0) { const before = qi.orders.slice(0, mineIdx).reduce((a, o) => a + vis(o), 0); mineTxt = `<p style="margin:4px 0;color:var(--accent);font-size:12.5px">Your order is #${mineIdx + 1} in line with ${before.toLocaleString()} shares ahead of it.</p>`; }
    el.innerHTML = `<h4><span>${esc(qi.venue.name)} · ${sim.fmtPx(qi.px)} · ${qi.side} queue</span><button class="btn sm" type="button" id="qClose">Close</button></h4>
      <p class="lat" style="margin:0">${qi.orders.length ? `${qi.orders.length} orders, ${tot.toLocaleString()} shares visible. A ${qi.side === 'bid' ? 'sell' : 'buy'} order at this price fills #1 first, then #2, and so on (price-time priority).` : 'No orders resting at this price right now. Click a price where there are bars.'}</p>
      ${mineTxt}${qi.orders.length ? `<div style="overflow-x:auto"><table class="res qtab"><thead><tr><th>#</th><th style="text-align:left">Owner</th><th>Shares</th><th>Ahead</th><th>Waited</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
    $('qClose').onclick = () => { S.selOpen = false; book.select(null); renderQueue(); };
  }
  function buildFlowFilters() {
    const C = TH.c, F = [['orders', 'Orders', C.ink], ['cancels', 'Cancels', C.muted], ['fills', 'Fills', C.up], ['acks', 'Acks', C.dim], ['md', 'Market data', C.info], ['lead', 'Futures ticks', C.fair]];
    $('flowFilters').innerHTML = F.map(([k, l, c]) => `<label><input type="checkbox" data-k="${k}" ${net.filters[k] ? 'checked' : ''}><i style="background:${c}"></i>${l}</label>`).join('') +
      '<button class="btn sm" type="button" id="flowNews" title="Futures drop 0.8%: watch the news travel and the race it starts">News shock</button>';
    $('flowNews').onclick = () => { startImpact('News: futures −0.8%'); S.sim.shock(-0.008); };
    $('flowFilters').onchange = e => { const k = e.target.dataset.k; if (k) net.filters[k] = e.target.checked; };
  }

  // ---------------------------------------------------------------- form helpers
  function slider(parent, o) {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    const d = document.createElement('div'); d.className = 'field';
    const fmt = o.fmt || (v => String(v));
    d.innerHTML = `<span><label for="${id}">${esc(o.label)}</label></span><div class="sl"><input id="${id}" type="range" min="${o.min}" max="${o.max}" step="${o.step}" value="${o.value}"><output>${fmt(o.value)}</output></div>${o.help ? `<small>${esc(o.help)}</small>` : ''}`;
    const inp = d.querySelector('input'), out = d.querySelector('output');
    inp.addEventListener('input', () => { const v = Number(inp.value); out.textContent = fmt(v); o.onInput(v); });
    parent.appendChild(d); return inp;
  }
  function toggle(parent, o) {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    const d = document.createElement('div'); d.className = 'field';
    d.innerHTML = `<label class="sw" for="${id}"><input id="${id}" type="checkbox" ${o.checked ? 'checked' : ''}> ${esc(o.label)}</label>${o.help ? `<small>${esc(o.help)}</small>` : ''}`;
    d.querySelector('input').addEventListener('change', e => o.onChange(e.target.checked));
    parent.appendChild(d);
  }
  function select(parent, o) {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    const d = document.createElement('div'); d.className = 'field';
    d.innerHTML = `<span><label for="${id}">${esc(o.label)}</label></span><select id="${id}">${o.options.map(([v, l]) => `<option value="${esc(v)}" ${v === o.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${o.help ? `<small>${esc(o.help)}</small>` : ''}`;
    d.querySelector('select').addEventListener('change', e => o.onChange(e.target.value));
    parent.appendChild(d); return d.querySelector('select');
  }

  // ---------------------------------------------------------------- market rules
  function buildRules() {
    const el = $('rulesPanel'), sim = S.sim, R = sim.rules; el.innerHTML = '';
    const p = document.createElement('p'); p.className = 'muted'; p.style.cssText = 'margin:0;font-size:12.5px'; p.textContent = sim.region.ruleText; el.appendChild(p);
    if (S.region === 'us') {
      toggle(el, { label: 'Limit Up–Limit Down bands', checked: R.bandOn, help: 'Blocks trades more than 5% from the 5-minute average; 15 s at the band pauses trading for 5 minutes.', onChange: v => { R.bandOn = v; startImpact(`LULD bands ${v ? 'on' : 'off'}`); } });
      toggle(el, { label: 'Allow stub quotes (pre-2010)', checked: R.stubOk, help: 'Placeholder quotes at $0.01 and $300.', onChange: v => { R.stubOk = v; sim.agentByKey('stub').setEnabled(v); buildAgents(); startImpact(`Stub quotes ${v ? 'allowed' : 'banned'}`); } });
      toggle(el, { label: 'Half-penny tick ($0.005)', checked: R.halfPenny, help: 'Smaller ticks: tighter spreads but shorter queues and more quote flicker.', onChange: v => { R.halfPenny = v; startImpact(`Tick size ${v ? '$0.005' : '$0.01'}`); } });
      slider(el, { label: 'Maker rebate ($ per share)', min: 0, max: 0.0035, step: 0.0001, value: -sim.venues[0].makerFee, fmt: v => '$' + v.toFixed(4), onInput: v => { for (const x of sim.venues) x.makerFee = -v; impactSoon(`Maker rebate $${v.toFixed(4)}`); } });
      slider(el, { label: 'Taker fee ($ per share)', min: 0, max: 0.003, step: 0.0001, value: sim.venues[0].takerFee, fmt: v => '$' + v.toFixed(4), help: 'Reg NMS caps this at $0.003.', onInput: v => { for (const x of sim.venues) x.takerFee = v; impactSoon(`Taker fee $${v.toFixed(4)}`); } });
      slider(el, { label: 'Consolidated feed (SIP) delay vs direct feeds', min: 0, max: 2000, step: 10, value: R.sipExtraUs, fmt: v => fmtUs(v), help: 'Retail apps and many brokers watch the slower consolidated feed.', onInput: v => { R.sipExtraUs = v; for (const a of sim.agents) a.rewire(); impactSoon(`SIP delay ${fmtUs(v)}`); } });
    } else {
      toggle(el, { label: 'Volatility Control Mechanism', checked: R.bandOn, help: 'A 5-minute band of ±10% after a sharp move.', onChange: v => { R.bandOn = v; startImpact(`VCM ${v ? 'on' : 'off'}`); } });
      slider(el, { label: 'Stamp duty (% of trade value, each side)', min: 0, max: 0.2, step: 0.01, value: R.stampBps / 100, fmt: v => v.toFixed(2) + '%', help: 'Set at 0.1% since November 2023 (0.13% before).', onInput: v => { R.stampBps = v * 100; impactSoon(`Stamp duty ${v.toFixed(2)}%`); } });
      toggle(el, { label: 'Stamp duty exemption for market makers', checked: sim.agents.some(a => a.kind === 'MarketMaker' && a.stampExempt), help: 'In reality available only for some ETF and structured-product market making.', onChange: v => { for (const a of sim.agents) if (a.kind === 'MarketMaker') a.stampExempt = v; startImpact(`Market maker stamp exemption ${v ? 'on' : 'off'}`); } });
    }
    const last = sim.venues[sim.venues.length - 1];
    slider(el, { label: `Speed bump on ${last.name} (IEX-style)`, min: 0, max: 1000, step: 10, value: last.speedBumpUs, fmt: v => fmtUs(v), help: 'IEX delays every incoming order by 350 µs using a coil of fiber.', onInput: v => { last.speedBumpUs = v; impactSoon(`${last.name} speed bump ${fmtUs(v)}`); } });
    slider(el, { label: 'Exchange capacity (messages per ms)', min: 20, max: 1000, step: 10, value: sim.venues[0].capacity, fmt: v => v.toFixed(0), onInput: v => { for (const x of sim.venues) x.capacity = v; impactSoon(`Exchange capacity ${v}/ms`); } });
    slider(el, { label: 'Index volatility (% per day)', min: 0.3, max: 6, step: 0.1, value: sim.region.dailyVolPct, fmt: v => v.toFixed(1) + '%', help: 'Moves every stock in the market through its beta.', onInput: v => { sim.sigmaPerUs = v / 100 / Math.sqrt(23400 * SEC); impactSoon(`Index volatility ${v.toFixed(1)}%/day`); } });
    slider(el, { label: `${sim.stock.ticker} company-specific volatility (% per day)`, min: 0.2, max: 8, step: 0.1, value: sim.stock.idioVol, fmt: v => v.toFixed(1) + '%', help: 'News about this company only. The futures can’t predict it.', onInput: v => { sim.idioSigmaPerUs = v / 100 / Math.sqrt(23400 * SEC); impactSoon(`${sim.stock.ticker} own volatility ${v.toFixed(1)}%/day`); } });
    slider(el, { label: 'News jumps per minute', min: 0, max: 6, step: 0.1, value: sim.jumpPerSec * 60, fmt: v => v.toFixed(1), onInput: v => { sim.jumpPerSec = v / 60; } });
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<button class="btn sm" type="button" data-s="-0.008">News: futures −0.8%</button><button class="btn sm" type="button" data-s="0.008">News: futures +0.8%</button>';
    row.onclick = e => { const b = e.target.closest('button'); if (!b) return; startImpact(b.textContent); sim.shock(Number(b.dataset.s)); };
    el.appendChild(row);
  }

  // ---------------------------------------------------------------- participants
  function latText(a) {
    const sim = S.sim, parts = [];
    if (a.leadMedium) {
      const me = a.leadLat(), best = Math.min(...sim.agents.filter(x => x.enabled && x.leadMedium && x !== a).map(x => x.leadLat()));
      parts.push(`Hears futures after ${fmtUs(me)}${isFinite(best) ? ` (fastest rival ${fmtUs(best)})` : ''}`);
    }
    for (const v of sim.venues) parts.push(`Order reaches ${v.name} in ${fmtUs(a.hwUs + a.latTo(v) + v.speedBumpUs)}`);
    if (a.sip) parts.push(`Sees prices on the consolidated feed, ${fmtUs(sim.rules.sipExtraUs)} slower than direct feeds`);
    return parts.join('<br>');
  }
  function buildAgents() {
    const el = $('agentsPanel'), sim = S.sim; el.innerHTML = '';
    const list = sim.agents.filter(a => a.kind !== 'PlayerRetail' && (a.kind !== 'Institution' || a.key === 'inst'));
    for (const a of list) {
      const d = document.createElement('div'); d.className = 'agent'; d.dataset.key = a.key;
      const open = S.open.has(a.key);
      d.innerHTML = `<div class="ahead"><span class="dot" style="background:${CATS[a.cat].color}"></span><span class="nm" title="${esc(a.name)}">${esc(a.name)}</span>
        <span class="pl" data-pl></span><button class="icon" type="button" data-x aria-label="How ${esc(a.name)} works">?</button>
        <label class="sw" title="On or off"><input type="checkbox" ${a.enabled ? 'checked' : ''} aria-label="${esc(a.name)} on"></label></div>
        ${window.Profiles.person(a.key, S.region) ? `<span class="role">${esc(window.Profiles.person(a.key, S.region).role)}</span>` : ''}
        <div class="adet" ${open ? '' : 'hidden'}></div>
        <button class="btn sm" type="button" data-more style="margin:6px 0 0 22px">${open ? 'Hide settings' : 'Settings'}</button>`;
      d.querySelector('input[type=checkbox]').addEventListener('change', e => {
        a.setEnabled(e.target.checked);
        if (a.kind === 'StubQuoter') sim.rules.stubOk = e.target.checked;
        startImpact(`${a.name} ${e.target.checked ? 'on' : 'off'}`);
      });
      d.querySelector('[data-x]').onclick = () => openProfile(a);
      d.querySelector('[data-more]').onclick = () => { if (S.open.has(a.key)) S.open.delete(a.key); else S.open.add(a.key); buildAgents(); };
      if (open) fillAgentDetail(d.querySelector('.adet'), a);
      el.appendChild(d);
    }
  }
  function fillAgentDetail(box, a) {
    const sim = S.sim;
    const lat = document.createElement('div'); lat.className = 'lat'; lat.innerHTML = latText(a); box.appendChild(lat);
    const refresh = () => { lat.innerHTML = latText(a); };
    if (a.kind !== 'Institution') {
      select(box, { label: 'Location', value: a.place, options: LOCS[S.region].map(k => [k, `${PLACES[k].name}, ${PLACES[k].area}`]), onChange: v => { a.place = v; a.rewire(); refresh(); startImpact(`${a.name} moved to ${PLACES[v].area}`); } });
      select(box, { label: 'Link to the exchanges', value: a.links[sim.venues[0].id], options: LINK_OPTS.map(m => [m, MEDIA[m].label]), help: 'Ignored when it sits in the exchange’s own building.', onChange: v => { for (const x of sim.venues) a.links[x.id] = v; a.rewire(); refresh(); startImpact(`${a.name} link: ${MEDIA[v].label}`); } });
      if (a.leadMedium !== undefined && ['MarketMaker', 'LatencyArb', 'StatArb', 'RebateCapture', 'Wholesaler', 'Anticipator', 'Spoofer', 'Igniter'].includes(a.kind))
        select(box, { label: 'Link from the futures market', value: a.leadMedium || 'none', options: [['none', 'Does not watch futures'], ...LINK_OPTS.map(m => [m, MEDIA[m].label])], onChange: v => { a.leadMedium = v === 'none' ? null : v; a.rewire(); refresh(); startImpact(`${a.name} futures link: ${v}`); } });
      select(box, { label: 'Hardware', value: a.hw, options: Object.entries(HARDWARE).map(([k, h]) => [k, `${h.label} (${fmtUs(h.us)})`]), onChange: v => { a.hw = v; refresh(); startImpact(`${a.name} hardware: ${HARDWARE[v].label}`); } });
    }
    for (const [key, label, min, max, step, help] of (P[SCHEMA[a.kind]] || [])) {
      if (a.p[key] === undefined) continue;
      slider(box, { label, min: Math.min(min, a.p[key]), max: Math.max(max, a.p[key] * 2), step, value: a.p[key], help, fmt: v => (step < 1 && step < 0.01 ? v.toFixed(4) : step < 1 ? v.toFixed(2) : v.toLocaleString()),
        onInput: v => { a.p[key] = v; impactSoon(`${a.name}: ${label} = ${v}`); } });
    }
    if (a.kind === 'Institution') { const p = document.createElement('p'); p.className = 'muted'; p.style.margin = '0'; p.textContent = 'Start its orders from the Scenario menu, or play as an institution yourself.'; box.appendChild(p); }
  }
  function updateAgentsLive() {
    for (const d of document.querySelectorAll('#agentsPanel .agent')) {
      const a = S.sim.agentByKey(d.dataset.key); if (!a) continue;
      const v = a.pnl(), el = d.querySelector('[data-pl]');
      el.textContent = a.enabled || a.fills ? money(v) : 'off'; el.className = 'pl ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim');
    }
  }
  function openExplain(kind) {
    const x = EXPLAIN[kind] || EXPLAIN.MarketMaker;
    $('mBody').className = '';
    $('mTitle').textContent = x.title;
    $('mBody').innerHTML = [['How it works', x.how], ['Who it helps', x.wins], ['Who pays', x.loses], ['In the real world', x.real], ['Legal status', x.legal]]
      .filter(r => r[1]).map(([t, v]) => `<dt>${t}</dt><dd class="${t === 'Legal status' && /illegal|banned|disruptive/i.test(v) ? 'legal' : ''}">${esc(v)}</dd>`).join('');
    $('modal').hidden = false; $('mClose').focus();
  }

  // ---------------------------------------------------------------- play as
  function buildRole() {
    const el = $('rolePanel');
    const roles = [['watch', 'Watch'], ['retail', 'Retail investor'], ['inst', 'Institution'], ['hft', 'Your HFT firm']];
    el.innerHTML = `<div class="seg" id="roleSeg" role="group" aria-label="Role">${roles.map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${k === S.role}">${l}</button>`).join('')}</div><div id="roleBody" class="pbody" style="padding:0"></div>`;
    el.querySelector('#roleSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.role = b.dataset.r; buildRole(); };
    const body = el.querySelector('#roleBody');
    ({ watch: roleWatch, retail: roleRetail, inst: roleInst, hft: roleHft })[S.role](body);
  }
  function roleWatch(b) {
    b.innerHTML = `<p class="muted" style="margin:0">Pick a scenario at the top and press Run, or switch strategies on and off below and watch the order book, the price chart and the "What your last change did" card. Slow the speed to 1/100 or 1/1000 to watch individual microsecond races in the event log. Use 60×, Max or Skip ahead to watch minutes or hours of trading, and Volume to make the market busier or quieter.</p>
      <p class="muted" style="margin:0">In the 3D view, each bar is the number of shares waiting at one price; time runs backwards into the screen. The front row is coloured by who placed the orders. Sparks are trades, coloured by who crossed the spread.</p>`;
  }
  function ensureAgent(slot, tpl) {
    const sim = S.sim;
    if (S.player[slot] && sim.agents.includes(S.player[slot])) return S.player[slot];
    const K = window.Agents.KINDS[tpl.kind], a = new K(sim, tpl);
    sim.agents.push(a); a.attach(); S.player[slot] = a; buildLegend();
    return a;
  }
  function roleRetail(b) {
    const us = S.region === 'us', sim = S.sim, lot = sim.rules.lot;
    b.innerHTML = `<p class="muted" style="margin:0">You trade from home through a broker app, ${us ? 'watching the consolidated feed' : 'connected to HKEX through your broker'}. ${us ? 'Your broker can send your order to a wholesaler, which fills it off-exchange and pays the broker, or straight to an exchange.' : 'Every trade pays 0.1% stamp duty.'}</p>
      <div class="row"><div class="field" style="width:8.5rem"><span><label for="rQty">Shares</label></span><input id="rQty" type="number" min="${lot}" step="${lot}" value="${us ? 100 : 1000}"></div>
      ${us ? '<div class="field" style="flex:1;min-width:10rem"><span><label for="rRoute">Route</label></span><select id="rRoute"><option value="1">Broker → wholesaler</option><option value="0">Broker → exchange</option></select></div>' : ''}</div>
      <div class="row"><button class="btn primary" type="button" data-side="1">Buy at market</button><button class="btn" type="button" data-side="-1">Sell at market</button></div>
      <div class="row"><div class="field" style="width:8.5rem"><span><label for="rPx">Limit price</label></span><input id="rPx" type="number" step="0.01"></div><button class="btn" type="button" data-lim="1">Buy limit</button><button class="btn" type="button" data-lim="-1">Sell limit</button></div>
      <div id="rMsg" class="muted" style="font-size:12.5px"></div>
      <div style="overflow-x:auto"><table class="res"><thead><tr><th>Order</th><th>Fill</th><th>vs screen</th><th>vs mid</th><th>Filled by</th></tr></thead><tbody id="rRes"></tbody></table></div>`;
    const player = ensureAgent('retail', { key: 'youRetail', kind: 'PlayerRetail', cat: 'you', name: 'You (retail)', place: us ? 'ohio' : 'shatin', hw: 'human', lead: null,
      link: Object.fromEntries(sim.venues.map(v => [v.id, 'internet'])), sip: us, on: true, p: { rate: 0, avgSize: 100, marketShare: 1, chase: 0, toWholesaler: 1 } });
    player.onPlayerFill = (o, px, q, venue, counter, cost) => {
      const slip = o.screenPx != null ? o.side * (px - o.screenPx) / o.screenPx * 1e4 : null;
      S.results.unshift({ side: o.side, q, px, slip, cost, where: venue.id === 'TRF' ? 'wholesaler (off-exchange)' : venue.name, who: CATS[counter.cat].label });
      S.results = S.results.slice(0, 12); renderResults();
    };
    const go = (side, market) => {
      const qty = Math.max(lot, Math.round(Number($('rQty').value) / lot) * lot);
      const nb = player.viewNbbo();
      if (nb.mid == null) { $('rMsg').textContent = 'Connecting to the market…'; return; }
      if (us) player.p.toWholesaler = Number($('rRoute').value);
      const px = market ? null : Math.round(Number($('rPx').value) * PIPS);
      if (!market && !(px > 0)) { $('rMsg').textContent = 'Enter a limit price first.'; return; }
      player.submit(side, qty, market, px, nb);
      if (!market && book) { // show the player's place in line
        const v = player.bestVenue(side);
        if (book.venue !== v) { book.setVenue(v.id); buildVenueSeg(); }
        setTimeout(() => { book.select(side > 0 ? v.roundDown(px) : v.roundUp(px)); S.selOpen = true; setView('book'); renderQueue(); }, 300);
      }
      $('rMsg').textContent = `Sent ${side > 0 ? 'buy' : 'sell'} ${qty.toLocaleString()} ${market ? 'at market' : 'limit ' + sim.fmtPx(px)}. Your screen showed ${sim.fmtPx(nb.bid)} / ${sim.fmtPx(nb.ask)}; it takes about ${fmtUs(linkUs(player.place, sim.venues[0].place, 'internet'))} to arrive.`;
    };
    b.querySelectorAll('[data-side]').forEach(x => x.onclick = () => go(Number(x.dataset.side), true));
    b.querySelectorAll('[data-lim]').forEach(x => x.onclick = () => go(Number(x.dataset.lim), false));
    const nb = player.viewNbbo(); if (nb.mid) $('rPx').value = (nb.mid / PIPS).toFixed(2);
    renderResults();
  }
  function renderResults() {
    const t = $('rRes'); if (!t) return;
    const sim = S.sim;
    t.innerHTML = S.results.map(r => `<tr><td>${r.side > 0 ? 'Buy' : 'Sell'} ${r.q.toLocaleString()}</td><td>${sim.fmtPx(r.px)}<br><span class="dim">${esc(r.where)}</span></td>
      <td class="${r.slip == null ? '' : r.slip > 0 ? 'neg' : 'pos'}">${r.slip == null ? '–' : (r.slip > 0 ? '+' : '') + r.slip.toFixed(1) + ' bp'}</td>
      <td class="${r.cost > 0 ? 'neg' : 'pos'}">${(r.cost > 0 ? '+' : '') + r.cost.toFixed(2)} bp</td><td style="text-align:left">${esc(r.who)}</td></tr>`).join('') ||
      '<tr><td colspan="5" class="dim">No trades yet. "vs screen" is how much worse (red) or better (green) you did than the price you saw.</td></tr>';
  }
  function roleInst(b) {
    const us = S.region === 'us';
    b.innerHTML = `<p class="muted" style="margin:0">You run a large order for a pension fund through a broker algorithm. Watch who trades against you and what it costs (implementation shortfall).</p>
      <div class="row"><div class="field"><span><label for="iSide">Side</label></span><select id="iSide"><option value="-1">Sell</option><option value="1">Buy</option></select></div>
      <div class="field" style="width:9rem"><span><label for="iQty">Shares</label></span><input id="iQty" type="number" value="${us ? 100000 : 300000}" step="1000"></div></div>
      <div class="row"><div class="field" style="flex:1"><span><label for="iAlgo">Algorithm</label></span><select id="iAlgo"><option value="TWAP">TWAP: equal slices, fixed interval</option><option value="VWAP">VWAP: follows market volume</option><option value="POV">POV: % of volume</option><option value="ICEBERG">Iceberg: passive, shows a little</option><option value="STEALTH">Stealth: random size, time, venue</option></select></div></div>
      <div class="row"><div class="field" style="width:7rem"><span><label for="iDur">Over (s)</label></span><input id="iDur" type="number" value="90" min="10" step="10"></div>
      <div class="field" style="width:7rem"><span><label for="iPov">POV %</label></span><input id="iPov" type="number" value="10" min="1" max="50"></div>
      <div class="field" style="width:8rem"><span><label for="iDisp">Iceberg shows</label></span><input id="iDisp" type="number" value="${us ? 2000 : 10000}" step="100"></div></div>
      <div class="row"><button class="btn primary" type="button" id="iGo">Start order</button><button class="btn" type="button" id="iStop">Stop</button></div>
      <div id="iLive"></div>`;
    const sim = S.sim;
    const me = ensureAgent('inst', { key: 'youInst', kind: 'Institution', cat: 'you', name: 'You (institution)', place: us ? 'secaucus' : 'central', hw: 'kbypass', lead: null,
      link: Object.fromEntries(sim.venues.map(v => [v.id, 'metrofiber'])), on: true, p: {} });
    $('iGo').onclick = () => {
      me.launch({ side: Number($('iSide').value), qty: Number($('iQty').value), algo: $('iAlgo').value, durationS: Number($('iDur').value), pov: Number($('iPov').value) / 100, display: Number($('iDisp').value) });
      startImpact(`You started a ${$('iAlgo').value} order`);
    };
    $('iStop').onclick = () => me.finish();
  }
  function roleHft(b) {
    const sim = S.sim, us = S.region === 'us';
    const kinds = [['MarketMaker', 'Market maker'], ['LatencyArb', 'Latency arbitrage'], ['StatArb', 'Imbalance stat-arb'], ...(us ? [['RebateCapture', 'Rebate capture']] : [])];
    S.hftCfg = S.hftCfg && S.hftCfg.region === S.region ? S.hftCfg : { region: S.region, kind: 'LatencyArb', place: us ? 'carteret' : 'tko', link: us ? 'mmwave' : 'crossconnect', lead: us ? 'microwave' : 'crossconnect', hw: 'kbypass' };
    const C = S.hftCfg;
    b.innerHTML = '<p class="muted" style="margin:0">Build a firm: pick a strategy, where your servers sit, how they connect, and what hardware runs them. Then launch it against the other firms.</p>';
    select(b, { label: 'Strategy', value: C.kind, options: kinds, onChange: v => { C.kind = v; } });
    select(b, { label: 'Server location', value: C.place, options: LOCS[S.region].map(k => [k, `${PLACES[k].name}, ${PLACES[k].area}`]), onChange: v => { C.place = v; } });
    select(b, { label: 'Link from the futures market', value: C.lead, options: LINK_OPTS.map(m => [m, MEDIA[m].label]), onChange: v => { C.lead = v; } });
    select(b, { label: 'Link to the exchanges', value: C.link, options: LINK_OPTS.map(m => [m, MEDIA[m].label]), onChange: v => { C.link = v; } });
    select(b, { label: 'Hardware', value: C.hw, options: Object.entries(HARDWARE).filter(([k]) => k !== 'human').map(([k, h]) => [k, `${h.label} (${fmtUs(h.us)})`]), onChange: v => { C.hw = v; } });
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<button class="btn primary" type="button">Launch my firm</button>';
    row.querySelector('button').onclick = () => {
      const old = S.player.hft;
      if (old) { old.setEnabled(false); sim.agents.splice(sim.agents.indexOf(old), 1); }
      const tplKey = { MarketMaker: 'mmFast', LatencyArb: 'arbMW', StatArb: 'stat', RebateCapture: 'rebate' }[C.kind];
      const base = AGENTS[S.region].find(t => t.key === tplKey);
      S.player.hft = null;
      ensureAgent('hft', { key: 'youHft', kind: C.kind, cat: 'you', name: 'Your firm', place: C.place, hw: C.hw, lead: C.lead, link: Object.fromEntries(sim.venues.map(v => [v.id, C.link])), on: true, p: window.scaleTemplate(base, sim.stock, S.region).p });
      S.open.add('youHft'); buildAgents(); buildRole();
      startImpact(`Your ${kinds.find(k => k[0] === C.kind)[1].toLowerCase()} firm launched`);
    };
    b.appendChild(row);
    const live = document.createElement('div'); live.id = 'hLive'; b.appendChild(live);
    if (S.player.hft) {
      const box = document.createElement('div'); box.className = 'adet'; box.style.paddingLeft = '0';
      const h = document.createElement('div'); h.innerHTML = '<span class="muted" style="font:600 12px var(--cond);text-transform:uppercase;letter-spacing:.06em">Your firm’s settings</span>';
      b.appendChild(h); b.appendChild(box); fillAgentDetail(box, S.player.hft);
    }
  }
  function updateRoleLive() {
    const sim = S.sim;
    if (S.role === 'inst' && $('iLive')) {
      const me = S.player.inst, P2 = me && me.parent;
      if (!P2) { $('iLive').innerHTML = ''; return; }
      const done = Math.min(1, P2.filled / P2.qty), sf = me.shortfallBps();
      const cps = Object.entries(P2.counter).sort((a, b) => b[1] - a[1]);
      const ant = sim.logs.some(e => e.kind === 'detect' && e.t >= P2.start);
      $('iLive').innerHTML = `<div class="prog"><b style="width:${(done * 100).toFixed(1)}%"></b></div>
        <p style="margin:6px 0 0;font-size:13px">${P2.filled.toLocaleString()} of ${P2.qty.toLocaleString()} shares ${P2.done ? '(finished)' : ''}. Arrival price ${sim.fmtPx(P2.arrivalMid)}, average ${P2.filled ? sim.fmtPx(P2.cost / P2.filled) : '–'}.</p>
        <p style="margin:2px 0 0;font-size:13px">Shortfall: <b class="${sf > 0 ? 'neg' : 'pos'}">${sf == null ? '–' : sf.toFixed(1) + ' bp'}</b>${ant ? ' · <span class="neg">an order-anticipation algo has spotted a pattern</span>' : ''}</p>
        <div class="bars" style="margin-top:6px">${cps.map(([c, q]) => `<div class="bar"><span class="nm"><i style="background:${CATS[c].color}"></i>${CATS[c].label}</span><span class="track"><b style="left:0;width:${(q / P2.filled * 100).toFixed(1)}%;background:${CATS[c].color}"></b></span><span class="v">${(q / P2.filled * 100).toFixed(0)}%</span></div>`).join('')}</div>`;
    }
    if (S.role === 'hft' && $('hLive')) {
      const me = S.player.hft;
      if (!me) { $('hLive').innerHTML = ''; return; }
      const v = me.pnl();
      $('hLive').innerHTML = `<div class="board" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <div class="tile"><span>Profit</span><b class="${v >= 0 ? 'pos' : 'neg'}">${money(v)}</b><small>fees ${money(-me.fees)}${me.stamp ? `, stamp ${money(-me.stamp)}` : ''}</small></div>
        <div class="tile"><span>Races</span><b>${me.racesWon} won · ${me.racesLost} lost</b><small>stale-quote races</small></div>
        <div class="tile"><span>Position</span><b>${me.pos.toLocaleString()}</b><small>${me.fills} fills</small></div>
        <div class="tile"><span>Messages</span><b>${me.msgs.toLocaleString()}</b><small>${me.fills ? (me.msgs / me.fills).toFixed(0) + ' per fill' : ''}</small></div></div>`;
    }
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $('regionSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; newSim(b.dataset.region); if (globe) globe.focus(b.dataset.region); };
    $('scenarioBtn').onclick = () => applyScenario($('scenarioSel').value);
    $('playBtn').onclick = () => { S.paused = !S.paused; $('playBtn').textContent = S.paused ? 'Play' : 'Pause'; $('playBtn').setAttribute('aria-label', S.paused ? 'Play' : 'Pause'); updateStatus(); };
    $('speedSel').onchange = e => { S.speed = e.target.value === 'max' ? Infinity : Number(e.target.value); S.actual = null; rate.sim = rate.wall = 0; showRate(); setSampleEvery(); };
    $('winSel').onchange = () => setSampleEvery();
    $('skipCtl').onclick = e => { const b = e.target.closest('button[data-skip]'); if (b && !S.skip) startSkip(Number(b.dataset.skip)); };
    $('skipStop').onclick = () => finishSkip(true);
    $('volSel').onchange = e => {
      S.vol = Number(e.target.value); S.sim.volMult = S.vol;
      const txt = e.target.selectedOptions[0].textContent;
      S.sim.addLog('rule', `Market volume set to ${txt}: retail investors and the fundamental fund now send orders ${S.vol}× as often as normal.`);
      startImpact(`Volume set to ${txt}`);
    };
    $('resetBtn').onclick = () => newSim(S.region, S.focus);
    $('viewSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; setView(b.dataset.view); if (b.dataset.view === 'globe' && globe) globe.focus(S.region); };
    $('focusSeg').onclick = e => { const b = e.target.closest('button'); if (!b || !globe) return; globe.focus(b.dataset.focus); for (const x of $('focusSeg').children) x.setAttribute('aria-pressed', String(x === b)); };
    $('scaleRange').oninput = e => { const v = Number(e.target.value); $('scaleOut').textContent = v.toFixed(2) + ' s'; if (globe) globe.setScale(v); };
    S.keyOpen = window.innerWidth > 900;
    $('keyBtn').setAttribute('aria-expanded', String(S.keyOpen));
    $('keyBtn').onclick = () => { S.keyOpen = !S.keyOpen; $('keyBtn').setAttribute('aria-expanded', String(S.keyOpen)); $('legend').hidden = !S.keyOpen || S.view !== 'book'; };
    $('mClose').onclick = () => { $('modal').hidden = true; };
    $('modal').onclick = e => { if (e.target === $('modal')) $('modal').hidden = true; };
    // keyboard: / command line, 1 2 3 views, V view options, Space pause, Esc closes menus
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $('modal').hidden = true; toggleViewPop(false); $('cmdList').hidden = true; }
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); $('cmd').focus(); }
      else if ('1234'.includes(e.key)) { const v = ['book', 'net', 'globe', 'map'][Number(e.key) - 1]; setView(v); if (v === 'globe' && globe) globe.focus(S.region); }
      else if (e.key === 'v' || e.key === 'V') toggleViewPop();
      else if (e.key === ' ' && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); $('playBtn').click(); }
    });
    $('viewBtn').onclick = () => toggleViewPop();
    $('viewPop').onclick = e => {
      const kind = S.view === 'net' ? 'flow' : 'book';
      if (e.target.closest('[data-close]')) { toggleViewPop(false); return; }
      if (e.target.closest('[data-reset]')) {
        TH.resetView(kind);
        if (kind === 'book' && book) { book.configure(TH.prefs.book); book.setCamera(TH.prefs.book.camera); buildLegend(); } else net.configure(TH.prefs.flow);
        renderViewPop(); return;
      }
      const b = e.target.closest('button[data-v]'); if (!b) return;
      const k = b.parentNode.dataset.k, cur = TH.prefs[kind][k];
      setViewOpt(kind, k, typeof cur === 'number' ? Number(b.dataset.v) : b.dataset.v);
    };
    $('viewPop').onchange = e => { const k = e.target.dataset.c; if (k) setViewOpt(S.view === 'net' ? 'flow' : 'book', k, e.target.checked); };
    document.addEventListener('pointerdown', e => { if (!$('viewPop').hidden && !e.target.closest('#viewPop, #viewBtn')) toggleViewPop(false); });
    $('themeSel').onchange = e => TH.set('theme', e.target.value);
    $('modeSel').onchange = e => TH.set('mode', e.target.value);
    wireCommand();
    $('mapModeSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.mapMode = b.dataset.m; for (const x of $('mapModeSeg').children) x.setAttribute('aria-pressed', String(x === b)); setView('map'); };
    $('mapColor').onchange = e => { mapv.opts.color = e.target.value; };
    $('mapSize').onchange = e => { mapv.opts.size = e.target.value; mapv.sig = ''; };
    $('mapFind').onchange = e => { const v = e.target.value.trim().toUpperCase(), st = S.uni.stocks.find(x => x.ticker === v || x.name.toUpperCase() === v || x.name.toUpperCase().startsWith(v)); if (st) selectStock(st.ticker); e.target.value = ''; };
    $('mapEvents').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.idx) { const p = Number(b.dataset.idx); startImpact(`Index news ${p > 0 ? '+' : ''}${(p * 100).toFixed(1)}%`); S.sim.shock(p); }
      if (b.dataset.sec) sectorNews($('secSel').value, Number(b.dataset.sec));
    };
    $('stockCard').onclick = e => cardClick(e, S.mapSel);
    $('stockPanel').onclick = e => cardClick(e, S.focus);
    $('mapTable').onclick = e => {
      const th = e.target.closest('th[data-k]');
      if (th) { const k = th.dataset.k; S.tableSort = [k, S.tableSort[0] === k ? -S.tableSort[1] : (k === 'ticker' || k === 'name' || k === 'sector' ? 1 : -1)]; renderMapTable(true); return; }
      const tr = e.target.closest('tr[data-t]'); if (tr) selectStock(tr.dataset.t);
    };
    $('mapTable').ondblclick = e => { const tr = e.target.closest('tr[data-t]'); if (tr) simulateStock(tr.dataset.t); };
    $('idxBox').onclick = e => { if (e.target.closest('#simChip')) { setView('map'); selectStock(S.focus); } };
    $('mBody').onclick = e => { const ch = e.target.closest('.chip[data-t]'); if (ch) { $('modal').hidden = true; setView('map'); selectStock(ch.dataset.t); } };
  }

  initGfx(); wire(); buildLogFilters(); buildFlowFilters(); newSim('us'); setView('book');
  TH.on(applyThemeEverywhere); $('themeSel').value = TH.prefs.theme; $('modeSel').value = TH.prefs.mode; updateStatus();
  window.MicrosecondMarket = { state: S, applyScenario, setView };
  requestAnimationFrame(frame);
})();
