// Headless run of the Microsecond Market engine: node tests/sim_smoke.js [us|hk] [seconds] [news|inst|spoof|flash|vcm|stamp]
// Exits with an error if the market fails to trade or ends with one side of the book empty.
const fs = require('fs');
const path = require('path');
global.window = global;
const dir = path.join(__dirname, '..', 'web', 'microsecond-market');
for (const f of ['config.js', 'stocks.js', 'universe.js', 'engine.js', 'agents.js', 'build.js']) eval(fs.readFileSync(path.join(dir, f), 'utf8'));

const region = process.argv[2] || 'us';
const secs = Number(process.argv[3] || 30);
const sim = buildSim(region, 11);
const logs = [];
sim.listeners.log.push(e => logs.push(e));

const scenario = process.argv[4];
const t0 = Date.now();
let events = 0;
for (let s = 1; s <= secs; s++) {
  if (scenario === 'inst' && s === 2) sim.agentByKey('inst').launch({ side: -1, qty: region === 'hk' ? 600000 : 120000, algo: process.argv[5] || 'TWAP', durationS: 60 });
  if (scenario === 'news' && s === 5) sim.shock(-0.008);
  if (scenario === 'vcm' && s === 5) sim.shock(-0.13);
  if (scenario === 'stamp' && s === 1) { sim.agentByKey('mmFast').stampExempt = true; sim.agentByKey('mmSlow').stampExempt = true; }
  if (scenario === 'spoof' && s === 2) { sim.agentByKey('spoof').setEnabled(true); sim.agentByKey('stat').p.depthLevels = 3; }
  if (scenario === 'flash' && s === 2) {
    sim.rules.bandOn = false; sim.rules.stubOk = true; sim.agentByKey('stub').setEnabled(true);
    for (const k of ['mmFast', 'mmSlow']) sim.agentByKey(k).p.withdraw = 2;
    sim.agentByKey('inst').launch({ side: -1, qty: 400000, algo: 'POV', pov: 0.15, minClip: 6000, noLimit: true, durationS: 60 });
    sim.shock(-0.005);
  }
  const before = sim.heap.size;
  sim.runTo(s * 1e6, 5e7);
}
const ms = Date.now() - t0;
const nb = sim.nbbo();
console.log(`${region}: ${secs}s simulated in ${ms} ms; trades ${sim.counters.trades}, msgs ${sim.counters.msgs}, cancels ${Math.round(sim.counters.cancels)}`);
console.log(`V ${(sim.V / 1000).toFixed(3)}  nbbo ${nb.bid / 1000}/${nb.ask / 1000}`);
for (const v of sim.venues) console.log(`  ${v.name}: bid ${v.bestBid()} ask ${v.bestAsk()} levels ${v.bidPx.length}/${v.askPx.length} orders ${v.orders.size} trades ${v.nTrades} queue ${v.queueUs.toFixed(1)}us halted ${v.halted}`);
for (const a of sim.agents) console.log(`  ${a.name.padEnd(28)} on=${a.enabled ? 1 : 0} pnl ${a.pnl().toFixed(2).padStart(10)} pos ${String(a.pos).padStart(8)} fills ${String(a.fills).padStart(6)} msgs ${String(a.msgs).padStart(7)} fees ${a.fees.toFixed(2)} stamp ${a.stamp.toFixed(2)} won ${a.racesWon} lost ${a.racesLost}`);
const r = sim.agentByKey('retail'); if (r && r.stats) console.log('retail cost bp', (r.stats.costBps / Math.max(1, r.stats.notional)).toFixed(3), 'slip bp', (r.stats.slipBps / Math.max(1, r.stats.notional)).toFixed(3), 'via wh', r.stats.viaWholesaler, 'via ex', r.stats.viaExchange);
const inst = sim.agentByKey('inst'); if (inst && inst.parent) console.log('inst', inst.parent.algo, 'filled', inst.parent.filled, 'shortfall bp', inst.shortfallBps());
console.log('--- logs by kind:', Object.entries(logs.reduce((m, e) => (m[e.kind] = (m[e.kind] || 0) + 1, m), {})).map(x => x.join(':')).join(' '));
for (const e of logs.slice(-8)) console.log(`  [${(e.t / 1e6).toFixed(3)}s ${e.kind}] ${e.text}`);
if (sim.counters.trades === 0 || nb.bid == null || nb.ask == null) { console.error('FAIL: no trades or a one-sided book at the end'); process.exit(1); }
