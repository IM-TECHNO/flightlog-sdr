import sqlite3
from datetime import datetime, timedelta, timezone

from app import config, enrich
from app.ingest.sbs import SbsMessage, parse_sbs


def sbs(**kw):
    base = dict(icao24="800001", ts=datetime.now(timezone.utc), callsign="IGO335", alt=30000, gs=450.0, track=90.0,
                lat=11.5, lon=77.0, vrate=0, squawk=None)
    base.update(kw)
    return SbsMessage(**base)


def feed(c, app, msgs):
    async def run():
        for m in msgs:
            await app.main.recorder.on_msg(m)
        await app.main.recorder.flush()
    c.portal.call(run)


def flush(c, app):
    c.portal.call(app.main.recorder.flush)


# ------------------------------------------------------------------------------------------ parser
def test_parser_reads_squawk_and_on_ground():
    line = "MSG,3,1,1,800001,1,2026/09/19,10:00:00.000,2026/09/19,10:00:00.000,IGO335,36000,450,90,11.5,77.0,0,7700,-1,-1,0,-1"
    m = parse_sbs(line)
    assert m.squawk == "7700" and m.on_ground is True
    assert parse_sbs(line[:-2] + "0").on_ground is False          # 0 = airborne
    assert parse_sbs(line[:-2]).on_ground is None                  # empty = not reported


# ------------------------------------------------------------------------------------------ alerts
def test_emergency_squawk_raises_one_alert_per_change(app_client):
    c, app = app_client
    t = datetime.now(timezone.utc)
    feed(c, app, [sbs(ts=t, squawk="1200"), sbs(ts=t + timedelta(seconds=2), squawk="7700"),
                  sbs(ts=t + timedelta(seconds=4), squawk="7700"),  # same squawk: no second alert
                  sbs(ts=t + timedelta(seconds=6), squawk="2000"),
                  sbs(ts=t + timedelta(seconds=8), squawk="7600")])
    alerts = c.get("/api/alerts").json()
    assert [a["detail"] for a in alerts] == ["Squawk 7600: radio failure", "Squawk 7700: general emergency"]
    assert alerts[0]["kind"] == "emergency" and alerts[0]["callsign"] == "IGO335" and alerts[0]["flight_id"]
    assert c.get("/api/alerts", params={"after": alerts[0]["id"]}).json() == []
    live = c.get("/api/aircraft/live").json()[0]
    assert live["squawk"] == "7600" and live["emergency"] == "radio failure"


def test_watchlist_matches_and_validates(app_client):
    c, app = app_client
    assert c.post("/api/watchlist", json={"kind": "callsign", "value": "igo33"}).json()["value"] == "IGO33"
    assert c.post("/api/watchlist", json={"kind": "airline", "value": "AIC"}).status_code == 200
    assert c.post("/api/watchlist", json={"kind": "icao24", "value": "ABCDEF"}).json()["value"] == "abcdef"
    assert c.post("/api/watchlist", json={"kind": "airline", "value": "AIRINDIA"}).status_code == 400
    assert c.post("/api/watchlist", json={"kind": "icao24", "value": "12"}).status_code == 400
    assert c.post("/api/watchlist", json={"kind": "colour", "value": "red"}).status_code == 400
    assert len(c.get("/api/watchlist").json()) == 3
    flush(c, app)  # the recorder reloads the list on its next flush

    t = datetime.now(timezone.utc)
    feed(c, app, [sbs(ts=t), sbs(ts=t + timedelta(seconds=2)),                       # IGO335 matches "IGO33"
                  sbs(icao24="800002", callsign="AXB52K", ts=t)])                    # no match
    alerts = c.get("/api/alerts").json()
    assert len(alerts) == 1 and alerts[0]["kind"] == "watch" and alerts[0]["detail"] == "Watchlist: callsign IGO33"
    by_call = {a["callsign"]: a for a in c.get("/api/aircraft/live").json()}
    assert by_call["IGO335"]["watched"] is True and by_call["AXB52K"]["watched"] is False

    wid = c.get("/api/watchlist").json()[0]["id"]
    assert c.delete(f"/api/watchlist/{wid}").status_code == 200
    assert c.delete(f"/api/watchlist/{wid}").status_code == 404


