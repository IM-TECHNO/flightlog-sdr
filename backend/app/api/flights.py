import asyncio
import csv
import io
from datetime import datetime, timezone
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from sqlalchemy import select

from .. import attitude, config, enrich, signal
from ..db import Session
from ..models import Flight, Position
from ..recorder import EMERGENCY

router = APIRouter(prefix="/api")


def _flight(f: Flight):
    return {"id": f.id, "icao24": f.icao24, "callsign": f.callsign,
            "first_seen": f.first_seen.isoformat() + "Z", "last_seen": f.last_seen.isoformat() + "Z",
            "msg_count": f.msg_count, "max_alt": f.max_alt, "min_alt": f.min_alt,
            "type_code": (enrich.aircraft_cached(f.icao24) or {}).get("type_code"),
            **enrich.basic(f.icao24, f.callsign)}


def _live(a, flight_id=None, watched=False):
    ac = enrich.aircraft_cached(a.icao24) or {}
    return {"flight_id": flight_id, "icao24": a.icao24, "callsign": a.callsign, "lat": a.lat, "lon": a.lon, "alt": a.alt,
            "gs": a.gs, "track": a.track, "vrate": a.vrate, "flight_seq": a.flight_seq,
            "last_seen": a.last_seen.isoformat(),
            "route": enrich.route_cached(a.callsign),
            "squawk": a.squawk, "emergency": EMERGENCY.get(a.squawk), "watched": watched, "on_ground": a.on_ground,
            "type_code": ac.get("type_code"), "registration": ac.get("registration"),
            "rssi": (signal.get(a.icao24) or {}).get("rssi"), "msg_rate": (signal.get(a.icao24) or {}).get("rate"),
            **enrich.basic(a.icao24, a.callsign)}


def _live_list(app):
    rec = app.state.recorder
    return [_live(a, rec.flight_ids.get(a.icao24), rec.watching(a))
            for a in app.state.tracker.snapshot(datetime.now(timezone.utc)) if a.lat is not None]


@router.get("/flights")
async def flights(limit: int = 100, offset: int = 0, callsign: str | None = None,
                  q: str | None = None, start: datetime | None = None, end: datetime | None = None,
                  min_msgs: int = 0):
    """List logged flights. `start`/`end` (UTC) select flights active in that window; `q` matches
    callsign substring or exact ICAO24.
    `min_msgs` hides brief contacts (a few stray messages from an aircraft at the edge of range)."""
    stmt = select(Flight).order_by(Flight.first_seen.desc()).limit(min(limit, 500)).offset(offset)
    if callsign:
        stmt = stmt.where(Flight.callsign == callsign.upper())
    if q:
        stmt = stmt.where(Flight.callsign.ilike(f"%{q}%") | (Flight.icao24 == q.lower()))
    if min_msgs > 0:
        stmt = stmt.where(Flight.msg_count >= min_msgs)
    if start:
        stmt = stmt.where(Flight.last_seen >= start.replace(tzinfo=None))
    if end:
        stmt = stmt.where(Flight.first_seen <= end.replace(tzinfo=None))
    async with Session() as s:
        return [_flight(f) for f in (await s.scalars(stmt))]


@router.get("/flights/{fid}/track")
async def track(fid: int):
    async with Session() as s:
        f = await s.get(Flight, fid)
        if not f:
            raise HTTPException(404)
        rows = await s.scalars(select(Position).where(Position.flight_id == fid).order_by(Position.ts))
        pts = [{"ts": p.ts.isoformat() + "Z", "lat": p.lat, "lon": p.lon, "alt": p.alt, "gs": p.gs,
                "track": p.track, "vrate": p.vrate, "rssi": p.rssi} for p in rows]
        return {**_flight(f), "points": attitude.derive(pts)}


@router.get("/flights/{fid}/export")
async def export(fid: int, format: str = "kml"):
    """Download a flight as KML (3D path for Google Earth, altitude absolute) or CSV."""
    if format not in ("kml", "csv"):
        raise HTTPException(400, "format must be kml or csv")
    async with Session() as s:
        f = await s.get(Flight, fid)
        if not f:
            raise HTTPException(404)
        rows = (await s.scalars(select(Position).where(Position.flight_id == fid).order_by(Position.ts))).all()
    pts = attitude.derive([{"ts": p.ts.isoformat() + "Z", "lat": p.lat, "lon": p.lon, "alt": p.alt, "gs": p.gs,
                            "track": p.track, "vrate": p.vrate, "rssi": p.rssi} for p in rows])
    name = f"{f.callsign or f.icao24}-{f.first_seen:%Y%m%d-%H%M}"
    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["ts", "lat", "lon", "alt_ft", "gs_kt", "track_deg", "vrate_fpm", "pitch_deg_est", "roll_deg_est", "rssi_dbfs"])
        for p in pts:
            w.writerow([p["ts"], p["lat"], p["lon"], p["alt"], p["gs"], p["track"], p["vrate"], p["pitch"], p["roll"], p["rssi"]])
        body, media = buf.getvalue(), "text/csv"
    else:
        coords = " ".join(f"{p['lon']},{p['lat']},{(p['alt'] or 0) * 0.3048:.1f}" for p in pts)
        title = escape(f.callsign or f.icao24.upper())
        body = ('<?xml version="1.0" encoding="UTF-8"?>'
                '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
                f"<name>{title}</name><Style id=\"t\"><LineStyle><color>ff4444ef</color><width>3</width></LineStyle>"
                "<PolyStyle><color>554444ef</color></PolyStyle></Style>"
                f"<Placemark><name>{title} {f.first_seen:%Y-%m-%d %H:%M} UTC</name><styleUrl>#t</styleUrl>"
                f"<LineString><extrude>1</extrude><tessellate>1</tessellate><altitudeMode>absolute</altitudeMode>"
                f"<coordinates>{coords}</coordinates></LineString></Placemark></Document></kml>")
        media = "application/vnd.google-earth.kml+xml"
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}.{format}"'})


@router.get("/flights/{fid}/info")
async def info(fid: int):
    """Enrichment: country, airline, aircraft registry entry and route (when known)."""
    async with Session() as s:
        f = await s.get(Flight, fid)
    if not f:
        raise HTTPException(404)
    return await enrich.full_info(f.icao24, f.callsign)


@router.get("/flights/{fid}/history")
async def history(fid: int):
    """Other logged flights with the same callsign or airframe (ICAO24)."""
    async with Session() as s:
        f = await s.get(Flight, fid)
        if not f:
            raise HTTPException(404)
        cond = Flight.icao24 == f.icao24
        if f.callsign:
            cond = cond | (Flight.callsign == f.callsign)
        rows = await s.scalars(select(Flight).where(cond, Flight.id != fid).order_by(Flight.first_seen.desc()))
        return [_flight(r) for r in rows]


@router.get("/config")
async def get_config():
    airport = ({"icao": config.AIRPORT_ICAO, "name": config.AIRPORT_NAME, "lat": config.AIRPORT_LAT,
                "lon": config.AIRPORT_LON, "elev_ft": config.AIRPORT_ELEV_FT}
               if config.AIRPORT_LAT or config.AIRPORT_LON else None)
    return {"receiver": {"lat": config.RECEIVER_LAT, "lon": config.RECEIVER_LON},
            "enrich_online": config.ENRICH_ONLINE, "airport": airport,
            "signal_available": signal.available}


@router.get("/aircraft/live")
async def live(request: Request):
    return _live_list(request.app)


@router.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            await ws.send_json(_live_list(ws.app))
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
