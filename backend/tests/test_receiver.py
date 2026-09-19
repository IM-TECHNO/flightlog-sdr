import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app import config, receiver, signal

CFG = (
    "# comment about things\r\n"
    "agc        = false       # Enable Digital AGC.\r\n"
    "gain       = 31          # Set gain.\r\n"
    "# gain = 5   (an old, commented-out line must be ignored)\r\n"
    "samplerate    = 2.4M     # Set sample-rate.\r\n"
)


@pytest.fixture
def cfg(tmp_path):
    p = tmp_path / "dump1090.cfg"
    p.write_bytes(CFG.encode())
    return p


# ------------------------------------------------------------------------------------------ config file
def test_read_gain_ignores_comments_and_junk(cfg, tmp_path):
    assert receiver.read_gain(cfg) == 31.0
    other = tmp_path / "x.cfg"
    other.write_text("# gain = 7\nsamplerate = 2.4M\n")
    assert receiver.read_gain(other) is None                       # only a commented line
    other.write_text("gain = auto\n")
    assert receiver.read_gain(other) is None                       # not a number
    assert receiver.read_gain(tmp_path / "missing.cfg") is None


def test_write_gain_changes_only_that_line_and_backs_up(cfg):
    backup = receiver.write_gain(cfg, 22)
    new = cfg.read_bytes().decode()
    assert new == CFG.replace("gain       = 31          # Set gain.", "gain       = 22          # Set gain.")   # comment, spacing, CRLF kept
    assert backup.read_bytes().decode() == CFG and backup.name.startswith("dump1090.cfg.bak-")
    assert receiver.read_gain(cfg) == 22.0


@pytest.mark.parametrize("bad", [-1, 51, 29.7, True, "20"])
def test_write_gain_rejects_bad_values_without_touching_the_file(cfg, bad):
    with pytest.raises(ValueError):
        receiver.write_gain(cfg, bad)
    assert cfg.read_bytes().decode() == CFG and not list(cfg.parent.glob("*.bak-*"))


def test_write_gain_needs_a_gain_line_and_keeps_only_a_few_backups(cfg, tmp_path):
    empty = tmp_path / "e.cfg"
    empty.write_text("samplerate = 2.4M\n")
    with pytest.raises(ValueError, match="no `gain =` line"):
        receiver.write_gain(empty, 20)
    for i in range(8):
        (cfg.parent / f"dump1090.cfg.bak-2020010{i}-000000").write_text("old")
    receiver.write_gain(cfg, 25)
    assert len(list(cfg.parent.glob("dump1090.cfg.bak-*"))) == receiver.KEEP_BACKUPS


# ------------------------------------------------------------------------------------------ finding the config
def test_cfg_path_resolution(tmp_path, monkeypatch, cfg):
    exe = tmp_path / "dump1090.exe"
    exe.write_text("")
    dec = {"pid": 1, "exe": str(exe), "cmdline": f'"{exe}" --net'}
    assert receiver.cfg_path_for(dec) == cfg                                       # beside the exe by default
    other = tmp_path / "custom.cfg"
    other.write_text(CFG)
    assert receiver.cfg_path_for({**dec, "cmdline": f'"{exe}" --net --config "{other}"'}) == other
    assert receiver.cfg_path_for({**dec, "cmdline": f"dump1090 --net -c custom.cfg"}) == other   # relative to the exe
    assert receiver.cfg_path_for({**dec, "cmdline": f'"{exe}" --config nope.cfg'}) is None
    assert receiver.cfg_path_for(None) is None
    monkeypatch.setattr(config, "DUMP1090_CFG", str(other))
    assert receiver.cfg_path_for(None) == other                                    # the override needs no running decoder


# ------------------------------------------------------------------------------------------ applying, restarting, rolling back
def test_apply_without_restart_only_edits(cfg):
    calls = []
    r = receiver.apply_gain(18, False, decoder={"pid": 1, "exe": "x", "cmdline": "x"}, path=cfg, start=calls.append, check=lambda: True)
    assert r["applied"] and not r["restarted"] and r["previous"] == 31 and calls == [] and receiver.read_gain(cfg) == 18


def test_apply_with_restart_success(cfg):
    started = []
    r = receiver.apply_gain(18, True, decoder={"pid": 1, "exe": "x", "cmdline": "x"}, path=cfg, start=started.append, check=lambda: True)
    assert r["applied"] and r["restarted"] and len(started) == 1 and receiver.read_gain(cfg) == 18


def test_failed_restart_restores_the_previous_config(cfg):
    started = []
    answers = iter([False, True])                                # the first start fails, the recovery start works
    r = receiver.apply_gain(18, True, decoder={"pid": 1, "exe": "x", "cmdline": "x"}, path=cfg,
                            start=started.append, check=lambda: next(answers))
    assert not r["applied"] and r["restarted"] and r["gain"] == 31
    assert len(started) == 2 and receiver.read_gain(cfg) == 31   # config back to what it was
    assert "restored" in r["message"] and "running again" in r["message"]


def test_failed_restart_that_cannot_recover_says_so(cfg):
    r = receiver.apply_gain(18, True, decoder={"pid": 1, "exe": "x", "cmdline": "x"}, path=cfg, start=lambda d: None, check=lambda: False)
    assert not r["applied"] and not r["restarted"] and "NOT running" in r["message"] and receiver.read_gain(cfg) == 31


