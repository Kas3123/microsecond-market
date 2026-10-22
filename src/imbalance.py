"""Does top-of-book imbalance predict the next mid-price move? Measured properly.

Imbalance = (bid size - ask size) / (bid size + ask size) at the best prices.
For each horizon h we sample the book every h seconds (non-overlapping windows, so each
observation is independent of the next) and correlate imbalance with the mid change over
the following h seconds. 95% intervals come from a block bootstrap over 10-minute blocks.

The 1-second correlation is the real-data counterpart of the simulation's rho (which I
assumed was 0.2).

Usage:
    python src/imbalance.py --window dev
"""
import argparse
import json
from pathlib import Path

import numpy as np

from analyze_book import coins_recorded, load
from protocol import WINDOWS, split

ROOT = Path(__file__).resolve().parent.parent
HORIZONS = [1, 5, 30, 60]


def series(coin, window):
    start, end = WINDOWS[window]
    bbo = [b for b in split(load(coin, "bbo"), start, end) if b["bid"] and b["ask"]]
    t = np.array([b["t"] for b in bbo], dtype=float) / 1000
    mid = np.array([(b["bid"][0] + b["ask"][0]) / 2 for b in bbo])
    bs = np.array([b["bid"][1] for b in bbo])
    az = np.array([b["ask"][1] for b in bbo])
    return t, mid, (bs - az) / (bs + az)


def at(t, x, when):
    i = np.searchsorted(t, when, side="right") - 1
    return x[np.clip(i, 0, len(x) - 1)]


def corr_ci(x, y, blocks, n_boot=2000, seed=0):
    if np.std(x) == 0 or np.std(y) == 0:
        return 0.0, (0.0, 0.0)
    c = float(np.corrcoef(x, y)[0, 1])
    ids = np.unique(blocks)
    rng = np.random.default_rng(seed)
    idx = {b: np.where(blocks == b)[0] for b in ids}
    boots = []
    for _ in range(n_boot):
        sel = np.concatenate([idx[b] for b in rng.choice(ids, len(ids))])
        xs, ys = x[sel], y[sel]
        if np.std(xs) > 0 and np.std(ys) > 0:
            boots.append(np.corrcoef(xs, ys)[0, 1])
    return c, tuple(np.quantile(boots, [0.025, 0.975])) if boots else (np.nan, np.nan)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", default="dev", choices=list(WINDOWS))
    args = ap.parse_args()
    out = {}
    for coin in coins_recorded():
        t, mid, imb = series(coin, args.window)
        if len(t) < 500:
            print(f"{coin} [{args.window}]: not enough data")
            continue
        hours = (t[-1] - t[0]) / 3600
        print(f"\n=== {coin} [{args.window}] {hours:.2f} h, {len(t)} quote updates ===")
        print(f"  {'horizon':>8}{'samples':>9}{'corr':>8}{'95% interval':>20}{'mid moved':>11}")
        out[coin] = {}
        for h in HORIZONS:
            grid = np.arange(t[0], t[-1] - h, h)
            x = at(t, imb, grid)
            y = at(t, mid, grid + h) - at(t, mid, grid)
            blocks = (grid // 600).astype(int)
            c, (lo, hi) = corr_ci(x, y, blocks)
            moved = float(np.mean(y != 0))
            out[coin][h] = {"corr": round(c, 4), "ci": [round(float(lo), 4), round(float(hi), 4)],
                            "n": len(grid), "share_mid_moved": round(moved, 3)}
            print(f"  {h:>7}s{len(grid):>9}{c:>8.3f}   [{lo:+.3f}, {hi:+.3f}]{moved:>10.0%}")
    path = ROOT / "data" / f"imbalance_{args.window}.json"
    path.write_text(json.dumps(out, indent=1))
    print(f"\nWrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
