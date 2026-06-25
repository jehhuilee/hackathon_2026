"""FastAPI routes for the real-time audio service."""

import asyncio
import json
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from Audio.config import (
    CHANNELS,
    DEFAULT_PERSONA,
    FEEDBACK_PROFILES,
    MAX_QUEUED_FRAMES,
    SAMPLE_RATE,
    SUPPORTED_DTYPES,
    WINDOW_SECONDS,
    AudioDType,
)
from Audio.models import AudioFrame
from Audio.worker import analysis_worker
from Audio.ws_utils import put_latest, put_stop_signal, send_json_safe

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "sample_rate": SAMPLE_RATE,
        "channels": CHANNELS,
        "window_seconds": WINDOW_SECONDS,
    }


@router.websocket("/ws/audio")
async def audio_websocket(websocket: WebSocket) -> None:
    """Receive browser audio and send real-time feedback over one WebSocket."""
    await websocket.accept()

    active_dtype: AudioDType = "int16"
    runtime_config: dict[str, Any] = {"vad_level": 2, "persona": DEFAULT_PERSONA}
    queue: asyncio.Queue[AudioFrame | None] = asyncio.Queue(maxsize=MAX_QUEUED_FRAMES)
    send_lock = asyncio.Lock()
    worker = asyncio.create_task(analysis_worker(queue, websocket, send_lock, runtime_config))

    await send_json_safe(
        websocket,
        send_lock,
        {
            "event": "READY",
            "sample_rate": SAMPLE_RATE,
            "channels": CHANNELS,
            "dtype": active_dtype,
            "window_seconds": WINDOW_SECONDS,
        },
    )

    try:
        while True:
            message = await websocket.receive()
            message_type = message.get("type")

            if message_type == "websocket.disconnect":
                break

            if text := message.get("text"):
                try:
                    config = json.loads(text)
                except json.JSONDecodeError:
                    await send_json_safe(
                        websocket,
                        send_lock,
                        {"event": "ERROR", "message": "Invalid JSON config message."},
                    )
                    continue

                if config.get("event") == "config":
                    requested_dtype = config.get("dtype", active_dtype)
                    if requested_dtype in SUPPORTED_DTYPES:
                        active_dtype = requested_dtype

                    requested_vad_level = config.get("vad_level", runtime_config["vad_level"])
                    if isinstance(requested_vad_level, int) and 0 <= requested_vad_level <= 3:
                        runtime_config["vad_level"] = requested_vad_level

                    requested_persona = config.get("persona", runtime_config["persona"])
                    if requested_persona in FEEDBACK_PROFILES or requested_persona == "D":
                        runtime_config["persona"] = requested_persona
                    if requested_persona == "D" and config.get("custom_strictness") is not None:
                        runtime_config["custom_strictness"] = int(config["custom_strictness"])

                    await send_json_safe(
                        websocket,
                        send_lock,
                        {
                            "event": "CONFIG_ACK",
                            "dtype": active_dtype,
                            "vad_level": runtime_config["vad_level"],
                            "persona": runtime_config["persona"],
                            "sample_rate": SAMPLE_RATE,
                            "channels": CHANNELS,
                        },
                    )
                continue

            if payload := message.get("bytes"):
                await put_latest(
                    queue,
                    AudioFrame(
                        payload=payload,
                        dtype=active_dtype,
                        received_at=time.monotonic(),
                    ),
                )

    except WebSocketDisconnect:
        pass
    finally:
        put_stop_signal(queue)
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass
