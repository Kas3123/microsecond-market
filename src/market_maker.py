"""Pyramid (laddered) Avellaneda-Stoikov market maker.

Core idea ("the math that explains the market gap"): a market maker earns
the bid-ask spread by always quoting both sides. The two risks are
(1) adverse selection from quoting too tight, and (2) inventory risk from
accumulating a one-sided position if the market trends. Avellaneda-Stoikov
(2008) solves for the quotes that balance spread capture against inventory
risk. We use the stationary (infinite-horizon) simplification of their
model -- appropriate for a continuous trading session rather than a single
episode that expires at time T, since we don't want the spread to
artificially collapse to zero as a fixed horizon approaches:

    reservation price:   r = mid - q * gamma * sigma^2 / kappa
    optimal half-spread: delta = (gamma * sigma^2) / (2 * kappa)
                                  + (1 / gamma) * ln(1 + gamma / kappa)

    bid = r - delta
    ask = r + delta

q is current inventory (can be negative = short). As q grows positive
(long), r shifts DOWN -> both quotes shift down, making the ask cheaper
(sell faster) and the bid less attractive (buy slower). As q goes
negative (short), r shifts UP -> "putting the price up higher" to
encourage buy-backs and discourage further selling. That inventory-driven
skew is the mechanism this demo is meant to show.

"Pyramid" extension: instead of one bid/ask pair, we ladder N price
levels on each side at increasing distance from the reservation price,
with size tapering outward (biggest size closest to the reservation
price, smaller further out) - a common real-market-making technique to
capture more volume while still controlling adverse selection on the
outer, worse-priced levels.
"""
from dataclasses import dataclass, field

import numpy as np


@dataclass
class Fill:
    tick: int
    side: str  # "buy" or "sell" from the market maker's perspective
    price: float
    size: float
    level: int


@dataclass
class MarketMakerConfig:
    gamma: float = 0.1       # inventory risk aversion
    kappa: float = 1.5       # order book liquidity decay parameter
    A: float = 0.3           # uninformed (noise) order arrivals per second at the mid
    n_levels: int = 4        # pyramid depth per side
    level_spacing: float = 1.0   # extra half-spread multiples added per level out
    base_size: float = 1.0       # size at the innermost level
    size_taper: float = 0.6      # size multiplier applied per level out
    max_inventory: float = 50.0  # hard inventory cap (risk limit)
    spread_mult: float = 1.0     # strategy's own widening of the A-S spread; kappa stays a market property
    fee: float = 0.0             # cost per unit filled, in price points
    # Upgrade 1: volatility-adaptive width. Compares 30s realized vol to a 10-minute baseline.
    vol_adapt: bool = False
    pause_ratio: float = 2.0     # stop quoting entirely when short vol > this x baseline
    # Upgrade 2: lean the reservation price toward the side the order book predicts.
    imbalance_skew: float = 0.0  # 1.0 = shift by the full predicted next move; 0 = off


@dataclass
class BacktestResult:
    mid_path: np.ndarray
    reservation_path: np.ndarray
    half_spread_path: np.ndarray
    inventory_path: np.ndarray
    cash_path: np.ndarray
    pnl_path: np.ndarray
    fills: list[Fill] = field(default_factory=list)


def _fill_probability(distance: float, A: float, kappa: float, dt: float = 1.0) -> float:
    """Poisson fill intensity decaying with distance from mid (A-S model),
    converted to a per-tick probability."""
    intensity = A * np.exp(-kappa * distance)
    return 1.0 - np.exp(-intensity * dt)


