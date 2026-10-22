"""Event-driven market-making replay on recorded best-bid/offer updates, books and trades.

Strategy, in ticks (prices only move in whole ticks, so this is the honest unit):
    shift  = -skew_ticks * (inventory / base_size)  [+ imbalance lean]     (Avellaneda-Stoikov
             reservation-price skew: hold too much -> quote lower to sell it off)
    bid    = best_bid + (round(shift) - offset_ticks) * tick, never above best_ask - tick
    ask    = best_ask + (round(shift) + offset_ticks) * tick, never below best_bid + tick
    extra pyramid levels sit 1 tick further out each, size tapering by size_taper.
    pause  = cancel everything while 30s realized volatility > pause_ratio x 10-minute volatility.

Realism:
    - Decisions are made on every top-of-book change but only take effect latency_s later.
    - Queue: a new order joins behind all displayed size at its price. Trades at our price eat
      the queue ahead of us first; displayed size shrinking (cancellations) caps the queue ahead.
    - fill_mode "optimistic" ignores the queue; "conservative" fills only on trades through us.
    - Maker fee on every fill; final P&L shown both marked at mid and after closing the
      leftover position by crossing the spread with the taker fee.

Usage:
    python src/replay2.py --coin xyz:XYZ100 --window dev
"""
import argparse
import math
from collections import deque
from dataclasses import dataclass, field, replace

import numpy as np

from analyze_book import load
from markouts import FEES
from protocol import WINDOWS, split


@dataclass(frozen=True)
class Strat:
    offset_ticks: int = 0
    n_levels: int = 1
    size_taper: float = 0.6
    skew_ticks: float = 0.5
    max_units: float = 10.0
    pause_ratio: float | None = None
    lean: bool = False
    latency_s: float = 0.5
    fill_mode: str = "queue"


@dataclass
class Venue:
    tick: float
    base_size: float
    maker_bps: float
    taker_bps: float


@dataclass
class Ord:
    side: str
    px: float
    size: float
    ahead: float


@dataclass
class Result:
    fills: int = 0
    volume: float = 0.0
    notional: float = 0.0
    gross: float = 0.0          # marked at final mid, before fees
    fees: float = 0.0
    net_mid: float = 0.0        # after maker fees, marked at mid
    net_flat: float = 0.0       # after maker fees and closing the position as a taker
    max_units: float = 0.0
    paused_share: float = 0.0
    hours: float = 0.0
    markout_5s_bps: float = float("nan")
    markout_60s_bps: float = float("nan")
    spread_pnl: float = 0.0     # edge at the moment of each fill vs the mid
    inv_pnl: float = 0.0        # gross minus spread_pnl: adverse selection plus directional drift
    mm60: float = 0.0           # market-making P&L: each fill marked 60s later, minus fees
    fill_log: list = field(default_factory=list)

    @property
    def gross_bps_per_fill(self):
        return self.gross / self.notional * 1e4 if self.notional else float("nan")

    @property
    def net_per_hour(self):
        return self.net_flat / self.hours if self.hours else float("nan")


class RollingVar:
    """Sum of squared log mid changes over the last `window` seconds."""

    def __init__(self, window):
        self.window, self.q, self.s = window, deque(), 0.0

    def add(self, t, r2):
        self.q.append((t, r2))
        self.s += r2
        while self.q and self.q[0][0] < t - self.window:
            self.s -= self.q.popleft()[1]

    def per_second(self):
        return self.s / self.window


def load_window(coin, window):
    start, end = WINDOWS[window]
    bbo = [b for b in split(load(coin, "bbo"), start, end) if b["bid"] and b["ask"]]
    trades = split(load(coin, "trades"), start, end)
    books = split(load(coin, "book"), start, end)
    if bbo:
        t0, t1 = bbo[0]["t"], bbo[-1]["t"]
        trades = [x for x in trades if t0 <= x["t"] <= t1]
        books = [x for x in books if t0 <= x["t"] <= t1]
    return bbo, trades, books


def venue_for(coin, bbo, trades):
    px = sorted({q["bid"][0] for q in bbo[:5000]} | {q["ask"][0] for q in bbo[:5000]})
    gaps = np.diff(px)
    tick = float(np.round(gaps[gaps > 1e-9].min(), 6))
    base = float(np.median([x["sz"] for x in trades]))
    f = FEES[coin]
    return Venue(tick, base, f["maker"], f["taker"])


