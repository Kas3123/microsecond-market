// Long-run health check for the Microsecond Market engine.
// Runs every scenario, then lets the market trade on (like pressing "Skip ahead"), and checks that it stays usable:
// no runaway event loops or memory growth, the book has both sides, trades keep happening, and the price ends
// close to the stock's true value.
//
//   node tests/sim_stress.js              all scenarios on each market's default stock, 10 simulated minutes each, plus volume extremes
//   node tests/sim_stress.js 30           30 simulated minutes each
//   node tests/sim_stress.js 10 flash     only cases whose label contains "flash"
//   node tests/sim_stress.js stocks 10    every stock in both markets (150), calm market, 10 minutes each
const fs = require('fs');
const path = require('path');
global.window = global;
const dir = path.join(__dirname, '..', 'web', 'microsecond-market');
for (const f of ['config.js', 'stocks.js', 'universe.js', 'engine.js', 'agents.js', 'build.js']) eval(fs.readFileSync(path.join(dir, f), 'utf8'));

const STOCK_MODE = process.argv[2] === 'stocks';
const args = STOCK_MODE ? process.argv.slice(3) : process.argv.slice(2);
const MINUTES = Number(args[0] || 10);
const FILTER = args[1] || '';
const SEC = 1e6;
const MAX_EVENTS_PER_SEC = 2e6;   // a healthy market needs well under 100k
const MAX_HEAP_MB = 1500;

function run(region, id, volMult, seed, ticker) {
  const sim = buildSim(region, seed, ticker ? window.Universe.stockInfo(region, ticker) : undefined);
  sim.volMult = volMult;
  sim.runTo(5 * SEC, 1e10);
  window.applyScenarioToSim(sim, id); // the same settings the page applies
  const end = MINUTES * 60, tail = Math.min(180, end / 3); // judge the last 3 minutes
  let worstEvents = 0, oneSided = 0, haltedS = 0, tailTrades0 = null, problems = [], lastGap = null;
  const t0 = Date.now();
  for (let s = 6; s <= end; s++) {
    let n = 0;
    while (!sim.runTo(s * SEC, 200000)) { n += 200000; if (n > MAX_EVENTS_PER_SEC) break; }
    if (n > MAX_EVENTS_PER_SEC) { problems.push(`event explosion at ${s} s (over ${MAX_EVENTS_PER_SEC.toLocaleString()} events in one simulated second)`); break; }
    worstEvents = Math.max(worstEvents, n);
    if (s === end - tail) tailTrades0 = sim.counters.trades;
    if (s > end - tail) {
      const nb = sim.nbbo(), halted = sim.venues.some(v => v.halted || (v.band && v.band.kind === 'VCM')); // LULD pause or VCM cooling-off
      if (halted) haltedS++;
      else if (nb.bid == null || nb.ask == null || nb.ask - nb.bid > 0.01 * nb.mid) oneSided++;
      else lastGap = Math.abs(nb.mid - sim.Vs) / sim.Vs * 100; // judged on the last two-sided book, not one instant
    }
    if (s % 60 === 0 && process.memoryUsage().heapUsed / 1e6 > MAX_HEAP_MB) { problems.push(`memory over ${MAX_HEAP_MB} MB at ${s} s`); break; }
  }
  const nb = sim.nbbo(), restricted = sim.venues.some(v => v.halted || (v.band && v.band.kind === 'VCM'));
  const gapPct = nb.bid != null && nb.ask != null ? Math.abs(nb.mid - sim.Vs) / sim.Vs * 100 : lastGap;
  const tailTrades = tailTrades0 == null ? 0 : sim.counters.trades - tailTrades0;
  if (!problems.length) {
    if (oneSided > 0.25 * tail) problems.push(`book one-sided or broken for ${oneSided} of the last ${tail} s`);
    if (haltedS < tail && tailTrades === 0) problems.push(`no trades in the last ${tail} s`);
    if (!restricted && gapPct == null) problems.push('book one-sided at the end');
    else if (!restricted && gapPct > 2) problems.push(`price ends ${gapPct.toFixed(2)}% away from true value`);
  }
  return { ok: !problems.length, problems, gapPct, oneSided, haltedS, tailTrades, wall: (Date.now() - t0) / 1000 };
}

const cases = [];
if (STOCK_MODE) for (const region of ['us', 'hk']) for (const st of window.STOCKS.list[region]) cases.push([region, 'calm', 1, st.ticker]);
else {
  for (const region of ['us', 'hk']) for (const sc of window.MM.SCENARIOS[region]) cases.push([region, sc.id, 1]);
  for (const region of ['us', 'hk']) for (const m of [0.25, 10]) cases.push([region, 'calm', m]);
}
let failed = 0;
console.log(`Microsecond Market stress test: ${MINUTES} simulated minutes per case\n`);
const [shard, shards] = (process.env.SHARD || '0/1').split('/').map(Number); // SHARD=k/n runs every n-th case, for parallel runs
for (const [i, [region, id, m, ticker]] of cases.entries()) {
  const label = `${region} ${ticker ? ticker.padEnd(5) + ' ' : ''}${id}${m !== 1 ? ` (volume ${m}x)` : ''}`;
  if (FILTER && !label.includes(FILTER)) continue;
  if (i % shards !== shard) continue;
  const r = run(region, id, m, 1, ticker);
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} end gap ${r.gapPct == null ? '  –  ' : r.gapPct.toFixed(2) + '%'}  ` +
    `last ${Math.min(180, MINUTES * 20)} s: ${r.tailTrades} trades, one-sided ${r.oneSided} s, paused ${r.haltedS} s  (${r.wall.toFixed(1)} s)` +
    (r.ok ? '' : `\n      ${r.problems.join('; ')}`));
}
console.log(failed ? `\n${failed} case(s) failed` : '\nAll cases passed');
process.exit(failed ? 1 : 0);
