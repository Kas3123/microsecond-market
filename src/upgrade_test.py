"""Test the two strategy upgrades on 50 unseen market paths per scenario.

Usage:
    python src/upgrade_test.py
"""
import numpy as np

from market_maker import MarketMakerConfig, run_pyramid_backtest
from price_sim import simulate_market

S0, ATR, N = 30911.0, 83.0, 7200
SEEDS = range(1000, 1050)
BASE = dict(spread_mult=4.0, n_levels=7, size_taper=0.6, gamma=0.54, A=0.3)

STRATS = {
    "baseline": {},
    "+ vol-adaptive": dict(vol_adapt=True),
    "+ imbalance skew": dict(imbalance_skew=1.0),
    "+ both": dict(vol_adapt=True, imbalance_skew=1.0),
}
MARKETS = {
    "calm, no signal (rho 0)": dict(storm_rate=0, signal_rho=0.0),
    "calm, signal rho 0.2": dict(storm_rate=0, signal_rho=0.2),
    "stormy (2/hr), no signal": dict(storm_rate=2, signal_rho=0.0),
    "stormy (2/hr), rho 0.2": dict(storm_rate=2, signal_rho=0.2),
}


def main():
    for mname, mkw in MARKETS.items():
        print(f"\n{mname}")
        print(f"  {'strategy':<20}{'avg':>7}{'win':>7}{'worst':>8}{'fills':>7}")
        mk = {s: simulate_market(S0, ATR, N, seed=s, **mkw) for s in SEEDS}
        for sname, skw in STRATS.items():
            cfg = MarketMakerConfig(**BASE, **skw)
            res = [run_pyramid_backtest(mk[s][0], cfg, seed=s + 7, imbalance=mk[s][1]) for s in SEEDS]
            p = np.array([r.pnl_path[-1] for r in res])
            f = np.mean([len(r.fills) for r in res])
            print(f"  {sname:<20}{p.mean():>7.0f}{(p > 0).mean() * 100:>6.0f}%{p.min():>8.0f}{f:>7.0f}")


if __name__ == "__main__":
    main()
