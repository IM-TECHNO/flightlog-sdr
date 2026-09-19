import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from datetime import datetime, timezone

from . import config, enrich, maintenance, receiver, signal
from .api.alerts import router as alerts_router
from .api.flights import router
from .api.insights import router as insights_router
from .api.receiver import router as receiver_router
from .api.stats import router as stats_router
from .db import init_db
from .ingest.sbs import read_sbs
from .ingest.tracker import Tracker
from .recorder import Recorder

tracker = Tracker(config.FLIGHT_GAP_SECONDS)
recorder = Recorder(tracker)
sampler = receiver.Sampler(tracker)


async def lookup_worker():
    """Fill the aircraft-type and route caches for what is in view. Never blocks the feed and is gentle
    with the online services (only when ENRICH_ONLINE is on)."""
    while True:
        await asyncio.sleep(5)
        live = tracker.snapshot(datetime.now(timezone.utc))
        for a in [a for a in live if enrich.aircraft_pending(a.icao24)][:3]:
            await enrich.aircraft_info(a.icao24)
        if config.ENRICH_ONLINE:
            for cs in [a.callsign for a in live if a.callsign and enrich.route_pending(a.callsign)][:3]:
                await enrich.route_info(cs)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    tasks = [asyncio.create_task(read_sbs(config.SBS_HOST, config.SBS_PORT, recorder.on_msg)),
             asyncio.create_task(recorder.run()),
             asyncio.create_task(lookup_worker()),
             asyncio.create_task(maintenance.worker()),
             asyncio.create_task(signal.worker()),
             asyncio.create_task(sampler.run())]
    yield
    for t in tasks:
        t.cancel()
    await recorder.flush()


app = FastAPI(title="FlightLog SDR", lifespan=lifespan)
app.state.tracker = tracker
app.state.recorder = recorder
# the web app may be opened from this machine or from another device on the home network
LOCAL_ORIGINS = r"https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?"
app.add_middleware(CORSMiddleware, allow_origin_regex=LOCAL_ORIGINS, allow_methods=["*"], allow_headers=["*"])
app.include_router(router)
app.include_router(stats_router)
app.include_router(alerts_router)
app.include_router(insights_router)
app.include_router(receiver_router)
