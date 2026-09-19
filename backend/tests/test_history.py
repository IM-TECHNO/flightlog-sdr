import importlib

from fastapi.testclient import TestClient

from app import config


def L(icao, cs, day, sec, alt):
    t = f"2025/09/{day}"
    return f"MSG,3,1,1,{icao},1,{t},10:00:{sec:02d}.000,{t},10:00:{sec:02d}.000,{cs},{alt},450,90,52.3,4.7,0,,0,0,0,0"


def test_history_filters_and_altitude(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_URL", f"sqlite+aiosqlite:///{tmp_path}/h.db")
    monkeypatch.setattr(config, "SBS_PORT", 1)  # never connect to a real feed during tests
    import app.db, app.models, app.recorder, app.api.flights, app.main
    for m in (app.db, app.models, app.recorder, app.api.flights, app.main):
        importlib.reload(m)
    from app.ingest.sbs import parse_sbs

    with TestClient(app.main.app) as c:
        rec = app.main.recorder

        async def feed():
            for l in [L("4840D6", "KLM1023", 18, 0, 36000), L("4840D6", "KLM1023", 18, 5, 36100),
                      L("4840D6", "KLM1023", 19, 0, 35000), L("ABC123", "BAW7", 19, 1, 20000)]:
                await rec.on_msg(parse_sbs(l))
            await rec.flush()

        c.portal.call(feed)
        fl = c.get("/api/flights").json()
        assert len(fl) == 3
        klm = [f for f in fl if f["callsign"] == "KLM1023"]
        newest, oldest = klm
        assert (oldest["min_alt"], oldest["max_alt"]) == (36000, 36100)

        hist = c.get(f"/api/flights/{newest['id']}/history").json()
        assert [h["id"] for h in hist] == [oldest["id"]]
        assert len(c.get("/api/flights", params={"q": "klm"}).json()) == 2
        assert len(c.get("/api/flights", params={"start": "2025-09-19T00:00:00Z"}).json()) == 2
        assert c.get("/api/flights/999/history").status_code == 404
        assert c.get("/api/aircraft/live").json() == []  # replayed data is stale
        assert set(c.get("/api/config").json()) == {"receiver", "enrich_online", "airport", "signal_available"}
        with c.websocket_connect("/api/ws/live") as ws:
            assert ws.receive_json() == []
