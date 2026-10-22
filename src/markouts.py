"""Model-free test: does providing liquidity pay on this venue?

For every real trade, take the passive side (the resting order that got filled) and measure
its profit "markout" at several horizons:

    markout_h = maker_sign * (mid(t + h) - trade_price) / trade_price   [basis points]

maker_sign = +1 when the maker bought (aggressor sold, side "A"), -1 when the maker sold.
h = 0 is the spread captured at the moment of the fill; later horizons subtract adverse
selection (the price moving against the maker after the fill).

Grouped by how far the trade printed from the pre-trade mid, in ticks, so we can see
whether resting deeper in the book (the pyramid idea) earns more than resting at the top.
Confidence intervals use a block bootstrap over 5-minute blocks because trades cluster.

Usage:
    python src/markouts.py                      # dev window only (see protocol.py)
    python src/markouts.py --window holdout
"""
import argparse
import json
from pathlib import Path

import numpy as np

from analyze_book import coins_recorded, load, tick_size
from protocol import WINDOWS, split

ROOT = Path(__file__).resolve().parent.parent
HORIZONS = [0, 1, 5, 30, 60, 300]
# All-in maker / taker fee in bps for a new (tier 0) account, from the market's own
# settings on 2026-10-09: XYZ100 growth mode with deployer scale 1.0, GOLD not in growth mode.
FEES = {"xyz:XYZ100": {"maker": 0.30, "taker": 0.90}, "xyz:GOLD": {"maker": 3.0, "taker": 9.0}}
# Session 2 candidates: all growth mode with deployer scale 1.0 in the 2026-10-09 scan.
FEES.update({c: {"maker": 0.30, "taker": 0.90} for c in
             ("xyz:CXMT", "xyz:AMD", "xyz:MRNA", "xyz:HOOD", "xyz:COIN", "xyz:CRCL", "xyz:SOXL", "xyz:ORCL")})


def bbo_mid(bbo):
    t = np.array([b["t"] for b in bbo if b["bid"] and b["ask"]], dtype=float) / 1000
    mid = np.array([(b["bid"][0] + b["ask"][0]) / 2 for b in bbo if b["bid"] and b["ask"]])
    return t, mid


def block_bootstrap_ci(values, blocks, n_boot=2000, seed=0):
    rng = np.random.default_rng(seed)
    ids = np.unique(blocks)
    if len(ids) < 3:
        return (np.nan, np.nan)
    by = {b: values[blocks == b] for b in ids}
    means = []
    for _ in range(n_boot):
        pick = rng.choice(ids, size=len(ids), replace=True)
        v = np.concatenate([by[b] for b in pick])
        means.append(v.mean())
    return tuple(np.quantile(means, [0.025, 0.975]))


def markouts(coin, window):
    start, end = WINDOWS[window]
    bbo = [b for b in split(load(coin, "bbo"), start, end) if b["bid"] and b["ask"]]
    trades = split(load(coin, "trades"), start, end)
    if len(bbo) < 100 or len(trades) < 50:
        return None, None
    tick = tick_size([b["bid"][0] for b in bbo[:5000]] + [b["ask"][0] for b in bbo[:5000]])
    t, mid = bbo_mid(bbo)
    rows = []
    for tr in trades:
        ts = tr["t"] / 1000
        i0 = int(np.searchsorted(t, ts, side="left")) - 1  # last quote strictly before the trade
        if i0 < 0:
            continue
        m0 = mid[i0]
        sign = 1 if tr["side"] == "A" else -1
        dist = abs(tr["px"] - m0) / tick
        row = {"t": ts, "dist": dist, "sz": tr["sz"], "notional": tr["sz"] * tr["px"]}
        for h in HORIZONS:
            if h == 0:
                m = m0
            else:
                j = int(np.searchsorted(t, ts + h, side="right")) - 1
                if t[-1] < ts + h:
                    m = np.nan
                else:
                    m = mid[j]
            row[h] = sign * (m - tr["px"]) / tr["px"] * 1e4
        rows.append(row)
    return rows, tick


def summarize(coin, window):
    rows, tick = markouts(coin, window)
    if not rows:
        print(f"{coin} [{window}]: not enough data")
        return None
    fee = FEES.get(coin, {"maker": np.nan})["maker"]
    hours = (rows[-1]["t"] - rows[0]["t"]) / 3600
    print(f"\n=== {coin} [{window}] {len(rows)} trades over {hours:.2f} h, tick {tick}, maker fee {fee} bp ===")
    buckets = [("at touch (<=0.75 tick)", 0, 0.75), ("1-2 ticks", 0.75, 2.0), ("2+ ticks (sweeps)", 2.0, 1e9)]
    out = {}
    head = "".join(f"{('+' + str(h) + 's') if h else 'fill':>16}" for h in HORIZONS)
    print(f"  {'depth from mid':<24}{'trades':>7}{head}")
    for name, lo, hi in buckets + [("ALL", 0, 1e9)]:
        sel = [r for r in rows if lo <= r["dist"] < hi]
        if len(sel) < 10:
            continue
        cells, res = [], {}
        blocks = np.array([int(r["t"] // 300) for r in sel])
        for h in HORIZONS:
            v = np.array([r[h] for r in sel])
            ok = ~np.isnan(v)
            if ok.sum() == 0:
                res[h] = {"mean": None, "ci": [None, None], "n": 0}
                cells.append(f"{'n/a':>6}")
                continue
            m = v[ok].mean()
            lo_ci, hi_ci = block_bootstrap_ci(v[ok], blocks[ok])
            res[h] = {"mean": round(float(m), 3), "ci": [round(float(lo_ci), 3), round(float(hi_ci), 3)], "n": int(ok.sum())}
            cells.append(f"{m:+6.2f} [{lo_ci:+.1f},{hi_ci:+.1f}]")
        out[name] = res
        print(f"  {name:<24}{len(sel):>7}" + "".join(f"{c:>16}" for c in cells))
    # Size-weighted: larger trades tend to be better informed, so dollars can tell a different story.
    for h in (5, 60):
        v = np.array([r[h] for r in rows])
        w = np.array([r["notional"] for r in rows])
        ok = ~np.isnan(v)
        if ok.any():
            out["ALL"][f"{h}_notional_weighted"] = round(float(np.average(v[ok], weights=w[ok])), 3)
    print(f"  Size-weighted, all fills: +5s {out['ALL'].get('5_notional_weighted')} bp, "
          f"+60s {out['ALL'].get('60_notional_weighted')} bp")
    # Fixed in advance (no picking the best of many cells): all fills, 60 seconds later.
    a = out["ALL"][60]
    print(f"  Pre-chosen test, all fills at +60s: {a['mean']:+.2f} bp [{a['ci'][0]:+.2f}, {a['ci'][1]:+.2f}] "
          f"vs maker fee {fee} bp -> {'covers' if a['ci'][0] is not None and a['ci'][0] > fee else 'does not cover'} the fee")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", default="dev", choices=list(WINDOWS))
    args = ap.parse_args()
    results = {c: summarize(c, args.window) for c in coins_recorded()}
    path = ROOT / "data" / f"markouts_{args.window}.json"
    path.write_text(json.dumps(results, indent=1))
    print(f"\nWrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
