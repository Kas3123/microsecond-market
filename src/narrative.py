"""Report text. Sections marked HOLDOUT are written after the holdout run."""

WHAT_I_DID = """
<ul class="plain">
<li>Recorded Hyperliquid's NASDAQ‑100 (<code>xyz:XYZ100</code>) and gold (<code>xyz:GOLD</code>) markets
overnight: every best-bid/ask change (~0.1 s apart), the full 20-level book every ~5.4 s, and every trade.
Free public data, no account, nothing traded.</li>
<li>Before looking at any of it, I wrote down a test rule (<code>src/protocol.py</code>): data before 03:00
Pacific is <b>development</b>, where I could try anything; data after is <b>holdout</b>, touched once at the end
with all settings frozen. The US cash open (06:30 Pacific onward) is reported separately.</li>
<li>Measured, without any strategy, whether the traders who rest orders in these books make money after fees.</li>
<li>Rebuilt the backtester to replay real quotes and trades with queue position, order delay, real fees and
the cost of closing out, then checked it with 19 hand-built tests and deliberately broke it to make sure the
tests notice.</li>
<li>Searched 96 strategy settings on development data, froze the best ones, and tested them once on the holdout.</li>
<li>Re-ran every simulation claim I made yesterday on 100 fresh random price paths.</li>
</ul>
"""

MARKETS = """
<p>Both markets almost always sit at a one-tick spread: the tightest possible. That is the first problem. A
market maker earns at most half the spread per fill, which here is under 0.2 basis points (0.002%), while a new
account pays a maker fee of 0.3 bp on NASDAQ‑100 and 3 bp on gold. The fee figures come from each market's own
settings: NASDAQ‑100 is in Hyperliquid's discounted "growth mode", gold is not, and both add the deployer's
fee share.</p>
"""

CORRECTIONS = """
<ul class="plain">
<li><b>"Both upgrades make stormy markets profitable."</b> Wrong. On 100 fresh price paths the result is
+5 ± 26, a coin flip. The seeds I reported on had been reused while I fixed a bug, so they weren't really unseen.</li>
<li><b>Simulation volatility.</b> I treated Liquid's ATR reading as the typical hourly move. For random-walk
prices ATR is about 1.58 times the typical move, so the simulation was too volatile. Fixing it makes the
simulation <i>more</i> profitable, which is one more reason not to trust the simulation over real data.</li>
<li><b>"Liquid's own order book."</b> Liquid is a front end. The <code>xyz:</code> markets are Hyperliquid
HIP‑3 perpetuals and <code>LIT:QQQ</code> is on Lighter. They give stock and gold exposure, but the venue is
crypto infrastructure settled in USDC. You asked for no crypto; the paper has to say this plainly.</li>
<li><b>Gold's 0.72 imbalance correlation.</b> An artifact of overlapping time windows on 30 data points. The
honest 1-second figure is 0.14.</li>
<li><b>The first real-data backtest.</b> It decided on order-book snapshots that were up to 5.4 s old; 27–44%
of trades happened at prices those snapshots didn't show. Deleted and rebuilt.</li>
<li><b>Every earlier profit figure ignored fees.</b></li>
</ul>
"""

REPRODUCE = """
<pre>python src/recorder.py --minutes 120      # record (Ctrl+C to stop)
python src/audit_data.py                  # data-quality checks
python src/analyze_book.py --window dev   # market statistics
python src/imbalance.py --window dev      # does imbalance predict the next move?
python src/markouts.py --window dev       # do resting orders make money? (no strategy)
python src/evaluate.py dev                # 96-setting search, freezes picks
python src/evaluate.py holdout            # one frozen test on later data
python src/audit_sim.py                   # re-checks the simulation claims
python -m unittest discover -s tests      # 19 tests for the backtester
python src/make_report.py                 # rebuilds this page</pre>
<p class="muted">Raw data is in <code>data/raw/</code> (not in git; about 20 MB for the night). The full findings
log is <code>docs/audit_findings.md</code>.</p>
"""