# ------------------------------------------------------------------------------------------ coverage & heatmap
def test_coverage_bins_and_heatmap(app_client, monkeypatch):
    c, app = app_client
    monkeypatch.setattr(config, "RECEIVER_LAT", 11.0)
    monkeypatch.setattr(config, "RECEIVER_LON", 77.0)
    t = datetime.now(timezone.utc)
    feed(c, app, [sbs(icao24="a00001", ts=t, lat=11.55, lon=77.0),                       # due north, about 61 km
                  sbs(icao24="a00001", ts=t + timedelta(seconds=2), lat=11.52, lon=77.0),
                  sbs(icao24="a00002", ts=t, lat=11.0, lon=78.0)])                       # east, about 109 km
    cov = c.get("/api/coverage").json()
    assert cov["enabled"] and cov["positions"] == 3
    assert 60.5 < cov["bins"][0]["max_km"] < 62 and cov["bins"][0]["count"] == 2
    # a great-circle bearing "east" from 11N is really ~89.9 degrees, so it lands in the 80-90 sector
    assert 108 < cov["bins"][8]["max_km"] < 110.5 and cov["bins"][9]["count"] == 0
    assert cov["max_km"] == cov["bins"][8]["max_km"]

    heat = c.get("/api/heatmap", params={"cell": 0.1}).json()
    assert heat["max"] == 2 and len(heat["cells"]) == 2            # both northern points fall in one 0.1 degree cell
    monkeypatch.setattr(config, "RECEIVER_LAT", 0.0)
    monkeypatch.setattr(config, "RECEIVER_LON", 0.0)
    assert c.get("/api/coverage").json() == {"enabled": False}


# ------------------------------------------------------------------------------------------ replay
def test_replay_returns_every_flight_in_the_window(app_client):
    c, app = app_client
    t = datetime.now(timezone.utc) - timedelta(hours=3)
    msgs = []
    for i in range(30):
        msgs.append(sbs(icao24="b00001", callsign="KLM1023", ts=t + timedelta(seconds=2 * i), lat=11.0 + i / 100, alt=10000 + i * 100))
        msgs.append(sbs(icao24="b00002", callsign="BAW117", ts=t + timedelta(seconds=2 * i), lat=12.0 + i / 100))
    feed(c, app, msgs)
    start = (t - timedelta(minutes=5)).isoformat()
    end = (t + timedelta(hours=1)).isoformat()
    full = c.get("/api/replay", params={"start": start, "end": end}).json()
    assert {f["callsign"] for f in full["flights"]} == {"KLM1023", "BAW117"} and full["stride"] == 1
    assert len(full["flights"][0]["points"]) == 30 and {"pitch", "roll"} <= full["flights"][0]["points"][0].keys()
    later = c.get("/api/replay", params={"start": (t + timedelta(hours=2)).isoformat(), "end": (t + timedelta(hours=3)).isoformat()}).json()
    assert later["flights"] == []


def test_replay_thins_large_windows(app_client):
    c, app = app_client
    t = datetime.now(timezone.utc) - timedelta(hours=1)
    feed(c, app, [sbs(ts=t + timedelta(seconds=2 * i), lat=11.0 + i / 10000) for i in range(1500)])
    r = c.get("/api/replay", params={"start": (t - timedelta(minutes=1)).isoformat(),
                                     "end": (t + timedelta(hours=1)).isoformat(), "max_points": 1000}).json()
    assert r["stride"] == 2 and len(r["flights"][0]["points"]) <= 1000
    pts = r["flights"][0]["points"]
    assert pts[0]["lat"] == 11.0 and abs(pts[-1]["lat"] - (11.0 + 1499 / 10000)) < 1e-9   # first and last are kept


# ------------------------------------------------------------------------------------------ airport
LAT0, LON0 = 11.0300, 77.0434


def leg(icao, callsign, t0, points, track):
    return [sbs(icao24=icao, callsign=callsign, ts=t0 + timedelta(seconds=3 * i), lat=lat, lon=lon, alt=alt, track=track)
            for i, (lat, lon, alt) in enumerate(points)]


