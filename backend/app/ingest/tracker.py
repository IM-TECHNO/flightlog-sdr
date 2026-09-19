"""In-memory live aircraft state with flight segmentation."""
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from .sbs import SbsMessage


@dataclass
class LiveAircraft:
    icao24: str
    first_seen: datetime
    last_seen: datetime
    flight_seq: int = 0
    callsign: Optional[str] = None
    alt: Optional[int] = None
    gs: Optional[float] = None
    track: Optional[float] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    vrate: Optional[int] = None
    squawk: Optional[str] = None
    on_ground: Optional[bool] = None
    msgs: int = 0


class Tracker:
    def __init__(self, gap_seconds: int = 1200):
        self.gap = timedelta(seconds=gap_seconds)
        self.aircraft: dict[str, LiveAircraft] = {}

    def update(self, m: SbsMessage) -> tuple[LiveAircraft, bool]:
        """Apply a message. Returns (aircraft, is_new_flight)."""
        ac = self.aircraft.get(m.icao24)
        new_flight = False
        if ac is None or m.ts - ac.last_seen > self.gap or (
            m.callsign and ac.callsign and m.callsign != ac.callsign
        ):
            seq = ac.flight_seq + 1 if ac else 0
            ac = LiveAircraft(m.icao24, m.ts, m.ts, flight_seq=seq)
            self.aircraft[m.icao24] = ac
            new_flight = True
        ac.last_seen = m.ts
        ac.msgs += 1
        for f in ("callsign", "alt", "gs", "track", "lat", "lon", "vrate", "squawk", "on_ground"):
            v = getattr(m, f)
            if v is not None:
                setattr(ac, f, v)
        return ac, new_flight

    def snapshot(self, now: datetime, max_age_s: int = 60) -> list[LiveAircraft]:
        return [a for a in self.aircraft.values() if (now - a.last_seen).total_seconds() <= max_age_s]
