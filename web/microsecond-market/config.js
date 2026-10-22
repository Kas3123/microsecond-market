// Configuration: places, links, hardware, exchanges, agent templates, explanations, scenarios.
// Coordinates and latencies are approximate public figures, used to compute delays from real distances.
(function () {
  'use strict';

  const PLACES = {
    mahwah:    { name: 'NYSE data center', area: 'Mahwah, NJ', lat: 41.0890, lon: -74.1440, venue: true },
    carteret:  { name: 'Nasdaq data center', area: 'Carteret, NJ', lat: 40.5800, lon: -74.2290, venue: true },
    secaucus:  { name: 'Equinix NY4/NY5', area: 'Secaucus, NJ', lat: 40.7770, lon: -74.0700 },
    manhattan: { name: 'Midtown office', area: 'Manhattan, NY', lat: 40.7550, lon: -73.9840 },
    aurora:    { name: 'CME Group data center', area: 'Aurora, IL', lat: 41.7960, lon: -88.2440, venue: true },
    boston:    { name: 'Asset manager office', area: 'Boston, MA', lat: 42.3550, lon: -71.0600 },
    ohio:      { name: 'Retail investor at home', area: 'Columbus, OH', lat: 39.9610, lon: -82.9990 },
    london:    { name: 'Equinix LD4', area: 'Slough, UK', lat: 51.5220, lon: -0.6290 },
    tko:       { name: 'HKEX data center', area: 'Tseung Kwan O, HK', lat: 22.3080, lon: 114.2610, venue: true },
    central:   { name: 'Broker office', area: 'Central, HK', lat: 22.2810, lon: 114.1580 },
    shatin:    { name: 'Retail investor at home', area: 'Sha Tin, HK', lat: 22.3830, lon: 114.1880 },
    singapore: { name: 'Equinix SG1', area: 'Singapore', lat: 1.2900, lon: 103.8510 },
    tokyo:     { name: 'Equinix TY3', area: 'Tokyo', lat: 35.6810, lon: 139.7670 },
  };

  // speed in km/s; route = path length / great-circle distance; fixedUs = equipment delay per one-way trip.
  const MEDIA = {
    crossconnect: { label: 'Colocation cross-connect', speed: 204190, route: 1, fixedUs: 1.5,
      note: 'Equal-length cable inside the exchange building (exchanges equalize lengths so no rack is closer).' },
    metrofiber:   { label: 'Metro fiber', speed: 204190, route: 1.35, fixedUs: 3, note: 'Light in glass: about 2/3 the speed of light.' },
    longfiber:    { label: 'Long-haul fiber', speed: 204190, route: 1.15, fixedUs: 6, note: 'A straight, purpose-built route like Spread Networks (2010).' },
    microwave:    { label: 'Microwave towers', speed: 299700, route: 1.03, fixedUs: 15, note: 'Through air at ~99.97% of light speed; tower hops add a little delay; rain can cut it.' },
    mmwave:       { label: 'Millimeter wave / laser', speed: 299700, route: 1.01, fixedUs: 4, note: 'Short line-of-sight hops between NJ data centers.' },
    subsea:       { label: 'Subsea fiber', speed: 204190, route: 1.45, fixedUs: 60, note: 'Undersea cables wander around coastlines.' },
    internet:     { label: 'Home internet + broker app', speed: 204190, route: 1.8, fixedUs: 20000, note: 'ISP hops, Wi-Fi, the app and the broker’s servers.' },
  };

  // Time from receiving market data to sending an order.
  const HARDWARE = {
    fpga:     { label: 'FPGA (logic in silicon)', us: 0.8 },
    kbypass:  { label: 'C++ with kernel-bypass network card', us: 6 },
    server:   { label: 'Ordinary trading server', us: 60 },
    oms:      { label: 'Institutional order management system', us: 2500 },
    human:    { label: 'Person tapping an app', us: 0 },
  };

  // Hong Kong spread table (price bands in HK$; "over lo up to hi").
  const HK_BANDS = [[0.01, 0.25, 0.001], [0.25, 0.5, 0.005], [0.5, 10, 0.01], [10, 20, 0.02], [20, 100, 0.05],
    [100, 200, 0.1], [200, 500, 0.2], [500, 1000, 0.5], [1000, 2000, 1], [2000, 5000, 2], [5000, 9995, 5]];

  const CATS = {
    mm:        { label: 'HFT market makers', color: '#2EC4B6' },
    arb:       { label: 'Latency arbitrage', color: '#FF5FA2' },
    stat:      { label: 'Stat-arb HFT', color: '#9B7BFF' },
    anticip:   { label: 'Order anticipation', color: '#FF8A3D' },
    rebate:    { label: 'Rebate capture', color: '#4FA3FF' },
    wholesale: { label: 'Wholesaler', color: '#5BD18B' },
    retail:    { label: 'Retail investors', color: '#C9D3E0' },
    momentum:  { label: 'Momentum followers', color: '#E7A6FF' },
    fund:      { label: 'Fundamental fund', color: '#C8C86A' },
    inst:      { label: 'Institution', color: '#F2C14E' },
    manip:     { label: 'Manipulators', color: '#FF3B3B' },
    stub:      { label: 'Stub quotes', color: '#6B7785' },
    you:       { label: 'You', color: '#FFFFFF' },
  };

  const REGIONS = {
    us: {
      id: 'us', label: 'United States', currency: '$', session: '09:30 ET', stock: 'NQX',
      stockNote: 'NQX is a made-up large-cap stock in the Nasdaq-100, priced near $100.',
      startPrice: 100.00, dailyVolPct: 1.3, leadPlace: 'aurora',
      leadLabel: 'MSM 100 index futures (CME data center, Aurora IL)',
      venues: [
        { id: 'NYSE', name: 'NYSE', place: 'mahwah', matchUs: 30, capacity: 400, feeType: 'pershare', maker: -0.0020, taker: 0.0030 },
        { id: 'NSDQ', name: 'Nasdaq', place: 'carteret', matchUs: 25, capacity: 400, feeType: 'pershare', maker: -0.0020, taker: 0.0030 },
      ],
      rules: { tick: 'us', lot: 1, band: 'LULD', bandPct: 5, stampBps: 0, levyBps: 0, sipExtraUs: 150 },
      ruleText: 'One stock trades on two exchanges 57 km apart. Reg NMS order protection makes brokers route to the best displayed price on either exchange, so a stale quote anywhere can be hit. $0.01 tick, maker–taker fees, Limit Up–Limit Down bands (5% for large stocks; 15 seconds stuck at the band triggers a 5-minute pause).',
    },
    hk: {
      id: 'hk', label: 'Hong Kong', currency: 'HK$', session: '09:30 HKT', stock: 'HKX',
      stockNote: 'HKX is a made-up Hang Seng Index constituent priced near HK$80 (board lot 100 shares).',
      startPrice: 80.00, dailyVolPct: 1.5, leadPlace: 'tko',
      leadLabel: 'MSM HK 50 index futures (HKFE, same TKO data center)',
      venues: [
        { id: 'HKEX', name: 'HKEX', place: 'tko', matchUs: 250, capacity: 150, feeType: 'bps', maker: 0.85, taker: 0.85 },
      ],
      rules: { tick: 'hk', lot: 100, band: 'VCM', bandPct: 10, stampBps: 10, levyBps: 0 },
      ruleText: 'One exchange, with the index futures matching engine in the same Tseung Kwan O data center, so there is little cross-venue racing. Ticks follow a price-banded spread table (HK$0.05 between HK$20 and HK$100, about 6 bp here). Every trade pays 0.1% stamp duty on both buyer and seller, plus trading fee 0.00565%, SFC levy 0.0027% and AFRC levy 0.00015% (about 0.85 bp together; broker commissions and settlement fees not modelled). No maker rebates. Volatility Control Mechanism: a 5-minute cooling-off when the price moves more than about 10% from 5 minutes earlier.',
    },
  };

  // Parameter schemas: [key, label, min, max, step, help]
  const P = {
    mm: [
      ['halfSpread', 'Quote distance from fair value (ticks)', 0, 6, 1, '0 joins the best price; wider earns more per fill but fills less.'],
      ['size', 'Quote size (shares)', 100, 3000, 100, ''],
      ['levels', 'Pyramid levels per side', 1, 5, 1, 'Extra levels sit one tick further out each.'],
      ['skew', 'Inventory skew (ticks per quote-size held)', 0, 3, 0.25, 'Avellaneda–Stoikov: holding stock shifts both quotes down to sell it.'],
      ['maxInv', 'Inventory limit (shares)', 500, 20000, 500, 'Above 60% of this it crosses the spread to reduce its position.'],
      ['useLead', 'Use futures as fair value (1 = on)', 0, 1, 1, 'Off: fair value from its own exchange quotes only.'],
      ['withdraw', 'Pull quotes when volatility exceeds (× normal)', 1.5, 20, 0.5, 'Low = pulls liquidity quickly in fast markets.'],
    ],
    arb: [
      ['threshold', 'Minimum edge to fire (ticks)', 0.5, 5, 0.5, 'Edge = futures-implied value minus stale quote, after fees.'],
      ['maxSize', 'Max shares per shot', 100, 5000, 100, ''],
      ['maxPos', 'Position limit (shares)', 500, 20000, 500, ''],
      ['crossVenue', 'Also arbitrage NYSE vs Nasdaq (1 = on)', 0, 1, 1, 'Buys on one exchange and sells on the other when prices cross.'],
    ],
    stat: [
      ['threshold', 'Imbalance needed to trade (0–1)', 0.2, 0.95, 0.05, 'Imbalance = (bid size − ask size) / (bid size + ask size).'],
      ['size', 'Trade size (shares)', 100, 3000, 100, ''],
      ['holdMs', 'Holding time (ms)', 50, 5000, 50, ''],
      ['maxPos', 'Position limit (shares)', 300, 10000, 100, ''],
      ['depthLevels', 'Book levels it reads (1 = best price only)', 1, 5, 1, 'Reading deeper levels makes it easier to fool with spoof orders.'],
    ],
    anticip: [
      ['minPattern', 'Repeats needed to detect a pattern', 3, 12, 1, ''],
      ['maxCv', 'Regularity needed (timing variation, lower = stricter)', 0.05, 0.8, 0.05, ''],
      ['size', 'Size it trades ahead (shares)', 100, 10000, 100, ''],
      ['markupTicks', 'Ticks above entry it offers back', 1, 6, 1, ''],
    ],
    rebate: [
      ['size', 'Order size (shares)', 100, 2000, 100, ''],
      ['cancelTicks', 'Cancel when futures move (ticks)', 0.5, 5, 0.5, ''],
    ],
    wholesale: [
      ['pi', 'Price improvement given to retail ($ per share)', 0, 0.005, 0.0005, 'Retail gets filled this much better than the best public price.'],
      ['pfof', 'Payment for order flow to the broker ($ per share)', 0, 0.003, 0.0005, 'Paid to the broker, not to the investor.'],
      ['declineTicks', 'Send to exchange if futures moved this many ticks', 0.5, 5, 0.5, 'Screens out orders that arrive after a big move.'],
      ['hedgeAt', 'Hedge on exchange above inventory (shares)', 500, 20000, 500, ''],
    ],
    retail: [
      ['rate', 'Orders per second (all accounts)', 0.2, 20, 0.2, ''],
      ['avgSize', 'Average order (shares)', 10, 2000, 10, ''],
      ['marketShare', 'Share of market orders (0–1)', 0, 1, 0.05, 'The rest are limit orders near the best price.'],
      ['chase', 'Momentum chasing (0–1)', 0, 1, 0.05, 'How much recent price rises make them buy.'],
      ['toWholesaler', 'Route to wholesaler (1) or exchange (0)', 0, 1, 1, 'US only. Hong Kong orders always go to the exchange.'],
    ],
    momentum: [
      ['lookbackMs', 'Look-back window (ms)', 200, 10000, 100, ''],
      ['triggerTicks', 'Move that triggers a trade (ticks)', 1, 20, 1, ''],
      ['imbalanceRatio', 'Also buy when visible bids exceed asks by (×)', 1.2, 10, 0.1, 'This is what spoofers exploit.'],
      ['size', 'Trade size (shares)', 100, 5000, 100, ''],
      ['holdMs', 'Holding time (ms)', 500, 30000, 500, ''],
    ],
    fund: [
      ['threshold', 'Mispricing needed (ticks)', 1, 30, 1, ''],
      ['noiseTicks', 'Research error (ticks)', 0, 20, 1, 'How wrong its estimate of true value is.'],
      ['size', 'Order size (shares)', 100, 10000, 100, ''],
      ['everyMs', 'Checks the market every (ms)', 200, 10000, 100, ''],
      ['maxPos', 'Position limit at the threshold (shares)', 1000, 300000, 1000, 'How much it will own when the price is just past its threshold. It buys more, and holds more, the further the price is from value.'],
    ],
    spoof: [
      ['spoofSize', 'Fake order size per layer (shares)', 500, 20000, 500, ''],
      ['layers', 'Layers', 1, 6, 1, ''],
      ['realSize', 'Real order size (shares)', 100, 5000, 100, ''],
      ['cycleMs', 'Cycle length (ms)', 300, 10000, 100, ''],
    ],
    ignite: [
      ['burst', 'Aggressive burst size (shares)', 500, 20000, 500, ''],
      ['sweepTicks', 'Ticks it sweeps through', 1, 10, 1, ''],
      ['exitMs', 'Waits before selling into followers (ms)', 100, 5000, 100, ''],
      ['cycleMs', 'Repeat every (ms)', 1000, 20000, 500, ''],
    ],
    stuff: [
      ['perMs', 'Messages per millisecond', 10, 2000, 10, 'Exchange capacity is a few hundred per ms; above that, everyone queues.'],
    ],
    stub: [],
    inst: [],
  };

  // Agent templates per region. kind = class in agents.js; cat = colour/category.
  const AGENTS = {
    us: [
      { key: 'mmFast', kind: 'MarketMaker', cat: 'mm', name: 'Colocated MM', place: 'carteret', hw: 'fpga', lead: 'microwave', link: { NYSE: 'mmwave', NSDQ: 'crossconnect' }, on: true,
        p: { halfSpread: 0, size: 500, levels: 3, skew: 0.5, maxInv: 15000, useLead: 1, withdraw: 4 } },
      { key: 'mmSlow', kind: 'MarketMaker', cat: 'mm', name: 'Regional bank MM', place: 'manhattan', hw: 'server', lead: 'longfiber', link: { NYSE: 'metrofiber', NSDQ: 'metrofiber' }, on: true,
        p: { halfSpread: 0, size: 400, levels: 2, skew: 0.5, maxInv: 8000, useLead: 1, withdraw: 6 } },
      { key: 'arbMW', kind: 'LatencyArb', cat: 'arb', name: 'Sniper A (microwave, FPGA)', place: 'carteret', hw: 'fpga', lead: 'microwave', link: { NYSE: 'mmwave', NSDQ: 'crossconnect' }, on: true,
        p: { threshold: 1, maxSize: 1000, maxPos: 5000, crossVenue: 1 } },
      { key: 'arbFiber', kind: 'LatencyArb', cat: 'arb', name: 'Sniper B (fiber, C++)', place: 'carteret', hw: 'kbypass', lead: 'longfiber', link: { NYSE: 'metrofiber', NSDQ: 'crossconnect' }, on: true,
        p: { threshold: 1, maxSize: 1000, maxPos: 5000, crossVenue: 1 } },
      { key: 'stat', kind: 'StatArb', cat: 'stat', name: 'Imbalance stat-arb', place: 'carteret', hw: 'kbypass', lead: 'microwave', link: { NYSE: 'mmwave', NSDQ: 'crossconnect' }, on: true,
        p: { threshold: 0.75, size: 200, holdMs: 800, maxPos: 2000, depthLevels: 1 } },
      { key: 'anticip', kind: 'Anticipator', cat: 'anticip', name: 'Order anticipation', place: 'secaucus', hw: 'kbypass', lead: 'microwave', link: { NYSE: 'metrofiber', NSDQ: 'metrofiber' }, on: true,
        p: { minPattern: 5, maxCv: 0.25, size: 2000, markupTicks: 2 } },
      { key: 'rebate', kind: 'RebateCapture', cat: 'rebate', name: 'Rebate capture', place: 'carteret', hw: 'kbypass', lead: 'microwave', link: { NYSE: 'mmwave', NSDQ: 'crossconnect' }, on: true,
        p: { size: 200, cancelTicks: 1 } },
      { key: 'wholesale', kind: 'Wholesaler', cat: 'wholesale', name: 'Wholesale market maker', place: 'secaucus', hw: 'kbypass', lead: 'microwave', link: { NYSE: 'metrofiber', NSDQ: 'metrofiber' }, on: true,
        p: { pi: 0.001, pfof: 0.001, declineTicks: 2, hedgeAt: 3000 } },
      { key: 'retail', kind: 'Retail', cat: 'retail', name: 'Retail investors', place: 'ohio', hw: 'human', lead: null, link: { NYSE: 'internet', NSDQ: 'internet', WH: 'internet' }, sip: true, on: true,
        p: { rate: 3, avgSize: 120, marketShare: 0.85, chase: 0.3, toWholesaler: 1 } },
      { key: 'momentum', kind: 'Momentum', cat: 'momentum', name: 'Momentum followers', place: 'manhattan', hw: 'server', lead: null, link: { NYSE: 'metrofiber', NSDQ: 'metrofiber' }, on: true,
        p: { lookbackMs: 2000, triggerTicks: 4, imbalanceRatio: 3, size: 600, holdMs: 6000 } },
      { key: 'fund', kind: 'Fundamental', cat: 'fund', name: 'Fundamental fund', place: 'boston', hw: 'oms', lead: null, link: { NYSE: 'longfiber', NSDQ: 'longfiber' }, on: true,
        p: { threshold: 6, noiseTicks: 4, size: 3000, everyMs: 1500, maxPos: 60000 } },
      { key: 'spoof', kind: 'Spoofer', cat: 'manip', name: 'Spoofer', place: 'carteret', hw: 'kbypass', lead: 'microwave', link: { NYSE: 'mmwave', NSDQ: 'crossconnect' }, on: false,
        p: { spoofSize: 6000, layers: 3, realSize: 800, cycleMs: 2500 } },
      { key: 'ignite', kind: 'Igniter', cat: 'manip', name: 'Momentum igniter', place: 'carteret', hw: 'kbypass', lead: 'microwave', link: { NYSE: 'mmwave', NSDQ: 'crossconnect' }, on: false,
        p: { burst: 4000, sweepTicks: 4, exitMs: 1500, cycleMs: 8000 } },
      { key: 'stuff', kind: 'Stuffer', cat: 'manip', name: 'Quote stuffer', place: 'carteret', hw: 'fpga', lead: null, link: { NYSE: 'mmwave', NSDQ: 'crossconnect' }, on: false,
        p: { perMs: 600 } },
      { key: 'stub', kind: 'StubQuoter', cat: 'stub', name: 'Stub quotes (pre-2010)', place: 'manhattan', hw: 'server', lead: null, link: { NYSE: 'metrofiber', NSDQ: 'metrofiber' }, on: false, p: {} },
      { key: 'inst', kind: 'Institution', cat: 'inst', name: 'Pension fund algo', place: 'secaucus', hw: 'kbypass', lead: null, link: { NYSE: 'metrofiber', NSDQ: 'metrofiber' }, on: true, p: {} },
    ],
    hk: [
      { key: 'mmFast', kind: 'MarketMaker', cat: 'mm', name: 'TKO colocated MM', place: 'tko', hw: 'fpga', lead: 'crossconnect', link: { HKEX: 'crossconnect' }, on: true,
        p: { halfSpread: 0, size: 2000, levels: 3, skew: 0.5, maxInv: 20000, useLead: 1, withdraw: 4 }, stampExempt: 0 },
      { key: 'mmSlow', kind: 'MarketMaker', cat: 'mm', name: 'Singapore MM', place: 'singapore', hw: 'kbypass', lead: 'subsea', link: { HKEX: 'subsea' }, on: true,
        p: { halfSpread: 1, size: 1000, levels: 2, skew: 0.5, maxInv: 10000, useLead: 1, withdraw: 6 }, stampExempt: 0 },
      { key: 'arbMW', kind: 'LatencyArb', cat: 'arb', name: 'TKO futures-lead arb', place: 'tko', hw: 'fpga', lead: 'crossconnect', link: { HKEX: 'crossconnect' }, on: true,
        p: { threshold: 1, maxSize: 2000, maxPos: 10000, crossVenue: 0 } },
      { key: 'arbFiber', kind: 'LatencyArb', cat: 'arb', name: 'Tokyo arb (subsea)', place: 'tokyo', hw: 'kbypass', lead: 'subsea', link: { HKEX: 'subsea' }, on: true,
        p: { threshold: 1, maxSize: 2000, maxPos: 10000, crossVenue: 0 } },
      { key: 'stat', kind: 'StatArb', cat: 'stat', name: 'Imbalance stat-arb', place: 'tko', hw: 'kbypass', lead: 'crossconnect', link: { HKEX: 'crossconnect' }, on: true,
        p: { threshold: 0.75, size: 1000, holdMs: 1500, maxPos: 10000, depthLevels: 1 } },
      { key: 'anticip', kind: 'Anticipator', cat: 'anticip', name: 'Order anticipation', place: 'tko', hw: 'kbypass', lead: 'crossconnect', link: { HKEX: 'crossconnect' }, on: true,
        p: { minPattern: 5, maxCv: 0.25, size: 5000, markupTicks: 1 } },
      { key: 'retail', kind: 'Retail', cat: 'retail', name: 'Retail investors', place: 'shatin', hw: 'human', lead: null, link: { HKEX: 'internet' }, sip: false, on: true,
        p: { rate: 3, avgSize: 400, marketShare: 0.6, chase: 0.3, toWholesaler: 0 } },
      { key: 'momentum', kind: 'Momentum', cat: 'momentum', name: 'Momentum followers', place: 'central', hw: 'server', lead: null, link: { HKEX: 'metrofiber' }, on: true,
        p: { lookbackMs: 2000, triggerTicks: 2, imbalanceRatio: 3, size: 3000, holdMs: 6000 } },
      { key: 'fund', kind: 'Fundamental', cat: 'fund', name: 'Fundamental fund', place: 'central', hw: 'oms', lead: null, link: { HKEX: 'metrofiber' }, on: true,
        p: { threshold: 2, noiseTicks: 1, size: 20000, everyMs: 1500, maxPos: 400000 } },
      { key: 'spoof', kind: 'Spoofer', cat: 'manip', name: 'Spoofer', place: 'tko', hw: 'kbypass', lead: 'crossconnect', link: { HKEX: 'crossconnect' }, on: false,
        p: { spoofSize: 30000, layers: 3, realSize: 3000, cycleMs: 2500 } },
      { key: 'ignite', kind: 'Igniter', cat: 'manip', name: 'Momentum igniter', place: 'tko', hw: 'kbypass', lead: 'crossconnect', link: { HKEX: 'crossconnect' }, on: false,
        p: { burst: 20000, sweepTicks: 2, exitMs: 1500, cycleMs: 8000 } },
      { key: 'stuff', kind: 'Stuffer', cat: 'manip', name: 'Quote stuffer', place: 'tko', hw: 'fpga', lead: null, link: { HKEX: 'crossconnect' }, on: false, p: { perMs: 300 } },
      { key: 'inst', kind: 'Institution', cat: 'inst', name: 'Mutual fund algo', place: 'central', hw: 'kbypass', lead: null, link: { HKEX: 'metrofiber' }, on: true, p: {} },
    ],
  };

  const EXPLAIN = {
    MarketMaker: {
      title: 'HFT market making',
      how: 'Keeps bids and asks resting on every exchange and earns the gap between them, plus maker rebates in the US. It moves its quotes the moment the futures market moves (its estimate of fair value), stacks extra orders further out (the pyramid), and shifts both quotes down when it holds too much stock so others buy it off (Avellaneda–Stoikov skew).',
      wins: 'Everyone who crosses the spread: more makers mean tighter spreads and deeper books.',
      loses: 'The maker itself when its quotes are stale and a faster trader hits them. When volatility spikes it pulls quotes, which is exactly when the market needs them.',
      real: 'Most displayed liquidity in US stocks is posted by electronic market makers. In Hong Kong, 0.1% stamp duty on each side makes high-turnover stock market making very hard; HFT there concentrates in futures, ETFs and warrants (some ETF market makers are exempt from stamp duty).',
      legal: 'Legal.',
    },
    LatencyArb: {
      title: 'Latency arbitrage (stale-quote sniping)',
      how: 'Watches the futures market. When futures jump, stock quotes are stale for a few microseconds to milliseconds until market makers cancel them. The sniper races to hit those quotes first. In the US it also buys on one exchange and sells on the other when their prices cross.',
      wins: 'Prices across markets line up faster.',
      loses: 'Slower market makers, who lose on every snipe and respond by quoting wider, a cost passed on to everyone who trades.',
      real: 'Spread Networks’ straight fiber (2010) cut Chicago–New Jersey round trips to about 13 ms; microwave towers then cut it to about 8 ms, because signals travel roughly 1.5× faster through air than through glass. The winner of each race is often decided by microseconds.',
      legal: 'Legal.',
    },
    StatArb: {
      title: 'Short-term statistical arbitrage (order-book imbalance)',
      how: 'When far more shares wait on the bid than the ask, the next price move is more likely up. It buys ahead of that move and sells a moment later. This is the same signal we measured on real Hyperliquid data (correlation about 0.3, one second ahead).',
      wins: 'The market absorbs information faster.',
      loses: 'Whoever traded with it just before the move. It is also the main victim of spoofing, because fake orders create fake imbalance.',
      real: 'Imbalance and "microprice" signals are standard inputs for market makers and HFT firms.',
      legal: 'Legal.',
    },
    Anticipator: {
      title: 'Order anticipation (back-running)',
      how: 'Large orders are sliced into many child orders. If the slices are regular (same size, same interval), the pattern shows up in the public trade feed. This algo spots the pattern, buys ahead of the remaining slices, then sells back to the institution at higher prices.',
      wins: 'Itself.',
      loses: 'The institution, whose cost (implementation shortfall) rises. Defenses: random sizes and timing, passive orders, iceberg orders, dark pools.',
      real: 'Brokers advertise "anti-gaming" logic for exactly this reason.',
      legal: 'Legal when based only on public market data. Trading ahead of a client’s order using private knowledge of it is illegal front-running.',
    },
    RebateCapture: {
      title: 'Rebate capture',
      how: 'US exchanges pay makers a rebate (about $0.002 per share here) and charge takers a fee (capped at $0.003 per share under Reg NMS Rule 610). Sitting at the best price to collect rebates can pay even when the spread earned is zero.',
      wins: 'Itself, and anyone who needs displayed liquidity.',
      loses: 'Takers who pay the fee. In Hong Kong there are no maker rebates, so the strategy doesn’t exist there.',
      real: 'In 2024 the SEC voted to lower the access-fee cap to $0.001 for most stocks and allow half-penny ticks for some; check whether that is in effect when you cite it.',
      legal: 'Legal.',
    },
    Wholesaler: {
      title: 'Wholesale market making (retail internalization)',
      how: 'US retail brokers route orders to wholesalers, which pay the broker for the flow (payment for order flow) and fill retail orders off-exchange at, or slightly better than, the best public price. Retail flow is rarely informed, so the wholesaler earns the spread with little adverse selection.',
      wins: 'Retail gets small price improvement and the broker gets paid, which funds zero-commission trading.',
      loses: 'Arguably, public exchanges lose uninformed flow, which makes their quotes wider. Hong Kong has no equivalent: retail orders go to HKEX.',
      real: 'Brokers disclose routing and payments in SEC Rule 606 reports.',
      legal: 'Legal in the US; banned or restricted in several other markets.',
    },
    Retail: {
      title: 'Retail investors',
      how: 'Many small accounts trading through apps over home internet, roughly 20 ms or more from the exchange, watching a slower consolidated price feed. Mostly market orders.',
      wins: 'Tight spreads and price improvement in calm markets.',
      loses: 'Market orders in fast or thin markets, chasing moves that manipulators started, and stale screens during spikes.',
      real: 'Retail is a large share of US volume; Hong Kong retail pays stamp duty on every trade.',
      legal: '',
    },
    Momentum: {
      title: 'Momentum and imbalance followers',
      how: 'Slower algorithms that buy after prices rise or when the visible book looks one-sided, and sell after a set time.',
      wins: 'Themselves, in trending markets.',
      loses: 'Themselves, when a move was manufactured. They are the target of spoofing and momentum ignition, and they amplify crashes.',
      real: 'Trend-following runs on every horizon, from milliseconds to months.',
      legal: 'Legal.',
    },
    Fundamental: {
      title: 'Fundamental fund',
      how: 'Trades when price drifts away from its research estimate of value, slowly, from Boston. The further the price is from value, the more it buys or sells, which is what pulls the price back after a big sale.',
      wins: 'Itself when its research is right.',
      loses: 'Market makers who trade against it: this is informed flow, the "adverse selection" makers fear.',
      real: '',
      legal: 'Legal.',
    },
    Institution: {
      title: 'Institutional execution',
      how: 'A pension or mutual fund order of hundreds of thousands of shares, worked by a broker algorithm. TWAP and VWAP slice evenly and are predictable; POV follows a share of market volume; iceberg shows only a small part of a resting order; stealth randomizes size, timing and venue.',
      wins: 'Long-term savers when the algorithm hides well.',
      loses: 'The fund when its pattern leaks, measured as implementation shortfall: average price paid vs the price when the order started.',
      real: 'On 6 May 2010 a large sell program in E-mini futures, executed at about 9% of volume with no price or time limit, was identified by the SEC and CFTC as a trigger of the Flash Crash.',
      legal: 'Legal.',
    },
    Spoofer: {
      title: 'Spoofing and layering (illegal)',
      how: 'Places large orders it never intends to fill so the book looks one-sided. Imbalance readers react and push the price; the spoofer trades on the other side at the better price, then cancels the fake orders before they can fill.',
      wins: 'The spoofer, until surveillance notices.',
      loses: 'Stat-arb and momentum algorithms and anyone who trusts the visible book.',
      real: 'Navinder Sarao spoofed E-mini futures from London; his trading was cited in the 2010 Flash Crash case and he pleaded guilty in 2016. Surveillance looks for extreme order-to-trade ratios and orders cancelled just before they could fill.',
      legal: 'Illegal in the US under the Dodd-Frank Act (2010) and in Hong Kong as false trading under the Securities and Futures Ordinance.',
    },
    Igniter: {
      title: 'Momentum ignition (illegal when meant to mislead)',
      how: 'Fires a burst of aggressive buys that sweeps several price levels, waits for momentum algorithms to pile in, then sells to them.',
      wins: 'The igniter.',
      loses: 'Momentum followers and retail who chase the move.',
      real: 'Regulators treat trades meant to create a false impression of activity as manipulation.',
      legal: 'Illegal when done to mislead.',
    },
    Stuffer: {
      title: 'Quote stuffing',
      how: 'Floods an exchange with orders and immediate cancels. Here that fills the exchange’s processing queue, so every other participant’s orders wait in line.',
      wins: 'Possibly a colocated firm that benefits from others being slowed.',
      loses: 'Everyone else’s latency.',
      real: 'Exchanges now cap message rates and charge for excessive order-to-trade ratios.',
      legal: 'Treated as disruptive trading.',
    },
    StubQuoter: {
      title: 'Stub quotes (before late 2010)',
      how: 'Placeholder quotes at absurd prices (like $0.01) that market makers kept to meet quoting obligations without risk.',
      wins: 'Nobody.',
      loses: 'Anyone whose market order reaches them when real liquidity vanishes: on 6 May 2010 Accenture briefly traded at one cent.',
      real: 'Stub quotes were banned in late 2010; Limit Up–Limit Down bands followed in 2012–13.',
      legal: 'Banned since 2010.',
    },
  };

  const SCENARIOS = {
    us: [
      { id: 'calm', label: 'Calm open', text: 'Default market: makers quote, retail trades, futures lead.' },
      { id: 'news', label: 'News shock', text: 'Futures drop 0.8% in Chicago. Watch the drop reach New Jersey and the race to hit stale quotes.' },
      { id: 'instTwap', label: 'Institution sells (predictable TWAP)', text: 'A pension fund sells a large block in even slices over 90 seconds (sized to the stock’s trading volume). Watch the anticipation algo detect it.' },
      { id: 'instStealth', label: 'Institution sells (stealth)', text: 'Same order, randomized size, timing and venue. Compare the shortfall.' },
      { id: 'flash', label: 'Flash crash (2010 rules)', text: 'A huge sell at 15% of volume with no limit, makers pull quotes, stub quotes in the book, no LULD bands.' },
      { id: 'flashLuld', label: 'Same crash with LULD bands', text: 'Identical sell program with today’s Limit Up–Limit Down protection.' },
      { id: 'spoof', label: 'Spoofing attack', text: 'Watch red walls appear and vanish, and the imbalance traders get fooled.' },
      { id: 'ignite', label: 'Momentum ignition', text: 'A burst sweeps the book, followers pile in, the igniter sells to them.' },
      { id: 'stuff', label: 'Quote stuffing', text: 'Nasdaq’s queue fills with junk messages; watch everyone’s delay rise.' },
      { id: 'race', label: 'Microwave vs fiber race', text: 'Two snipers, identical except the Chicago link. Watch who wins each race and by how much.' },
    ],
    hk: [
      { id: 'calm', label: 'Calm open', text: 'HKEX with 0.1% stamp duty on both sides, no rebates, HK$0.05 ticks.' },
      { id: 'news', label: 'News shock', text: 'HSI futures drop 0.8%. Futures and stocks share the TKO data center, so the race is tiny.' },
      { id: 'stamp', label: 'Stamp duty exemption on', text: 'Give the market makers a stamp duty exemption and compare their P&L and the spread.' },
      { id: 'instTwap', label: 'Institution sells (predictable TWAP)', text: 'A mutual fund sells a large block in even slices over 90 seconds (sized to the stock’s trading volume).' },
      { id: 'vcm', label: 'Volatility Control Mechanism', text: 'A sharp fall triggers the 5-minute cooling-off band.' },
      { id: 'spoof', label: 'Spoofing attack', text: 'Same trick, but each fake order risks stamp duty if it fills.' },
    ],
  };

  window.MM = { PLACES, MEDIA, HARDWARE, HK_BANDS, CATS, REGIONS, P, AGENTS, EXPLAIN, SCENARIOS };
})();
