"""Serve a synthetic SBS-1 feed (aircraft flying circles) for testing without an SDR.
Usage: python scripts/synth_sbs.py [port=30003] [lat=52.3] [lon=4.76]"""
import asyncio, math, sys
from datetime import datetime, timezone

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 30003
LAT = float(sys.argv[2]) if len(sys.argv) > 2 else 52.3
LON = float(sys.argv[3]) if len(sys.argv) > 3 else 4.76
PLANES = [("4840D6", "KLM1023", 36000), ("406A2B", "BAW117", 28000), ("3C6444", "DLH4YZ", 12000),
          ("4CA7B4", "RYR8XK", 33000), ("471F8A", "WZZ2345", 9000), ("A1B2C3", "UAL901", 39000)]

def line(icao, cs, alt, lat, lon, hdg):
    n = datetime.now(timezone.utc); d, t = n.strftime("%Y/%m/%d"), n.strftime("%H:%M:%S.%f")[:-3]
    return f"MSG,3,1,1,{icao},1,{d},{t},{d},{t},{cs},{alt},450,{hdg:.0f},{lat:.5f},{lon:.5f},0,,0,0,0,0\n"

async def handle(_, w):
    t = 0
    try:
        while True:
            for i, (icao, cs, alt) in enumerate(PLANES):
                r = 0.3 + 0.15 * i; a = t * 0.02 * (1 + i * 0.1) + i
                w.write(line(icao, cs, alt, LAT + r * math.sin(a), LON + r * 1.6 * math.cos(a),
                             (math.degrees(a) + 90) % 360).encode())
            await w.drain(); await asyncio.sleep(1); t += 1
    except (ConnectionError, OSError):
        pass

async def main():
    srv = await asyncio.start_server(handle, "127.0.0.1", PORT)
    async with srv: await srv.serve_forever()

asyncio.run(main())
