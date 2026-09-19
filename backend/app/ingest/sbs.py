"""Parser and async reader for SBS-1 (BaseStation) lines from dump1090/readsb."""
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional


@dataclass
class SbsMessage:
    icao24: str
    ts: datetime
    callsign: Optional[str] = None
    alt: Optional[int] = None
    gs: Optional[float] = None
    track: Optional[float] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    vrate: Optional[int] = None
    squawk: Optional[str] = None
    on_ground: Optional[bool] = None


def _f(v: str, cast):
    return cast(v) if v else None


def _ground(v: str) -> Optional[bool]:
    """SBS IsOnGround: -1/1 = on the ground, 0 = airborne, empty = not reported."""
    v = v.strip()
    return None if not v else v not in ("0",)


def parse_sbs(line: str) -> Optional[SbsMessage]:
    p = line.strip().split(",")
    if len(p) < 22 or p[0] != "MSG":
        return None
    try:
        ts = datetime.strptime(f"{p[6]} {p[7]}", "%Y/%m/%d %H:%M:%S.%f").replace(tzinfo=timezone.utc)
        return SbsMessage(
            icao24=p[4].lower(),
            ts=ts,
            callsign=p[10].strip() or None,
            alt=_f(p[11], lambda x: int(float(x))),
            gs=_f(p[12], float),
            track=_f(p[13], float),
            lat=_f(p[14], float),
            lon=_f(p[15], float),
            vrate=_f(p[16], lambda x: int(float(x))),
            squawk=p[17].strip() or None,
            on_ground=_ground(p[21]),
        )
    except ValueError:
        return None


async def read_sbs(host: str, port: int, on_msg: Callable[[SbsMessage], Awaitable[None]]) -> None:
    """Connect forever, reconnecting on failure."""
    while True:
        try:
            reader, _ = await asyncio.open_connection(host, port)
            async for raw in reader:
                msg = parse_sbs(raw.decode(errors="ignore"))
                if msg:
                    await on_msg(msg)
        except (OSError, asyncio.IncompleteReadError):
            pass
        await asyncio.sleep(5)
