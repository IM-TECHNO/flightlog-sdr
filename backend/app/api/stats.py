"""Aggregate statistics over the flight log."""
import math
from collections import Counter
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from sqlalchemy import func, select

from .. import config, db, enrich, models

router = APIRouter(prefix="/api")

ALT_BUCKETS = [(0, 10000, "< 10k"), (10000, 20000, "10–20k"), (20000, 30000, "20–30k"),
               (30000, 40000, "30–40k"), (40000, 10**9, "40k+")]


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


@router.get("/stats")
async def stats(days: int = 7, tz: int = 0, min_msgs: int = 0):
    """Summary of the last `days` days. `tz` = minutes to add to UTC for the hour/day buckets (browser offset).
    `min_msgs` ignores brief contacts, matching the History list."""
    days = max(1, min(days, 365))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).replace(tzinfo=None)
    F, P = models.Flight, models.Position
    shift = timedelta(minutes=tz)

    async with db.Session() as s:
        flights = (await s.scalars(select(F).where(F.last_seen >= since, F.msg_count >= min_msgs))).all()
        positions = await s.scalar(select(func.count()).select_from(P).where(P.ts >= since)) or 0

        farthest = None
        if config.RECEIVER_LAT or config.RECEIVER_LON:
            lat0, lon0 = config.RECEIVER_LAT, config.RECEIVER_LON
            k = math.cos(math.radians(lat0)) ** 2  # equirectangular ordering is enough to find the candidate
            dist = (P.lat - lat0) * (P.lat - lat0) + (P.lon - lon0) * (P.lon - lon0) * k
            row = (await s.execute(select(P.flight_id, P.lat, P.lon, P.alt).where(P.ts >= since)
                                   .order_by(dist.desc()).limit(1))).first()
            if row:
                f = await s.get(F, row.flight_id)
                farthest = {"km": round(_haversine_km(lat0, lon0, row.lat, row.lon), 1), "flight_id": row.flight_id,
                            "callsign": f.callsign if f else None, "icao24": f.icao24 if f else None, "alt": row.alt}

    by_day: Counter = Counter()
    by_hour = [0] * 24
    airlines: Counter = Counter()
    aircraft: Counter = Counter()
    alt_hist = {label: 0 for _, _, label in ALT_BUCKETS}
    for f in flights:
        local = f.first_seen + shift
        by_day[local.date().isoformat()] += 1
        by_hour[local.hour] += 1
        a = enrich.airline_for(f.callsign)
        if a:
            airlines[a["name"] or a["icao"]] += 1
        aircraft[(f.icao24, f.callsign)] += 1
        if f.max_alt is not None:
            for lo, hi, label in ALT_BUCKETS:
                if lo <= f.max_alt < hi:
                    alt_hist[label] += 1
                    break

    today = (datetime.now(timezone.utc).replace(tzinfo=None) + shift).date()
    daily = [{"date": (today - timedelta(days=i)).isoformat(), "flights": by_day.get((today - timedelta(days=i)).isoformat(), 0)}
             for i in range(days - 1, -1, -1)]
    longest = max(flights, key=lambda f: (f.last_seen - f.first_seen), default=None)
    highest = max((f for f in flights if f.max_alt is not None), key=lambda f: f.max_alt, default=None)
    brief = lambda f: None if f is None else {"flight_id": f.id, "callsign": f.callsign, "icao24": f.icao24}

    return {
        "days": days,
        "totals": {"flights": len(flights), "aircraft": len({f.icao24 for f in flights}), "positions": positions},
        "daily": daily,
        "hourly": by_hour,
        "altitude": [{"label": label, "flights": alt_hist[label]} for _, _, label in ALT_BUCKETS],
        "airlines": [{"name": n, "flights": c} for n, c in airlines.most_common(8)],
        "frequent": [{"icao24": i, "callsign": c, "flights": n} for (i, c), n in aircraft.most_common(6)],
        "farthest": farthest,
        "longest": None if longest is None else {**brief(longest), "seconds": int((longest.last_seen - longest.first_seen).total_seconds())},
        "highest": None if highest is None else {**brief(highest), "alt": highest.max_alt},
    }
