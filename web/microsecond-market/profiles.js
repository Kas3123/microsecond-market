// Profiles: who each market participant is, what and why they trade, and a plain-language description of each stock.
// All firms and companies are made up; the real-world notes describe the industry, not these firms.
(function () {
  'use strict';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------------------------------------------------------- people
  // Fields: role, who, what, why, how, risk, helps, hurts, real, legal. `hk` overrides fields in Hong Kong.
  const PEOPLE = {
    mmFast: {
      role: 'High-frequency market maker',
      who: 'A proprietary trading firm of about 150 people, mostly engineers. It trades only its own money. Its servers sit inside the Nasdaq data center in Carteret, New Jersey, linked to NYSE by millimetre-wave radio and to the futures market in Chicago by microwave.',
      what: 'Buy and sell quotes in every stock in the index, all day, on both exchanges. Most of its business is in the most heavily traded names.',
      why: 'To earn the spread: buying at the bid and selling at the ask thousands of times a day, plus the exchange’s rebate (about $0.002 a share) for adding liquidity. It does not want to bet on direction; most positions last seconds.',
      how: 'Sets fair value from the index futures (beta times the futures move, plus the stock’s recent gap to futures), quotes a pyramid of orders around it, and shifts both quotes down when it owns too much stock and up when it is short (Avellaneda–Stoikov skew). Near its limit it crosses the spread to unload. When futures jump it races to cancel stale quotes; in very fast markets it pulls all its quotes.',
      risk: 'Adverse selection: getting filled by someone who knows more, such as a sniper with faster futures data or a fund with better research. Every stale quote that gets hit is a small loss.',
      helps: 'Everyone who trades: tighter spreads and deeper books.',
      hurts: 'Slower market makers, who lose the race for the front of the queue.',
      real: 'Electronic market makers post most of the displayed liquidity in US stocks. Margins are thin: profit comes from volume and speed, and a few firms do most of it.',
      legal: 'Legal. Registered market makers must keep two-sided quotes within set bands of the best price.',
      hk: {
        who: 'A proprietary firm colocated in HKEX’s Tseung Kwan O data center, where the futures market also runs, so futures moves reach it within microseconds.',
        why: 'To earn the spread. In Hong Kong there are no maker rebates, and every trade pays 0.1% stamp duty on each side, many times the typical spread. That makes all-day stock market making very hard.',
        real: 'High-frequency market makers in Hong Kong concentrate on futures, ETFs and warrants, where stamp duty does not apply or is waived, rather than on ordinary shares.',
      },
    },
    mmSlow: {
      role: 'Traditional market maker',
      who: 'The equities desk of a regional bank, running market-making software on ordinary servers in a Manhattan office, connected to the exchanges by leased fiber.',
      what: 'Quotes in fewer stocks, mostly mid-sized names where the fastest firms compete less.',
      why: 'The same business as the fast market maker, earning the spread, but it relies on being one of only a few quoting firms rather than on speed.',
      how: 'Uses the same fair-value-from-futures logic, but its futures data and its orders both arrive later, so its quotes are the first to go stale. It quotes smaller and pulls quotes sooner when volatility rises.',
      risk: 'Being picked off by faster firms. In the simulator you can watch “Sniper A hit Regional bank MM’s stale offer” in the event log.',
      helps: 'Adds depth, especially in stocks the fastest firms ignore.',
      hurts: 'Mostly itself, by paying for its slowness.',
      real: 'Many slower market makers left US equities in the 2010s as the cost of speed rose, and the business concentrated in a handful of electronic firms.',
      legal: 'Legal.',
      hk: { who: 'A market-making team in Singapore that trades Hong Kong stocks over subsea cable, several milliseconds away.', what: 'A selection of Hong Kong stocks, quoted wider than the local firm to cover its slower data.' },
    },
    arbMW: {
      role: 'Latency arbitrage (fast)',
      who: 'A small, very fast proprietary firm of about 30 people. It leases bandwidth on a microwave tower network from Chicago to New Jersey and runs its strategy on FPGA chips that react in a fraction of a microsecond.',
      what: 'The stocks that move most tightly with the index futures: heavily traded, high-beta names where a futures move reliably predicts the stock’s next move.',
      why: 'When the futures jump in Chicago, stock quotes in New Jersey are stale for a few milliseconds. It buys or sells those stale quotes before the market makers can cancel them, then trades out at the new price.',
      how: 'Hears the futures over microwave (about 4 ms from Chicago, versus about 6.6 ms over fiber), works out each stock’s new fair value, and fires immediate-or-cancel orders at any quote that is now wrong by more than its threshold after fees. It also buys on one exchange and sells on the other when their prices cross. Positions are tiny and closed within seconds.',
      risk: 'Losing the race: its order arrives after the quote has gone, so nothing fills. Or the move reverses before it can get out.',
      helps: 'Makes prices on every exchange catch up with the futures faster.',
      hurts: 'Market makers, who pay for every stale quote it hits. Economists call this a “latency arbitrage tax” on liquidity.',
      real: 'Microwave links between Chicago and New Jersey were built around 2010–2013 because radio waves travel through air faster than light travels through glass fiber. A study of London Stock Exchange data (Aquilina, Budish and O’Neill, 2022) found such races happen about once a minute in each large stock and are decided by millionths of a second.',
      legal: 'Legal. Critics argue it taxes liquidity providers; defenders say it keeps prices consistent across markets.',
      hk: {
        who: 'A fast proprietary firm colocated in Tseung Kwan O, next to both the futures and the stock matching engines.',
        how: 'The same strategy, but in Hong Kong the futures and stocks share one data center, so the race is measured in microseconds, not milliseconds, and stamp duty makes each round trip expensive.',
      },
    },
    arbFiber: {
      role: 'Latency arbitrage (slower)',
      who: 'A competitor using the older, cheaper route: long-haul fiber from Chicago and software on fast servers with kernel-bypass networking rather than custom chips.',
      what: 'The same high-beta, heavily traded stocks as Sniper A.',
      why: 'The same strategy: hit stale quotes after a futures move.',
      how: 'Identical logic, but its futures data arrives about 2.6 ms after Sniper A’s. It wins only when Sniper A is already at its position limit or the stale quote is big enough for both.',
      risk: 'Arriving second. In a speed race, second place earns almost nothing.',
      helps: 'A little extra price consistency.',
      hurts: 'Market makers, when it gets there in time.',
      real: 'Speed races are winner-take-most, which is why firms pay millions a year for a link that is a few microseconds faster.',
      legal: 'Legal.',
      hk: { who: 'A firm trading Hong Kong from Tokyo over subsea cable.', how: 'Its data is milliseconds behind the colocated firms in Tseung Kwan O, so it almost never wins a race in Hong Kong.' },
    },
    stat: {
      role: 'Short-term statistical arbitrage',
      who: 'A quantitative trading firm running short-horizon statistical models on colocated servers.',
      what: 'Heavily traded stocks where the spread is one tick and queues are long. There, the size imbalance between the best bid and best offer predicts the next tick best.',
      why: 'When far more shares are waiting to buy than to sell at the best prices, the price is more likely to tick up next. It buys just before that move and sells a fraction of a second later.',
      how: 'Reads the top of the order book (or a few levels deep), trades when the imbalance passes a threshold, and holds for under a second. This project’s real-data research found the same signal in NASDAQ-100 futures (a 1-second correlation of about 0.3), but too small to cover fees for a slow trader.',
      risk: 'Being fooled by spoofing: fake orders create false imbalance. Reading deeper levels makes it easier to fool.',
      helps: 'Moves prices toward where supply and demand say they should be, slightly sooner.',
      hurts: 'Slower traders on the wrong side of the imbalance.',
      real: 'Order-book imbalance is one of the best-documented short-term signals in market microstructure research.',
      legal: 'Legal.',
    },
    anticip: {
      role: 'Order anticipation',
      who: 'A firm that searches the public trade feed for the footprints of large institutional orders.',
      what: 'The biggest stocks, where pension and mutual funds do most of their trading.',
      why: 'If a fund is selling 100,000 shares in equal slices every two seconds, the price will drift down while it sells. Selling ahead of the remaining slices and buying back later is profitable.',
      how: 'Groups trades into the child orders that produced them, checks whether their sizes and timing repeat regularly, and once it finds a pattern, trades in the same direction ahead of it.',
      risk: 'Seeing patterns that aren’t there. Funds that randomize size, timing and venue (stealth algorithms) defeat it.',
      helps: 'Nobody directly. It pushes funds toward better execution algorithms.',
      hurts: 'Institutions with predictable algorithms, through worse prices (implementation shortfall).',
      real: 'This is why institutional brokers randomize their slices. Trading ahead using public data is legal; trading ahead of a client’s order using confidential knowledge of it (front-running) is illegal.',
      legal: 'Legal when based only on public market data.',
    },
    rebate: {
      role: 'Rebate capture',
      who: 'A firm whose main income is the exchange’s maker rebate rather than the spread.',
      what: 'Cheap, heavily traded stocks where queues are long and a $0.002 rebate is a big share of the one-cent spread.',
      why: 'Under maker–taker pricing the exchange pays about $0.002 a share to whoever posted the resting order. It joins the queue at the best price, collects the rebate when filled, and cancels the instant the futures move against it.',
      how: 'Its quotes flicker: most of its orders are cancelled before they fill. It is throttled to one decision per 50 µs per exchange.',
      risk: 'Being filled just before the price moves against it, which can cost more than the rebate.',
      helps: 'Adds displayed size at the best price.',
      hurts: 'Investors whose brokers chase rebates instead of the best fill, a conflict of interest critics point to.',
      real: 'The SEC approved a pilot in 2018 to test lower exchange fees and rebates; a federal court struck it down in 2020. Hong Kong has no maker rebates, so this strategy doesn’t exist there.',
      legal: 'Legal.',
    },
    wholesale: {
      role: 'Wholesale market maker',
      who: 'A large market maker that pays retail brokers for their customers’ orders and fills those orders itself, off-exchange.',
      what: 'Every retail order its partner brokers send, mostly in retail favorites.',
      why: 'Retail orders are mostly small and not based on short-term information, so filling them is profitable even after giving a slightly better price than the exchange (price improvement) and paying the broker (payment for order flow).',
      how: 'Checks each order against the futures-implied value. It fills at the best exchange price minus a small improvement unless the futures have already moved against it, in which case it sends the order to an exchange. It hedges leftover inventory on the exchanges.',
      risk: '“Toxic” flow: a sudden wave of informed orders, or volatile days when the futures move between order and fill.',
      helps: 'Retail investors get slightly better prices than the exchange showed.',
      hurts: 'Exchanges and their market makers, who lose the least risky orders. Critics say retail would get even better prices if orders competed in auctions.',
      real: 'Most US retail market orders are filled this way. In 2022 the SEC proposed making more retail orders go through auctions. Payment for order flow is banned in the UK and is being phased out in the EU.',
      legal: 'Legal in the US, with disclosure.',
    },
    retail: {
      role: 'Individual investors',
      who: 'Thousands of people trading from phone apps, combined here into one flow.',
      what: 'Mostly well-known names (tech, electric cars, stocks in the news), and they tend to buy after prices rise.',
      why: 'Long-term saving, speculation, or following a trend. A typical order is around $12,000.',
      how: 'Mostly market orders through a broker app. In the US the broker usually routes them to a wholesaler, and they watch prices on the slower consolidated feed (SIP).',
      risk: 'Paying the spread, buying after big moves, and trading on stale prices.',
      helps: 'Provides the uninformed flow that market makers profit from, which keeps spreads narrow.',
      hurts: 'Mostly themselves, when they chase momentum.',
      real: 'Retail trading rose sharply after US brokers dropped commissions in 2019.',
      legal: 'Legal.',
      hk: { how: 'Orders go through a broker to HKEX in board lots, and every trade pays 0.1% stamp duty on each side. That is far more than the spread, so it is retail’s biggest trading cost in Hong Kong.' },
    },
    momentum: {
      role: 'Short-term trend followers',
      who: 'Traders and simple algorithms in Manhattan that react to price moves within seconds.',
      what: 'Volatile stocks that are already moving.',
      why: 'Short-term moves tend to continue briefly, so they buy breakouts and sell breakdowns.',
      how: 'Trade after the price moves a set number of ticks within a look-back window, or when visible bids far exceed visible offers, then hold for a few seconds.',
      risk: 'Being the last buyer before the move reverses. This is exactly what momentum igniters and spoofers exploit.',
      helps: 'Adds volume in trends.',
      hurts: 'Can push prices further from value, briefly.',
      real: 'Trend-following runs on every horizon, from milliseconds to months.',
      legal: 'Legal.',
    },
    fund: {
      role: 'Fundamental (value) investor',
      who: 'An asset manager in Boston whose analysts estimate what each company is worth.',
      what: 'Stocks whose price has drifted away from its estimate of value: after news, overreactions, or forced selling by others.',
      why: 'To buy below value and sell above it, holding for weeks or years. In this simulator it is the informed trader: it knows roughly what the stock is worth.',
      how: 'Checks prices every second or so (it isn’t fast). It buys when the price is below value by more than its threshold and buys more the bigger the gap, so after a crash it becomes the main buyer.',
      risk: 'Being wrong about value (“value traps”).',
      helps: 'Anchors prices to value. After flash crashes and big sell programs, it is the buyer that brings prices back.',
      hurts: 'Market makers that trade against it: this is the adverse selection they fear.',
      real: 'Active and value managers are a big part of the market’s price discovery, even though index funds now hold more stock.',
      legal: 'Legal.',
      hk: { who: 'An asset manager in Central, Hong Kong, whose analysts estimate what each company is worth.' },
    },
    inst: {
      role: 'Institutional execution algorithm',
      who: 'A pension fund’s broker algorithm working a large order with retirement savings.',
      what: 'All index stocks in proportion to their index weight, so the biggest companies most.',
      why: 'It must buy or sell large amounts (rebalancing, new money, withdrawals) at the lowest cost, measured as implementation shortfall: its average price versus the price when it started.',
      how: 'Splits the order into small child orders: TWAP (even slices over time), VWAP (follows market volume), POV (a fixed share of volume), iceberg (shows only a little) or stealth (randomized).',
      risk: 'Information leakage: predictable slicing lets anticipation algorithms trade ahead of it.',
      helps: 'Brings large, steady flow that market makers can serve.',
      hurts: 'Itself, when its pattern leaks.',
      real: 'Pension funds, mutual funds and ETFs are the largest holders of stocks; most of their trading goes through algorithms like these.',
      legal: 'Legal.',
      hk: { who: 'A mutual fund’s broker algorithm in Central working a large order.' },
    },
    spoof: {
      role: 'Manipulator (spoofing)',
      who: 'A rogue trader at a small firm. Shown so you can see how it works and how it is caught.',
      what: 'Thinly traded mid-sized stocks, where a few thousand shares look like a big wall.',
      why: 'To trick other algorithms. Large fake orders on one side make imbalance and momentum traders expect a move, so they trade into the spoofer’s real order on the other side.',
      how: 'Places layers of large orders it never intends to fill and a small real order on the opposite side, then cancels the fakes as soon as the price gets close to them.',
      risk: 'Prosecution. Surveillance looks for exactly this: big orders that never trade, on the opposite side of the trades that do.',
      helps: 'Nobody.',
      hurts: 'Imbalance and momentum traders, and everyone who trusts the visible book.',
      real: 'Illegal in the US since the Dodd–Frank Act (2010). Navinder Sarao, who spoofed index futures from his home near London, pleaded guilty in 2016; regulators linked his trading to the 2010 flash crash. In 2020 JPMorgan agreed to pay about $920 million over spoofing in metals and Treasury futures.',
      legal: 'Illegal.',
    },
    ignite: {
      role: 'Manipulator (momentum ignition)',
      who: 'A firm that starts price moves in order to profit from the traders who follow them. Shown for education.',
      what: 'Thin, volatile stocks where a burst of buying moves the price quickly.',
      why: 'Momentum followers pile in after a sharp move; it sells to them at the higher prices.',
      how: 'Sweeps several price levels with an aggressive burst, waits for followers to react, then sells into their buying.',
      risk: 'Prosecution, and losing money if nobody follows.',
      helps: 'Nobody.',
      hurts: 'Momentum followers and anyone who buys at the inflated price.',
      real: 'Regulators treat this as manipulation when the intent is to create a misleading price move. Intent is hard to prove, so cases are rare.',
      legal: 'Illegal when done to mislead.',
    },
    stuff: {
      role: 'Manipulator (quote stuffing)',
      who: 'A firm that floods one exchange with orders and instant cancellations. Shown for education.',
      what: 'Any stock on the exchange it targets; the damage is to the whole exchange.',
      why: 'To slow the exchange and its market data, which can help a firm watching a faster market elsewhere.',
      how: 'Sends hundreds of messages per millisecond. Here the exchange’s gateway queues up to 50 ms of messages and then rejects the excess.',
      risk: 'Being caught by message-rate surveillance.',
      helps: 'Nobody.',
      hurts: 'Every participant on that exchange: their orders wait in line.',
      real: 'A market-data firm (Nanex) documented bursts of thousands of quotes per second in single stocks around the 2010 flash crash. Exchanges now cap message rates, and EU rules (MiFID II) require exchanges to limit excessive order-to-trade ratios.',
      legal: 'Illegal when intended to disrupt.',
    },
    stub: {
      role: 'Placeholder quotes (before 2010)',
      who: 'Not a trader: placeholder quotes that market makers posted to meet their obligation to always show a price.',
      what: 'Every stock.',
      why: 'To meet the rule cheaply: a bid at $0.01 and an offer far above the price ($300 here) that nobody expected to trade.',
      how: 'Sits quietly in the book until the real quotes vanish.',
      risk: 'None to the poster. The damage comes when market orders meet these quotes in a crash.',
      helps: 'Nobody.',
      hurts: 'Anyone whose market order fills against them.',
      real: 'In the 6 May 2010 flash crash, market orders met stub quotes: Accenture traded at a penny and some stocks traded at $100,000. From December 2010 the SEC required market makers to quote within a band of the best price, ending stub quotes.',
      legal: 'Banned in the US since 2010.',
    },
  };
  function person(key, region) {
    const base = PEOPLE[key]; if (!base) return null;
    return Object.assign({}, base, region === 'hk' && base.hk ? base.hk : {});
  }

  // Which stocks in the index each participant focuses on, from the stocks' characteristics.
  const FOCUS = {
    mmFast: s => s.advN, mmSlow: s => (s.tier === 2 || s.tier === 3 ? 1 : 0.3) * s.cap,
    arbMW: s => s.beta * s.L, arbFiber: s => s.beta * s.L, stat: s => Math.min(s.tickBp, 4) * s.L,
    anticip: s => s.cap, rebate: s => Math.min(s.tickBp, 6) * s.L, wholesale: s => (s.retail ? 3 : 1) * s.advN,
    retail: s => (s.retail ? 3 : 1) * s.L * s.totalVol, momentum: s => s.totalVol * s.L ** 0.3, fund: s => s.idioVol * (1 + Math.abs(Math.log(s.price / s.open)) * 40),
    inst: s => s.cap, spoof: s => (s.L < 0.8 ? 1 : 0.2) * s.totalVol, ignite: s => s.totalVol / s.L, stuff: s => s.advN, stub: s => s.cap,
  };
  function favourites(key, stocks, n = 6) {
    const f = FOCUS[key]; if (!f) return [];
    return [...stocks].sort((a, b) => f(b) - f(a)).slice(0, n);
  }

  // ---------------------------------------------------------------- stocks
  const ccy = r => (r === 'hk' ? 'HK$' : '$');
  function big(x, r) { return ccy(r) + (x >= 1e12 ? (x / 1e12).toFixed(2) + ' trillion' : x >= 1e9 ? (x / 1e9).toFixed(x >= 1e11 ? 0 : 1) + ' billion' : (x / 1e6).toFixed(0) + ' million'); }
  function shares(x) { return x >= 1e9 ? (x / 1e9).toFixed(1) + ' billion' : x >= 1e6 ? (x / 1e6).toFixed(1) + ' million' : Math.round(x).toLocaleString(); }
  function reactText(tau) { return tau < 0.1 ? `${Math.round(tau * 1000)} milliseconds` : tau < 1 ? `${(tau * 1000).toFixed(0)} milliseconds` : `${tau.toFixed(0)} second${tau >= 1.5 ? 's' : ''}`; }
  // Plain-language description of a stock: what it does and how it trades. Returns { paragraphs, bullets }.
  function describeStock(s, U) {
    const r = s.region, rank = U ? [...U.stocks].sort((a, b) => b.cap - a.cap).indexOf(s) + 1 : null, n = U ? U.stocks.length : null;
    const idxVol = window.Universe.INDEX_VOL[r];
    const p = [];
    p.push(esc(s.desc));
    p.push(`Worth about ${big(s.cap * 1e9, r)}${rank ? `, number ${rank} of ${n} by size (index weight ${(s.w * 100).toFixed(1)}%)` : ''}. About ${shares(s.adv)} shares (${big(s.advN, r)}) change hands on a normal day.`);
    const b = [];
    const px = ccy(r) + s.price.toFixed(s.price < 10 ? 2 : s.price < 100 ? 2 : 0), tk = ccy(r) + (s.tick < 0.01 ? s.tick.toFixed(3) : s.tick.toFixed(2));
    if (s.tickBp < 0.5) b.push(`<b>Small tick.</b> At ${px} a share, one tick (${tk}) is only ${s.tickBp.toFixed(2)} bp of the price. ${s.spreadTicks > 1
      ? `Market makers usually quote about ${s.spreadTicks} ticks wide (${s.spreadBp.toFixed(1)} bp) and compete on price, so queue position matters less than in cheaper stocks.`
      : 'It trades so heavily that competition still keeps the spread at about one tick, but quotes have to move every time fair value shifts by a cent, so its market makers send a lot of messages.'}`);
    else if (s.tickBp < 3) b.push(`<b>One-tick spread.</b> One tick (${tk}) is ${s.tickBp.toFixed(1)} bp of the ${px} price and the spread is usually one tick, so the competition is for a place at the front of the queue at the best price: being first in line decides who trades.`);
    else b.push(`<b>Tick-constrained.</b> One tick (${tk}) is a large ${s.tickBp.toFixed(1)} bp of the ${px} price, so the spread can’t be narrower than that. Queues at the best price are long and each fill earns the market maker a lot, which attracts rebate-capture and queue-jockeying strategies.`);
    b.push(`<b>Beta ${s.beta.toFixed(2)}.</b> When the index futures move 1%, ${esc(s.ticker)} tends to move about ${s.beta.toFixed(2)}%. ${s.beta >= 1.3 ? 'A high-beta stock: latency arbitrageurs watch it closely because a futures move predicts its next move well.' : s.beta <= 0.6 ? 'A defensive stock: market moves pass through only weakly.' : ''}`);
    b.push(`<b>Reaction speed.</b> It absorbs a futures move in roughly ${reactText(s.tau)}. ${s.tier >= 3 ? 'Many high-frequency firms watch it, so stale prices are picked off almost at once.' : 'Fewer firms trade it, so stale prices last longer: a bigger opportunity for latency arbitrage, but more risk for whoever is quoting.'}`);
    b.push(s.idioVol > s.beta * idxVol ? `<b>Company risk.</b> Most of its daily movement (${s.idioVol.toFixed(1)}% a day on its own) comes from company news rather than the market, which index futures can’t predict. Market makers learn it only from the orders that hit them.`
      : `<b>Market risk.</b> Most of its movement comes from the overall market (beta × ${idxVol}% a day for the index) rather than company news (${s.idioVol.toFixed(1)}%).`);
    if (s.retail) b.push(`<b>Retail favorite.</b> Lots of small orders from individual investors${r === 'us' ? ', most of them filled off-exchange by wholesalers that pay brokers for the flow' : ''}.`);
    if (r === 'hk') {
      const lotVal = s.lot * s.price, stampRatio = 10 / s.spreadBp;
      b.push(`<b>Board lot ${s.lot.toLocaleString()} shares</b> (about HK$${Math.round(lotVal).toLocaleString()} per lot). Orders must be in whole lots.`);
      b.push(`<b>Stamp duty.</b> 0.1% per side is ${stampRatio >= 1 ? `${stampRatio.toFixed(stampRatio < 10 ? 1 : 0)}× the typical spread` : 'about the size of the typical spread'}, so buying and selling the same day is expensive and high-frequency trading in it is limited.`);
    }
    b.push(`<b>Who trades it.</b> High-frequency firms are an estimated ${Math.round(s.hftShare)}% of its volume.${s.tier === 1 ? ' Only a few fast firms bother with it.' : ''}`);
    return { paragraphs: p, bullets: b };
  }

  window.Profiles = { PEOPLE, person, favourites, describeStock, big, shares };
})();