def run(bbo, trades, books, s: Strat, v: Venue) -> Result:
    ev = [(x["t"], 0, "trade", x) for x in trades] + [(x["t"], 1, "book", x) for x in books] + \
         [(x["t"], 2, "bbo", x) for x in bbo]
    ev.sort(key=lambda e: (e[0], e[1]))
    tick, res = v.tick, Result()
    max_q = s.max_units * v.base_size

    q = cash = 0.0
    active: list[Ord] = []
    pending = None              # (activation time in s, desired list)
    current_desired = None
    best_bid = best_ask = bid_sz = ask_sz = None
    last_book = None
    last_mid = None
    v30, v600 = RollingVar(30), RollingVar(600)
    lean_q, sxy, sxx, npairs = deque(), 0.0, 0.0, 0
    paused_time = 0.0
    last_t = None
    first_t = ev[0][0] / 1000 if ev else 0.0

    def displayed(side, px):
        if side == "bid":
            if best_bid is not None and abs(px - best_bid) < tick / 2:
                return bid_sz
            if best_bid is not None and px > best_bid + tick / 2:
                return 0.0
            levels = last_book["bids"] if last_book else []
        else:
            if best_ask is not None and abs(px - best_ask) < tick / 2:
                return ask_sz
            if best_ask is not None and px < best_ask - tick / 2:
                return 0.0
            levels = last_book["asks"] if last_book else []
        for p, sz, _ in levels:
            if abs(p - px) < tick / 2:
                return sz
        return 0.0

    def fill(o, qty, px, t):
        nonlocal q, cash, current_desired
        current_desired = None  # force a fresh decision so a filled order gets re-posted
        sign = 1 if o.side == "bid" else -1
        q += sign * qty
        cash -= sign * px * qty
        fee = v.maker_bps / 1e4 * px * qty
        res.fees += fee
        res.fills += 1
        res.volume += qty
        res.notional += px * qty
        res.fill_log.append((t, sign, px, qty, last_mid))
        res.spread_pnl += sign * (last_mid - px) * qty
        o.size -= qty

    for t_ms, _, kind, x in ev:
        t = t_ms / 1000
        if last_t is not None and t - last_t > 30:
            # Recording gap: we can't see trades in it, so assume we were offline with nothing resting.
            active, pending, current_desired = [], None, None
        elif last_t is not None and current_desired == []:
            paused_time += t - last_t
        last_t = t

        if pending is not None and t >= pending[0]:
            new = []
            for side, px, size in pending[1]:
                keep = next((o for o in active if o.side == side and abs(o.px - px) < tick / 2 and o.size > 0), None)
                if keep is not None:  # leave a resting order alone: keeps its queue place, no top-up
                    new.append(keep)
                else:
                    new.append(Ord(side, px, size, displayed(side, px)))
            active, pending = new, None

        if kind == "trade":
            hit = "bid" if x["side"] == "A" else "ask"
            remaining = x["sz"]
            for o in sorted([o for o in active if o.side == hit and o.size > 0],
                            key=lambda o: -o.px if hit == "bid" else o.px):
                through = x["px"] < o.px - tick / 2 if hit == "bid" else x["px"] > o.px + tick / 2
                at = abs(x["px"] - o.px) < tick / 2
                if through and s.fill_mode != "never":
                    fill(o, o.size, o.px, t)
                elif at and s.fill_mode == "optimistic":
                    fill(o, min(o.size, remaining), o.px, t)
                elif at and s.fill_mode == "queue":
                    eaten = min(o.ahead, remaining)
                    o.ahead -= eaten
                    qty = min(o.size, remaining - eaten)
                    if qty > 0:
                        fill(o, qty, o.px, t)

        elif kind == "book":
            last_book = x
            for o in active:
                o.ahead = min(o.ahead, displayed(o.side, o.px))

        else:  # bbo
            best_bid, bid_sz, _ = x["bid"]
            best_ask, ask_sz, _ = x["ask"]
            mid = (best_bid + best_ask) / 2
            for o in active:
                if o.size <= 0:
                    continue
                crossed = (o.side == "bid" and best_ask <= o.px + tick / 2) or \
                          (o.side == "ask" and best_bid >= o.px - tick / 2)
                if crossed and s.fill_mode != "conservative":
                    fill(o, o.size, o.px, t)
                else:
                    o.ahead = min(o.ahead, displayed(o.side, o.px))
            if last_mid is not None and mid != last_mid:
                r2 = math.log(mid / last_mid) ** 2
                v30.add(t, r2)
                v600.add(t, r2)
            last_mid = mid

            imb = (bid_sz - ask_sz) / (bid_sz + ask_sz) if bid_sz + ask_sz > 0 else 0.0
            if s.lean:
                lean_q.append((t, imb, mid))
                while lean_q and lean_q[0][0] <= t - 5:
                    t0, i0, m0 = lean_q.popleft()
                    sxy += i0 * (mid - m0)
                    sxx += i0 * i0
                    npairs += 1

            # Decide what we want resting, effective after latency.
            paused = False
            if s.pause_ratio is not None and t - first_t > 600:
                base = v600.per_second()
                paused = base > 0 and math.sqrt(v30.per_second() / base) > s.pause_ratio
            if paused:
                desired = []
            else:
                shift = -s.skew_ticks * (q / v.base_size)
                if s.lean and npairs >= 200 and sxx > 0:
                    shift += max(-2.0, min(2.0, (sxy / sxx) * imb / tick))
                k = round(shift)
                top_bid = min(best_bid + (k - s.offset_ticks) * tick, best_ask - tick)
                top_ask = max(best_ask + (k + s.offset_ticks) * tick, best_bid + tick)
                desired = []
                for lvl in range(s.n_levels):
                    size = v.base_size * s.size_taper ** lvl
                    if q < max_q:
                        desired.append(("bid", round((top_bid - lvl * tick) / tick) * tick, size))
                    if q > -max_q:
                        desired.append(("ask", round((top_ask + lvl * tick) / tick) * tick, size))
            if desired != current_desired:
                current_desired = desired
                pending = (t + s.latency_s, desired)

        res.max_units = max(res.max_units, abs(q) / v.base_size)

    res.hours = (ev[-1][0] - ev[0][0]) / 3.6e6 if ev else 0.0
    res.paused_share = paused_time / (res.hours * 3600) if res.hours else 0.0
    res.gross = cash + q * last_mid
    res.net_mid = res.gross - res.fees
    exit_px = best_bid if q > 0 else best_ask
    res.net_flat = cash + q * exit_px - res.fees - abs(q) * exit_px * v.taker_bps / 1e4
    res.inv_pnl = res.gross - res.spread_pnl

    if res.fill_log:
        tq = np.array([b["t"] for b in bbo]) / 1000
        mq = np.array([(b["bid"][0] + b["ask"][0]) / 2 for b in bbo])
        mm = 0.0
        for ft, sign, px, qty, _ in res.fill_log:
            j = int(np.searchsorted(tq, ft + 60, side="right")) - 1
            mm += sign * (mq[j] - px) * qty
        res.mm60 = mm - res.fees
        for h, attr in ((5, "markout_5s_bps"), (60, "markout_60s_bps")):
            vals = []
            for ft, sign, px, qty, _ in res.fill_log:
                if ft + h > tq[-1]:
                    continue
                j = int(np.searchsorted(tq, ft + h, side="right")) - 1
                vals.append(sign * (mq[j] - px) / px * 1e4)
            if vals:
                setattr(res, attr, float(np.mean(vals)))
    return res


