"""Audit of the simulation results claimed earlier.

1. Calibration: the sim treated ATR(14, 1h) as one standard deviation of hourly moves.
   For a random walk the expected hourly high-low range is about 1.6 standard deviations,
   so that conversion overstates volatility. Measure the factor directly.
2. Re-run the headline claims on FRESH_SEEDS, which no earlier test used. Seeds 1000-1049
   were reused while the imbalance fix was designed, so they are no longer out of sample.
3. Re-run with volatility corrected to ATR / 1.6.

Usage:
    python src/audit_sim.py
"""
import numpy as np

from market_maker import MarketMakerConfig, run_pyramid_backtest
from price_sim import simulate_market
from protocol import FRESH_SEEDS

S0, ATR, N = 30911.0, 83.0, 7200
USER = dict(spread_mult=4.0, n_levels=7, size_taper=0.6, gamma=0.54)


def range_factor(n_hours=4000, seed=1):
    rng = np.random.default_rng(seed)
    x = np.cumsum(rng.standard_normal((n_hours, 3600)), axis=1)  # sigma = 1 per sqrt(second)
    hourly_sd = np.sqrt(3600)
    ranges = x.max(axis=1) - np.minimum(x.min(axis=1), 0)
    return ranges.mean() / hourly_sd


def evaluate(atr, flow, market_kw, strat_kw, seeds):
    pnl = []
    for s in seeds:
        p, imb, _ = simulate_market(S0, atr, N, seed=s, **market_kw)
        r = run_pyramid_backtest(p, MarketMakerConfig(**USER, A=flow, **strat_kw), seed=s + 7, imbalance=imb)
        pnl.append(r.pnl_path[-1])
    p = np.array(pnl)
    se = p.std(ddof=1) / np.sqrt(len(p))
    return p.mean(), se, (p > 0).mean()


def main():
    f = range_factor()
    print(f"1. Expected hourly high-low range = {f:.3f} x hourly standard deviation "
          f"(theory: sqrt(8/pi) = {np.sqrt(8 / np.pi):.3f}).")
    print(f"   So ATR {ATR} implies hourly sd ~{ATR / f:.1f} pts, not {ATR}. Sim volatility was {f:.2f}x too high.\n")

    seeds = list(FRESH_SEEDS)
    rows = [
        ("Claim: hand-picked settings, flow 2.0 = +504, 100% win", ATR, 2.0, {}, {}),
        ("Claim: hand-picked settings, flow 0.3 = +41, 74% win", ATR, 0.3, {}, {}),
        ("Claim: stormy+rho0.2 baseline = -167, 6% win", ATR, 0.3, dict(storm_rate=2, signal_rho=0.2), {}),
        ("Claim: stormy+rho0.2 both upgrades = +18, 58%", ATR, 0.3, dict(storm_rate=2, signal_rho=0.2),
         dict(vol_adapt=True, imbalance_skew=1.0)),
        ("Corrected vol: hand-picked settings, flow 2.0", ATR / f, 2.0, {}, {}),
        ("Corrected vol: hand-picked settings, flow 0.3", ATR / f, 0.3, {}, {}),
        ("Corrected vol: stormy+rho0.2 both upgrades", ATR / f, 0.3, dict(storm_rate=2, signal_rho=0.2),
         dict(vol_adapt=True, imbalance_skew=1.0)),
    ]
    print(f"2-3. Fresh seeds {seeds[0]}-{seeds[-1]} ({len(seeds)} paths). Mean +/- 1.96 standard errors.")
    for name, atr, flow, mk, st in rows:
        m, se, win = evaluate(atr, flow, mk, st, seeds)
        print(f"   {name:<50} {m:+8.1f} +/- {1.96 * se:6.1f}   win {win:5.0%}", flush=True)


if __name__ == "__main__":
    main()
