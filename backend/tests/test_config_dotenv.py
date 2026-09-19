from app import config


def test_dotenv_file_is_loaded_but_real_environment_wins(tmp_path, monkeypatch):
    monkeypatch.delenv("FLIGHTLOG_NO_DOTENV", raising=False)
    env = tmp_path / ".env"
    env.write_text("FLTEST_A=from-file\nFLTEST_B=from-file\n# comment\nFLTEST_C=\"quoted value\"\n")
    monkeypatch.delenv("FLTEST_A", raising=False)
    monkeypatch.delenv("FLTEST_C", raising=False)
    monkeypatch.setenv("FLTEST_B", "from-environment")
    assert config.load_dotenv_file(env) is True
    import os
    assert os.environ["FLTEST_A"] == "from-file"
    assert os.environ["FLTEST_B"] == "from-environment"            # a real variable beats the file
    assert os.environ["FLTEST_C"] == "quoted value"
    for k in ("FLTEST_A", "FLTEST_C"):
        monkeypatch.delenv(k, raising=False)


def test_missing_file_is_fine_and_the_switch_disables_loading(tmp_path, monkeypatch):
    monkeypatch.delenv("FLIGHTLOG_NO_DOTENV", raising=False)
    assert config.load_dotenv_file(tmp_path / "nope.env") is False
    env = tmp_path / ".env"
    env.write_text("FLTEST_D=1\n")
    monkeypatch.setenv("FLIGHTLOG_NO_DOTENV", "1")
    assert config.load_dotenv_file(env) is False
    import os
    assert "FLTEST_D" not in os.environ


def test_defaults_are_neutral_for_a_public_repo():
    """Without a .env or environment, nothing personal or privacy-sensitive is switched on."""
    import importlib, os
    keys = ["RECEIVER_LAT", "RECEIVER_LON", "ENRICH_ONLINE", "AIRPORT_LAT", "AIRPORT_LON", "AIRPORT_ICAO"]
    saved = {k: os.environ.pop(k, None) for k in keys}
    try:
        fresh = importlib.reload(config)
        assert (fresh.RECEIVER_LAT, fresh.RECEIVER_LON) == (0.0, 0.0)
        assert fresh.ENRICH_ONLINE is False
        assert (fresh.AIRPORT_LAT, fresh.AIRPORT_LON, fresh.AIRPORT_ICAO) == (0.0, 0.0, "")
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v
        importlib.reload(config)