def fmt(name, r: Result, v: Venue):
    return (f"  {name:<34}{r.fills:>6}{r.gross:>10.2f}{r.gross_bps_per_fill:>8.2f}{r.fees:>9.2f}"
            f"{r.net_flat:>10.2f}{r.spread_pnl:>9.2f}{r.inv_pnl:>9.2f}{r.mm60:>9.2f}"
            f"{r.max_units:>7.1f}{r.paused_share:>7.0%}{r.markout_5s_bps:>8.2f}{r.markout_60s_bps:>8.2f}")


HEADER = (f"  {'variant':<34}{'fills':>6}{'gross$':>10}{'bp/fill':>8}{'fees$':>9}{'net$':>10}"
          f"{'spread$':>9}{'inv$':>9}{'mm60$':>9}{'maxinv':>7}{'paused':>7}{'mk5s':>8}{'mk60s':>8}")


def ablation(coin, window, base: Strat | None = None):
    bbo, trades, books = load_window(coin, window)
    if len(bbo) < 1000:
        print(f"{coin} [{window}]: not enough data ({len(bbo)} quotes)")
        return {}
    v = venue_for(coin, bbo, trades)
    base = base or Strat()
    hours = (bbo[-1]["t"] - bbo[0]["t"]) / 3.6e6
    print(f"\n=== {coin} [{window}] {hours:.2f} h, {len(bbo)} quote updates, {len(trades)} trades; "
          f"tick {v.tick}, order size {v.base_size}, maker {v.maker_bps} bp, taker {v.taker_bps} bp ===")
    print("  gross/net in $ for one order size per level; bp/fill = gross edge per fill before fees;")
    print("  mk5s/mk60s = average profit of our fills 5s/60s later, in bp (before fees)")
    print(HEADER)
    variants = [
        ("baseline (join best, 1 level)", base),
        ("fill: optimistic (no queue)", replace(base, fill_mode="optimistic")),
        ("fill: conservative", replace(base, fill_mode="conservative")),
        ("latency 0.25s", replace(base, latency_s=0.25)),
        ("latency 1.0s", replace(base, latency_s=1.0)),
        ("offset 1 tick back", replace(base, offset_ticks=1)),
        ("offset 2 ticks back", replace(base, offset_ticks=2)),
        ("offset 5 ticks back", replace(base, offset_ticks=5)),
        ("pyramid 4 levels", replace(base, n_levels=4)),
        ("pyramid 4 levels, offset 2", replace(base, n_levels=4, offset_ticks=2)),
        ("no inventory skew", replace(base, skew_ticks=0.0)),
        ("strong skew (1 tick/unit)", replace(base, skew_ticks=1.0)),
        ("vol pause (2x)", replace(base, pause_ratio=2.0)),
        ("imbalance lean", replace(base, lean=True)),
        ("pause + lean", replace(base, pause_ratio=2.0, lean=True)),
    ]
    out = {}
    for name, st in variants:
        r = run(bbo, trades, books, st, v)
        out[name] = r
        print(fmt(name, r, v), flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--coin", default="xyz:XYZ100")
    ap.add_argument("--window", default="dev", choices=list(WINDOWS))
    args = ap.parse_args()
    ablation(args.coin, args.window)


if __name__ == "__main__":
    main()
