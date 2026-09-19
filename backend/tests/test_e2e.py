import asyncio

from fastapi.testclient import TestClient

from app import config

L = "MSG,3,1,1,4840D6,1,2026/09/19,10:00:0{n}.000,2026/09/19,10:00:0{n}.000,KLM1023,36000,450,90,52.{n},4.7,0,,0,0,0,0\n"


def test_ingest_to_api(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_URL", f"sqlite+aiosqlite:///{tmp_path}/t.db")
    import importlib, app.db, app.models, app.recorder, app.api.flights, app.main
    for m in (app.db, app.models, app.recorder, app.api.flights, app.main):
        importlib.reload(m)

    async def serve():
        async def h(_, w):
            for n in range(5):
                w.write(L.format(n=n).encode())
            await w.drain(); await asyncio.sleep(3); w.close()
        return await asyncio.start_server(h, "127.0.0.1", 30999)

    monkeypatch.setattr(config, "SBS_PORT", 30999)
    loop = asyncio.new_event_loop()
    srv = loop.run_until_complete(serve())
    import threading
    threading.Thread(target=loop.run_forever, daemon=True).start()
    with TestClient(app.main.app) as c:
        import time; time.sleep(3.5)
        fl = c.get("/api/flights").json()
        assert fl and fl[0]["callsign"] == "KLM1023"
        tr = c.get(f"/api/flights/{fl[0]['id']}/track").json()
        assert len(tr["points"]) == 5
    loop.call_soon_threadsafe(srv.close)
