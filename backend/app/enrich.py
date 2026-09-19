"""Flight enrichment: country (ICAO24 block), airline (callsign prefix), aircraft registry, route.

Offline sources are built in. The aircraft registry is filled by `python -m app.enrich_import <csv>`
(OpenSky aircraftDatabase.csv). Online lookups (adsbdb) only run when ENRICH_ONLINE=1 and are cached.
"""
import re
import time
from typing import Optional

import httpx
from . import config, db, models

# (start, end, country) — main ICAO Annex 10 allocations; unlisted addresses return None.
_BLOCKS = [
    (0x008000, 0x00FFFF, "South Africa"), (0x010000, 0x017FFF, "Egypt"), (0x06A000, 0x06AFFF, "Qatar"),
    (0x0D0000, 0x0D7FFF, "Mexico"), (0x140000, 0x15FFFF, "Russia"), (0x300000, 0x33FFFF, "Italy"),
    (0x340000, 0x37FFFF, "Spain"), (0x380000, 0x3BFFFF, "France"), (0x3C0000, 0x3FFFFF, "Germany"),
    (0x400000, 0x43FFFF, "United Kingdom"), (0x440000, 0x447FFF, "Austria"), (0x448000, 0x44FFFF, "Belgium"),
    (0x458000, 0x45FFFF, "Denmark"), (0x460000, 0x467FFF, "Finland"), (0x468000, 0x46FFFF, "Greece"),
    (0x470000, 0x477FFF, "Hungary"), (0x478000, 0x47FFFF, "Norway"), (0x480000, 0x487FFF, "Netherlands"),
    (0x488000, 0x48FFFF, "Poland"), (0x490000, 0x497FFF, "Portugal"), (0x498000, 0x49FFFF, "Czechia"),
    (0x4A0000, 0x4A7FFF, "Sweden"), (0x4B0000, 0x4B7FFF, "Switzerland"), (0x4B8000, 0x4BFFFF, "Türkiye"),
    (0x4CA000, 0x4CAFFF, "Ireland"), (0x508000, 0x50FFFF, "Ukraine"), (0x710000, 0x717FFF, "Saudi Arabia"),
    (0x718000, 0x71FFFF, "South Korea"), (0x738000, 0x73FFFF, "Israel"), (0x760000, 0x767FFF, "Pakistan"), (0x768000, 0x76FFFF, "Singapore"),
    (0x780000, 0x7BFFFF, "China"), (0x7C0000, 0x7FFFFF, "Australia"), (0x800000, 0x83FFFF, "India"),
    (0x840000, 0x87FFFF, "Japan"), (0x896000, 0x896FFF, "United Arab Emirates"), (0xA00000, 0xAFFFFF, "United States"),
    (0x040000, 0x040FFF, "Ethiopia"), (0x04C000, 0x04CFFF, "Kenya"), (0x702000, 0x702FFF, "Bangladesh"),
    (0x706000, 0x706FFF, "Kuwait"), (0x70C000, 0x70CFFF, "Oman"), (0x730000, 0x737FFF, "Iran"),
    (0x750000, 0x757FFF, "Malaysia"), (0x758000, 0x75FFFF, "Philippines"), (0x770000, 0x777FFF, "Sri Lanka"),
    (0x880000, 0x887FFF, "Thailand"), (0x888000, 0x88FFFF, "Vietnam"), (0x894000, 0x894FFF, "Bahrain"),
    (0x8A0000, 0x8A7FFF, "Indonesia"),
    (0xC00000, 0xC3FFFF, "Canada"), (0xC80000, 0xC87FFF, "New Zealand"), (0xE40000, 0xE7FFFF, "Brazil"),
]

