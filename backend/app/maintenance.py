"""Database housekeeping: size/info, thinning old positions, and safe online backups.

CLI (run from the backend folder):
    python -m app.maintenance info
    python -m app.maintenance thin [older_than_days=30] [keep_seconds=10]
    python -m app.maintenance backup [directory=backups]
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import func, select, text

from . import config, db, models


def db_path() -> Optional[Path]:
    """File path of a SQLite database URL (None for other databases)."""
    url = config.DB_URL
    if not url.startswith("sqlite"):
        return None
    path = url.split("///", 1)[-1]
    return Path(path) if path and path != ":memory:" else None


async def info() -> dict:
    async with db.Session() as s:
        flights = await s.scalar(select(func.count()).select_from(models.Flight)) or 0
        positions = await s.scalar(select(func.count()).select_from(models.Position)) or 0
        oldest = await s.scalar(select(func.min(models.Position.ts)))
        newest = await s.scalar(select(func.max(models.Position.ts)))
    path = db_path()
    return {
        "size_bytes": path.stat().st_size if path and path.exists() else None,
        "flights": flights,
        "positions": positions,
        "oldest": oldest.isoformat() + "Z" if oldest else None,
        "newest": newest.isoformat() + "Z" if newest else None,
        "retention_days": config.RETENTION_DAYS,
        "thin_keep_seconds": config.THIN_KEEP_SECONDS,
    }


async def thin_positions(older_than_days: int, keep_seconds: int = 10) -> int:
    """Keep one position per `keep_seconds` per flight for positions older than the cutoff. Returns rows deleted."""
    keep_seconds = max(1, keep_seconds)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).replace(tzinfo=None)
    async with db.engine.begin() as conn:
        res = await conn.execute(
            text(
                "DELETE FROM positions WHERE ts < :cutoff AND id NOT IN ("
                " SELECT MIN(id) FROM positions WHERE ts < :cutoff"
                " GROUP BY flight_id, CAST(strftime('%s', ts) AS INTEGER) / :k)"
            ),
            {"cutoff": cutoff.strftime("%Y-%m-%d %H:%M:%S.%f"), "k": keep_seconds},
        )
        return res.rowcount or 0


async def backup(directory: Path) -> Path:
    """Consistent copy of the database while it is in use (SQLite VACUUM INTO)."""
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory / f"flightlog-{datetime.now():%Y%m%d-%H%M%S}.db"
    async with db.engine.connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        await conn.exec_driver_sql("VACUUM INTO ?", (str(dest),))
    return dest


async def worker() -> None:
    """Daily thinning when RETENTION_DAYS is set."""
    await asyncio.sleep(60)
    while True:
        if config.RETENTION_DAYS > 0:
            await thin_positions(config.RETENTION_DAYS, config.THIN_KEEP_SECONDS)
        await asyncio.sleep(24 * 3600)


async def _main(argv: list[str]) -> None:
    cmd = argv[0] if argv else "info"
    if cmd == "info":
        print(await info())
    elif cmd == "thin":
        days = int(argv[1]) if len(argv) > 1 else 30
        keep = int(argv[2]) if len(argv) > 2 else config.THIN_KEEP_SECONDS
        print(f"deleted {await thin_positions(days, keep)} positions older than {days} days (kept 1 per {keep}s)")
    elif cmd == "backup":
        print("backup written to", await backup(Path(argv[1] if len(argv) > 1 else "backups")))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    asyncio.run(_main(sys.argv[1:]))
