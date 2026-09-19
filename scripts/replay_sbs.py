"""Serve an SBS capture file on a local TCP port to test without hardware.
Usage: python scripts/replay_sbs.py capture.sbs [port=30003]"""
import asyncio, sys

async def main(path, port):
    lines = open(path).read().splitlines()
    async def handle(_, w):
        while True:
            for l in lines:
                w.write((l + "\n").encode()); await w.drain(); await asyncio.sleep(0.05)
    srv = await asyncio.start_server(handle, "127.0.0.1", port)
    async with srv: await srv.serve_forever()

asyncio.run(main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 30003))
