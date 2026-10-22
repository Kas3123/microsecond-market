"""Sweep the strategy's quote width to show the spread-capture vs adverse-selection tradeoff.

Market behaviour (kappa, A) is held fixed; only our spread_mult changes.

Usage:
    python src/spread_sweep.py
"""
import numpy as np

from market_maker import MarketMakerConfig, run_pyramid_backtest
from price_sim import simulate_price_path

REAL_PRICE = 30911.0
REAL_HOURLY_ATR = 83.34
N_TICKS = 7200
SEEDS = range(5)


def main():
    print(f"{'mult':>6} {'half-spread':>12} {'fills':>7} {'mean PnL':>10} {'PnL std':>9} {'max |inv|':>10}")
    for mult in [1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 10.0]:
        pnls, fills, max_inv, spreads = [], [], [], []
        for seed in SEEDS:
            path = simulate_price_path(REAL_PRICE, REAL_HOURLY_ATR, N_TICKS, seed=seed)
            cfg = MarketMakerConfig(spread_mult=mult)
            r = run_pyramid_backtest(path, cfg, seed=seed + 100)
            pnls.append(r.pnl_path[-1])
            fills.append(len(r.fills))
            max_inv.append(np.max(np.abs(r.inventory_path)))
            spreads.append(np.mean(r.half_spread_path))
        print(f"{mult:>6.1f} {np.mean(spreads):>12.2f} {np.mean(fills):>7.0f} "
              f"{np.mean(pnls):>10.1f} {np.std(pnls):>9.1f} {np.mean(max_inv):>10.1f}")


if __name__ == "__main__":
    main()
