"""Import the OpenSky aircraft database CSV into the local registry.
Usage: python -m app.enrich_import path/to/aircraftDatabase.csv"""
import asyncio
import csv
import sys

from sqlalchemy.dialects.sqlite import insert

from .db import Session, init_db
from .models import AircraftInfo

BATCH = 5000


def _row(r: dict) -> dict | None:
    icao = (r.get("icao24") or "").strip().lower()
    if len(icao) != 6:
        return None
    return {"icao24": icao, "registration": r.get("registration") or None,
            "type_code": r.get("typecode") or None, "type_name": r.get("model") or None,
            "manufacturer": r.get("manufacturername") or None,
            "operator": r.get("operator") or r.get("owner") or None}


async def import_csv(path: str) -> int:
    await init_db()
    total = 0
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        batch = []
        for r in csv.DictReader(f):
            row = _row(r)
            if row:
                batch.append(row)
            if len(batch) >= BATCH:
                total += await _write(batch)
                batch = []
        if batch:
            total += await _write(batch)
    return total


async def _write(batch: list[dict]) -> int:
    async with Session() as s:
        stmt = insert(AircraftInfo).values(batch)
        stmt = stmt.on_conflict_do_update(index_elements=["icao24"],
                                          set_={k: stmt.excluded[k] for k in batch[0] if k != "icao24"})
        await s.execute(stmt)
        await s.commit()
    return len(batch)


if __name__ == "__main__":
    print(f"imported {asyncio.run(import_csv(sys.argv[1]))} aircraft")
