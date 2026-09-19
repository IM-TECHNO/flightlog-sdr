"""Receiver gain: status, the gain assistant and the (local-only) control."""
import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import config, receiver

router = APIRouter(prefix="/api")

LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}  # "testclient" only ever comes from Starlette's test client


def _is_local(request: Request) -> bool:
    return bool(request.client and request.client.host in LOCAL_HOSTS)


async def _status(local: bool) -> dict:
    decoder = await asyncio.to_thread(receiver.find_decoder)
    path = await asyncio.to_thread(receiver.cfg_path_for, decoder)
    reason = None
    if not config.RECEIVER_CONTROL:
        reason = "Receiver control is switched off (RECEIVER_CONTROL=0)."
    elif not local:
        reason = "Gain can only be changed from the machine running the backend."
    elif path is None:
        reason = ("Could not find dump1090.cfg. This works with the Windows dump1090 while it is running; "
                  "otherwise set DUMP1090_CFG to the config file.")
    summary = receiver.summary_now()
    return {
        "controllable": reason is None,
        "reason": reason,
        "decoder": {"running": decoder is not None, "pid": decoder["pid"] if decoder else None},
        "cfg_path": str(path) if path else None,
        "gain": receiver.read_gain(path) if path else None,
        "gain_max": receiver.MAX_GAIN,
        "signal": summary,
        "verdict": receiver.verdict(summary),
        "history": await receiver.history(),
    }


@router.get("/receiver")
async def get_receiver(request: Request):
    return await _status(_is_local(request))


class GainIn(BaseModel):
    gain: int
    restart: bool = False


@router.post("/receiver/gain")
async def set_gain(body: GainIn, request: Request):
    if not config.RECEIVER_CONTROL:
        raise HTTPException(403, "receiver control is switched off (RECEIVER_CONTROL=0)")
    if not _is_local(request):
        raise HTTPException(403, "gain can only be changed from the machine running the backend")
    if not 0 <= body.gain <= receiver.MAX_GAIN:
        raise HTTPException(400, f"gain must be a whole number from 0 to {receiver.MAX_GAIN} dB")
    try:
        result = await asyncio.to_thread(receiver.apply_gain, body.gain, body.restart)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))
    return {**result, "status": await _status(True)}
