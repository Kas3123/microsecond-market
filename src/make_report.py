"""Build docs/report.html from saved results.

Hypothesis verdicts are computed from the criteria written in protocol.HYPOTHESES, not by hand.

Usage:
    python src/make_report.py
"""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
from markouts import FEES  # noqa: E402
from protocol import HYPOTHESES  # noqa: E402

D, R = ROOT / "data", ROOT / "data" / "results"
COINS = [("xyz:XYZ100", "NASDAQ‑100"), ("xyz:GOLD", "Gold")]
BUCKETS = [("at touch (<=0.75 tick)", "At best price"), ("1-2 ticks", "1–2 ticks out"),
           ("2+ ticks (sweeps)", "Sweeps, 2+ ticks"), ("ALL", "All fills")]


def jload(p):
    return json.loads(p.read_text()) if p.exists() else None


stats = {w: jload(D / f"market_stats_{w}.json") for w in ("dev", "holdout", "us_open")}
marks = {w: jload(D / f"markouts_{w}.json") for w in ("dev", "holdout", "us_open")}
imb = {w: jload(D / f"imbalance_{w}.json") for w in ("dev", "holdout", "us_open")}
devsum = jload(R / "dev_summary.json") or {}
hold = jload(R / "holdout.json") or {}
from narrative import SECTIONS as NARR  # noqa: E402

e = html.escape


def num(x, d=2, sign=False):
    if x is None:
        return "–"
    return f"{x:+.{d}f}" if sign else f"{x:.{d}f}"


def money(x):
    return "–" if x is None else (f"−${abs(x):.2f}" if x < 0 else f"+${x:.2f}")


def get(d, *keys):
    for k in keys:
        if d is None:
            return None
        d = d.get(k) if isinstance(d, dict) else None
    return d


# ---------- hypothesis verdicts (mechanical) ----------

def verdicts():
    out = {}
    m = get(marks["holdout"], "xyz:XYZ100", "2+ ticks (sweeps)", "60")
    if m and m["ci"][0] is not None:
        fee = FEES["xyz:XYZ100"]["maker"]
        ok = m["ci"][0] > fee
        out["H1"] = ("supported" if ok else ("not confirmed" if m["mean"] > fee else "rejected"),
                     f"Holdout: {num(m['mean'], sign=True)} bp [{num(m['ci'][0], sign=True)}, {num(m['ci'][1], sign=True)}], "
                     f"n = {m['n']}, vs fee {fee} bp.")
    parts, ok_all, have = [], True, True
    for coin, name in COINS:
        m = get(marks["holdout"], coin, "at touch (<=0.75 tick)", "60")
        if not m or m["ci"][1] is None:
            have = False
            continue
        fee = FEES[coin]["maker"]
        ok_all &= m["ci"][1] < fee
        parts.append(f"{name} {num(m['mean'], sign=True)} bp [{num(m['ci'][0], sign=True)}, {num(m['ci'][1], sign=True)}] vs fee {fee}")
    if have and parts:
        out["H2"] = ("supported" if ok_all else "rejected", "Holdout: " + "; ".join(parts) + ".")
    parts, ok_all, have = [], True, True
    for coin, name in COINS:
        c = get(imb["holdout"], coin, "1")
        if not c:
            have = False
            continue
        ok_all &= c["ci"][0] > 0
        parts.append(f"{name} {num(c['corr'], 3)} [{num(c['ci'][0], 3)}, {num(c['ci'][1], 3)}]")
    if have and parts:
        out["H3"] = ("supported" if ok_all else "rejected", "Holdout 1 s correlation: " + "; ".join(parts) + ".")
    parts, ok_all, have = [], True, True
    for coin, name in COINS:
        g = get(hold, coin, "holdout", "grid_tier0")
        p = get(hold, coin, "holdout", "picks", "tier0_best_mm")
        if not g or not p:
            have = False
            continue
        ok_all &= g["share_mm60_positive"] == 0 and p["mm60"] < 0
        parts.append(f"{name}: {g['share_mm60_positive']:.0%} of 96 settings positive, frozen pick {money(p['mm60'])}")
    if have and parts:
        out["H4"] = ("supported" if ok_all else "rejected", "Holdout: " + "; ".join(parts) + ".")
    lat = get(hold, "xyz:XYZ100", "holdout", "latency")
    if lat:
        a, b, c = (lat[k]["markout_5s_bps"] for k in ("0.0", "0.5", "2.0"))
        ok = a > b > c
        out["H5"] = ("supported" if ok else "rejected",
                     f"Holdout 5 s markout of our fills: 0 s {num(a, sign=True)}, 0.5 s {num(b, sign=True)}, 2 s {num(c, sign=True)} bp.")
    return out


