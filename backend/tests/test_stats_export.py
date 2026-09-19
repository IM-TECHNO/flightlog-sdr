import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import config, enrich
from app.ingest.sbs import SbsMessage


def test_country_blocks_for_south_asia():
    assert enrich.country_for("800000") == "India"
    assert enrich.country_for("760123") == "Pakistan"      # 0x76xxxx below 0x768000 is Pakistan, not Singapore
    assert enrich.country_for("768001") == "Singapore"
    assert enrich.airline_for("IGO6234") == {"icao": "IGO", "name": "IndiGo"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_URL", f"sqlite+aiosqlite:///{tmp_path}/s.db")
    monkeypatch.setattr(config, "SBS_PORT", 1)  # never connect to a real feed during tests
    monkeypatch.setattr(config, "RECEIVER_LAT", 52.3)
    monkeypatch.setattr(config, "RECEIVER_LON", 4.76)
    import app.db, app.models, app.recorder, app.api.flights, app.main
    for m in (app.db, app.models, app.recorder, app.api.flights, app.main):
        importlib.reload(m)
    with TestClient(app.main.app) as c:
        yield c, app


def feed(c, app, msgs):
    async def run():
        for m in msgs:
            await app.main.recorder.on_msg(m)
        await app.main.recorder.flush()
    c.portal.call(run)


def msg(icao, cs, ts, alt, lat, lon):
    return SbsMessage(icao24=icao, ts=ts, callsign=cs, alt=alt, gs=450.0, track=90.0, lat=lat, lon=lon, vrate=0)


def test_stats_and_export(client):
    c, app = client
    t0 = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)
    feed(c, app, [
        msg("4840d6", "KLM1023", t0, 36000, 52.3, 4.7),
        msg("4840d6", "KLM1023", t0 + timedelta(seconds=30), 36100, 53.3, 6.7),   # ~171 km away
        msg("800001", "IGO6234", t0 + timedelta(minutes=5), 12000, 52.4, 4.8),
    ])
    st = c.get("/api/stats", params={"days": 3}).json()
    assert st["totals"] == {"flights": 2, "aircraft": 2, "positions": 3}
    assert sum(d["flights"] for d in st["daily"]) == 2 and len(st["daily"]) == 3
    assert sum(st["hourly"]) == 2
    assert {a["name"] for a in st["airlines"]} == {"KLM", "IndiGo"}
    assert st["highest"]["callsign"] == "KLM1023" and st["highest"]["alt"] == 36100
    assert 170 < st["farthest"]["km"] < 173 and st["farthest"]["callsign"] == "KLM1023"
    assert st["longest"]["callsign"] == "IGO6234" or st["longest"]["seconds"] == 30

    # msg_count comes from the tracker: KLM sent 2 messages, IGO only 1 -> min_msgs=2 hides the brief contact
    assert [f["callsign"] for f in c.get("/api/flights", params={"min_msgs": 2}).json()] == ["KLM1023"]
    assert c.get("/api/stats", params={"days": 3, "min_msgs": 2}).json()["totals"]["flights"] == 1

    fid = c.get("/api/flights", params={"callsign": "KLM1023"}).json()[0]["id"]
    kml = c.get(f"/api/flights/{fid}/export", params={"format": "kml"})
    assert kml.status_code == 200 and "attachment" in kml.headers["content-disposition"]
    assert "<altitudeMode>absolute</altitudeMode>" in kml.text and "4.7,52.3,10972.8" in kml.text
    rows = c.get(f"/api/flights/{fid}/export", params={"format": "csv"}).text.strip().splitlines()
    assert rows[0].startswith("ts,lat,lon,alt_ft") and len(rows) == 3
    assert c.get(f"/api/flights/{fid}/export", params={"format": "pdf"}).status_code == 400
    assert c.get("/api/flights/999/export").status_code == 404
