"""Development search and frozen holdout test, following protocol.py.

    python src/evaluate.py dev       # grid search on DEV, freeze best settings per coin and fee case
    python src/evaluate.py holdout   # run the frozen settings once on HOLDOUT (and its sub-windows)

Selection is by net P&L after closing the position (net_flat). Two fee cases:
    tier0 - real all-in fees for a new account (FEES in markouts.py)
    zero  - no fees, to show the gross edge the strategy finds before costs
"""
import itertools
import json
import sys
from dataclasses import asdict, replace
from pathlib import Path

from analyze_book import coins_recorded
from replay2 import HEADER, Strat, Venue, fmt, load_window, run, venue_for

ROOT = Path(__file__).resolve().parent.parent
FROZEN = ROOT / "data" / "frozen_choices.json"

GRID = dict(
    offset_ticks=[0, 1, 2, 3],
    n_levels=[1, 4],
    skew_ticks=[0.0, 0.5, 1.0],
    pause_ratio=[None, 2.0],
    lean=[False, True],
)


def grid():
    keys = list(GRID)
    for combo in itertools.product(*GRID.values()):
        yield Strat(**dict(zip(keys, combo)))


def label(s: Strat):
    return (f"off{s.offset_ticks} lv{s.n_levels} skew{s.skew_ticks} "
            f"{'pause' if s.pause_ratio else 'nopause'} {'lean' if s.lean else 'nolean'}")


def dev():
    frozen = {}
    for coin in coins_recorded():
        bbo, trades, books = load_window(coin, "dev")
        if len(bbo) < 1000:
            continue
        v = venue_for(coin, bbo, trades)
        frozen[coin] = {"venue": asdict(v)}
        hours = (bbo[-1]["t"] - bbo[0]["t"]) / 3.6e6
        for case, vv in (("tier0", v), ("zero", replace(v, maker_bps=0.0, taker_bps=0.0))):
            results = [(run(bbo, trades, books, s, vv), s) for s in grid()]
            results.sort(key=lambda rs: rs[0].net_flat, reverse=True)
            print(f"\n=== {coin} DEV {hours:.2f} h, fees {case}: top 5 and bottom 3 of {len(results)} ===")
            print(HEADER)
            for r, s in results[:5] + results[-3:]:
                print(fmt(label(s), r, vv))
            traded = [rs for rs in results if rs[0].fills >= 30]  # must actually trade, not get lucky once
            best_r, best_s = results[0]
            best_trading = traded[0] if traded else results[0]
            # Added at 10:20 UTC, before HOLDOUT: pick on market-making P&L only (fills marked 60s
            # later, minus fees), so a lucky directional position can't win the selection.
            by_mm = sorted(traded or results, key=lambda rs: rs[0].mm60, reverse=True)
            best_mm = by_mm[0]
            frozen[coin][case] = {
                "best": asdict(best_s), "best_dev_net": best_r.net_flat, "best_dev_fills": best_r.fills,
                "best_trading": asdict(best_trading[1]), "best_trading_dev_net": best_trading[0].net_flat,
                "best_mm": asdict(best_mm[1]), "best_mm_dev_net": best_mm[0].net_flat, "best_mm_dev_mm60": best_mm[0].mm60,
                "share_profitable": sum(r.net_flat > 0 for r, _ in results) / len(results),
            }
            print(f"  profitable after costs: {frozen[coin][case]['share_profitable']:.0%} of settings; "
                  f"positive market-making P&L (mm60): {sum(r.mm60 > 0 for r, _ in results) / len(results):.0%}")
            print(f"  best by market-making P&L: {label(best_mm[1])}")
            print(fmt("  (that setting)", best_mm[0], vv))
    if not frozen:  # never replace the published choices with nothing
        print("No DEV data found (the original recordings before the DEV_END cut-off in src/protocol.py are not in the repo).\n"
              f"{FROZEN.relative_to(ROOT)} was left unchanged.")
        return
    FROZEN.write_text(json.dumps(frozen, indent=1))
    print(f"\nFrozen choices written to {FROZEN.relative_to(ROOT)}")