# ---------- charts (inline SVG, colours from CSS tokens) ----------

def markout_chart(coin, name):
    fee = FEES[coin]["maker"]
    series = [(w, lab, cls) for w, lab, cls in (("dev", "Development", "s-dev"), ("holdout", "Holdout", "s-hold"))
              if get(marks[w], coin)]
    vals = []
    for w, _, _ in series:
        for b, _ in BUCKETS:
            m = get(marks[w], coin, b, "60")
            if m and m["mean"] is not None:
                vals += [m["mean"]] + [x for x in m["ci"] if x is not None]
    if not vals:
        return ""
    lo, hi = min(vals + [0]), max(vals + [fee])
    pad = (hi - lo) * 0.12
    lo, hi = lo - pad, hi + pad
    W, H, L, B, T = 640, 300, 52, 44, 16
    pw, ph = W - L - 12, H - T - B
    y = lambda v: T + ph * (1 - (v - lo) / (hi - lo))
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{e(name)}: maker profit 60 seconds after a fill, by depth, against the maker fee">']
    step = _nice_step(hi - lo)
    v = step * int(lo / step)
    while v <= hi:
        out.append(f'<line class="grid" x1="{L}" x2="{W - 12}" y1="{y(v):.1f}" y2="{y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 8}" y="{y(v) + 4:.1f}" text-anchor="end">{_tick(v, step)}</text>')
        v += step
    out.append(f'<line class="zero" x1="{L}" x2="{W - 12}" y1="{y(0):.1f}" y2="{y(0):.1f}"/>')
    gw = pw / len(BUCKETS)
    bw = min(34, gw / (len(series) + 1.2))
    for i, (b, lab) in enumerate(BUCKETS):
        cx = L + gw * i + gw / 2
        for j, (w, _, cls) in enumerate(series):
            m = get(marks[w], coin, b, "60")
            if not m or m["mean"] is None:
                continue
            x0 = cx + (j - len(series) / 2) * bw + 2
            y0, y1 = sorted((y(0), y(m["mean"])))
            out.append(f'<rect class="{cls}" x="{x0:.1f}" y="{y0:.1f}" width="{bw - 4:.1f}" height="{max(y1 - y0, 1):.1f}"/>')
            if m["ci"][0] is not None:
                xm = x0 + (bw - 4) / 2
                out.append(f'<line class="whisker" x1="{xm:.1f}" x2="{xm:.1f}" y1="{y(m["ci"][0]):.1f}" y2="{y(m["ci"][1]):.1f}"/>')
            out.append(f'<text class="n" x="{x0 + (bw - 4) / 2:.1f}" y="{H - B + 30:.1f}" text-anchor="middle">{m["n"]}</text>')
        out.append(f'<text class="cat" x="{cx:.1f}" y="{H - B + 16:.1f}" text-anchor="middle">{e(lab)}</text>')
    out.append(f'<line class="fee" x1="{L}" x2="{W - 12}" y1="{y(fee):.1f}" y2="{y(fee):.1f}"/>'
               f'<text class="feelab" x="{W - 14}" y="{y(fee) - 6:.1f}" text-anchor="end">maker fee {fee} bp</text>')
    out.append(f'<text class="tick" x="{L}" y="{T - 4}">bp</text></svg>')
    legend = "".join(f'<span><i class="{cls}"></i>{lab}</span>' for _, lab, cls in series)
    return (f'<figure><figcaption><b>{e(name)}</b>: average profit of the resting order 60 s after it was filled, '
            f'by how far from the mid price the trade printed. Whiskers are 95% intervals; numbers under the bars '
            f'are trade counts.</figcaption>{"".join(out)}<div class="legend">{legend}'
            f'<span><i class="fee-key"></i>Maker fee</span></div></figure>')


