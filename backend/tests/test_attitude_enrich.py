import asyncio
import importlib

import pytest
from fastapi.testclient import TestClient

from app import attitude, config, enrich


def pt(sec, track, alt=10000, gs=400, vrate=0):
    return {"ts": f"2025-01-01T00:00:{sec:02d}Z", "alt": alt, "gs": gs, "track": track, "vrate": vrate}


def test_level_flight_has_no_pitch_or_roll():
    out = attitude.derive([pt(0, 90), pt(1, 90), pt(2, 90)])
    assert all(p["pitch"] == 0 and p["roll"] == 0 for p in out)


def test_climb_pitch_and_turn_roll_signs():
    out = attitude.derive([pt(0, 90, vrate=3000), pt(1, 93, vrate=3000), pt(2, 96, vrate=3000)])
    mid = out[1]
    assert 4.0 < mid["pitch"] < 4.5        # atan(3000 fpm / 400 kt) = 4.2 deg
    assert mid["roll"] > 15                # right turn (track increasing) => positive bank
    left = attitude.derive([pt(0, 96), pt(1, 93), pt(2, 90)])[1]
    assert left["roll"] < -15


def test_heading_wraparound_does_not_spike():
    mid = attitude.derive([pt(0, 359), pt(1, 0), pt(2, 1)])[1]
    assert 15 < mid["roll"] < 25         # 1 deg/s at 400 kt is about 20 deg of bank


def test_vrate_falls_back_to_altitude_delta():
    p = pt(1, 90, alt=10100)
    p["vrate"] = None
    out = attitude.derive([pt(0, 90, alt=10000), p])
    assert out[1]["pitch"] > 0


def test_country_and_airline():
    assert enrich.country_for("4840d6") == "Netherlands"
    assert enrich.country_for("a1b2c3") == "United States"
    assert enrich.country_for("zzzzzz") is None
    assert enrich.airline_for("KLM1023") == {"icao": "KLM", "name": "KLM"}
    assert enrich.airline_for("N123AB") is None


CSV = ("icao24,registration,manufacturername,manufacturericao,model,typecode,serialnumber,linenumber,"
       "icaoaircrafttype,operator,operatorcallsign,operatoricao,operatoriata,owner\n"
       "4840d6,PH-BXA,Boeing,BOEING,737-800,B738,1,,L2J,KLM Royal Dutch Airlines,KLM,KLM,KL,\n"
       "bad,,,,,,,,,,,,,\n")


def L(sec, day=1):
    t = f"2025/09/{day:02d}"
    return f"MSG,3,1,1,4840D6,1,{t},10:00:{sec:02d}.000,{t},10:00:{sec:02d}.000,KLM1023,36000,450,90,52.3,4.7,0,,0,0,0,0"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_URL", f"sqlite+aiosqlite:///{tmp_path}/e.db")
    monkeypatch.setattr(config, "SBS_PORT", 1)  # never connect to a real feed during tests
    monkeypatch.setattr(config, "ENRICH_ONLINE", False)  # tests never touch the network, whatever the user default
    enrich._route_mem.clear()
    enrich._route_miss.clear()
    import app.db, app.models, app.recorder, app.api.flights, app.main
    for m in (app.db, app.models, app.recorder, app.api.flights, app.main):
        importlib.reload(m)
    with TestClient(app.main.app) as c:
        yield c, app


def test_info_endpoint_with_registry_and_online_route(client, tmp_path, monkeypatch):
    c, app = client
    from app.ingest.sbs import parse_sbs
    import app.enrich_import as imp
    importlib.reload(imp)

    async def feed():
        await app.main.recorder.on_msg(parse_sbs(L(0)))
        await app.main.recorder.flush()
    c.portal.call(feed)
    fid = c.get("/api/flights").json()[0]["id"]

    info = c.get(f"/api/flights/{fid}/info").json()
    assert info["country"] == "Netherlands" and info["airline"]["name"] == "KLM"
    assert info["aircraft"] is None and info["route"] is None

    csv_path = tmp_path / "db.csv"
    csv_path.write_text(CSV)
    assert c.portal.call(imp.import_csv, str(csv_path)) == 1  # 'bad' row skipped
    info = c.get(f"/api/flights/{fid}/info").json()
    assert info["aircraft"]["registration"] == "PH-BXA" and info["aircraft"]["type_code"] == "B738"

    calls = []

    async def fake_get(url):
        calls.append(url)
        return {"response": {"flightroute": {"origin": {"icao_code": "EHAM", "name": "Schiphol", "municipality": "Amsterdam"},
                                             "destination": {"icao_code": "EGLL", "name": "Heathrow", "municipality": "London"}}}}
    monkeypatch.setattr(enrich, "_get_json", fake_get)
    assert c.get(f"/api/flights/{fid}/info").json()["route"] is None and calls == []  # online off by default
    monkeypatch.setattr(config, "ENRICH_ONLINE", True)
    route = c.get(f"/api/flights/{fid}/info").json()["route"]
    assert route["origin"]["icao"] == "EHAM" and route["destination"]["city"] == "London"
    c.get(f"/api/flights/{fid}/info")
    assert len(calls) == 1  # second request served from cache

    assert c.get("/api/flights/999/info").status_code == 404
    tr = c.get(f"/api/flights/{fid}/track").json()
    assert {"pitch", "roll"} <= tr["points"][0].keys()
