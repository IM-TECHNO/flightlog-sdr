import asyncio
import time
from datetime import datetime, timedelta, timezone

from app import signal
from app.ingest.sbs import SbsMessage


def ac(hex_, rssi=-18.5, messages=100, seen=0.4):
    return {"hex": hex_, "rssi": rssi, "messages": messages, "seen": seen}


def test_parse_reads_rssi_and_derives_message_rate():
    n = signal.parse({"aircraft": [ac("8016b7", -12.3, 100)]}, now=1000.0)
    assert n == 1 and signal.latest["8016b7"]["rssi"] == -12.3 and signal.latest["8016b7"]["rate"] is None
    signal.parse({"aircraft": [ac("8016b7", -13.0, 130)]}, now=1002.0)          # 30 messages in 2 s
    assert signal.latest["8016b7"]["rate"] == 15.0 and signal.latest["8016b7"]["rssi"] == -13.0
    signal.parse({"aircraft": [ac("8016b7", -14.0, 130)]}, now=1003.0)          # no new messages: rate 0, not "unknown"
    assert signal.latest["8016b7"]["rate"] == 0.0


def test_parse_is_defensive_about_what_decoders_send():
    doc = {"aircraft": [
        ac("~ABC123", -20.0),                       # non-ICAO (TIS-B) address: the ~ is dropped
        ac("4840d6", "n/a"),                        # junk rssi: kept without a level
        ac("bad", -5.0),                            # not a 6-character address
        ac("800001", -9.0, seen=60),                # not heard for a minute: ignored
        {"hex": "800002"},                          # no signal fields at all
        "garbage",
    ]}
    assert signal.parse(doc, now=10.0) == 1
    assert signal.latest["abc123"]["rssi"] == -20.0
    assert signal.latest["4840d6"]["rssi"] is None
    assert "bad" not in signal.latest and "800001" not in signal.latest
    assert signal.latest["800002"]["rssi"] is None
    assert signal.parse({"unexpected": True}) == 0 and signal.parse(None) == 0


def test_readings_go_stale_and_departed_aircraft_are_forgotten():
    signal.latest["aaaaaa"] = {"rssi": -10.0, "rate": 5.0, "t": time.monotonic() - 30}
    assert signal.get("aaaaaa") is None and signal.rssi_of("aaaaaa") is None      # older than the stale window
    signal.parse({"aircraft": []}, now=time.monotonic())
    assert "aaaaaa" in signal.latest                                              # stale but not yet forgotten
    signal.latest["aaaaaa"]["t"] = time.monotonic() - 70
    signal.parse({"aircraft": []}, now=time.monotonic())
    assert "aaaaaa" not in signal.latest                                          # dropped after a minute


def test_worker_is_off_without_a_url():
    asyncio.run(asyncio.wait_for(signal.worker(), timeout=2))                     # returns at once, does not poll


def msg(icao, ts):
    return SbsMessage(icao24=icao, ts=ts, callsign="IGO335", alt=30000, gs=450.0, track=90.0, lat=11.5, lon=77.0, vrate=0)


def test_signal_reaches_the_live_feed_and_is_stored_with_each_position(app_client):
    c, app = app_client
    now = datetime.now(timezone.utc)
    signal.latest["800001"] = {"rssi": -18.5, "rate": 12.0, "t": time.monotonic()}

    async def feed(msgs):
        for m in msgs:
            await app.main.recorder.on_msg(m)
        await app.main.recorder.flush()

    c.portal.call(feed, [msg("800001", now), msg("800002", now)])                 # the second aircraft has no reading
    live = {a["icao24"]: a for a in c.get("/api/aircraft/live").json()}
    assert live["800001"]["rssi"] == -18.5 and live["800001"]["msg_rate"] == 12.0
    assert live["800002"]["rssi"] is None and live["800002"]["msg_rate"] is None

    fid = c.get("/api/flights", params={"callsign": "IGO335"}).json()[0]["id"]
    flights = {f["icao24"]: f["id"] for f in c.get("/api/flights").json()}
    pts = c.get(f"/api/flights/{flights['800001']}/track").json()["points"]
    assert pts[0]["rssi"] == -18.5
    assert c.get(f"/api/flights/{flights['800002']}/track").json()["points"][0]["rssi"] is None
    csv = c.get(f"/api/flights/{flights['800001']}/export", params={"format": "csv"}).text.splitlines()
    assert csv[0].endswith("rssi_dbfs") and csv[1].endswith("-18.5")
    assert fid  # both flights were recorded


def test_config_reports_whether_signal_data_is_flowing(app_client, monkeypatch):
    c, _ = app_client
    assert c.get("/api/config").json()["signal_available"] is False
    monkeypatch.setattr(signal, "available", True)
    assert c.get("/api/config").json()["signal_available"] is True