def test_airport_arrival_departure_go_around_and_overflight(app_client, monkeypatch):
    c, app = app_client
    for k, v in {"AIRPORT_ICAO": "VOCB", "AIRPORT_NAME": "Coimbatore", "AIRPORT_LAT": LAT0, "AIRPORT_LON": LON0,
                 "AIRPORT_ELEV_FT": 1324, "AIRPORT_RUNWAYS": "05:49,23:229"}.items():
        monkeypatch.setattr(config, k, v)
    t = datetime.now(timezone.utc) - timedelta(hours=1)
    # arrival on 23: descending from the NE, last seen about 1 km from the field and 200 ft above it
    arr = leg("c00001", "IGO335", t, [(LAT0 + 0.08 - i * 0.012, LON0 + 0.09 - i * 0.013, 4200 - i * 420) for i in range(7)], 229)
    # departure on 05: first seen just after lift-off, then climbing away to the NE, out of the box
    dep = leg("c00002", "AIC7RJ", t, [(LAT0 + i * 0.03, LON0 + i * 0.033, 1400 + i * 900) for i in range(9)], 49)
    # go-around: comes down to ~300 ft above the field, then climbs away and is last seen far out and high
    ga = leg("c00003", "SEJ812", t, [(LAT0 + 0.07 - i * 0.014, LON0 + 0.08 - i * 0.016, 3400 - i * 350) for i in range(6)]
             + [(LAT0 - 0.02 - i * 0.05, LON0 - 0.02 - i * 0.05, 1700 + i * 1200) for i in range(1, 6)], 229)
    # overflight: high and unrelated to the airport
    over = leg("c00004", "UAE501", t, [(LAT0 + 0.1 - i * 0.03, LON0 - 0.1 + i * 0.03, 36000) for i in range(8)], 130)
    feed(c, app, arr + dep + ga + over)

    r = c.get("/api/airport", params={"days": 2}).json()
    assert r["enabled"] and r["airport"]["icao"] == "VOCB"
    by_call = {m["callsign"]: m for m in r["movements"]}
    assert set(by_call) == {"IGO335", "AIC7RJ", "SEJ812"}          # the overflight is ignored
    assert by_call["IGO335"]["kind"] == "arrival" and by_call["IGO335"]["runway"] == "23" and not by_call["IGO335"]["go_around"]
    assert by_call["AIC7RJ"]["kind"] == "departure" and by_call["AIC7RJ"]["runway"] == "05"
    assert by_call["SEJ812"]["go_around"] is True and by_call["SEJ812"]["kind"] == "arrival"
    assert r["summary"] == {"arrivals": 2, "departures": 1, "go_arounds": 1, "by_runway": {"23": 2, "05": 1}}


def test_airport_can_be_disabled(app_client, monkeypatch):
    c, _ = app_client
    monkeypatch.setattr(config, "AIRPORT_LAT", 0.0)
    monkeypatch.setattr(config, "AIRPORT_LON", 0.0)
    assert c.get("/api/airport").json() == {"enabled": False}


# ------------------------------------------------------------------------------------------ photo
def test_photo_lookup_is_opt_in_cached_and_validated(app_client, monkeypatch):
    c, _ = app_client
    calls = []

    async def fake(url):
        calls.append(url)
        if url.endswith("adfdf8"):
            return {"photos": [{"thumbnail_large": {"src": "https://t.example/a.jpg"}, "link": "https://p.example/1", "photographer": "Jo"}]}
        return {"photos": []}

    monkeypatch.setattr(enrich, "_get_json", fake)
    assert c.get("/api/photo/adfdf8").json()["available"] is False and calls == []      # online lookups off
    monkeypatch.setattr(config, "ENRICH_ONLINE", True)
    ok = c.get("/api/photo/ADFDF8").json()
    assert ok == {"available": True, "src": "https://t.example/a.jpg", "link": "https://p.example/1", "photographer": "Jo"}
    c.get("/api/photo/adfdf8")
    assert len(calls) == 1                                                            # second request from cache
    assert c.get("/api/photo/123456").json() == {"available": False, "reason": "no photo on file"}
    assert c.get("/api/photo/zzzzzz").status_code == 400


# ------------------------------------------------------------------------------------------ housekeeping
def test_thinning_backup_and_info(app_client, tmp_path):
    from app import maintenance
    c, app = app_client
    old = datetime.now(timezone.utc) - timedelta(days=60)
    recent = datetime.now(timezone.utc) - timedelta(minutes=5)
    feed(c, app, [sbs(icao24="d00001", ts=old + timedelta(seconds=i)) for i in range(60)]
                 + [sbs(icao24="d00002", ts=recent + timedelta(seconds=i)) for i in range(20)])
    before = c.get("/api/db").json()
    assert before["positions"] == 80 and before["flights"] == 2 and before["size_bytes"] > 0

    deleted = c.portal.call(maintenance.thin_positions, 30, 10)
    assert deleted in (53, 54)              # 60 s of 1 Hz data keeps one point per 10 s bucket: 6 or 7, by alignment
    remaining = 80 - deleted
    assert c.get("/api/db").json()["positions"] == remaining and remaining >= 20 + 6   # recent data untouched

    dest = c.portal.call(maintenance.backup, tmp_path / "backups")
    con = sqlite3.connect(dest)
    assert con.execute("SELECT COUNT(*) FROM positions").fetchone() == (remaining,)
    con.close()


# ------------------------------------------------------------------------------------------ CORS
def test_cors_allows_the_home_network_but_not_the_internet(app_client):
    c, _ = app_client
    for origin in ("http://192.168.1.20:3000", "http://localhost:3000", "http://10.0.0.5:3000"):
        assert c.get("/api/config", headers={"Origin": origin}).headers["access-control-allow-origin"] == origin
    assert "access-control-allow-origin" not in c.get("/api/config", headers={"Origin": "https://evil.example"}).headers