def latency_chart():
    series = []
    d = get(devsum, "xyz:XYZ100", "dev", "latency")
    h = get(hold, "xyz:XYZ100", "holdout", "latency")
    if d:
        series.append(("Development", "s-dev", d))
    if h:
        series.append(("Holdout", "s-hold", h))
    if not series:
        return ""
    lats = ["0.0", "0.25", "0.5", "1.0", "2.0"]
    vals = [s[2][k]["markout_5s_bps"] for s in series for k in lats if k in s[2]]
    lo, hi = min(vals + [0]), max(vals + [0])
    pad = (hi - lo) * 0.15 or 0.2
    lo, hi = lo - pad, hi + pad
    W, H, L, B, T = 640, 260, 52, 46, 16
    pw, ph = W - L - 20, H - T - B
    x = lambda i: L + pw * i / (len(lats) - 1)
    y = lambda v: T + ph * (1 - (v - lo) / (hi - lo))
    out = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Profit of our fills 5 seconds later against order delay">']
    step = _nice_step(hi - lo)
    v = step * int(lo / step)
    while v <= hi:
        out.append(f'<line class="grid" x1="{L}" x2="{W - 20}" y1="{y(v):.1f}" y2="{y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 8}" y="{y(v) + 4:.1f}" text-anchor="end">{_tick(v, step)}</text>')
        v += step
    out.append(f'<line class="zero" x1="{L}" x2="{W - 20}" y1="{y(0):.1f}" y2="{y(0):.1f}"/>')
    for i, k in enumerate(lats):
        out.append(f'<text class="cat" x="{x(i):.1f}" y="{H - B + 18:.1f}" text-anchor="middle">{float(k):g} s</text>')
    for j, (lab, cls, s) in enumerate(series):
        pts = [(x(i), y(s[k]["markout_5s_bps"]), s[k]["fills"]) for i, k in enumerate(lats) if k in s]
        out.append(f'<polyline class="line {cls}" points="{" ".join(f"{a:.1f},{b:.1f}" for a, b, _ in pts)}"/>')
        for a, b, n in pts:
            out.append(f'<circle class="dot {cls}" cx="{a:.1f}" cy="{b:.1f}" r="4"/>')
            out.append(f'<text class="n" x="{a:.1f}" y="{H - B + 32 + 12 * j:.1f}" text-anchor="middle">{n}</text>')
    out.append(f'<text class="tick" x="{L}" y="{T - 4}">bp</text></svg>')
    legend = "".join(f'<span><i class="{cls}"></i>{lab}</span>' for lab, cls, _ in series)
    return (f'<figure><figcaption><b>NASDAQ‑100, quoting 2 ticks back with 4 levels</b>: average profit of our '
            f'fills 5 s later, against how long an order takes to go live. Numbers under the axis are fill counts '
            f'(development first, holdout second).</figcaption>{"".join(out)}<div class="legend">{legend}</div></figure>')


def _tick(v, step):
    if abs(v) < step / 1000:
        return "0"
    d = 2 if step in (0.05, 0.25) else (1 if step < 1 else 0)
    return f"{v:+.{d}f}"


def _nice_step(span):
    for s in (0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10):
        if span / s <= 7:
            return s
    return 20


# ---------- tables ----------

def market_table():
    rows = [("Hours recorded", "hours", 2), ("Quote updates per second", "quote_updates_per_s", 2),
            ("Time at a one-tick spread", "spread_one_tick_time_share", None),
            ("Average spread (bp)", "spread_mean_bps_time_weighted", 3),
            ("Trades per minute", "trades_per_min", 1), ("Dollars traded per hour", "notional_per_hour_usd", 0),
            ("Realized volatility (bp per hour)", "realized_vol_hourly_bps", 1)]
    wins = [w for w in ("dev", "holdout", "us_open") if stats[w]]
    labels = {"dev": "Development", "holdout": "Holdout", "us_open": "US open"}
    head = "".join(f"<th scope='col'>{name}<br><small>{labels[w]}</small></th>" for _, name in COINS for w in wins)
    body = []
    for lab, key, d in rows:
        cells = []
        for coin, _ in COINS:
            for w in wins:
                v = get(stats[w], coin, key)
                if v is None:
                    cells.append("<td>–</td>")
                elif d is None:
                    cells.append(f"<td>{v:.0%}</td>")
                elif key == "notional_per_hour_usd":
                    cells.append(f"<td>${v / 1e6:.1f}M</td>")
                else:
                    cells.append(f"<td>{v:.{d}f}</td>")
        body.append(f"<tr><th scope='row'>{lab}</th>{''.join(cells)}</tr>")
    fees = []
    for coin, _ in COINS:
        for _ in wins:
            fees.append(f"<td>{FEES[coin]['maker']} / {FEES[coin]['taker']}</td>")
    body.append(f"<tr><th scope='row'>Maker / taker fee, new account (bp)</th>{''.join(fees)}</tr>")
    return f"<div class='tw'><table><thead><tr><th></th>{head}</tr></thead><tbody>{''.join(body)}</tbody></table></div>"


