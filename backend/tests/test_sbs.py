from datetime import timedelta

from app.ingest.sbs import parse_sbs
from app.ingest.tracker import Tracker

L1 = "MSG,3,1,1,4840D6,1,2026/09/19,10:00:00.000,2026/09/19,10:00:00.000,KLM1023,36000,450,90,52.3,4.7,0,,0,0,0,0"
L2 = "MSG,3,1,1,4840D6,1,2026/09/19,11:00:00.000,2026/09/19,11:00:00.000,KLM1023,35000,450,90,52.4,4.8,0,,0,0,0,0"


def test_parse():
    m = parse_sbs(L1)
    assert m.icao24 == "4840d6" and m.callsign == "KLM1023" and m.alt == 36000 and m.lat == 52.3


def test_parse_rejects_garbage():
    assert parse_sbs("hello") is None


def test_segmentation():
    t = Tracker(1200)
    _, new1 = t.update(parse_sbs(L1))
    _, new2 = t.update(parse_sbs(L2))
    assert new1 and new2  # 1h gap starts a new flight
