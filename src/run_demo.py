"""Run the pyramid market-making demo and plot the results.

Usage:
    python src/run_demo.py
"""
import matplotlib.pyplot as plt
import numpy as np

from market_maker import MarketMakerConfig, run_pyramid_backtest
from price_sim import simulate_price_path

# Calibration pulled live from Liquid (xyz:XYZ100, NASDAQ-100 proxy) on 2026-10-08:
# currentPrice=30911, ATR(14, 1h)=83.34
REAL_PRICE = 30911.0
REAL_HOURLY_ATR = 83.34

N_TICKS = 7200  # 2 hours at 1 tick/sec


def main():
    price_path = simulate_price_path(REAL_PRICE, REAL_HOURLY_ATR, N_TICKS, seed=42)

    cfg = MarketMakerConfig(
        gamma=0.1,
        kappa=1.5,
        A=0.3,
        n_levels=4,
        level_spacing=1.0,
        base_size=1.0,
        size_taper=0.6,
        max_inventory=50.0,
        spread_mult=4.0,  # width that earned the most on average in src/spread_sweep.py; a single run can still lose
    )

    result = run_pyramid_backtest(price_path, cfg, seed=7)

    buys = [f for f in result.fills if f.side == "buy"]
    sells = [f for f in result.fills if f.side == "sell"]
    total_spread_pnl = result.pnl_path[-1]

    print(f"Ticks simulated:        {N_TICKS}")
    print(f"Total fills:            {len(result.fills)} ({len(buys)} buys, {len(sells)} sells)")
    print(f"Final inventory:        {result.inventory_path[-1]:.2f} units")
    print(f"Final mark-to-market PnL: {total_spread_pnl:.2f}")
    print(f"Max inventory reached:  {np.max(np.abs(result.inventory_path)):.2f}")

    _plot(result, cfg)


def _plot(result, cfg):
    t = np.arange(len(result.mid_path))
    fig, axes = plt.subplots(3, 1, figsize=(12, 11))

    # Zoom to the busiest 300s window so individual pyramid levels are visible.
    fill_ticks = np.array([f.tick for f in result.fills])
    counts = np.bincount(fill_ticks // 300, minlength=len(t) // 300 + 1) if len(fill_ticks) else [0]
    w0 = int(np.argmax(counts)) * 300
    w1 = min(w0 + 300, len(t))
    tw = t[w0:w1]

    ax = axes[0]
    ax.plot(tw, result.mid_path[w0:w1], color="black", linewidth=1, label="mid price")
    for level in range(cfg.n_levels):
        d = result.half_spread_path[w0:w1] * (1 + level * cfg.level_spacing)
        r = result.reservation_path[w0:w1]
        alpha = 0.9 - 0.2 * level
        ax.plot(tw, r + d, color="tab:red", linewidth=0.7, alpha=alpha,
                label="ask ladder" if level == 0 else None)
        ax.plot(tw, r - d, color="tab:green", linewidth=0.7, alpha=alpha,
                label="bid ladder" if level == 0 else None)
    win = [f for f in result.fills if w0 <= f.tick < w1]
    ax.scatter([f.tick for f in win if f.side == "buy"], [f.price for f in win if f.side == "buy"],
               marker="^", color="green", s=40, zorder=3, label="we bought")
    ax.scatter([f.tick for f in win if f.side == "sell"], [f.price for f in win if f.side == "sell"],
               marker="v", color="red", s=40, zorder=3, label="we sold")
    ax.set_ylabel("price")
    ax.set_title(f"Pyramid quotes, {cfg.n_levels} levels per side (zoom: seconds {w0}-{w1})")
    ax.legend(loc="upper left", fontsize=8)

    ax2 = axes[1]
    skew = result.reservation_path - result.mid_path
    ax2.plot(t, result.inventory_path, color="tab:purple", label="inventory (units)")
    ax2.set_ylabel("inventory (units)", color="tab:purple")
    ax2.axhline(0, color="gray", linewidth=0.5)
    ax2b = ax2.twinx()
    ax2b.plot(t, skew, color="tab:orange", linewidth=0.8, label="quote skew (reservation - mid)")
    ax2b.set_ylabel("quote skew (price pts)", color="tab:orange")
    ax2.set_title("Inventory vs quote skew: short inventory pushes quotes UP, long pushes them DOWN")

    ax3 = axes[2]
    ax3.plot(t, result.pnl_path, color="tab:green")
    ax3.axhline(0, color="gray", linewidth=0.5)
    ax3.set_ylabel("mark-to-market PnL")
    ax3.set_xlabel("tick (seconds)")
    ax3.set_title("Cumulative PnL (no fees or latency modelled)")

    plt.tight_layout()
    out_path = "docs/pyramid_mm_demo.png"
    plt.savefig(out_path, dpi=150)
    print(f"Saved plot to {out_path}")


if __name__ == "__main__":
    main()