def picks_table(coin):
    rows = []
    for key, lab in (("tier0_best", "Best net P&L on development"), ("tier0_best_mm", "Best market-making P&L on development"),
                     ("tier0_baseline", "Baseline: join best price, 1 level")):
        for w, src in (("Development", get(devsum, coin, "dev", "picks", key)),
                       ("Holdout", get(hold, coin, "holdout", "picks", key)),
                       ("US open", get(hold, coin, "us_open", "picks", key))):
            if not src:
                continue
            rows.append(
                f"<tr><th scope='row'>{lab}<br><small>{e(src['setting'])} · {w}</small></th>"
                f"<td>{src['fills']}</td><td class='{_cls(src['net_flat'])}'>{money(src['net_flat'])}</td>"
                f"<td>{money(src['spread_pnl'])}</td><td>{money(src['inv_pnl'])}</td><td>{money(-src['fees'])}</td>"
                f"<td class='{_cls(src['mm60'])}'>{money(src['mm60'])}</td>"
                f"<td>{num(src['breakeven_maker_bps'], sign=True)}</td></tr>")
    if not rows:
        return ""
    return ("<div class='tw'><table><thead><tr><th>Setting</th><th>Fills</th><th>Net P&amp;L</th>"
            "<th>Fill edge</th><th>Inventory</th><th>Fees</th><th>Market-making P&amp;L</th>"
            "<th>Break-even fee (bp)</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>")


def grid_table():
    rows = []
    for coin, name in COINS:
        for w, src in (("Development", get(devsum, coin, "dev", "grid_tier0")),
                       ("Holdout", get(hold, coin, "holdout", "grid_tier0")),
                       ("US open", get(hold, coin, "us_open", "grid_tier0"))):
            if src:
                rows.append(f"<tr><th scope='row'>{name} · {w}</th><td>{src['share_net_positive']:.0%}</td>"
                            f"<td class='{_cls(src['share_mm60_positive'] - 1e-9)}'>{src['share_mm60_positive']:.0%}</td>"
                            f"<td>{money(src['best_mm60'])}</td></tr>")
    return ("<div class='tw'><table><thead><tr><th>Market · data</th><th>Net P&amp;L &gt; 0</th>"
            "<th>Market-making P&amp;L &gt; 0</th><th>Best market-making P&amp;L</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table></div>")


def imbalance_table():
    rows = []
    for coin, name in COINS:
        for w, lab in (("dev", "Development"), ("holdout", "Holdout"), ("us_open", "US open")):
            d = get(imb[w], coin)
            if not d:
                continue
            cells = "".join(f"<td>{d[h]['corr']:.2f} <small>[{d[h]['ci'][0]:.2f}, {d[h]['ci'][1]:.2f}]</small></td>"
                            if h in d else "<td>–</td>" for h in ("1", "5", "30", "60"))
            rows.append(f"<tr><th scope='row'>{name} · {lab}</th>{cells}</tr>")
    return ("<div class='tw'><table><thead><tr><th>Market · data</th><th>1 s</th><th>5 s</th><th>30 s</th><th>60 s</th>"
            "</tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>")


def _cls(v):
    return "" if v is None else ("pos" if v > 0 else "neg")


def hypotheses_block(v):
    rows = []
    for k, text in HYPOTHESES.items():
        verdict, detail = v.get(k, ("pending", "Holdout not run yet."))
        rows.append(f"<li><div class='hyp-head'><b>{k}</b><span class='chip v-{verdict.replace(' ', '-')}'>{verdict}</span></div>"
                    f"<p>{e(text)}</p><p class='muted'>{e(detail)}</p></li>")
    return f"<ol class='hyps'>{''.join(rows)}</ol>"


