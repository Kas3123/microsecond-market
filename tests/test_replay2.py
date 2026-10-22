"""Hand-built scenarios checking the replay's fill, queue, latency and accounting logic.

Run:  python -m unittest discover -s tests -v      (from the project folder)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from replay2 import Strat, Venue, run  # noqa: E402

V = Venue(tick=1.0, base_size=1.0, maker_bps=0.0, taker_bps=0.0)
S = Strat(skew_ticks=0.0, latency_s=0.5)


def bbo(t, bid=100, bsz=5, ask=101, asz=5):
    return {"t": t, "bid": [bid, bsz, 1], "ask": [ask, asz, 1]}


def tr(t, side, px, sz, tid):
    return {"t": t, "side": side, "px": px, "sz": sz, "tid": tid}


class ReplayLogic(unittest.TestCase):
    def test_latency_blocks_early_fills(self):
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(200, "A", 99, 10, 1)]  # trades through our bid before the order is live
        r = run(quotes, trades, [], S, V)
        self.assertEqual(r.fills, 0)

    def test_queue_ahead_must_trade_first(self):
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(1200, "A", 100, 3, 1), tr(1300, "A", 100, 3, 2)]
        r = run(quotes, trades, [], S, V)
        self.assertEqual(r.fills, 1)        # 5 ahead: first trade eats 3, second eats 2 then fills us
        self.assertAlmostEqual(r.volume, 1.0)

    def test_no_fill_while_queue_ahead_remains(self):
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(1200, "A", 100, 3, 1)]  # 5 ahead of us, only 3 trade
        r = run(quotes, trades, [], S, V)
        self.assertEqual(r.fills, 0)

    def test_cancellations_cap_queue_exactly(self):
        quotes = [bbo(0), bbo(1000), bbo(1100, bsz=1), bbo(5000)]
        trades = [tr(1200, "A", 100, 1, 1)]  # exactly the 1 left ahead trades: we are not filled yet
        r = run(quotes, trades, [], S, V)
        self.assertEqual(r.fills, 0)

    def test_ask_dropping_onto_our_bid_fills_us(self):
        quotes = [bbo(0), bbo(1000), bbo(1500, bid=99, ask=100), bbo(5000, bid=99, ask=100)]
        r = run(quotes, [], [], S, V)
        self.assertEqual(r.fills, 1)
        r = run(quotes, [], [], Strat(skew_ticks=0.0, latency_s=0.5, fill_mode="conservative"), V)
        self.assertEqual(r.fills, 0)

    def test_pyramid_levels_sit_further_out(self):
        quotes = [bbo(0), bbo(1000), bbo(2000), bbo(5000)]  # nothing trades: an outer level on the
        r = run(quotes, [], [], Strat(skew_ticks=0.0, latency_s=0.5, n_levels=3), V)  # wrong side would cross
        self.assertEqual(r.fills, 0)

    def test_deeper_level_queue_capped_by_book_snapshot(self):
        book_full = {"t": 0, "bids": [[100, 5, 1], [99, 5, 1]], "asks": [[101, 5, 1], [102, 5, 1]]}
        book_thin = {"t": 1500, "bids": [[100, 5, 1], [99, 0.5, 1]], "asks": [[101, 5, 1], [102, 5, 1]]}
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(1800, "A", 99, 0.5, 1), tr(1900, "A", 99, 0.5, 2)]
        s = Strat(skew_ticks=0.0, latency_s=0.5, offset_ticks=1)  # our bid rests at 99
        r = run(quotes, trades, [book_full, book_thin], s, V)
        self.assertEqual(r.fills, 1)  # queue ahead shrank 5 -> 0.5, first trade clears it, second fills us

    def test_recording_gap_cancels_orders(self):
        quotes = [bbo(0), bbo(1000), bbo(60000, bid=97, ask=98), bbo(65000, bid=97, ask=98)]
        r = run(quotes, [], [], S, V)  # without the gap rule our stale 100 bid would "fill" at 98's ask
        self.assertEqual(r.fills, 0)

    def test_pnl_split_into_spread_and_inventory(self):
        quotes = [bbo(0), bbo(1000), bbo(2000, bid=96, ask=97), bbo(5000, bid=96, ask=97)]
        trades = [tr(1200, "A", 99, 5, 1)]  # bought 1 at 100 (mid 100.5), then mid fell to 96.5
        r = run(quotes, trades, [], Strat(skew_ticks=0.0, latency_s=0.5, max_units=1.0), V)
        self.assertAlmostEqual(r.spread_pnl, 0.5)
        self.assertAlmostEqual(r.inv_pnl, -4.0)
        self.assertAlmostEqual(r.gross, -3.5)

    def test_optimistic_ignores_queue(self):
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(1200, "A", 100, 3, 1)]
        r = run(quotes, trades, [], Strat(skew_ticks=0.0, latency_s=0.5, fill_mode="optimistic"), V)
        self.assertEqual(r.fills, 1)

    def test_conservative_needs_trade_through(self):
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(1200, "A", 100, 50, 1)]
        r = run(quotes, trades, [], Strat(skew_ticks=0.0, latency_s=0.5, fill_mode="conservative"), V)
        self.assertEqual(r.fills, 0)

    def test_through_trade_fills_regardless_of_queue(self):
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(1200, "A", 99, 0.1, 1)]
        r = run(quotes, trades, [], S, V)
        self.assertEqual(r.fills, 1)
        self.assertAlmostEqual(r.volume, 1.0)

    def test_cancellations_move_us_forward(self):
        quotes = [bbo(0), bbo(1000), bbo(1100, bsz=1), bbo(5000)]
        trades = [tr(1200, "A", 100, 2, 1)]
        r = run(quotes, trades, [], S, V)
        self.assertEqual(r.fills, 1)        # displayed size shrank from 5 to 1, so only 1 ahead

    def test_round_trip_profit_equals_spread(self):
        quotes = [bbo(0, bsz=0.0001, asz=0.0001), bbo(1000, bsz=0.0001, asz=0.0001),
                  bbo(3000, bsz=0.0001, asz=0.0001), bbo(6000, bsz=0.0001, asz=0.0001)]
        trades = [tr(1200, "A", 99, 5, 1), tr(3500, "B", 102, 5, 2)]
        r = run(quotes, trades, [], S, V)
        self.assertEqual(r.fills, 2)        # bought at 100, sold at 101
        self.assertAlmostEqual(r.gross, 1.0)
        self.assertAlmostEqual(r.net_flat, 1.0)
        self.assertAlmostEqual(r.spread_pnl, 1.0)   # half a tick of edge on each fill
        self.assertAlmostEqual(r.inv_pnl, 0.0)      # mid never moved

    def test_fees_charged_per_fill(self):
        v = Venue(tick=1.0, base_size=1.0, maker_bps=10.0, taker_bps=0.0)
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(1200, "A", 99, 5, 1)]
        r = run(quotes, trades, [], S, v)
        self.assertAlmostEqual(r.fees, 100 * 10 / 1e4)

    def test_filled_order_is_reposted(self):
        quotes = [bbo(0), bbo(1000), bbo(2000), bbo(3000), bbo(6000)]
        trades = [tr(1200, "A", 99, 5, 1), tr(3200, "A", 99, 5, 2)]
        r = run(quotes, trades, [], S, V)
        self.assertEqual(r.fills, 2)

    def test_inventory_limit_stops_bidding(self):
        quotes = [bbo(0), bbo(1000), bbo(2000), bbo(3000), bbo(6000)]
        trades = [tr(1200, "A", 99, 5, 1), tr(3200, "A", 99, 5, 2)]
        r = run(quotes, trades, [], Strat(skew_ticks=0.0, latency_s=0.5, max_units=1.0), V)
        self.assertEqual(r.fills, 1)

    def test_skew_lowers_bid_when_long(self):
        quotes = [bbo(0), bbo(1000), bbo(2000), bbo(3000), bbo(6000)]
        # after buying 1 unit, a 1-tick skew moves our bid to 99: a print at 100 must not fill us
        trades = [tr(1200, "A", 99, 5, 1), tr(3200, "A", 100, 50, 2)]
        r = run(quotes, trades, [], Strat(skew_ticks=1.0, latency_s=0.5, fill_mode="optimistic"), V)
        self.assertEqual(r.fills, 1)

    def test_closing_position_pays_spread_and_taker_fee(self):
        v = Venue(tick=1.0, base_size=1.0, maker_bps=0.0, taker_bps=10.0)
        quotes = [bbo(0), bbo(1000), bbo(5000)]
        trades = [tr(1200, "A", 99, 5, 1)]
        r = run(quotes, trades, [], Strat(skew_ticks=0.0, latency_s=0.5, max_units=1.0), v)
        self.assertAlmostEqual(r.gross, 0.5)                     # bought 100, mid 100.5
        self.assertAlmostEqual(r.net_flat, 0.0 - 100 * 10 / 1e4)  # sold back at the 100 bid, taker fee


if __name__ == "__main__":
    unittest.main()
