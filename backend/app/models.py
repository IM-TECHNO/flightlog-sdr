from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class Flight(Base):
    __tablename__ = "flights"
    id: Mapped[int] = mapped_column(primary_key=True)
    icao24: Mapped[str] = mapped_column(index=True)
    callsign: Mapped[Optional[str]] = mapped_column(index=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime, index=True)
    last_seen: Mapped[datetime] = mapped_column(DateTime)
    max_alt: Mapped[Optional[int]]
    min_alt: Mapped[Optional[int]]
    msg_count: Mapped[int] = mapped_column(default=0)


class AircraftInfo(Base):
    __tablename__ = "aircraft_info"
    icao24: Mapped[str] = mapped_column(primary_key=True)
    registration: Mapped[Optional[str]]
    type_code: Mapped[Optional[str]]
    type_name: Mapped[Optional[str]]
    manufacturer: Mapped[Optional[str]]
    operator: Mapped[Optional[str]]


class RouteCache(Base):
    __tablename__ = "route_cache"
    callsign: Mapped[str] = mapped_column(primary_key=True)
    origin_icao: Mapped[Optional[str]]
    origin_name: Mapped[Optional[str]]
    origin_city: Mapped[Optional[str]]
    origin_iata: Mapped[Optional[str]]
    origin_lat: Mapped[Optional[float]]
    origin_lon: Mapped[Optional[float]]
    dest_icao: Mapped[Optional[str]]
    dest_name: Mapped[Optional[str]]
    dest_city: Mapped[Optional[str]]
    dest_iata: Mapped[Optional[str]]
    dest_lat: Mapped[Optional[float]]
    dest_lon: Mapped[Optional[float]]


class Alert(Base):
    """Something worth noticing: an emergency squawk, or a watchlist match."""
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    kind: Mapped[str]  # "emergency" | "watch"
    icao24: Mapped[str]
    callsign: Mapped[Optional[str]]
    flight_id: Mapped[Optional[int]]
    detail: Mapped[str]


class Watch(Base):
    __tablename__ = "watchlist"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str]  # "callsign" (prefix match) | "icao24" | "airline" (3-letter ICAO code)
    value: Mapped[str]
    label: Mapped[Optional[str]]


class GainSample(Base):
    """One reading a minute of how the receiver is doing at the gain in force, to compare gain settings."""
    __tablename__ = "gain_samples"
    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    gain: Mapped[float]
    aircraft: Mapped[int]
    msg_rate: Mapped[float]
    median_rssi: Mapped[Optional[float]]
    max_km: Mapped[Optional[float]]


class Position(Base):
    __tablename__ = "positions"
    id: Mapped[int] = mapped_column(primary_key=True)
    flight_id: Mapped[int] = mapped_column(ForeignKey("flights.id"))
    ts: Mapped[datetime] = mapped_column(DateTime)
    lat: Mapped[float]
    lon: Mapped[float]
    alt: Mapped[Optional[int]]
    gs: Mapped[Optional[float]]
    track: Mapped[Optional[float]]
    vrate: Mapped[Optional[int]]
    rssi: Mapped[Optional[float]]  # dBFS at the time, when the decoder reports it
    __table_args__ = (Index("ix_pos_flight_ts", "flight_id", "ts"),)
