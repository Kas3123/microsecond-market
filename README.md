# Microsecond Market — does the spread pay?

**Try it in your browser:** https://kas3123.github.io/microsecond-market/

A student research project on **market making**: posting buy and sell orders on both sides of an order book and trying to earn the gap between them (the spread). It has two parts:

1. **Research pipeline** (`src/`, `tests/`, `docs/`): a laddered ("pyramid") Avellaneda–Stoikov market maker, tested first in simulation and then on real order-book data recorded live, with a pre-registered development/holdout split.
2. **Microsecond Market** (`web/microsecond-market/`): a playable 3D simulator of how high-frequency trading works on NYSE, Nasdaq and the Hong Kong Stock Exchange, with real distances, link speeds, fees and market rules, and a market of 150 made-up stocks.

> Educational project. Not investment advice. The simulator shows manipulative strategies (spoofing, momentum ignition, quote stuffing) so you can see how they work and how they are caught. They are illegal.

## Getting started

```bash
git clone https://github.com/Kas3123/microsecond-market.git
cd microsecond-market
```

Run every command below from this folder (the repository root).

**Simulator** (needs only Python and a browser; three.js and fonts load from public CDNs, so you need an internet connection):

```bash
python web/serve_nocache.py 8765 web/microsecond-market
```

Then open http://127.0.0.1:8765. Stop the server with Ctrl+C.

**Research code** (optional): create a virtual environment and install the three dependencies.

```bash
python -m venv .venv
```

Activate it (`.venv\Scripts\activate` on Windows, `source .venv/bin/activate` on macOS/Linux), then:

```bash
pip install -r requirements.txt
```

Tested with Python 3.13, numpy 2.5, matplotlib 3.11, websockets 17 and Node.js 24 (Node is only needed for the simulator tests).

## Main finding

On real data, **the spread does not pay for a slow newcomer**. With the fees a new account actually pays:

- **0 of 96** strategy settings earned positive market-making profit on the holdout data, in either market (NASDAQ‑100 and gold), overnight or after the US open.
- The development "winner" made money only because it happened to hold stock while the price rose. On the holdout it lost.
- **Fees are larger than the spread.** NASDAQ‑100: maker fee ≈ 0.30 bp vs a spread of ≈ 0.35 bp. Gold: maker fee ≈ 3.0 bp vs ≈ 0.24 bp.
- **Speed decides who wins.** As order delay rises from 0 to 2 s, fills rise from 39 to 381, and the extra fills are stale quotes being picked off.
- Order-book imbalance does predict the next price move (1‑second correlation 0.31 for NASDAQ‑100, 0.14 for gold), but not by enough to cover fees.

Every flaw found along the way, including in my own earlier claims, is logged in [`docs/audit_findings.md`](docs/audit_findings.md). The full write-up is [`docs/report.html`](docs/report.html) (open it in a browser).

### About the data

The two markets studied are **perpetual futures**: futures contracts with no expiry date that track a price (here the NASDAQ‑100 index, `xyz:XYZ100`, and gold, `xyz:GOLD`). They trade on **Hyperliquid**, a crypto exchange that lets third parties list such markets (its "HIP‑3" feature), and were reached through the Liquid Trade app. You get stock and gold exposure, but the exchange itself is crypto infrastructure, settled in USDC.

The study used about 8 hours recorded on 9 October 2026. The **development** and **holdout** windows are fixed calendar times set in `src/protocol.py` before the analysis (development before 10:00 UTC, holdout after). The raw recordings are not in the repo (`data/raw/` is git-ignored); the results they produced are in `data/` and `data/results/`. Record new data with `src/recorder.py`, which uses Hyperliquid's public API with no key. Trader wallet addresses are deliberately not stored.

## Microsecond Market (simulator)

What you can do:

