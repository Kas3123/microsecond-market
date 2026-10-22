# Overnight audit log — 2026-10-09

Running log of every flaw found, in my own work and in the data. Severity:
**critical** (changes the conclusion), **major** (changes numbers a lot), **minor**.

## Data and venue

1. **critical — Fees exceed the spread.** Real fees for a new account, from the markets' own
   settings and Hyperliquid's fee docs: NASDAQ‑100 (xyz:XYZ100, growth mode, deployer scale 1.0)
   maker ≈ 0.30 bp, taker ≈ 0.90 bp. Gold (xyz:GOLD, not in growth mode, deployer scale 1.0)
   maker ≈ 3.0 bp, taker ≈ 9.0 bp. Time-weighted spread ≈ 0.35 bp (XYZ100) and ≈ 0.24 bp (gold),
   so a maker earns at most ≈ 0.17 / 0.12 bp per fill before adverse selection. Every earlier
   result ignored fees.
2. **major — The 5.4 s book feed is stale.** The l2Book websocket sends on a fixed ~5.4 s timer.
   27% (gold) and 44% (XYZ100) of trades printed at prices the last snapshot did not show as best.
   The first replay (replay.py) decided on that stale view. Fixed: record the `bbo` channel
   (~0.1 s updates) and rebuild the replay on it (replay2.py); replay.py deleted.
3. **minor — Feed delay.** Quotes arrive ≈ 236 ms (median) after their exchange timestamp. The
   replay now adds 0.5 s latency by default and tests 0.25 s and 1 s.
4. **checked, OK — Trade side meaning.** "B" trades print at or above the ask, so "B" = buyer
   aggressed. The fill logic had it the right way round.
5. **major (framing) — These are crypto-venue markets.** Liquid is a front end over decentralized
   exchanges: `xyz:` markets are Hyperliquid HIP‑3 perpetuals deployed by "XYZ"; `LIT:QQQ` is on
   Lighter. Exposure is to stocks/gold, but settlement, fees and order books are crypto
   infrastructure (USDC on Hyperliquid). The project set out to avoid crypto markets, so the paper must say this.
6. **minor — Perpetual funding.** Funding was 0.000625%/hour on both markets (≈ 0.06 bp/hour on
   inventory). Negligible next to fees for positions held minutes; ignored, stated here.
7. **minor — Overnight session.** Most data is recorded while the NASDAQ cash market is closed;
   the perp then tracks an oracle (likely futures). XYZ100 traded 2.7 bp above oracle at 07:05
   UTC. US-open data is reported separately.

## Simulation (earlier work)

8. **major — Volatility calibration was 1.58× too high.** I treated ATR(14, 1h) as one standard
   deviation of hourly moves. For a random walk the mean hourly high-low range is ≈ 1.58 sd
   (measured; theory 1.596). Correcting it makes the simulation *more* profitable (the hand-picked settings,
   flow 0.3: +27 → +187).
9. **major — "Out-of-sample" seeds were reused.** Seeds 1000–1049 were used again while designing
   the imbalance fix. On 100 fresh seeds (5000–5099): hand-picked settings flow 2.0 +473 (claimed +504),
   flow 0.3 +27 ± 14 (claimed +41), storm baseline −147 (claimed −167), **both upgrades in storms
   +5 ± 26, win 50% (claimed +18, 58%) — the "profitable in storms" claim is retracted.**
10. **major — Simulation is circular.** Storms and a predictive imbalance were built into the
    simulated market, then strategies built for them won. Only real data can test them.
11. **major — Simulated fills are generous.** A quote fills whenever the next simulated price
    crosses it, with no queue and full size; plus random "noise" fills whose rate is a guess.
12. **minor — Earlier sweep confound (already fixed then).** kappa set both quote width and trader
    price-sensitivity.

## Statistics and reporting

13. **major — Overlapping windows inflated imbalance correlations.** analyze_book.py's gold
    "0.72 at 60 s" used overlapping windows on ~30 snapshots. Replaced by imbalance.py
    (non-overlapping samples, 10-minute block bootstrap); old code removed.
14. **minor — Cherry-picked summary line.** markouts.py printed the best of 18 depth×horizon
    cells. Replaced with a fixed, pre-chosen test (all fills, +60 s, vs fee).
15. **process — Pre-registered split.** DEV = before 10:00 UTC, HOLDOUT = after; US open from
    13:30 UTC. Fixed in protocol.py before any overnight data was analysed.

