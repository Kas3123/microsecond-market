"""Describe the recorded markets: spread, depth, trade flow, volatility.

Imbalance predictiveness lives in imbalance.py (non-overlapping windows, bootstrap
intervals). An earlier version of this file measured it with overlapping windows, which
inflated the correlations, so that code was removed.

Usage:
    python src/analyze_book.py --window dev
Writes data/market_stats_<window>.json.
"""
import argparse
import glob
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"


def load(coin, kind):
    rows = []
    for f in sorted(glob.glob(str(RAW / "*" / f"{coin.replace(':', '_')}_*_{kind}.jsonl"))):
        with open(f) as fh:
            rows += [json.loads(line) for line in fh if line.strip()]
    rows.sort(key=lambda r: r["t"])
    if kind == "trades":  # each (re)connect replays recent trades, so drop repeats
        seen, out = set(), []
        for r in rows:
            if r["tid"] not in seen:
                seen.add(r["tid"])
                out.append(r)
        rows = out
    return rows


def coins_recorded():
    names = {Path(f).name.rsplit("_", 2)[0] for f in glob.glob(str(RAW / "*" / "*_book.jsonl"))}
    return sorted(n.replace("_", ":", 1) for n in names)


def tick_size(prices):
    px = np.unique(np.round(prices, 6))
    gaps = np.diff(px)
    gaps = gaps[gaps > 1e-9]
    return float(np.round(gaps.min(), 6)) if len(gaps) else float("nan")


def analyze(coin, window):
    from protocol import WINDOWS, split
    start, end = WINDOWS[window]
    bbo = [b for b in split(load(coin, "bbo"), start, end) if b["bid"] and b["ask"]]
    books = split(load(coin, "book"), start, end)
    trades = split(load(coin, "trades"), start, end)
    if len(bbo) < 100:
        return {"coin": coin, "error": "not enough data"}

    t = np.array([b["t"] for b in bbo], dtype=float) / 1000
    bid = np.array([b["bid"][0] for b in bbo])
    ask = np.array([b["ask"][0] for b in bbo])
    tick = tick_size(np.concatenate([bid[:5000], ask[:5000]]))
    mid, spread = (bid + ask) / 2, ask - bid
    # Time-weight: each quote state lasts until the next update.
    dur = np.diff(t, append=t[-1])
    w = dur / dur.sum()
    hours = (t[-1] - t[0]) / 3600

    changes = np.diff(np.log(mid))
    vol_hourly_bps = float(np.sqrt(np.sum(changes**2) / (t[-1] - t[0]) * 3600) * 1e4)

    b5 = [sum(l[1] for l in b["bids"][:5]) for b in books]
    a5 = [sum(l[1] for l in b["asks"][:5]) for b in books]
    sizes = np.array([x["sz"] for x in trades]) if trades else np.array([np.nan])
    notional = sum(x["sz"] * x["px"] for x in trades)
    gaps = np.diff(t)

    return {
        "coin": coin,
        "window": window,
        "hours": round(hours, 2),
        "quote_updates": len(bbo),
        "quote_updates_per_s": round(len(bbo) / max(hours * 3600, 1), 2),
        "recording_gaps_over_30s": int(np.sum(gaps > 30)),
        "tick": tick,
        "mid_first_last": [float(mid[0]), float(mid[-1])],
        "spread_one_tick_time_share": round(float(np.sum(w * np.isclose(spread, tick))), 3),
        "spread_mean_ticks_time_weighted": round(float(np.sum(w * spread / tick)), 3),
        "spread_mean_bps_time_weighted": round(float(np.sum(w * spread / mid * 1e4)), 3),
        "best_level_size_median": {"bid": float(np.median([b["bid"][1] for b in bbo])),
                                   "ask": float(np.median([b["ask"][1] for b in bbo]))},
        "top5_depth_median": {"bid": float(np.median(b5)) if b5 else None,
                              "ask": float(np.median(a5)) if a5 else None},
        "trades": len(trades),
        "trades_per_min": round(len(trades) / max(hours * 60, 1e-9), 2),
        "trade_size_median": float(np.median(sizes)),
        "notional_per_hour_usd": round(notional / max(hours, 1e-9)),
        "buyer_initiated_share": round(float(np.mean([x["side"] == "B" for x in trades])), 3) if trades else None,
        "realized_vol_hourly_bps": round(vol_hourly_bps, 2),
    }


def main():
    from protocol import WINDOWS
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", default="dev", choices=list(WINDOWS))
    args = ap.parse_args()
    stats = {c: analyze(c, args.window) for c in coins_recorded()}
    for c, s in stats.items():
        print(f"\n=== {c} [{args.window}] ===")
        for k, v in s.items():
            if k not in ("coin", "window"):
                print(f"  {k}: {v}")
    path = ROOT / "data" / f"market_stats_{args.window}.json"
    path.write_text(json.dumps(stats, indent=2))
    print(f"\nWrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
