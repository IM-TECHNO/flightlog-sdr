from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from . import config


class Base(DeclarativeBase):
    pass


engine = create_async_engine(config.DB_URL)
Session = async_sessionmaker(engine, expire_on_commit=False)


def _add_missing_columns(conn) -> None:
    """create_all() never alters existing tables; add columns introduced since the DB was created."""
    insp = inspect(conn)
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue
        have = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name not in have and col.nullable:
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col.type.compile(conn.dialect)}'))


async def init_db() -> None:
    from . import models  # noqa: F401  (register tables on Base)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_add_missing_columns)