def test_apply_when_the_decoder_is_not_running_just_edits(cfg):
    r = receiver.apply_gain(20, True, decoder=None, path=cfg, start=lambda d: pytest.fail("must not start anything"), check=lambda: True)
    assert r["applied"] and not r["restarted"] and "not running" in r["message"] and receiver.read_gain(cfg) == 20


# ------------------------------------------------------------------------------------------ the assistant
def summary(**kw):
    return {"aircraft": 10, "median": -20.0, "strongest": -8.0, "weakest": -30.0, "strong": 0, "msg_rate": 50.0, **kw}


def test_verdict_thresholds():
    assert receiver.verdict(summary(aircraft=2))["level"] == "unknown"
    assert receiver.verdict(summary())["level"] == "ok"
    assert receiver.verdict(summary(strong=2))["level"] == "high"          # 20% of aircraft above -3 dBFS
    assert receiver.verdict(summary(strong=1))["level"] == "ok"
    assert receiver.verdict(summary(median=-38.0))["level"] == "low"


def test_summary_from_the_live_signal_readings():
    now = time.monotonic()
    signal.latest.update({"a00001": {"rssi": -2.0, "rate": 10.0, "t": now}, "a00002": {"rssi": -30.0, "rate": 5.0, "t": now},
                          "a00003": {"rssi": -20.0, "rate": None, "t": now}, "a00004": {"rssi": None, "rate": 3.0, "t": now},
                          "a00005": {"rssi": -1.0, "rate": 9.0, "t": now - 60}})            # stale: ignored
    s = receiver.summary_now()
    assert s == {"aircraft": 3, "median": -20.0, "strongest": -2.0, "weakest": -30.0, "strong": 1, "msg_rate": 18.0}


# ------------------------------------------------------------------------------------------ the API
def test_status_explains_why_it_cannot_control(app_client):
    c, _ = app_client
    r = c.get("/api/receiver").json()
    assert r["controllable"] is False and "dump1090.cfg" in r["reason"] and r["decoder"] == {"running": False, "pid": None}
    assert r["gain"] is None and r["gain_max"] == 50 and set(r["verdict"]) == {"level", "text"} and r["history"] == []


def test_status_and_control_with_a_config_found(app_client, cfg, monkeypatch):
    c, _ = app_client
    monkeypatch.setattr(config, "DUMP1090_CFG", str(cfg))
    st = c.get("/api/receiver").json()
    assert st["controllable"] and st["gain"] == 31.0 and st["cfg_path"] == str(cfg)

    r = c.post("/api/receiver/gain", json={"gain": 24}).json()
    assert r["applied"] and r["previous"] == 31 and r["status"]["gain"] == 24.0 and receiver.read_gain(cfg) == 24
    assert c.post("/api/receiver/gain", json={"gain": 51}).status_code == 400
    assert c.post("/api/receiver/gain", json={"gain": -1}).status_code == 400
    assert c.post("/api/receiver/gain", json={"gain": "abc"}).status_code == 422
    assert receiver.read_gain(cfg) == 24                                           # refused requests changed nothing


def test_control_is_refused_from_other_machines_and_when_switched_off(app_client, cfg, monkeypatch):
    from app.api import receiver as api
    c, _ = app_client
    monkeypatch.setattr(config, "DUMP1090_CFG", str(cfg))
    monkeypatch.setattr(api, "_is_local", lambda request: False)                   # as if from a phone on the Wi-Fi
    assert c.post("/api/receiver/gain", json={"gain": 10}).status_code == 403
    st = c.get("/api/receiver").json()
    assert st["controllable"] is False and "machine running the backend" in st["reason"] and st["gain"] == 31.0   # reading is still fine
    monkeypatch.setattr(api, "_is_local", lambda request: True)
    monkeypatch.setattr(config, "RECEIVER_CONTROL", False)
    assert c.post("/api/receiver/gain", json={"gain": 10}).status_code == 403
    assert receiver.read_gain(cfg) == 31


# ------------------------------------------------------------------------------------------ comparing gain settings
def test_sampler_records_and_history_averages_per_gain(app_client, cfg, monkeypatch):
    c, app = app_client
    sampler = receiver.Sampler(app.main.tracker)
    monkeypatch.setattr(sampler, "_cfg", lambda: cfg)
    now = time.monotonic()

    async def go(gain_db, n, rssi):
        receiver.write_gain(cfg, gain_db)
        signal.latest.clear()
        for i in range(n):
            signal.latest[f"b0000{i}"] = {"rssi": rssi, "rate": 4.0, "t": time.monotonic()}
        await sampler.sample_once()

    c.portal.call(go, 20, 4, -25.0)
    c.portal.call(go, 20, 6, -23.0)
    c.portal.call(go, 40, 8, -12.0)
    signal.latest.clear()
    c.portal.call(sampler.sample_once)                                             # nothing in view: no sample
    hist = {h["gain"]: h for h in c.get("/api/receiver").json()["history"]}
    assert set(hist) == {20.0, 40.0}
    assert hist[20.0]["minutes"] == 2 and hist[20.0]["avg_aircraft"] == 5.0 and hist[20.0]["avg_rssi"] == -24.0
    assert hist[40.0]["minutes"] == 1 and hist[40.0]["avg_msg_rate"] == 32.0
    assert now  # keeps the monotonic clock referenced for readability
