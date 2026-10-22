"""Evaluation protocol, fixed on 2026-10-09 ~07:05 UTC before any overnight data was analysed.

DEV:      every recorded tick before DEV_END. Design decisions, parameter choices and bug
          fixes may use this data as often as needed.
HOLDOUT:  every tick from DEV_END onward. Touched once, at the end, with settings frozen.
US_OPEN:  part of HOLDOUT. NASDAQ cash session opens 13:30 UTC (06:30 Pacific); reported
          separately because the underlying index only trades then.

Simulation claims are re-checked on fresh seeds FRESH_SEEDS, never used before.
"""
from datetime import datetime, timezone

DEV_END = datetime(2026, 10, 9, 10, 0, tzinfo=timezone.utc).timestamp()
US_OPEN = datetime(2026, 10, 9, 13, 30, tzinfo=timezone.utc).timestamp()
FRESH_SEEDS = range(5000, 5100)

# Hypotheses written down at 2026-10-09 10:10 UTC after seeing DEV markouts, before HOLDOUT.
# H1 came from scanning 48 depth x horizon x coin cells, so it needs the holdout to count.
HYPOTHESES = {
    "H1": "xyz:XYZ100 maker fills printed 2+ ticks from the pre-trade mid have a mean +60s markout "
          "above the 0.30 bp maker fee (lower end of the 95% block-bootstrap interval > 0.30).",
    "H2": "Maker fills at the touch (<= 0.75 tick from mid) do not cover the maker fee at +60s in "
          "either market (upper end of the 95% interval < fee).",
    "H3": "Top-of-book imbalance has a positive 1-second correlation with the next mid move in both "
          "markets (lower end of the 95% interval > 0).",
    # Added 10:35 UTC after the DEV grid and latency runs, still before HOLDOUT.
    "H4": "No setting in the 96-setting grid earns positive market-making P&L (fills marked 60s later, "
          "minus tier-0 fees) in either market; the frozen best_mm settings lose on HOLDOUT too.",
    "H5": "For xyz:XYZ100 quoting 2 ticks back with 4 levels, the 5s markout of our fills falls as "
          "latency rises (0s > 0.5s > 2s).",
}

# Session 2, fixed 2026-10-09 ~15:15 UTC before recording started. Candidate markets were chosen from a
# one-snapshot scan of all xyz markets (24h volume >= ~$8M and half-spread well above the 0.30 bp fee).
SESSION2_COINS = ["xyz:CXMT", "xyz:AMD", "xyz:MRNA", "xyz:HOOD", "xyz:COIN", "xyz:CRCL", "xyz:SOXL", "xyz:ORCL"]
DEV2_START = datetime(2026, 10, 9, 15, 15, tzinfo=timezone.utc).timestamp()
DEV2_END = datetime(2026, 10, 9, 17, 40, tzinfo=timezone.utc).timestamp()     # 10:40 Pacific
HYPOTHESES_SESSION2 = {
    "S1": "In at least one candidate market, maker fills at the best price have a mean +60s markout above "
          "that market's maker fee on HOLDOUT2 (lower end of the 95% interval > fee). With 8 markets tested, "
          "the interval is widened to 99.4% (Bonferroni) before calling it.",
    "S2": "Across the candidates, a wider spread does not translate one-for-one into maker profit: the "
          "+60s markout at the best price is below half the spread in every candidate market.",
}

WINDOWS = {"dev": (None, DEV_END), "holdout": (DEV_END, None), "us_open": (US_OPEN, None),
           "holdout_overnight": (DEV_END, US_OPEN), "all": (None, None),
           "dev2": (DEV2_START, DEV2_END), "holdout2": (DEV2_END, None)}


def split(rows, start=None, end=None):
    """Rows with 't' in milliseconds, kept when start <= t/1000 < end."""
    lo = start if start is not None else float("-inf")
    hi = end if end is not None else float("inf")
    return [r for r in rows if lo <= r["t"] / 1000 < hi]
