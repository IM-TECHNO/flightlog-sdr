"""Insert demo flight history (departure climbs on previous days) so History/overlay/"flown before"
can be tried without waiting for real traffic.
Usage: python scripts/seed_demo.py [db=backend/flightlog.db] [days=3]
Seeded flights use the callsigns/airframes of scripts/synth_sbs.py, so live flights show up as
"flown before" matches."""
import math
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "backend" / "flightlog.db")
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
HOME = (52.31, 4.76)
# icao24, callsign, hour of day, initial heading, top altitude (ft)
PLANES = [("4840d6", "KLM1023", 10, 240, 36000), ("406a2b", "BAW117", 14, 250, 28000)]
STEP = 5  # seconds between positions


def fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")  # SQLAlchemy's sqlite DateTime storage format


def climb(start: datetime, hdg0: float, top: int, jitter: float):
    lat, lon = HOME
    for i in range(int(25 * 60 / STEP)):
        hdg = hdg0 + jitter + min(55, i * 0.6)
        gs = min(450, 160 + i * 2.6)
        alt = min(top, i * STEP / 60 * 2600)
        vrate = 2600 if alt < top else 0
        dist = gs * 0.514444 * STEP
        lat += dist * math.cos(math.radians(hdg)) / 111_320
        lon += dist * math.sin(math.radians(hdg)) / (111_320 * math.cos(math.radians(lat)))
        yield start + timedelta(seconds=i * STEP), lat, lon, int(alt), gs, hdg % 360, vrate


def main():
    con = sqlite3.connect(DB)
    now = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    n = 0
    for d in range(1, DAYS + 1):
        for icao, cs, hour, hdg0, top in PLANES:
            if cs == "BAW117" and d % 2 == 0:
                continue  # not every plane flies every day
            start = (now - timedelta(days=d)).replace(hour=hour)
            pts = list(climb(start, hdg0, top, jitter=(d - 2) * 6))
            cur = con.execute(
                "INSERT INTO flights (icao24, callsign, first_seen, last_seen, max_alt, min_alt, msg_count) VALUES (?,?,?,?,?,?,?)",
                (icao, cs, fmt(pts[0][0]), fmt(pts[-1][0]), max(p[3] for p in pts), min(p[3] for p in pts), len(pts) * 4),
            )
            con.executemany(
                "INSERT INTO positions (flight_id, ts, lat, lon, alt, gs, track, vrate) VALUES (?,?,?,?,?,?,?,?)",
                [(cur.lastrowid, fmt(p[0]), *p[1:]) for p in pts],
            )
            n += 1
    con.commit()
    print(f"seeded {n} flights into {DB}")


if __name__ == "__main__":
    main()
