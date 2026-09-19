"""Alerts (emergency squawks, watchlist matches) and the watchlist itself."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import db, models
from ..recorder import WATCH_KINDS

router = APIRouter(prefix="/api")


def _alert(a: models.Alert) -> dict:
    return {"id": a.id, "ts": a.ts.isoformat() + "Z", "kind": a.kind, "icao24": a.icao24, "callsign": a.callsign,
            "flight_id": a.flight_id, "detail": a.detail}


def _watch(w: models.Watch) -> dict:
    return {"id": w.id, "kind": w.kind, "value": w.value, "label": w.label}


@router.get("/alerts")
async def alerts(after: int = 0, limit: int = 50):
    """Newest first. Pass `after=<last id seen>` to get only newer ones."""
    stmt = select(models.Alert).where(models.Alert.id > after).order_by(models.Alert.id.desc()).limit(min(limit, 200))
    async with db.Session() as s:
        return [_alert(a) for a in await s.scalars(stmt)]


class WatchIn(BaseModel):
    kind: str
    value: str
    label: str | None = None


@router.get("/watchlist")
async def watchlist():
    async with db.Session() as s:
        return [_watch(w) for w in await s.scalars(select(models.Watch).order_by(models.Watch.id))]


@router.post("/watchlist")
async def add_watch(body: WatchIn, request: Request):
    if body.kind not in WATCH_KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(WATCH_KINDS)}")
    value = body.value.strip()
    if not value:
        raise HTTPException(400, "value is required")
    value = value.lower() if body.kind == "icao24" else value.upper()
    if body.kind == "airline" and len(value) != 3:
        raise HTTPException(400, "airline is the 3-letter ICAO code, e.g. IGO")
    if body.kind == "icao24" and len(value) != 6:
        raise HTTPException(400, "icao24 is the 6-character hex address")
    async with db.Session() as s:
        w = models.Watch(kind=body.kind, value=value, label=(body.label or "").strip() or None)
        s.add(w)
        await s.commit()
        request.app.state.recorder.watch_dirty = True
        return _watch(w)


@router.delete("/watchlist/{wid}")
async def delete_watch(wid: int, request: Request):
    async with db.Session() as s:
        w = await s.get(models.Watch, wid)
        if not w:
            raise HTTPException(404)
        await s.delete(w)
        await s.commit()
    request.app.state.recorder.watch_dirty = True
    return {"ok": True}
