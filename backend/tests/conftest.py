import os

os.environ["FLIGHTLOG_NO_DOTENV"] = "1"  # before app.config is imported: tests must not read a developer's .env

import importlib

import pytest
from fastapi.testclient import TestClient

from app import config, enrich, signal


@pytest.fixture(autouse=True)
def isolated_state(monkeypatch):
    """No test may inherit cached lookups from another, touch the network, or read a real feed,
    whatever the user's own defaults in config.py are."""
    monkeypatch.setattr(config, "ENRICH_ONLINE", False)
    monkeypatch.setattr(config, "SBS_PORT", 1)
    monkeypatch.setattr(config, "AIRCRAFT_JSON_URL", "")  # never poll a real decoder
    monkeypatch.setattr(config, "DUMP1090_CFG", "")
    monkeypatch.setattr(config, "RECEIVER_CONTROL", True)
    from app import receiver
    monkeypatch.setattr(receiver, "find_decoder", lambda: None)  # never look for (or restart) the real dump1090
    signal.latest.clear()
    signal._msgs.clear()
    monkeypatch.setattr(signal, "available", False)
    for cache in (enrich._route_mem, enrich._route_miss, enrich._ac_mem, enrich._ac_tried):
        cache.clear()
    try:
        from app.api import insights
        insights._photo_cache.clear()
    except ImportError:
        pass


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    """A fresh app on its own database, driven directly through the recorder (no network, no real feed)."""
    monkeypatch.setattr(config, "DB_URL", f"sqlite+aiosqlite:///{tmp_path}/t.db")
    import app.db, app.models, app.recorder, app.api.flights, app.api.alerts, app.api.insights, app.api.receiver, app.maintenance, app.main
    for m in (app.db, app.models, app.recorder, app.api.flights, app.api.alerts, app.api.insights, app.api.receiver, app.maintenance, app.main):
        importlib.reload(m)
    with TestClient(app.main.app) as c:
        yield c, app
