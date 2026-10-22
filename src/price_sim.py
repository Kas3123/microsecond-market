"""Simulated mid-price path calibrated to real market volatility.

We don't have a historical tick feed, so we generate a geometric Brownian
motion path whose volatility matches a real ATR(14) reading pulled live
from Liquid's NASDAQ-100 proxy (xyz:XYZ100), so the demo's price dynamics
are grounded in an actual market rather than an arbitrary made-up number.
"""
import numpy as np


def simulate_price_path(
    s0: float,
    hourly_atr: float,
    n_ticks: int,
    seed: int | None = None,
) -> np.ndarray:
    """GBM price path, one tick == one second.

    hourly_atr is converted to a per-second volatility assuming ATR scales
    roughly like one standard deviation of hourly moves.
    """
    rng = np.random.default_rng(seed)
    sigma_hourly = hourly_atr / s0
    sigma_sec = sigma_hourly / np.sqrt(3600)

    shocks = rng.standard_normal(n_ticks)
    log_returns = -0.5 * sigma_sec**2 + sigma_sec * shocks
    log_path = np.log(s0) + np.cumsum(log_returns)
    return np.exp(log_path)


def simulate_market(
    s0: float,
    hourly_atr: float,
    n_ticks: int,
    seed: int | None = None,
    storm_rate: float = 0.0,
    storm_mult: float = 3.0,
    storm_len: float = 300.0,
    signal_rho: float = 0.0,
):
    """Price path with optional volatility storms and an order-book imbalance signal.

    storm_rate: expected storms per hour; each lasts ~storm_len seconds at storm_mult x volatility.
    signal_rho: correlation between imbalance[t] and the price move from t to t+1.
        0 means the book tells you nothing. This is an assumption to calibrate
        against real Liquid order-book recordings, not a measured value.

    Returns (prices, imbalance in [-1, 1], storm flag per tick).
    """
    rng = np.random.default_rng(seed)
    sigma_sec = (hourly_atr / s0) / np.sqrt(3600)

    storm = np.zeros(n_ticks, dtype=bool)
    p_start, p_end = storm_rate / 3600, 1 / storm_len
    on = False
    for t in range(n_ticks):
        on = (rng.random() >= p_end) if on else (rng.random() < p_start)
        storm[t] = on

    z = rng.standard_normal(n_ticks)
    vol = sigma_sec * np.where(storm, storm_mult, 1.0)
    log_returns = -0.5 * vol**2 + vol * z
    prices = np.exp(np.log(s0) + np.cumsum(log_returns))

    # imbalance[t] leans toward the sign of the NEXT tick's shock z[t+1].
    nxt = np.append(z[1:], 0.0)
    raw = signal_rho * nxt + np.sqrt(1 - signal_rho**2) * rng.standard_normal(n_ticks)
    imbalance = np.tanh(raw)
    return prices, imbalance, storm