## Replay code (my own bugs, caught by tests)

16. **major — Filled orders were never re-posted** (strategy silently stopped quoting a side).
17. **major — Partly filled orders were topped up while keeping queue place** (optimistic).
18. **minor — Recording gaps** would let stale orders "fill" when data resumed. Now any gap > 30 s
    cancels everything.
19. **process — Tests were too weak at first.** Mutation testing showed 4 deliberate bugs passing
    the first 12 tests; now 19 tests catch all of them (one more added for the P&L split).

## DEV results (2.94 h, 07:03–10:00 UTC) — findings about the strategy itself

20. **critical — The "profitable" settings were directional luck.** Best NASDAQ‑100 setting on DEV
    (2 ticks back, no skew) made +$1.15 net: +$0.58 fill edge, **+$1.35 from holding a long
    position while the mid rose 6.8 bp**, −$0.71 fees. Its market-making P&L (fills marked 60 s
    later, minus fees) was −$0.98. A backtest that only reports net P&L would have called it a win.
21. **critical — 0 of 96 settings earn positive market-making P&L after fees on DEV, in either
    market.** Gold: 0% even with zero fees. NASDAQ‑100: 4% with zero fees, 0% with real fees.
22. **major — Back of the queue is the worst seat.** Market-wide, gold makers are roughly flat
    60 s after a fill; our strategy's gold fills lose ≈ 0.8 bp. A newcomer joins behind everyone,
    so it mostly fills right before the price moves through its level.
23. **major — Speed decides it.** NASDAQ‑100, 2 ticks back, 4 levels: as order delay rises from
    0 → 0.5 → 2 s, fills rise 39 → 171 → 381 and the 5 s markout falls +0.57 → −0.20 → −0.29 bp.
    The extra fills are stale quotes picked off. Even at ~0 delay it only breaks even after fees.
24. **limitation — "Zero delay" isn't really zero.** New orders go live at the next recorded event
    (~0.1–0.3 s apart), so the replay can't test true microsecond speed.
25. **interesting — Sweep fills look profitable market-wide.** NASDAQ‑100 makers filled 2+ ticks
    from the mid earn +0.54 bp at 60 s [+0.2, +0.9] vs a 0.30 bp fee. Found by scanning 48 cells,
    so pre-registered as H1 for the holdout. Our slow strategy can't capture it (finding 23).
26. **critical — Even the best fee tier can't save it.** Break-even maker fee (bp) on DEV is
    negative for every setting but one: you'd need a rebate of ≈ 0.1–0.3 bp (NASDAQ‑100) or
    ≈ 0.5–0.9 bp (gold). Hyperliquid's largest rebate is −0.003% (−0.3 bp), only above 3% of all
    exchange maker volume, and growth mode (NASDAQ‑100) cuts rebates by ≥ 90% (≈ −0.03 bp). Only
    one NASDAQ‑100 setting (2 back, 4 levels, lean) has a positive break-even, +0.06 bp.
27. **checked — Imbalance is real.** 1 s correlation 0.31 [0.30, 0.33] NASDAQ‑100, 0.14 [0.13,
    0.16] gold; fades within ~30 s. My simulated ρ = 0.2 was a reasonable guess. It still doesn't
    rescue the strategy: the lean helped fill quality slightly but not enough to cover fees.

## HOLDOUT results (10:00–15:00 UTC, settings frozen)

28. **critical — Confirmed on the holdout.** HOLDOUT (10:00–15:00 UTC, 4.99 h, settings frozen):
    0 of 96 settings earn positive market-making P&L in either market, overnight or after the US
    open. The development "winner" (+$1.15) lost −$13.86 when the price fell 40 bp.
29. **major — The US open is worse for makers.** NASDAQ‑100 orders filled at the best price lose
    0.36 bp a minute later after 06:30 Pacific, against 0.06 bp in development. More informed
    traders are active then.
30. **note — One small positive pocket.** In the overnight half of the holdout, 7% of NASDAQ‑100
    settings were slightly positive (best +$0.27). Out of 96 tries, a few will look good by chance,
    and this wasn't a pre-registered test, so it is not evidence of an edge.
31. **note — H1 not confirmed.** Deep sweep fills on NASDAQ‑100 averaged +0.35 bp at 60 s on the holdout,
    above the 0.30 bp fee, but the 95% interval [−0.20, +0.86] includes zero.
