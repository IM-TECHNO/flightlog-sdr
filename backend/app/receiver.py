"""Receiver gain: read and edit the decoder's config, restart it safely, and judge whether the gain looks right.

The Windows dump1090 build keeps its tuner gain in dump1090.cfg (`gain = 31`, whole dB; the decoder snaps to the
nearest step the tuner supports) and cannot change it while running. So "adjust gain" means: edit that one line
(after a backup), then restart the decoder, and check it comes back. If it does not, the backup is restored.

Only the local machine may change anything (see api/receiver.py).
"""
import asyncio
import json
import os
import re
import shutil
import socket
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from . import config, db, models, signal

MAX_GAIN = 50  # dB; the R820T tuner tops out at 49.6
GAIN_LINE = re.compile(r"^(\s*gain\s*=\s*)([^#\s]+)(.*)$", re.IGNORECASE)
KEEP_BACKUPS = 5
STRONG_DBFS = -3.0  # this strong is usually the front end being overdriven


# ------------------------------------------------------------------------------------------ the running decoder
def find_decoder() -> Optional[dict]:
    """The running dump1090.exe as {pid, exe, cmdline}, or None. Windows only."""
    if sys.platform != "win32":
        return None
    script = ("Get-CimInstance Win32_Process -Filter \"Name='dump1090.exe'\" | "
              "Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=20).stdout.strip()
        data = json.loads(out) if out else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if isinstance(data, list):
        data = data[0] if data else None
    if not data or not data.get("ExecutablePath"):
        return None
    return {"pid": int(data["ProcessId"]), "exe": data["ExecutablePath"], "cmdline": data.get("CommandLine") or ""}


def cfg_path_for(decoder: Optional[dict]) -> Optional[Path]:
    """Config file: DUMP1090_CFG, else `--config`/`-c` from the command line, else dump1090.cfg beside the exe."""
    if config.DUMP1090_CFG:
        p = Path(config.DUMP1090_CFG)
        return p if p.is_file() else None
    if not decoder:
        return None
    m = re.search(r'(?:--config|-c)[ =]+("([^"]+)"|(\S+))', decoder["cmdline"])
    if m:
        p = Path(m.group(2) or m.group(3))
        if not p.is_absolute():
            p = Path(decoder["exe"]).parent / p
        return p if p.is_file() else None
    p = Path(decoder["exe"]).parent / "dump1090.cfg"
    return p if p.is_file() else None


# ------------------------------------------------------------------------------------------ the config file
def read_gain(path: Path) -> Optional[float]:
    """The `gain =` value in the config (first uncommented line), or None if absent or not a number."""
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = GAIN_LINE.match(line)
            if m and not line.lstrip().startswith("#"):
                return float(m.group(2))
    except (OSError, ValueError):
        pass
    return None


def write_gain(path: Path, gain: int) -> Path:
    """Set `gain =` to a whole number of dB, changing nothing else, and return the backup that was made."""
    if not isinstance(gain, int) or isinstance(gain, bool) or not 0 <= gain <= MAX_GAIN:
        raise ValueError(f"gain must be a whole number from 0 to {MAX_GAIN} dB")
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        m = GAIN_LINE.match(line.rstrip("\r\n"))
        if m and not line.lstrip().startswith("#"):
            ending = line[len(line.rstrip("\r\n")):]
            lines[i] = f"{m.group(1)}{gain}{m.group(3)}{ending}"
            break
    else:
        raise ValueError("no `gain =` line found in the config file")
    backup = path.with_name(f"{path.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(path, backup)
    path.write_text("".join(lines), encoding="utf-8")
    for old in sorted(path.parent.glob(f"{path.name}.bak-*"))[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)
    return backup


# ------------------------------------------------------------------------------------------ restarting
def feed_is_up(timeout: float = 12.0) -> bool:
    """Wait for the decoder's SBS port to accept connections."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            with socket.create_connection((config.SBS_HOST, config.SBS_PORT), timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def _stop_and_start(decoder: dict) -> None:
    subprocess.run(["taskkill", "/PID", str(decoder["pid"]), "/F"], capture_output=True, timeout=15)
    time.sleep(1.5)  # let the USB device be released
    cmd = decoder["cmdline"].strip()
    rest = cmd[cmd.index('"', 1) + 1:] if cmd.startswith('"') else cmd[len(cmd.split(" ", 1)[0]):]
    subprocess.Popen(f'"{decoder["exe"]}"{rest}', cwd=str(Path(decoder["exe"]).parent),
                     creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))


def restart_decoder(decoder: dict, start: Callable[[dict], None] = _stop_and_start, check: Callable[[], bool] = feed_is_up) -> bool:
    """Restart with the same command line; True if the feed comes back."""
    start(decoder)
    return check()


def apply_gain(gain: int, restart: bool, *, decoder: Optional[dict] = None, path: Optional[Path] = None,
               start: Callable[[dict], None] = _stop_and_start, check: Callable[[], bool] = feed_is_up) -> dict:
    """Edit the config and optionally restart. If the decoder does not come back, the old config is restored."""
    decoder = decoder if decoder is not None else find_decoder()
    path = path or cfg_path_for(decoder)
    if path is None:
        raise ValueError("could not find dump1090.cfg (set DUMP1090_CFG)")
    previous = read_gain(path)
    backup = write_gain(path, gain)
    if not restart:
        return {"applied": True, "restarted": False, "previous": previous, "gain": gain,
                "message": f"Gain set to {gain} dB in {path.name}. Restart dump1090 to apply it."}
    if not decoder:
        return {"applied": True, "restarted": False, "previous": previous, "gain": gain,
                "message": f"Gain set to {gain} dB in {path.name}, but dump1090 is not running here. Start it to apply."}
    if restart_decoder(decoder, start, check):
        return {"applied": True, "restarted": True, "previous": previous, "gain": gain,
                "message": f"dump1090 restarted with {gain} dB gain."}
    shutil.copy2(backup, path)  # it did not come back: put the previous config back and try once more
    recovered = restart_decoder(decoder, start, check)
    return {"applied": False, "restarted": recovered, "previous": previous, "gain": previous,
            "message": ("dump1090 did not restart with the new gain, so the previous setting was restored"
                        + (" and it is running again." if recovered else ", but it is NOT running: start it manually."))}


# ------------------------------------------------------------------------------------------ is the gain right?
def verdict(s: dict) -> dict:
    """A plain-language read of the current signal mix. A rule of thumb, not a measurement."""
    n = s["aircraft"]
    if n < 3:
        return {"level": "unknown", "text": "Not enough aircraft in view yet to judge. Come back when a few are in range."}
    if s["strong"] / n >= 0.2:
        return {"level": "high", "text": "Many aircraft are very strong (above -3 dBFS). The receiver may be overloaded: try a lower gain."}
    if s["median"] is not None and s["median"] < -35:
        return {"level": "low", "text": "Signals are weak overall. A higher gain, a better antenna position or a shorter cable may help."}
    return {"level": "ok", "text": "The mix of signal levels looks balanced."}


def summary_now() -> dict:
    vals, rate = [], 0.0
    for icao in list(signal.latest):
        s = signal.get(icao)
        if not s:
            continue
        if s["rssi"] is not None:
            vals.append(s["rssi"])
        rate += s["rate"] or 0.0
    return {
        "aircraft": len(vals),
        "median": round(statistics.median(vals), 1) if vals else None,
        "strongest": round(max(vals), 1) if vals else None,
        "weakest": round(min(vals), 1) if vals else None,
        "strong": sum(v > STRONG_DBFS for v in vals),
        "msg_rate": round(rate, 1),
    }


async def history(days: int = 14) -> list[dict]:
    """Average results per gain setting, from the once-a-minute samples."""
    from sqlalchemy import func, select
    S = models.GainSample
    since = datetime.utcnow().replace(microsecond=0) - __import__("datetime").timedelta(days=days)
    async with db.Session() as s:
        rows = (await s.execute(
            select(S.gain, func.count(), func.avg(S.aircraft), func.avg(S.msg_rate), func.avg(S.median_rssi), func.max(S.max_km))
            .where(S.ts >= since).group_by(S.gain).order_by(S.gain))).all()
    return [{"gain": g, "minutes": n, "avg_aircraft": round(a or 0, 1), "avg_msg_rate": round(m or 0, 1),
             "avg_rssi": None if r is None else round(r, 1), "best_km": None if k is None else round(k, 1)}
            for g, n, a, m, r, k in rows]


class Sampler:
    """Once a minute, note the gain in force and how the receiver is doing, so settings can be compared later."""

    def __init__(self, tracker):
        self.tracker = tracker
        self._path: Optional[Path] = None
        self._path_at = 0.0

    def _cfg(self) -> Optional[Path]:
        if time.monotonic() - self._path_at > 600 or self._path is None:
            self._path = cfg_path_for(find_decoder())
            self._path_at = time.monotonic()
        return self._path

    def max_range_km(self) -> Optional[float]:
        if not (config.RECEIVER_LAT or config.RECEIVER_LON):
            return None
        from .api.insights import haversine_km
        best = 0.0
        for a in self.tracker.aircraft.values():
            if a.lat is not None and a.lon is not None and time.time() - a.last_seen.timestamp() < 60:
                best = max(best, haversine_km(config.RECEIVER_LAT, config.RECEIVER_LON, a.lat, a.lon))
        return round(best, 1) if best else None

    async def sample_once(self) -> None:
        path = await asyncio.to_thread(self._cfg)
        gain = read_gain(path) if path else None
        s = summary_now()
        if gain is None or s["aircraft"] == 0:
            return
        async with db.Session() as session:
            session.add(models.GainSample(ts=datetime.utcnow().replace(microsecond=0), gain=gain, aircraft=s["aircraft"],
                                          msg_rate=s["msg_rate"], median_rssi=s["median"], max_km=self.max_range_km()))
            await session.commit()

    async def run(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                await self.sample_once()
            except Exception:  # sampling must never take the app down
                pass
