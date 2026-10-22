"""Out-of-sample test of hand-picked settings on 50 unseen price paths.

Usage:
    python src/oos_test.py
"""
import numpy as np

from market_maker import MarketMakerConfig, run_pyramid_backtest
from price_sim import simulate_price_path

S0, N_TICKS = 30911.0, 7200
SEEDS = range(1000, 1050)  # the web page only ever uses seeds 1-50

CHOSEN = dict(spread_mult=4.0, n_levels=7, size_taper=0.6, gamma=0.54, max_inventory=50.0)


RUNS = []


def evaluate(name, atr, flow, fee):
    pnls, fills = [], []
    for s in SEEDS:
        path = simulate_price_path(S0, atr, N_TICKS, seed=s)
        r = run_pyramid_backtest(path, MarketMakerConfig(**CHOSEN, A=flow, fee=fee), seed=s + 7)
        pnls.append(r.pnl_path[-1])
        fills.append(len(r.fills))
        RUNS.append(dict(
            scenario=name, seed=s, atr=atr, flow=flow, fee=fee,
            pnl=round(float(r.pnl_path[-1]), 2), fills=len(r.fills),
            max_abs_inventory=round(float(np.max(np.abs(r.inventory_path))), 2),
            worst_drawdown=round(float(np.min(r.pnl_path - np.maximum.accumulate(r.pnl_path))), 2),
            price_change=round(float(path[-1] - path[0]), 2),
        ))
    p = np.array(pnls)
    return p.mean(), np.median(p), (p > 0).mean(), p.min(), p.max(), np.mean(fills)


def main():
    print(f"{'scenario':<34}{'mean':>8}{'median':>8}{'win %':>7}{'worst':>8}{'best':>8}{'fills':>7}")
    rows = [
        ("Your settings (flow 2.0, fee 0)", 81, 2.0, 0.0),
        ("Flow 2.0, fee 0.10", 81, 2.0, 0.10),
        ("Flow 2.0, fee 0.25", 81, 2.0, 0.25),
        ("Flow 2.0, fee 0.50", 81, 2.0, 0.50),
        ("Default flow 0.3, fee 0", 81, 0.3, 0.0),
        ("Flow 0.3, fee 0.10", 81, 0.3, 0.10),
        ("Flow 2.0, double volatility", 162, 2.0, 0.0),
    ]
    for name, atr, flow, fee in rows:
        m, med, win, lo, hi, f = evaluate(name, atr, flow, fee)
        print(f"{name:<34}{m:>8.0f}{med:>8.0f}{win*100:>6.0f}%{lo:>8.0f}{hi:>8.0f}{f:>7.0f}")

    import csv, json
    with open("data/oos_runs.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(RUNS[0]))
        w.writeheader()
        w.writerows(RUNS)
    with open("data/oos_runs.json", "w") as fh:
        json.dump(RUNS, fh, separators=(",", ":"))
    print(f"Wrote {len(RUNS)} runs to data/oos_runs.csv and data/oos_runs.json")


if __name__ == "__main__":
    main()