def findings_block():
    md = (ROOT / "docs" / "audit_findings.md").read_text(encoding="utf-8")
    sections = re.split(r"^## ", md, flags=re.M)[1:]
    out = []
    for sec in sections:
        title, _, body = sec.partition("\n")
        items = re.findall(r"^(\d+)\. \*\*(.+?)\*\*(.*?)(?=^\d+\. |\Z)", body, flags=re.M | re.S)
        lis = []
        for n, head, rest in items:
            sev, _, name = head.partition(" — ")
            kind = sev.split()[0].strip("()").lower()
            cls = {"critical": "crit", "major": "major", "minor": "minor"}.get(kind, "info")
            text = " ".join(line.strip() for line in rest.strip().splitlines())
            text = e(text)
            text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
            text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
            lis.append(f"<li><span class='chip {cls}'>{e(sev)}</span> <b>{e(name)}</b> {text}</li>")
        out.append(f"<h3>{e(title.strip())}</h3><ol class='findings' start='{items[0][0] if items else 1}'>{''.join(lis)}</ol>")
    return "".join(out)


CSS = """
:root{--bg:#F2F4F6;--surface:#FFFFFF;--line:#DDE2E7;--ink:#16202A;--muted:#5B6875;--accent:#2F5BEA;
--soft:#A9B9EE;--good:#1E8E5A;--bad:#C8413B;--warn:#A86A12;--grid:#E9EDF1;--chip:#EEF1F5}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0F1419;--surface:#171E26;
--line:#26313C;--ink:#E4E9EE;--muted:#8A97A4;--accent:#7B98FF;--soft:#3D4F86;--good:#3FBF83;--bad:#F06A63;--warn:#E0A84A;
--grid:#1F2832;--chip:#202A35}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0F1419;--surface:#171E26;--line:#26313C;--ink:#E4E9EE;--muted:#8A97A4;
--accent:#7B98FF;--soft:#3D4F86;--good:#3FBF83;--bad:#F06A63;--warn:#E0A84A;--grid:#1F2832;--chip:#202A35}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.6 "IBM Plex Sans",system-ui,sans-serif;padding-inline:16px;padding-block:28px 56px}
main{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:28px}
h1{font-size:30px;line-height:1.2;margin:0;font-weight:600;text-wrap:balance}
h2{font-size:20px;margin:0 0 4px;font-weight:600;text-wrap:balance}
h3{font-size:15px;margin:18px 0 6px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
p{margin:0 0 10px;max-width:68ch}
.dek{color:var(--muted);margin-top:6px}
section{display:flex;flex-direction:column;gap:8px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:18px 20px}
.bottom p{font-size:16px}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
@media (max-width:700px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tile span{display:block;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.tile b{display:block;font:500 22px/1.3 "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;margin-top:2px}
.tile small{color:var(--muted);font-size:12.5px}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{padding:7px 10px;border-bottom:1px solid var(--grid);text-align:right;vertical-align:top}
thead th{font-weight:600;white-space:nowrap;background:var(--surface);position:sticky;top:0}
th[scope=row]{text-align:left;font-weight:500;min-width:240px}
td{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
small{color:var(--muted);font-weight:400}
.pos{color:var(--good)} .neg{color:var(--bad)}
figure{margin:6px 0 0;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
figcaption{font-size:13.5px;color:var(--muted);margin-bottom:6px}
svg{width:100%;height:auto;display:block}
svg text{font:11px "IBM Plex Mono",monospace;fill:var(--muted)}
svg .cat{font-family:"IBM Plex Sans",sans-serif;font-size:12px;fill:var(--ink)}
svg .grid{stroke:var(--grid)} svg .zero{stroke:var(--muted);stroke-width:1}
svg .s-dev{fill:var(--soft)} svg .s-hold{fill:var(--accent)}
svg .whisker{stroke:var(--ink);stroke-width:1.3}
svg .fee{stroke:var(--bad);stroke-width:1.5;stroke-dasharray:5 4} svg .feelab{fill:var(--bad)}
svg .line{fill:none;stroke-width:2} svg .line.s-dev{stroke:var(--soft)} svg .line.s-hold{stroke:var(--accent)}
svg .dot.s-dev{fill:var(--soft)} svg .dot.s-hold{fill:var(--accent)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-top:6px}
.legend i{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.legend i.s-dev{background:var(--soft)} .legend i.s-hold{background:var(--accent)}
.legend i.fee-key{height:0;border-top:2px dashed var(--bad);border-radius:0;vertical-align:3px}
.chip{display:inline-block;font:500 11px/1.6 "IBM Plex Sans",sans-serif;letter-spacing:.04em;text-transform:uppercase;
padding:0 7px;border-radius:999px;background:var(--chip);color:var(--muted);white-space:nowrap}
.chip.crit{color:var(--bad)} .chip.major{color:var(--warn)} .chip.info{color:var(--accent)}
.chip.v-supported{color:var(--good)} .chip.v-rejected{color:var(--bad)} .chip.v-not-confirmed{color:var(--warn)}
ol.findings,ol.hyps{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:10px}
ol.findings li{max-width:75ch}
.hyps p{margin:2px 0}
.hyp-head{display:flex;gap:10px;align-items:center}
.muted{color:var(--muted);font-size:13.5px}
code{font:13px "IBM Plex Mono",monospace;background:var(--chip);padding:0 4px;border-radius:4px}
pre{font:13px/1.5 "IBM Plex Mono",monospace;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;margin:0}
ul.plain{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;max-width:72ch}
"""


