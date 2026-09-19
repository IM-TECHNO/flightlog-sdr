import importlib
import sqlite3
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import config, enrich
from app.ingest.sbs import SbsMessage

ADSBDB = {"response": {"flightroute": {
    "origin": {"iata_code": "BLR", "icao_code": "VOBL", "name": "Kempegowda", "municipality": "Bengaluru", "latitude": 13.1979, "longitude": 77.7063},
    "destination": {"iata_code": "COK", "icao_code": "VOCI", "name": "Cochin Intl", "municipality": "Kochi", "latitude": 10.152, "longitude": 76.4019}}}}


def boot(tmp_path, monkeypatch, db_file="r.db"):
    monkeypatch.setattr(config, "DB_URL", f"sqlite+aiosqlite:///{tmp_path}/{db_file}")
    monkeypatch.setattr(config, "SBS_PORT", 1)  # never connect to a real feed during tests
    monkeypatch.setattr(config, "ENRICH_ONLINE", False)  # each test opts in explicitly
    enrich._route_mem.clear()
    enrich._route_miss.clear()
    import app.db, app.models, app.recorder, app.api.flights, app.main
    for m in (app.db, app.models, app.recorder, app.api.flights, app.main):
        importlib.reload(m)
    return app


def test_old_database_gets_new_route_columns(tmp_path, monkeypatch):
    con = sqlite3.connect(tmp_path / "old.db")  # the schema an earlier version created
    con.execute("CREATE TABLE route_cache (callsign VARCHAR PRIMARY KEY, origin_icao VARCHAR, origin_name VARCHAR, "
                "origin_city VARCHAR, dest_icao VARCHAR, dest_name VARCHAR, dest_city VARCHAR)")
    con.execute("INSERT INTO route_cache (callsign, origin_icao) VALUES ('OLD1', 'EHAM')")
    con.commit()
    con.close()
    app = boot(tmp_path, monkeypatch, "old.db")
    with TestClient(app.main.app):
        pass
    cols = {r[1] for r in sqlite3.connect(tmp_path / "old.db").execute("PRAGMA table_info(route_cache)")}
    assert {"origin_lat", "origin_lon", "origin_iata", "dest_lat", "dest_lon", "dest_iata"} <= cols
    assert sqlite3.connect(tmp_path / "old.db").execute("SELECT origin_icao FROM route_cache").fetchone() == ("EHAM",)


def test_route_lookup_is_cached_and_attached_to_live_aircraft(tmp_path, monkeypatch):
    app = boot(tmp_path, monkeypatch)
    calls = []

    async def fake_get(url):
        calls.append(url)
        return ADSBDB

    monkeypatch.setattr(enrich, "_get_json", fake_get)
    monkeypatch.setattr(config, "ENRICH_ONLINE", True)
    with TestClient(app.main.app) as c:
        async def feed():
            await app.main.recorder.on_msg(SbsMessage(icao24="8016b7", ts=datetime.now(timezone.utc), callsign="IGO6234",
                                                      alt=12000, gs=300.0, track=200.0, lat=10.7, lon=76.8, vrate=0))
        c.portal.call(feed)
        assert c.get("/api/aircraft/live").json()[0]["route"] is None  # not looked up yet: the feed never blocks

        route = c.portal.call(enrich.route_info, "IGO6234")
        assert route["origin"]["iata"] == "BLR" and route["destination"]["lat"] == 10.152
        assert c.get("/api/aircraft/live").json()[0]["route"]["destination"]["icao"] == "VOCI"

        c.portal.call(enrich.route_info, "IGO6234")
        assert len(calls) == 1  # served from memory afterwards

        fid = c.get("/api/flights").json()[0]["id"]
        assert c.get(f"/api/flights/{fid}/info").json()["route"]["origin"]["city"] == "Bengaluru"


def test_unknown_callsign_is_not_retried_immediately(tmp_path, monkeypatch):
    app = boot(tmp_path, monkeypatch)
    calls = []

    async def fake_get(url):
        calls.append(url)
        return {"response": "unknown callsign"}

    monkeypatch.setattr(enrich, "_get_json", fake_get)
    monkeypatch.setattr(config, "ENRICH_ONLINE", True)
    with TestClient(app.main.app) as c:
        assert enrich.route_pending("AXB1341")
        assert c.portal.call(enrich.route_info, "AXB1341") is None
        assert not enrich.route_pending("AXB1341")          # negative-cached for an hour
        assert c.portal.call(enrich.route_info, "AXB1341") is None
        assert len(calls) == 1
