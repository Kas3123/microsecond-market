"""Record live order books and trades from Hyperliquid's public websocket.

These are the same markets Liquid shows (xyz:XYZ100 = NASDAQ-100, xyz:GOLD = gold).
Read-only public data: no account, no API key, nothing is traded.

Output: data/raw/<UTC date>/<coin>_<hour>_book.jsonl, ..._bbo.jsonl (best bid/offer) and ..._trades.jsonl
    book line:   {"t": ms, "bids": [[px, sz, n], ...], "asks": [...]}
    trade line:  {"t": ms, "side": "B"|"A", "px": float, "sz": float, "tid": int}
    ("B" = buyer was the aggressor, i.e. someone hit the ask.)

Usage:
    python src/recorder.py                     # run until Ctrl+C
    python src/recorder.py --minutes 60        # stop after an hour
    python src/recorder.py --coins xyz:GOLD
"""
import argparse
import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import websockets

URL = "wss://api.hyperliquid.xyz/ws"
OUT = Path(__file__).resolve().parent.parent / "data" / "raw"


class Sink:
    """Appends JSON lines to one file per coin, stream and UTC hour."""

    def __init__(self):
        self.files = {}
        self.counts = {}

    def write(self, coin, kind, t_ms, row):
        stamp = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc)
        key = (coin, kind, stamp.strftime("%Y-%m-%d_%H"))
        f = self.files.get(key)
        if f is None:
            for old in [k for k in self.files if k[:2] == key[:2]]:
                self.files.pop(old).close()
            folder = OUT / stamp.strftime("%Y-%m-%d")
            folder.mkdir(parents=True, exist_ok=True)
            name = f"{coin.replace(':', '_')}_{stamp.strftime('%H')}_{kind}.jsonl"
            f = self.files[key] = open(folder / name, "a", buffering=1)
        f.write(json.dumps(row, separators=(",", ":")) + "\n")
        self.counts[(coin, kind)] = self.counts.get((coin, kind), 0) + 1

    def close(self):
        for f in self.files.values():
            f.close()


def parse_levels(side):
    return [[float(l["px"]), float(l["sz"]), l["n"]] for l in side]


class Stale(Exception):
    pass


def keep_awake():
    """Ask Windows not to sleep while this process runs. Released automatically on exit."""
    try:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        return True
    except Exception:
        return False


async def stream(coins, sink, stop_at):
    async with websockets.connect(URL, ping_interval=None, max_size=2**22, open_timeout=20) as ws:
        for c in coins:
            # l2Book arrives on a ~5.4s timer; bbo arrives on every top-of-book change (~0.1s).
            for kind in ("l2Book", "trades", "bbo"):
                await ws.send(json.dumps({"method": "subscribe", "subscription": {"type": kind, "coin": c}}))
        last_ping = last_msg = time.time()
        while time.time() < stop_at:
            if time.time() - last_ping > 30:  # server drops idle connections after 60s
                await ws.send(json.dumps({"method": "ping"}))
                last_ping = time.time()
            if time.time() - last_msg > 120:  # half-open connection: nothing arriving at all
                raise Stale("no messages for 120s")
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            except asyncio.TimeoutError:
                continue
            last_msg = time.time()
            ch, data = msg.get("channel"), msg.get("data")
            rt = int(time.time() * 1000)  # local receive time, to measure feed delay
            if ch == "l2Book":
                bids, asks = data["levels"]
                sink.write(data["coin"], "book", data["time"],
                           {"t": data["time"], "rt": rt, "bids": parse_levels(bids), "asks": parse_levels(asks)})
            elif ch == "bbo":
                bid, ask = data["bbo"]
                lvl = lambda l: [float(l["px"]), float(l["sz"]), l["n"]] if l else None
                sink.write(data["coin"], "bbo", data["time"],
                           {"t": data["time"], "rt": rt, "bid": lvl(bid), "ask": lvl(ask)})
            elif ch == "trades":
                for tr in data:  # wallet addresses ("users") are deliberately not stored
                    sink.write(tr["coin"], "trades", tr["time"],
                               {"t": tr["time"], "rt": rt, "side": tr["side"], "px": float(tr["px"]),
                                "sz": float(tr["sz"]), "tid": tr["tid"]})


async def main(coins, minutes):
    stop_at = time.time() + minutes * 60 if minutes else float("inf")
    sink = Sink()
    last_report = time.time()
    try:
        while time.time() < stop_at:
            try:
                task = asyncio.create_task(stream(coins, sink, stop_at))
                while not task.done():
                    await asyncio.sleep(1)
                    if time.time() - last_report > 60:
                        last_report = time.time()
                        summary = ", ".join(f"{c} {k}: {n}" for (c, k), n in sorted(sink.counts.items()))
                        print(f"[{datetime.now():%H:%M:%S}] {summary}", flush=True)
                task.result()
            except Exception as e:  # any failure overnight: log it and reconnect
                print(f"[{datetime.now():%H:%M:%S}] Connection problem ({type(e).__name__}: {e}); reconnecting in 5s", flush=True)
                await asyncio.sleep(5)
    finally:
        sink.close()
        summary = ", ".join(f"{c} {k}: {n}" for (c, k), n in sorted(sink.counts.items()))
        print(f"Stopped. Recorded {summary or 'nothing'} into {OUT}", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--coins", nargs="+", default=["xyz:XYZ100", "xyz:GOLD"])
    ap.add_argument("--minutes", type=float, default=0, help="0 = run until Ctrl+C")
    args = ap.parse_args()
    if keep_awake():
        print("Asked Windows to stay awake while recording.", flush=True)
    try:
        asyncio.run(main(args.coins, args.minutes))
    except KeyboardInterrupt:
        pass