# Results sections, written after the holdout run on 2026-10-09.
BOTTOM_LINE = """
<p><b>No.</b> On about 8 hours of real data, a market maker on these two markets does not earn the spread
after fees. On the holdout, none of the 96 settings made money from market making in either market. The
setting that looked best on development data (+$1.15) lost $13.86 once prices fell.</p>
<p>Three things stop it: fees bigger than the spread, a newcomer's place at the back of the queue, and speed.
Order-book imbalance really does predict the next tick, but the edge is a fraction of the fee. For a paper this
is a useful negative result: a tested explanation of why a retail-speed market maker can't make money here, and
of how an ordinary backtest would have said it could.</p>
"""

MARKOUTS = """
<p>This test uses no strategy. For every real trade, it asks whether the order that was resting in the book
made money afterwards. Orders at the best price earn the half-spread (about 0.16 bp on NASDAQ‑100) the moment
they fill, then give it back as the price moves against them. A minute later they are flat or negative,
nowhere near the fee. Orders filled 2+ ticks deep by a sweep do better on NASDAQ‑100 (+0.35 bp at 60 s on the
holdout), but the interval includes zero, so the pre-registered test (H1) did not confirm they beat the fee.</p>
"""

STRATEGY = """
<p>The replay runs the pyramid strategy on the recorded quotes and trades. It joins the back of the queue, its
orders go live 0.5 s after it decides, and it pays real fees. Net P&amp;L is split into the edge earned at each
fill, profit or loss from holding inventory while the price moves, and fees. <b>Market-making P&amp;L</b>
marks every fill 60 s later and subtracts fees, which removes luck from longer price drifts. On development
data the best net P&amp;L came almost entirely from holding inventory while the price rose; on the holdout the
price fell and the same setting lost.</p>
"""

LATENCY = """
<p>The slower the strategy moves its orders, the more fills it gets and the worse they are: faster traders hit
our old prices before we can move them. With no delay the deep levels catch real overshoots, but even then the
strategy only about breaks even after fees. True zero delay can't be tested with this data, because new orders
go live at the next recorded update, 0.1–0.3 s later.</p>
"""

IMBALANCE = """
<p>When much more size waits on the bid than the ask, the price is more likely to tick up next. The 1-second
correlation is about 0.3 on NASDAQ‑100 and 0.2 on gold, stable from development to holdout and strongest after
the US open. It fades within a minute. Leaning quotes toward it slightly improved fill quality, but not by
enough to cover fees.</p>
"""

HYPOTHESES = """
<p>Written down before the holdout was opened and scored automatically against the stated test. H1 came from
scanning 48 results on development data, which is why it needed the holdout to count.</p>
"""

FINDINGS = """
<p>Every flaw I found overnight, in the data and in my own work. <b>Critical</b> means it changes the
conclusion. The same list is in <code>docs/audit_findings.md</code>.</p>
"""

PAPER = """
<ul class="plain">
<li><b>The finding:</b> on these venues, at retail speed and fee levels, quoting both sides does not pay. Costs
and adverse selection exceed the spread at every setting tested.</li>
<li><b>The method is the contribution:</b> a pre-registered split, P&amp;L split into fill edge, inventory and
fees, a queue- and delay-aware replay, and a list of the ways an ordinary backtest overstated profit (the $41k
simulation, the lucky long position, stale snapshots, reused seeds).</li>
<li><b>Limits to state:</b> one night (about 8 hours, Thursday into Friday), two markets, a crypto venue rather
than NASDAQ itself, no true low-latency test, and small hypothetical orders that don't move the market.</li>
<li><b>Next:</b> record several weekday sessions, repeat on LOBSTER's real NASDAQ order-book samples, and test
the one lead left: deep sweep fills with fast order updates.</li>
</ul>
"""

SECTIONS = {
    "bottom_line": BOTTOM_LINE, "what_i_did": WHAT_I_DID, "markets": MARKETS, "markouts": MARKOUTS,
    "strategy": STRATEGY, "latency": LATENCY, "imbalance": IMBALANCE, "hypotheses": HYPOTHESES,
    "findings": FINDINGS, "corrections": CORRECTIONS, "paper": PAPER, "reproduce": REPRODUCE,
}
