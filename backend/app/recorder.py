"""Persists tracker state: creates flights, buffers positions, flushes periodically."""
import asyncio
import time
from datetime import datetime

from sqlalchemy import select, update

from . import enrich, signal
from .db import Session
from .ingest.sbs import SbsMessage
from .ingest.tracker import LiveAircraft, Tracker
from .models import Alert, Flight, Position, Watch


def _naive(d: datetime) -> datetime:
    return d.replace(tzinfo=None)


EMERGENCY = {"7500": "hijacking", "7600": "radio failure", "7700": "general emergency"}
WATCH_KINDS = ("callsign", "icao24", "airline")


def watch_matches(kind: str, value: str, ac: LiveAircraft) -> bool:
    """Does this watchlist entry match the aircraft? callsign is a prefix match ("IGO33" matches IGO335)."""
    if kind == "icao24":
        return ac.icao24 == value.lower()
    if not ac.callsign:
        return False
    if kind == "callsign":
        return ac.callsign.upper().startswith(value.upper())
    if kind == "airline":
        a = enrich.airline_for(ac.callsign)
        return bool(a and a["icao"] == value.upper())
    return False


class Recorder:
    def __init__(self, tracker: Tracker, min_pos_interval: float = 1.0):
        self.tracker = tracker
        self.min_interval = min_pos_interval
        self.flight_ids: dict[str, int] = {}
        self.last_pos: dict[str, datetime] = {}
        self.buf: list[Position] = []
        self.alt_range: dict[int, tuple[int, int]] = {}
        self.lock = asyncio.Lock()
        self.watch: list[tuple[int, str, str]] = []  # (id, kind, value), refreshed from the DB
        self.watch_dirty = True
        self._watch_loaded = 0.0
        self._watch_hit: set[tuple[int, int]] = set()  # (flight_id, watch id) already alerted
        self._emerg: dict[str, str] = {}
        self.alert_buf: list[Alert] = []

    async def on_msg(self, m: SbsMessage):
        ac, new = self.tracker.update(m)
        async with self.lock:
            if new or m.icao24 not in self.flight_ids:
                async with Session() as s:
                    f = Flight(icao24=m.icao24, callsign=ac.callsign, first_seen=_naive(m.ts),
                               last_seen=_naive(m.ts), msg_count=0)
                    s.add(f)
                    await s.commit()
                    self.flight_ids[m.icao24] = f.id
                self.last_pos.pop(m.icao24, None)
            self._check_alerts(m, ac)
            if m.lat is not None and m.lon is not None:
                last = self.last_pos.get(m.icao24)
                if last is None or (m.ts - last).total_seconds() >= self.min_interval:
                    self.last_pos[m.icao24] = m.ts
                    self.buf.append(Position(flight_id=self.flight_ids[m.icao24], ts=_naive(m.ts),
                                             lat=m.lat, lon=m.lon, alt=ac.alt, gs=ac.gs,
                                             track=ac.track, vrate=ac.vrate, rssi=signal.rssi_of(m.icao24)))

    def watching(self, ac: LiveAircraft) -> bool:
        return any(watch_matches(k, v, ac) for _, k, v in self.watch)

    def _check_alerts(self, m: SbsMessage, ac: LiveAircraft) -> None:
        fid = self.flight_ids.get(m.icao24)
        now = _naive(m.ts)
        if m.squawk in EMERGENCY:
            if self._emerg.get(m.icao24) != m.squawk:
                self._emerg[m.icao24] = m.squawk
                self.alert_buf.append(Alert(ts=now, kind="emergency", icao24=m.icao24, callsign=ac.callsign, flight_id=fid,
                                            detail=f"Squawk {m.squawk}: {EMERGENCY[m.squawk]}"))
        elif m.squawk and m.icao24 in self._emerg:
            del self._emerg[m.icao24]
        for wid, kind, value in self.watch:
            if fid is not None and (fid, wid) not in self._watch_hit and watch_matches(kind, value, ac):
                self._watch_hit.add((fid, wid))
                self.alert_buf.append(Alert(ts=now, kind="watch", icao24=m.icao24, callsign=ac.callsign, flight_id=fid,
                                            detail=f"Watchlist: {kind} {value}"))

    async def _load_watch(self, s) -> None:
        rows = (await s.scalars(select(Watch))).all()
        self.watch = [(w.id, w.kind, w.value) for w in rows]
        self.watch_dirty = False
        self._watch_loaded = time.monotonic()

    async def flush(self):
        async with self.lock:
            buf, self.buf = self.buf, []
            alerts, self.alert_buf = self.alert_buf, []
            if not buf and not alerts and not self.tracker.aircraft and not self.watch_dirty:
                return
            async with Session() as s:
                s.add_all(buf)
                s.add_all(alerts)
                if self.watch_dirty or time.monotonic() - self._watch_loaded > 30:
                    await self._load_watch(s)
                touched = set()
                for p in buf:
                    if p.alt is None:
                        continue
                    lo, hi = self.alt_range.get(p.flight_id, (p.alt, p.alt))
                    self.alt_range[p.flight_id] = (min(lo, p.alt), max(hi, p.alt))
                    touched.add(p.flight_id)
                # flights that ended since the last flush are no longer in flight_ids
                for fid in touched:
                    lo, hi = self.alt_range[fid]
                    await s.execute(update(Flight).where(Flight.id == fid).values(min_alt=lo, max_alt=hi))
                for icao, fid in self.flight_ids.items():
                    ac = self.tracker.aircraft.get(icao)
                    if ac:
                        await s.execute(update(Flight).where(Flight.id == fid).values(
                            last_seen=_naive(ac.last_seen), msg_count=ac.msgs, callsign=ac.callsign))
                await s.commit()

    async def run(self, every: float = 2.0):
        while True:
            await asyncio.sleep(every)
            await self.flush()
