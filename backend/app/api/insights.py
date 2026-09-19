"""Coverage, heatmap, whole-sky replay, airport activity, aircraft photos and database info."""
import math
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from sqlalchemy import Integer, cast, func, select

from .. import attitude, config, db, enrich, maintenance, models
from .flights import _flight

router = APIRouter(prefix="/api")

R_EARTH_KM = 6371.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _since(days: int) -> datetime:
    return (datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365)))).replace(tzinfo=None)


# ---------------------------------------------------------------------------------------- coverage
@router.get("/coverage")
async def coverage(days: int = 30):
    """Furthest position received in each 10-degree sector around the receiver: shows what the antenna reaches."""
    lat0, lon0 = config.RECEIVER_LAT, config.RECEIVER_LON
    if not (lat0 or lon0):
        return {"enabled": False}
    P = models.Position
    async with db.Session() as s:
        rows = (await s.execute(select(P.lat, P.lon).where(P.ts >= _since(days)).limit(1_500_000))).all()
    bins = [{"bearing": i * 10, "max_km": 0.0, "count": 0} for i in range(36)]
    for lat, lon in rows:
        b = bins[int(bearing_deg(lat0, lon0, lat, lon) // 10) % 36]
        b["count"] += 1
        d = haversine_km(lat0, lon0, lat, lon)
        if d > b["max_km"]:
            b["max_km"] = d
    for b in bins:
        b["max_km"] = round(b["max_km"], 1)
    return {"enabled": True, "receiver": {"lat": lat0, "lon": lon0}, "bins": bins,
            "max_km": max(b["max_km"] for b in bins), "positions": len(rows)}


@router.get("/heatmap")
async def heatmap(days: int = 30, cell: float = 0.02):
    """Where aircraft were received: counts per lat/lon cell (`cell` degrees)."""
    cell = max(0.005, min(cell, 0.5))
    P = models.Position
    off = 100000  # keeps the integer cast away from zero so negative coordinates bin correctly
    gy = cast(P.lat / cell + off, Integer)
    gx = cast(P.lon / cell + off, Integer)
    stmt = (select(gy.label("gy"), gx.label("gx"), func.count().label("n")).where(P.ts >= _since(days))
            .group_by(gy, gx).order_by(func.count().desc()).limit(40000))
    async with db.Session() as s:
        rows = (await s.execute(stmt)).all()
    cells = [[round((r.gy - off + 0.5) * cell, 5), round((r.gx - off + 0.5) * cell, 5), r.n] for r in rows]
    return {"cell": cell, "cells": cells, "max": max((c[2] for c in cells), default=0)}


# ---------------------------------------------------------------------------------------- replay
@router.get("/replay")
async def replay(start: datetime, end: datetime, min_msgs: int = 5, max_flights: int = 120, max_points: int = 60000):
    """All flights active in a time window with their positions inside it, thinned to at most `max_points`."""
    s0, e0 = start.replace(tzinfo=None), end.replace(tzinfo=None)
    F, P = models.Flight, models.Position
    async with db.Session() as s:
        flights = (await s.scalars(
            select(F).where(F.last_seen >= s0, F.first_seen <= e0, F.msg_count >= min_msgs)
            .order_by(F.first_seen).limit(min(max_flights, 400)))).all()
        ids = [f.id for f in flights]
        rows = (await s.scalars(select(P).where(P.flight_id.in_(ids), P.ts >= s0, P.ts <= e0)
                                .order_by(P.flight_id, P.ts))).all() if ids else []
    by_flight: dict[int, list] = {}
    for p in rows:
        by_flight.setdefault(p.flight_id, []).append(p)
    stride = max(1, math.ceil(len(rows) / max(1000, max_points)))
    out = []
    for f in flights:
        pts = by_flight.get(f.id, [])
        if not pts:
            continue
        keep = pts[::stride]
        if keep[-1] is not pts[-1]:
            keep.append(pts[-1])
        raw = [{"ts": p.ts.isoformat() + "Z", "lat": p.lat, "lon": p.lon, "alt": p.alt, "gs": p.gs,
                "track": p.track, "vrate": p.vrate, "rssi": p.rssi} for p in keep]
        out.append({**_flight(f), "points": attitude.derive(raw)})
    return {"stride": stride, "flights": out}


# ---------------------------------------------------------------------------------------- airport
NEAR_KM = 8.0
LOW_AGL_FT = 1500


def _runways() -> list[tuple[str, float]]:
    out = []
    for part in config.AIRPORT_RUNWAYS.split(","):
        if ":" in part:
            name, hdg = part.split(":", 1)
            try:
                out.append((name.strip(), float(hdg)))
            except ValueError:
                pass
    return out


def _circ_mean(angles: list[float]) -> float:
    return math.degrees(math.atan2(sum(math.sin(math.radians(a)) for a in angles),
                                   sum(math.cos(math.radians(a)) for a in angles))) % 360


def _runway_for(track: float, runways: list[tuple[str, float]]) -> Optional[str]:
    best = min(runways, key=lambda r: abs((r[1] - track + 180) % 360 - 180), default=None)
    return best[0] if best and abs((best[1] - track + 180) % 360 - 180) <= 30 else None


def classify_movement(first, last, near, lat0, lon0, elev_ft, runways) -> Optional[dict]:
    """Decide whether a flight arrived at / departed from the airport, from what the receiver saw.

    Points are (ts, lat, lon, alt_ft, track) tuples. `first`/`last` are the flight's first and last points and
    `near` its points inside the airport box, in time order. Returns None for flights that just pass by.
    """
    def agl(p):
        return None if p[3] is None else p[3] - elev_ft

    def close_low(p, limit):
        a = agl(p)
        return a is not None and a <= limit and haversine_km(lat0, lon0, p[1], p[2]) <= NEAR_KM

    arrival, departure = close_low(last, LOW_AGL_FT), close_low(first, LOW_AGL_FT)
    lows = [p for p in near if agl(p) is not None and agl(p) <= LOW_AGL_FT and haversine_km(lat0, lon0, p[1], p[2]) <= NEAR_KM]
    go_around = False
    if lows and not arrival and not departure:  # a departure is low near the field too, then climbs
        lowest = min(lows, key=agl)
        go_around = any(p[0] > lowest[0] and p[3] is not None and p[3] >= lowest[3] + 1500 for p in near)

    if arrival and departure:
        return None  # circuits / local flying: not a movement we can classify
    if arrival:
        kind, ref = "arrival", last
        tracks = [p[4] for p in near if p[4] is not None and agl(p) is not None and agl(p) <= 2500][-6:]
    elif departure:
        kind, ref = "departure", first
        tracks = [p[4] for p in near if p[4] is not None and agl(p) is not None and agl(p) <= 3000][:6]
    elif go_around:
        kind, ref = "arrival", min(lows, key=agl)
        tracks = [p[4] for p in lows if p[4] is not None][:6]
    else:
        return None
    lowest_agl = min((agl(p) for p in (lows or [ref]) if agl(p) is not None), default=None)
    return {"kind": kind, "time": ref[0], "go_around": go_around,
            "runway": _runway_for(_circ_mean(tracks), runways) if tracks else None,
            "min_agl_ft": None if lowest_agl is None else int(lowest_agl)}


@router.get("/airport")
async def airport(days: int = 7, min_msgs: int = 5):
    """Arrivals, departures, runway use and possible go-arounds seen by the receiver."""
    lat0, lon0, elev = config.AIRPORT_LAT, config.AIRPORT_LON, config.AIRPORT_ELEV_FT
    if not (lat0 or lon0):
        return {"enabled": False}
    F, P = models.Flight, models.Position
    box = 0.2
    runways = _runways()
    since = _since(days)
    movements = []
    async with db.Session() as s:
        ids = (await s.scalars(
            select(P.flight_id).where(P.ts >= since, P.lat.between(lat0 - box, lat0 + box), P.lon.between(lon0 - box, lon0 + box))
            .distinct())).all()
        for fid in ids:
            f = await s.get(F, fid)
            if not f or f.msg_count < min_msgs:
                continue
            cols = (P.ts, P.lat, P.lon, P.alt, P.track)
            first = (await s.execute(select(*cols).where(P.flight_id == fid).order_by(P.ts).limit(1))).first()
            last = (await s.execute(select(*cols).where(P.flight_id == fid).order_by(P.ts.desc()).limit(1))).first()
            near = (await s.execute(select(*cols).where(P.flight_id == fid, P.lat.between(lat0 - box, lat0 + box),
                                                        P.lon.between(lon0 - box, lon0 + box)).order_by(P.ts))).all()
            m = classify_movement(tuple(first), tuple(last), [tuple(r) for r in near], lat0, lon0, elev, runways)
            if m:
                movements.append({"flight_id": fid, "callsign": f.callsign, "icao24": f.icao24,
                                  **m, "time": m["time"].isoformat() + "Z"})
    movements.sort(key=lambda m: m["time"], reverse=True)
    by_runway: dict[str, int] = {}
    for m in movements:
        if m["runway"]:
            by_runway[m["runway"]] = by_runway.get(m["runway"], 0) + 1
    return {
        "enabled": True,
        "airport": {"icao": config.AIRPORT_ICAO, "name": config.AIRPORT_NAME, "lat": lat0, "lon": lon0, "elev_ft": elev},
        "days": days,
        "summary": {"arrivals": sum(m["kind"] == "arrival" for m in movements),
                    "departures": sum(m["kind"] == "departure" for m in movements),
                    "go_arounds": sum(m["go_around"] for m in movements), "by_runway": by_runway},
        "movements": movements[:100],
    }


# ---------------------------------------------------------------------------------------- photo
_photo_cache: dict[str, tuple[float, dict]] = {}


@router.get("/photo/{icao24}")
async def photo(icao24: str):
    """A photo of the airframe from planespotters.net (online lookup, opt-in like routes). Credit is required."""
    icao24 = icao24.lower()
    if not re.fullmatch(r"[0-9a-f]{6}", icao24):
        raise HTTPException(400, "icao24 must be 6 hex characters")
    if not config.ENRICH_ONLINE:
        return {"available": False, "reason": "online lookups are off (ENRICH_ONLINE=1)"}
    hit = _photo_cache.get(icao24)
    if hit and time.time() < hit[0]:
        return hit[1]
    data = await enrich._get_json(f"https://api.planespotters.net/pub/photos/hex/{icao24}")
    photos = data.get("photos") if isinstance(data, dict) else None
    first = photos[0] if isinstance(photos, list) and photos and isinstance(photos[0], dict) else None
    src = ((first or {}).get("thumbnail_large") or (first or {}).get("thumbnail") or {}).get("src") if first else None
    result = ({"available": True, "src": src, "link": first.get("link"), "photographer": first.get("photographer")}
              if src else {"available": False, "reason": "no photo on file"})
    _photo_cache[icao24] = (time.time() + (86400 if result["available"] else 3600), result)
    return result


# ---------------------------------------------------------------------------------------- database
@router.get("/db")
async def database_info():
    return await maintenance.info()
