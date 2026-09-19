"""Estimate aircraft attitude from ADS-B kinematics.

ADS-B carries no pitch/roll, so these are derived estimates:
  heading = ground track
  pitch   = flight-path angle from vertical rate and ground speed (angle of attack ignored)
  roll    = coordinated-turn bank angle from the track rate of change
"""
import math
from datetime import datetime

G = 9.80665
KT_TO_MS = 0.514444
FPM_TO_MS = 0.00508
MAX_PITCH = 25.0
MAX_ROLL = 45.0


def _clamp(v: float, lim: float) -> float:
    return max(-lim, min(lim, v))


def _dt(a: str, b: str) -> float:
    return (datetime.fromisoformat(b.replace("Z", "+00:00")) - datetime.fromisoformat(a.replace("Z", "+00:00"))).total_seconds()


def derive(points: list[dict]) -> list[dict]:
    """Return copies of `points` (ts/alt/gs/track/vrate dicts) with `pitch` and `roll` degrees added."""
    out = []
    n = len(points)
    for i, p in enumerate(points):
        q = dict(p)
        prev = points[i - 1] if i > 0 else None
        nxt = points[i + 1] if i < n - 1 else None

        vrate = p.get("vrate")
        if vrate is None and prev and p.get("alt") is not None and prev.get("alt") is not None:
            dt = _dt(prev["ts"], p["ts"])
            if dt > 0:
                vrate = (p["alt"] - prev["alt"]) / dt * 60  # ft/min
        gs_ms = (p.get("gs") or 0) * KT_TO_MS
        if vrate is not None and gs_ms > 20:
            q["pitch"] = round(_clamp(math.degrees(math.atan2(vrate * FPM_TO_MS, gs_ms)), MAX_PITCH), 1)
        else:
            q["pitch"] = 0.0

        roll = 0.0
        a, b = (prev, nxt) if prev and nxt else (prev, p) if prev else (p, nxt)
        if a and b and a.get("track") is not None and b.get("track") is not None and gs_ms > 20:
            dt = _dt(a["ts"], b["ts"])
            if dt > 0:
                dpsi = (b["track"] - a["track"] + 540) % 360 - 180  # wrapped heading change
                roll = math.degrees(math.atan(gs_ms * math.radians(dpsi / dt) / G))
        q["roll"] = round(_clamp(roll, MAX_ROLL), 1)
        out.append(q)
    return out