def run_pyramid_backtest(
    price_path: np.ndarray,
    cfg: MarketMakerConfig,
    seed: int | None = None,
    imbalance: np.ndarray | None = None,
) -> BacktestResult:
    rng = np.random.default_rng(seed)
    n = len(price_path)
    log_rets = np.diff(np.log(price_path), prepend=np.log(price_path[0]))
    sq = np.cumsum(log_rets**2)

    def realized(t, w):
        a = max(0, t - w)
        k = t - a
        return np.sqrt((sq[t] - sq[a]) / k) if k >= 5 else None

    inventory = 0.0
    cash = 0.0
    sxy = sxx = 0.0

    inventory_path = np.zeros(n)
    cash_path = np.zeros(n)
    pnl_path = np.zeros(n)
    reservation_path = np.zeros(n)
    half_spread_path = np.zeros(n)
    fills: list[Fill] = []

    for t in range(n):
        mid = price_path[t]
        next_mid = price_path[t + 1] if t + 1 < n else mid
        sigma_est = _local_vol(price_path, t)

        # Long inventory (q>0) pulls r below mid; short (q<0) pushes r above
        # mid -- the "price goes up when we're short" skew.
        reservation = mid - inventory * cfg.gamma * sigma_est**2 / cfg.kappa

        base_half_spread = cfg.spread_mult * (
            cfg.gamma * sigma_est**2 / (2 * cfg.kappa)
            + (1 / cfg.gamma) * np.log(1 + cfg.gamma / cfg.kappa)
        )

        quoting = True
        if cfg.vol_adapt:
            short, base = realized(t, 30), realized(t, 600)
            if short is not None and base is not None and base > 0:
                ratio = short / base
                base_half_spread *= max(1.0, ratio)
                quoting = ratio <= cfg.pause_ratio

        if imbalance is not None and cfg.imbalance_skew:
            # Learn beta = cov(imbalance[s-1], return[s]) / var(imbalance) from past ticks only.
            if t >= 1:
                i_prev, r_now = imbalance[t - 1], log_rets[t]
                sxy += i_prev * r_now
                sxx += i_prev * i_prev
            if t >= 60 and sxx > 0:
                beta = sxy / sxx
                reservation += cfg.imbalance_skew * beta * imbalance[t] * mid

        reservation_path[t] = reservation
        half_spread_path[t] = base_half_spread

        if not quoting:
            inventory_path[t] = inventory
            cash_path[t] = cash
            pnl_path[t] = cash + inventory * mid
            continue

        can_buy = inventory < cfg.max_inventory
        can_sell = inventory > -cfg.max_inventory

        for level in range(cfg.n_levels):
            distance = base_half_spread * (1 + level * cfg.level_spacing)
            size = cfg.base_size * (cfg.size_taper ** level)

            bid_price = reservation - distance
            ask_price = reservation + distance

            # Two fill sources: informed flow (price moves through our quote,
            # i.e. adverse selection) and random uninformed flow.
            if can_buy:
                crossed = next_mid <= bid_price
                noise = rng.random() < _fill_probability(mid - bid_price, cfg.A, cfg.kappa)
                if crossed or noise:
                    inventory += size
                    cash -= (bid_price + cfg.fee) * size
                    fills.append(Fill(t, "buy", bid_price, size, level))
                    can_buy = inventory < cfg.max_inventory

            if can_sell:
                crossed = next_mid >= ask_price
                noise = rng.random() < _fill_probability(ask_price - mid, cfg.A, cfg.kappa)
                if crossed or noise:
                    inventory -= size
                    cash += (ask_price - cfg.fee) * size
                    fills.append(Fill(t, "sell", ask_price, size, level))
                    can_sell = inventory > -cfg.max_inventory

        inventory_path[t] = inventory
        cash_path[t] = cash
        pnl_path[t] = cash + inventory * mid  # mark-to-market

    return BacktestResult(
        mid_path=price_path,
        reservation_path=reservation_path,
        half_spread_path=half_spread_path,
        inventory_path=inventory_path,
        cash_path=cash_path,
        pnl_path=pnl_path,
        fills=fills,
    )


def _local_vol(price_path: np.ndarray, t: int, window: int = 300) -> float:
    """Rolling realized volatility (per-tick, in price units) used in place
    of a fixed sigma so the model reacts to changing conditions."""
    start = max(0, t - window)
    window_slice = price_path[start : t + 1]
    if len(window_slice) < 5:
        return price_path[0] * 1e-5
    log_rets = np.diff(np.log(window_slice))
    return max(np.std(log_rets) * price_path[t], 1e-6)
