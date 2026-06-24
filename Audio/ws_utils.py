"""WebSocket helpers for the audio route."""

import asyncio
from typing import Any

from fastapi import WebSocket
from fastapi.websockets import WebSocketState

from Audio.models import AudioFrame


async def send_json_safe(
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    message: dict[str, Any],
) -> bool:
    """Serialize writes to the WebSocket; return False if the connection is gone."""
    if websocket.application_state != WebSocketState.CONNECTED:
        return False

    try:
        async with send_lock:
            await websocket.send_json(message)
        return True
    except Exception:
        return False


async def put_latest(queue: asyncio.Queue[AudioFrame | None], frame: AudioFrame) -> None:
    """Put a frame into the queue, dropping the oldest frame if needed."""
    try:
        queue.put_nowait(frame)
        return
    except asyncio.QueueFull:
        pass

    try:
        queue.get_nowait()
        queue.task_done()
    except asyncio.QueueEmpty:
        pass

    await queue.put(frame)


def put_stop_signal(queue: asyncio.Queue[AudioFrame | None]) -> None:
    """Insert the worker stop signal without blocking on a full queue."""
    try:
        queue.put_nowait(None)
        return
    except asyncio.QueueFull:
        pass

    try:
        queue.get_nowait()
        queue.task_done()
    except asyncio.QueueEmpty:
        pass

    try:
        queue.put_nowait(None)
    except asyncio.QueueFull:
        pass