_AIRLINES = {
    "KLM": "KLM", "BAW": "British Airways", "DLH": "Lufthansa", "RYR": "Ryanair", "WZZ": "Wizz Air",
    "UAL": "United Airlines", "AAL": "American Airlines", "DAL": "Delta Air Lines", "AFR": "Air France",
    "EZY": "easyJet", "UAE": "Emirates", "QTR": "Qatar Airways", "SWR": "Swiss", "SAS": "SAS",
    "IBE": "Iberia", "VLG": "Vueling", "THY": "Turkish Airlines", "ETD": "Etihad", "SIA": "Singapore Airlines",
    "AUA": "Austrian", "BEL": "Brussels Airlines", "FIN": "Finnair", "TAP": "TAP Air Portugal", "NAX": "Norwegian",
    "TRA": "Transavia", "EWG": "Eurowings", "AZA": "ITA Airways", "LOT": "LOT Polish", "ACA": "Air Canada",
    "SWA": "Southwest", "JBU": "JetBlue", "QFA": "Qantas", "ANA": "All Nippon Airways", "JAL": "Japan Airlines",
    "CPA": "Cathay Pacific", "ELY": "El Al", "MSR": "EgyptAir", "FDX": "FedEx", "UPS": "UPS",
    "IGO": "IndiGo", "AIC": "Air India", "AXB": "Air India Express", "SEJ": "SpiceJet", "VTI": "Vistara",
    "AKJ": "Akasa Air", "ALK": "SriLankan Airlines", "GFA": "Gulf Air", "OMA": "Oman Air", "KAC": "Kuwait Airways",
    "SVA": "Saudia", "FDB": "flydubai", "ABY": "Air Arabia", "THA": "Thai Airways", "MAS": "Malaysia Airlines",
    "AXM": "AirAsia", "TGW": "Scoot", "BBC": "Biman Bangladesh", "PIA": "Pakistan International", "ETH": "Ethiopian",
    "KQA": "Kenya Airways", "GTI": "Atlas Air", "PAC": "Polar Air Cargo", "CLX": "Cargolux", "EIN": "Aer Lingus", "VIR": "Virgin Atlantic", "TOM": "TUI Airways", "BCS": "European Air Transport",
}


def country_for(icao24: str) -> Optional[str]:
    try:
        n = int(icao24, 16)
    except (ValueError, TypeError):
        return None
    return next((c for lo, hi, c in _BLOCKS if lo <= n <= hi), None)


def airline_for(callsign: Optional[str]) -> Optional[dict]:
    """Airline from a 3-letter ICAO prefix followed by a digit (e.g. KLM1023). GA registrations don't match."""
    if not callsign or not re.match(r"^[A-Z]{3}\d", callsign):
        return None
    code = callsign[:3]
    name = _AIRLINES.get(code)
    return {"icao": code, "name": name} if name else {"icao": code, "name": None}


def basic(icao24: str, callsign: Optional[str]) -> dict:
    return {"country": country_for(icao24), "airline": airline_for(callsign)}


async def _get_json(url: str) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(url)
            return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


def _dig(data: Optional[dict], key: str) -> Optional[dict]:
    """adsbdb answers {"response": {key: {...}}}, or {"response": "unknown ..."} (a string) when it has no match."""
    resp = data.get("response") if isinstance(data, dict) else None
    inner = resp.get(key) if isinstance(resp, dict) else None
    return inner if isinstance(inner, dict) else None


# icao24 -> registry entry, so the live feed can attach registration/type without touching the DB
_ac_mem: dict[str, dict] = {}
_ac_tried: dict[str, float] = {}  # icao24 -> when a lookup last found nothing
AC_RETRY_ONLINE_S = 3600
AC_RETRY_OFFLINE_S = 60  # a registry import may have happened since


def aircraft_cached(icao24: Optional[str]) -> Optional[dict]:
    return _ac_mem.get(icao24) if icao24 else None


def aircraft_pending(icao24: str) -> bool:
    retry = AC_RETRY_ONLINE_S if config.ENRICH_ONLINE else AC_RETRY_OFFLINE_S
    return icao24 not in _ac_mem and time.time() - _ac_tried.get(icao24, 0) > retry