def main():
    v = verdicts()
    n = NARR
    hours = sum(get(stats[w], c, "hours") or 0 for w in ("dev", "holdout") for c, _ in COINS[:1])
    quotes = sum(get(stats[w], c, "quote_updates") or 0 for w in ("dev", "holdout") for c, _ in COINS)
    trades = sum(get(stats[w], c, "trades") or 0 for w in ("dev", "holdout") for c, _ in COINS)
    tiles = []
    for coin, name in COINS:
        spread = get(stats["holdout"] or stats["dev"], coin, "spread_mean_bps_time_weighted")
        if spread is not None:
            tiles.append(f"<div class='tile'><span>{name}: most per fill</span><b>{spread / 2:.2f} bp</b>"
                         f"<small>half the spread, vs a {FEES[coin]['maker']} bp maker fee</small></div>")
    pos = [get(hold, c, "holdout", "grid_tier0", "share_mm60_positive") for c, _ in COINS]
    if all(p is not None for p in pos):
        tiles.append(f"<div class='tile'><span>Holdout: settings that make money</span><b>{sum(round(p * 96) for p in pos)} of 192</b>"
                     f"<small>market-making P&amp;L after fees, both markets</small></div>")
    tiles.append(f"<div class='tile'><span>Data recorded</span><b>{hours:.1f} h</b>"
                 f"<small>{quotes:,} quote updates, {trades:,} trades</small></div>")

    body = f"""<title>Does the Spread Pay?</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>{CSS}</style>
<main>
<header>
<h1>Does the Spread Pay?</h1>
<p class="dek">Overnight audit of the pyramid market maker on Hyperliquid's NASDAQ‑100 and gold perpetuals · recorded 8–9 October 2026 (Pacific)</p>
</header>
<section class="panel bottom"><h2>Bottom line</h2>{n.get('bottom_line', '<p>Pending holdout results.</p>')}</section>
<div class="tiles">{''.join(tiles)}</div>
<section><h2>What I did overnight</h2>{n.get('what_i_did', '')}</section>
<section><h2>The two markets</h2>{n.get('markets', '')}{market_table()}</section>
<section><h2>1. Who makes money providing liquidity?</h2>{n.get('markouts', '')}
{markout_chart('xyz:XYZ100', 'NASDAQ‑100')}{markout_chart('xyz:GOLD', 'Gold')}</section>
<section><h2>2. Our strategy, with real fees, queues and delay</h2>{n.get('strategy', '')}
<h3>Across all 96 settings (real fees)</h3>{grid_table()}
<h3>NASDAQ‑100: frozen picks, where the money came from</h3>{picks_table('xyz:XYZ100')}
<h3>Gold: frozen picks</h3>{picks_table('xyz:GOLD')}</section>
<section><h2>3. Speed decides it</h2>{n.get('latency', '')}{latency_chart()}</section>
<section><h2>4. Order-book imbalance is real but small</h2>{n.get('imbalance', '')}{imbalance_table()}</section>
<section><h2>Pre-registered hypotheses</h2>{n.get('hypotheses', '')}{hypotheses_block(v)}</section>
<section><h2>Everything I found wrong</h2>{n.get('findings', '')}{findings_block()}</section>
<section><h2>Corrections to what I told you earlier</h2>{n.get('corrections', '')}</section>
<section><h2>What this means for the paper</h2>{n.get('paper', '')}</section>
<section><h2>Reproduce it</h2>{n.get('reproduce', '')}</section>
</main>"""
    out = ROOT / "docs" / "report.html"
    out.write_text(body, encoding="utf-8")
    print(f"Wrote {out.relative_to(ROOT)} ({len(body) / 1024:.0f} KB); verdicts: " +
          ", ".join(f"{k} {x[0]}" for k, x in v.items()))


if __name__ == "__main__":
    main()
