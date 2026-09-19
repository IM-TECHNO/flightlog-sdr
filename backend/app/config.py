"""Settings, read from environment variables. A `.env` file in the backend folder is loaded first (copy
`.env.example` to `.env`); real environment variables always win over it."""
import os
from pathlib import Path
from typing import Optional


def load_dotenv_file(path: Optional[Path] = None) -> bool:
    """Load KEY=VALUE lines from backend/.env (or `path`) into the environment, without overriding anything already set.
    Returns True if a file was read. Set FLIGHTLOG_NO_DOTENV=1 to skip it (the tests do)."""
    if os.environ.get("FLIGHTLOG_NO_DOTENV") == "1":
        return False
    try:
        from dotenv import load_dotenv
    except ImportError:  # python-dotenv is optional at runtime: plain environment variables still work
        return False
    path = path or Path(__file__).resolve().parents[1] / ".env"
    return bool(path.is_file() and load_dotenv(path, override=False))


load_dotenv_file()

# --- receiver feed ----------------------------------------------------------------------------------
SBS_HOST = os.getenv("SBS_HOST", "127.0.0.1")
SBS_PORT = int(os.getenv("SBS_PORT", "30003"))
DB_URL = os.getenv("DB_URL", "sqlite+aiosqlite:///./flightlog.db")
RECEIVER_LAT = float(os.getenv("RECEIVER_LAT", "0"))  # your antenna: map home, range rings, coverage
RECEIVER_LON = float(os.getenv("RECEIVER_LON", "0"))
FLIGHT_GAP_SECONDS = int(os.getenv("FLIGHT_GAP_SECONDS", "1200"))

# Online lookups (aircraft type/registration, routes, photos). Off by default: they send callsigns and
# ICAO24 addresses of the aircraft you see to adsbdb.com / planespotters.net.
ENRICH_ONLINE = os.getenv("ENRICH_ONLINE", "0") == "1"

# --- airport activity (arrivals, departures, runway use). Off until AIRPORT_LAT / AIRPORT_LON are set. -----
AIRPORT_ICAO = os.getenv("AIRPORT_ICAO", "")
AIRPORT_NAME = os.getenv("AIRPORT_NAME", "")
AIRPORT_LAT = float(os.getenv("AIRPORT_LAT", "0"))
AIRPORT_LON = float(os.getenv("AIRPORT_LON", "0"))
AIRPORT_ELEV_FT = int(os.getenv("AIRPORT_ELEV_FT", "0"))
AIRPORT_RUNWAYS = os.getenv("AIRPORT_RUNWAYS", "")  # "name:heading,..." (magnetic, degrees), e.g. "05:49,23:229"

# --- housekeeping: thin positions older than RETENTION_DAYS to one point per THIN_KEEP_SECONDS (0 = never) --
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "0"))
THIN_KEEP_SECONDS = int(os.getenv("THIN_KEEP_SECONDS", "10"))

# --- signal strength: the decoder's own aircraft.json (dump1090 / readsb web feed). Empty string = off. -------
AIRCRAFT_JSON_URL = os.getenv("AIRCRAFT_JSON_URL", "http://127.0.0.1:8080/data/aircraft.json")

# --- receiver gain control (edits dump1090.cfg and can restart the decoder; only from this machine) ---------
RECEIVER_CONTROL = os.getenv("RECEIVER_CONTROL", "1") == "1"
DUMP1090_CFG = os.getenv("DUMP1090_CFG", "")  # path to dump1090.cfg; found from the running decoder when empty
