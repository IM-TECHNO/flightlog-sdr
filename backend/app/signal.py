"""Per-aircraft signal strength and message rate, read from the decoder's own aircraft.json.

The SBS-1 stream carries no signal level, but dump1090 / readsb publish `rssi` (dBFS: 0 is the strongest
possible, typical aircraft are between -5 and -35) and a per-aircraft message counter in their web feed.
Set AIRCRAFT_JSON_URL to that feed, or to an empty string to switch this off.
"""
import asyncio
import time
from typing import Optional

import httpx

from . import config

STALE_S = 15

latest: dict[str, dict] = {}  # icao24 -> {"rssi": float|None, "rate": float|None, "t": monotonic}
_msgs: dict[str, tuple[float, int]] = {}  # icao24 -> (monotonic, message counter) for the rate
available = False  # the last poll got a usable answer


def get(icao24: str) -> Optional[dict]:
    """Latest reading for an aircraft, or None if there is none or it is stale."""
    s = latest.get(icao24)
    return s if s and time.monotonic() - s["t"] < STALE_S else None


def rssi_of(icao24: str) -> Optional[float]:
    s = get(icao24)
    return s["rssi"] if s else None


def parse(data: dict, now: Optional[float] = None) -> int:
    """Update the readings from one aircraft.json document. Returns how many aircraft carried a signal level."""
    now = time.monotonic() if now is None else now
    seen_with_rssi = 0
    for ac in data.get("aircraft", []) if isinstance(data, dict) else []:
        if not isinstance(ac, dict):
            continue
        icao = str(ac.get("hex", "")).lower().lstrip("~")  # "~" marks non-ICAO (e.g. TIS-B) addresses
        if len(icao) != 6:
            continue
        seen = ac.get("seen")
        if isinstance(seen, (int, float)) and seen > STALE_S:
            continue
        rssi = ac.get("rssi")
        rssi = float(rssi) if isinstance(rssi, (int, float)) else None
        rate = None
        msgs = ac.get("messages")
        if isinstance(msgs, int):
            prev = _msgs.get(icao)
            if prev and now > prev[0] and msgs >= prev[1]:
                rate = round((msgs - prev[1]) / (now - prev[0]), 1)
            _msgs[icao] = (now, msgs)
        if rssi is not None:
            seen_with_rssi += 1
        old = latest.get(icao)
        latest[icao] = {"rssi": rssi, "rate": rate if rate is not None else (old or {}).get("rate"), "t": now}
    for icao in [k for k, v in latest.items() if now - v["t"] > 60]:  # forget aircraft that left
        latest.pop(icao, None)
        _msgs.pop(icao, None)
    return seen_with_rssi


async def worker() -> None:
    """Poll the decoder's JSON feed about once a second. Failures only mean there is no signal data."""
    global available
    if not config.AIRCRAFT_JSON_URL:
        return
    async with httpx.AsyncClient(timeout=3) as client:
        while True:
            try:
                r = await client.get(config.AIRCRAFT_JSON_URL)
                parse(r.json())
                available = r.status_code == 200
            except (httpx.HTTPError, ValueError):
                available = False
            await asyncio.sleep(1 if available else 5)