- **A whole market**: 100 made-up US large caps (the "MSM 100") and 50 made-up Hong Kong stocks, each with its own price, size, beta, volatility, tick size and trading volume. The market map shows them all reacting to the same index futures: big, heavily traded stocks reprice within milliseconds, while smaller ones lag by seconds. Click any stock for its profile; double-click to simulate it order by order. Only that one stock is simulated message by message; the others follow a lighter model, and their spreads and volumes are estimates.
- **Participant profiles**: who each trader is (market makers, snipers, stat-arb, wholesaler, retail, fundamental fund, pension algo, spoofer and more), what and why they trade, how they do it, who they help or hurt, and the real-world context.
- **3D order book**: every bar is the shares waiting at one price. Click a price to see its queue, order by order.
- **Order flow**: every message (orders, cancels, fills, market data, futures ticks) moving between data centers. At 1/1000 speed it moves in true time.
- **Globe and latency**: Chicago → New Jersey microwave vs fiber, and Hong Kong's data center in Tseung Kwan O.
- **Scenarios**: news shock, institutional selling (TWAP vs stealth), the 2010 flash crash with and without Limit Up–Limit Down bands, spoofing, momentum ignition, quote stuffing, stamp duty, and Hong Kong's Volatility Control Mechanism.
- **Controls**: speed from 1/1000 to Max, skip ahead 1 min / 10 min / 1 hour, and market volume from ¼× to 10×.
- **View options**: the order book in perspective, as a front depth profile, as a top-down heatmap (price up the screen, time left to right) or from the side, coloured by participant, by side or by size. The order-flow map has a schematic layout and a latency map, where distance from the exchange shows the one-way delay.
- **Terminal interface**: a command line (type `HELP`, `NEWS`, `SKIP 10`, `VOL 5`, `MAP`, or any ticker), keyboard shortcuts (`/`, `1`–`4`, `V`, Space), a time-and-sales tape, a status bar, and two themes (Terminal and Slate) with a colour-blind-safe blue/orange option.
- **Play as** a retail investor, an institution or your own HFT firm.

Every participant only acts on information that has physically reached its location: one-way delays come from real distances and the speed of light in fiber or air. All company names, tickers and firms in the simulator are fictional; any resemblance to real companies or listings is coincidental.

The older **Pyramid Quote Lab** (`web/pyramid-lab.html`) is a single page: open the file directly in a browser.

## Research pipeline

| Command | What it does | Time / needs | Writes |
| --- | --- | --- | --- |
| `python src/run_demo.py` | Pyramid market maker on simulated prices; prints fills and the final P&L (one run can lose money) | seconds | `docs/pyramid_mm_demo.png` |
| `python src/recorder.py --minutes 60` | Records live order books, best bid/offer and trades (NASDAQ‑100 and gold by default) | as long as you set; internet | `data/raw/` |
| `python src/evaluate.py dev` | Grid search on the development window and freeze the best settings | minutes; needs the original recordings* | `data/frozen_choices.json` |
| `python src/evaluate.py holdout` | Run the frozen settings once on the holdout windows | minutes; needs the original recordings* | `data/results/holdout.json` |
| `python src/make_report.py` | Rebuild the report from the saved results | seconds | `docs/report.html` |
| `python -m unittest discover tests` | 19 tests of the replay engine | seconds | – |
| `node tests/sim_smoke.js us 30 news` | Simulator smoke test (fails if the market stops trading) | seconds | – |
| `node tests/sim_stress.js` | Simulator long-run health check, all scenarios | 1–2 minutes | – |
| `node tests/sim_stress.js stocks 2` | Every one of the 150 stocks, 2 simulated minutes each (`stocks 10` for 10) | about 1 minute (several for 10) | – |

\* The original recordings aren't in the repo, so these two print a message and leave the published results unchanged. With your own recordings, adjust the windows in `src/protocol.py`.

| File | What it does |
| --- | --- |
| `src/market_maker.py`, `src/price_sim.py` | Pyramid Avellaneda–Stoikov market maker and simulated markets |
| `src/spread_sweep.py`, `src/oos_test.py`, `src/upgrade_test.py`, `src/audit_sim.py` | Simulation experiments: quote-width sweep, out-of-sample check, strategy upgrades, audit of earlier claims |
| `src/recorder.py` | Records order book, best bid/offer and trades over websocket |
| `src/protocol.py` | The pre-registered development/holdout split and hypotheses |
| `src/analyze_book.py`, `src/audit_data.py` | Market statistics and data-quality checks on the recordings |
| `src/replay2.py` | Event-driven replay with queue position, latency and fees |
| `src/markouts.py`, `src/imbalance.py` | Model-free maker profit and imbalance statistics with bootstrap intervals |
| `src/evaluate.py`, `src/make_report.py`, `src/narrative.py` | Grid search on development data, frozen test on holdout, report |
| `data/`, `data/results/` | Saved statistics and results from the recordings (raw data not included) |
| `web/pyramid-lab.html` | Interactive pyramid quote lab with a 3D profit surface |
| `web/microsecond-market/` | The simulator (plain JavaScript and three.js, no build step) |

## Limitations

- About 8 hours of real data, from one day, on two markets.
- The replay can't test true microsecond speed: new orders go live at the next recorded event (about 0.1–0.3 s apart).
- The simulator uses made-up stocks. Locations, link speeds, fees, tick sizes and circuit-breaker rules follow public information and are approximate.

## Copyright

© 2026. All rights reserved. The code is public so you can read it and run it to see how it works. Please ask before copying, modifying or reusing it.