async def aircraft_info(icao24: str) -> Optional[dict]:
    if icao24 in _ac_mem:
        return _ac_mem[icao24]
    async with db.Session() as s:
        row = await s.get(models.AircraftInfo, icao24)
        if row is None and config.ENRICH_ONLINE and aircraft_pending(icao24):
            data = await _get_json(f"https://api.adsbdb.com/v0/aircraft/{icao24}")
            ac = _dig(data, "aircraft")
            if ac:
                row = models.AircraftInfo(icao24=icao24, registration=ac.get("registration"), type_code=ac.get("icao_type"),
                                          type_name=ac.get("type"), manufacturer=ac.get("manufacturer"),
                                          operator=ac.get("registered_owner"))
                s.add(row)
                await s.commit()
        if row is None:
            _ac_tried[icao24] = time.time()
            return None
        _ac_mem[icao24] = {"registration": row.registration, "type_code": row.type_code, "type_name": row.type_name,
                           "manufacturer": row.manufacturer, "operator": row.operator}
        return _ac_mem[icao24]


def _airport(a: Optional[dict]) -> Optional[dict]:
    if not isinstance(a, dict):
        return None
    return {"icao": a.get("icao_code"), "iata": a.get("iata_code"), "name": a.get("name"),
            "city": a.get("municipality"), "lat": a.get("latitude"), "lon": a.get("longitude")}


# callsign -> route (already looked up), so the live feed can attach routes without touching the DB
_route_mem: dict[str, dict] = {}
_route_miss: dict[str, float] = {}  # callsign -> when the online lookup last found nothing
MISS_TTL_S = 3600


def _route_dict(row) -> dict:
    return {
        "origin": {"icao": row.origin_icao, "iata": row.origin_iata, "name": row.origin_name,
                   "city": row.origin_city, "lat": row.origin_lat, "lon": row.origin_lon},
        "destination": {"icao": row.dest_icao, "iata": row.dest_iata, "name": row.dest_name,
                        "city": row.dest_city, "lat": row.dest_lat, "lon": row.dest_lon},
    }


def route_cached(callsign: Optional[str]) -> Optional[dict]:
    """Route already known for this callsign (no I/O); None if unknown or not looked up yet."""
    return _route_mem.get(callsign) if callsign else None


def route_pending(callsign: str) -> bool:
    """True if an online lookup for this callsign is worth trying now."""
    return callsign not in _route_mem and time.time() - _route_miss.get(callsign, 0) > MISS_TTL_S


async def route_info(callsign: Optional[str]) -> Optional[dict]:
    if not callsign:
        return None
    if callsign in _route_mem:
        return _route_mem[callsign]
    async with db.Session() as s:
        row = await s.get(models.RouteCache, callsign)
        if row is None and config.ENRICH_ONLINE and route_pending(callsign):
            data = await _get_json(f"https://api.adsbdb.com/v0/callsign/{callsign}")
            fr = _dig(data, "flightroute")
            if isinstance(fr, dict):
                o, d = _airport(fr.get("origin")) or {}, _airport(fr.get("destination")) or {}
                row = models.RouteCache(
                    callsign=callsign,
                    origin_icao=o.get("icao"), origin_iata=o.get("iata"), origin_name=o.get("name"),
                    origin_city=o.get("city"), origin_lat=o.get("lat"), origin_lon=o.get("lon"),
                    dest_icao=d.get("icao"), dest_iata=d.get("iata"), dest_name=d.get("name"),
                    dest_city=d.get("city"), dest_lat=d.get("lat"), dest_lon=d.get("lon"))
                s.add(row)
                await s.commit()
            else:
                _route_miss[callsign] = time.time()
        if row is None:
            return None
        _route_mem[callsign] = _route_dict(row)
        return _route_mem[callsign]


async def full_info(icao24: str, callsign: Optional[str]) -> dict:
    return {**basic(icao24, callsign), "aircraft": await aircraft_info(icao24), "route": await route_info(callsign)}