def summary(r):
    out = {k: round(getattr(r, k), 4) for k in
           ("fills", "gross", "fees", "net_flat", "spread_pnl", "inv_pnl", "mm60", "notional",
            "markout_5s_bps", "markout_60s_bps", "max_units", "paused_share", "hours")}
    # Maker fee (bp) at which market-making P&L would be exactly zero.
    out["breakeven_maker_bps"] = round((r.mm60 + r.fees) / r.notional * 1e4, 4) if r.notional else None
    return out


def grid_summary(bbo, trades, books, v):
    rs = [run(bbo, trades, books, s, v) for s in grid()]
    return {"settings": len(rs), "share_net_positive": sum(r.net_flat > 0 for r in rs) / len(rs),
            "share_mm60_positive": sum(r.mm60 > 0 for r in rs) / len(rs),
            "best_mm60": max(r.mm60 for r in rs), "best_net": max(r.net_flat for r in rs)}


def latency_curve(bbo, trades, books, v):
    base = Strat(offset_ticks=2, n_levels=4, skew_ticks=0.0)
    out = {}
    for lat in (0.0, 0.25, 0.5, 1.0, 2.0):
        r = run(bbo, trades, books, replace(base, latency_s=lat), v)
        out[str(lat)] = summary(r)
        print(fmt(f"latency {lat}s (2 back, 4 levels)", r, v))
    return out


def holdout(windows=("holdout", "holdout_overnight", "us_open"), tag="holdout"):
    frozen = json.loads(FROZEN.read_text())
    saved = {}
    for coin, f in frozen.items():
        v = Venue(**f["venue"])
        saved[coin] = {}
        for window in windows:
            bbo, trades, books = load_window(coin, window)
            if len(bbo) < 1000:
                print(f"\n{coin} [{window}]: not enough data")
                continue
            hours = (bbo[-1]["t"] - bbo[0]["t"]) / 3.6e6
            mids = [(bbo[0]["bid"][0] + bbo[0]["ask"][0]) / 2, (bbo[-1]["bid"][0] + bbo[-1]["ask"][0]) / 2]
            print(f"\n=== {coin} {window.upper()} {hours:.2f} h, mid {mids[0]} -> {mids[1]} "
                  f"(settings and order size frozen from DEV) ===")
            print(HEADER)
            w = saved[coin][window] = {"hours": hours, "mid_first_last": mids, "picks": {}}
            for case in ("tier0", "zero"):
                vv = v if case == "tier0" else replace(v, maker_bps=0.0, taker_bps=0.0)
                for which in ("best", "best_trading", "best_mm"):
                    s = Strat(**f[case][which])
                    r = run(bbo, trades, books, s, vv)
                    dev_net = f[case][f"{which}_dev_net"]
                    print(fmt(f"{case} {which}: {label(s)}", r, vv) + f"   (dev net {dev_net:.2f})")
                    w["picks"][f"{case}_{which}"] = {"setting": label(s), **summary(r), "dev_net": dev_net}
                r = run(bbo, trades, books, Strat(), vv)
                print(fmt(f"{case} baseline: {label(Strat())}", r, vv))
                w["picks"][f"{case}_baseline"] = {"setting": label(Strat()), **summary(r)}
            w["grid_tier0"] = grid_summary(bbo, trades, books, v)
            g = w["grid_tier0"]
            print(f"  Full 96-setting grid, tier-0 fees: net>0 in {g['share_net_positive']:.0%}, "
                  f"market-making P&L>0 in {g['share_mm60_positive']:.0%} (best mm60 {g['best_mm60']:.2f})")
            if coin == "xyz:XYZ100":
                w["latency"] = latency_curve(bbo, trades, books, v)
    out = ROOT / "data" / "results" / f"{tag}.json"
    if not any(saved.values()):  # never replace the published results with nothing
        print(f"\nNo recordings found for these windows, so {out.relative_to(ROOT)} was left unchanged.")
        return
    out.write_text(json.dumps(saved, indent=1))
    print(f"\nWrote {out.relative_to(ROOT)}")


def dev_extras():
    """Same grid summary and latency curve on DEV, for side-by-side reporting."""
    holdout(windows=("dev",), tag="dev_summary")


if __name__ == "__main__":
    {"dev": dev, "holdout": holdout, "dev_extras": dev_extras}[sys.argv[1]]()
