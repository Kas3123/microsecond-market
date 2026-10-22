// Builds the order-by-order simulation of one stock. Shared by the page and the headless tests.
// Agent settings in config.js were tuned on a reference stock (US$100 or HK$80, average liquidity); here they are
// scaled to the chosen stock: share sizes by liquidity and price, tick-based settings by the tick's size in bp.
(function () {
  'use strict';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const SIZE_KEYS = new Set(['size', 'maxInv', 'maxSize', 'maxPos', 'hedgeAt', 'spoofSize', 'realSize', 'burst']);

  function scaleTemplate(tpl, st, regionId) {
    const t = JSON.parse(JSON.stringify(tpl)), p = t.p, lot = st.lot || 1, k = st.tickK, R = window.Universe.REF[regionId];
    const roundLot = q => Math.max(lot, Math.round(q / lot) * lot);
    for (const key of Object.keys(p)) if (SIZE_KEYS.has(key)) p[key] = roundLot(p[key] * st.sizeScale);
    const ticks = (x, min) => Math.max(min, Math.round(x * k * 2) / 2);
    if (t.kind === 'Retail') {
      p.avgSize = roundLot(p.avgSize * R.price / st.price);     // a retail order is about the same amount of money
      p.rate *= (st.retail ? 2.2 : 1) * Math.sqrt(clamp(st.L, 0.3, 3));
      if (st.retail) p.chase = 0.5;
    }
    if (t.kind === 'Fundamental') { p.threshold = Math.max(1, Math.round(p.threshold * k)); p.noiseTicks = Math.max(1, Math.round(p.noiseTicks * k)); }
    if (t.kind === 'Momentum') p.triggerTicks = Math.max(1, Math.round(p.triggerTicks * k));
    if (t.kind === 'RebateCapture') p.cancelTicks = ticks(p.cancelTicks, 0.5);
    if (t.kind === 'Wholesaler') p.declineTicks = ticks(p.declineTicks, 0.5);
    if (t.kind === 'Igniter') p.sweepTicks = Math.max(1, Math.round(p.sweepTicks * k));
    if (t.kind === 'MarketMaker') {
      // quote about as wide (in bp) as real market makers do in a stock this liquid; a tick is the minimum
      const targetHalfBp = (regionId === 'hk' ? 1.5 : 0.5) / Math.sqrt(st.L);
      p.halfSpread = Math.max(p.halfSpread, Math.round(targetHalfBp / st.tickBp - 0.5));
      p.skew = +(p.skew * clamp(k, 0.25, 10)).toFixed(2);
    }
    // fewer high-frequency firms bother with thinly traded stocks
    if (st.tier === 1 && ['rebate', 'arbFiber', 'stat'].includes(t.key)) t.on = false;
    if (st.tier === 2 && t.key === 'rebate') t.on = false;
    return t;
  }

  function buildSim(regionId, seed, stock) {
    const st = stock || window.Universe.stockInfo(regionId, window.STOCKS.DEFAULT[regionId]);
    const sim = new window.Engine.Sim(regionId, seed, st);
    sim.sizeScale = st.sizeScale;
    for (const tpl of window.MM.AGENTS[regionId]) {
      const K = window.Agents.KINDS[tpl.kind];
      sim.agents.push(new K(sim, scaleTemplate(tpl, st, regionId)));
    }
    sim.start();
    return sim;
  }
  // The market side of each scenario (the page adds view changes). Order sizes scale with the stock's liquidity.
  function applyScenarioToSim(sim, id) {
    const A = k => sim.agentByKey(k), us = sim.regionId === 'us', lot = sim.rules.lot;
    const q = n => Math.max(lot, Math.round(n * sim.sizeScale / lot) * lot);
    if (id === 'news') sim.shock(-0.008);
    if (id === 'instTwap') A('inst').launch({ side: -1, qty: q(us ? 120000 : 300000), algo: 'TWAP', durationS: 90 });
    if (id === 'instStealth') A('inst').launch({ side: -1, qty: q(us ? 120000 : 300000), algo: 'STEALTH', durationS: 90 });
    if (id === 'flash' || id === 'flashLuld') {
      sim.rules.bandOn = id === 'flashLuld'; sim.rules.stubOk = true; A('stub').setEnabled(true);
      for (const k of ['mmFast', 'mmSlow']) A(k).p.withdraw = 2;
      A('momentum').setEnabled(true);
      A('inst').launch({ side: -1, qty: q(400000), algo: 'POV', pov: 0.15, minClip: q(6000), noLimit: true, durationS: 60 });
      sim.shock(-0.005);
    }
    if (id === 'spoof') { A('spoof').setEnabled(true); A('stat').p.depthLevels = 3; }
    if (id === 'ignite') A('ignite').setEnabled(true);
    if (id === 'stuff') A('stuff').setEnabled(true);
    if (id === 'race') { A('arbMW').setEnabled(true); A('arbFiber').setEnabled(true); A('mmSlow').setEnabled(true); sim.after(30000, () => sim.shock(-0.003)); }
    if (id === 'stamp') for (const a of sim.agents) if (a.kind === 'MarketMaker') a.stampExempt = true;
    if (id === 'vcm') sim.shock(-0.13);
  }
  window.buildSim = buildSim;
  window.scaleTemplate = scaleTemplate;
  window.applyScenarioToSim = applyScenarioToSim;
})();
