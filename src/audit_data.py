"""Data-quality audit of the recorded books and trades.

Checks:
  1. Trade side meaning: do "B" trades print at the ask (buyer aggressed) or at the bid?
  2. Staleness: how often do trades print at prices the last book snapshot says were not
     the best bid/ask? High rates mean the ~5s snapshots miss book changes.
  3. Snapshot cadence, identical consecutive snapshots, and gaps (disconnects).

Usage:
    python src/audit_data.py
"""
import numpy as np

from analyze_book import coins_recorded, load


def audit(coin):
    books, trades = load(coin, "book"), load(coin, "trades")
    t = np.array([b["t"] for b in books], dtype=float) / 1000
    bb = np.array([b["bids"][0][0] for b in books])
    ba = np.array([b["asks"][0][0] for b in books])
    trades = [tr for tr in trades if t[0] <= tr["t"] / 1000 <= t[-1]]

    print(f"\n=== {coin}: {len(books)} snapshots, {len(trades)} trades, {(t[-1]-t[0])/3600:.2f} h ===")

    cats = {"B": {}, "A": {}}
    for tr in trades:
        i = int(np.searchsorted(t, tr["t"] / 1000, side="right")) - 1
        p = tr["px"]
        tol = 1e-9 + 1e-6 * p
        if abs(p - ba[i]) <= tol:
            c = "at ask"
        elif abs(p - bb[i]) <= tol:
            c = "at bid"
        elif p > ba[i]:
            c = "above ask"
        elif p < bb[i]:
            c = "below bid"
        else:
            c = "inside spread"
        cats[tr["side"]][c] = cats[tr["side"]].get(c, 0) + 1
    print("1. Where trades print vs the previous snapshot's best bid/ask:")
    for side, d in cats.items():
        n = sum(d.values()) or 1
        print(f"   side {side}: " + ", ".join(f"{k} {v} ({v/n:.0%})" for k, v in sorted(d.items(), key=lambda kv: -kv[1])))

    stale = sum(v for s in cats.values() for k, v in s.items() if k in ("above ask", "below bid", "inside spread"))
    print(f"2. Trades at prices not at the snapshot's best bid/ask: {stale}/{len(trades)} ({stale/max(len(trades),1):.1%})")

    gaps = np.diff(t)
    same = sum(1 for a, b in zip(books, books[1:]) if a["bids"] == b["bids"] and a["asks"] == b["asks"])
    print(f"3. Snapshot gap s: median {np.median(gaps):.2f}, p90 {np.quantile(gaps, .9):.2f}, max {gaps.max():.1f}; "
          f"gaps > 30s: {(gaps > 30).sum()}; identical consecutive snapshots: {same}/{len(books)-1}")
    crossed = int(np.sum(bb >= ba))
    print(f"   Crossed or locked books (bid >= ask): {crossed}")
    tt = np.array([tr["t"] for tr in trades]) / 1000
    if len(tt) > 1:
        print(f"   Trades sharing a timestamp with another trade: {np.mean(np.diff(tt) == 0):.0%} (one aggressive order sweeping several resting orders)")


if __name__ == "__main__":
    for c in coins_recorded():
        audit(c)
