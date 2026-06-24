"""Per-connection analysis worker."""

import asyncio
import time
from typing import Any

from fastapi import WebSocket

from Audio.config import (
    PROCESS_INTERVAL_SECONDS,
    SAMPLE_RATE,
    STATUS_INTERVAL_SECONDS,
    WINDOW_SECONDS,
    get_thresholds,
)
from Audio.dsp import analyze_window, decode_audio_frame
from Audio.events import AlertCooldown, build_alerts, build_status
from Audio.models import AudioFrame
from Audio.ring_buffer import RingBuffer
from Audio.ws_utils import send_json_safe


async def analysis_worker(
    queue: asyncio.Queue[AudioFrame | None],
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    runtime_config: dict[str, Any],
) -> None:
    """Consumer loop: queue -> ring buffer -> DSP analysis -> WebSocket alerts."""
    ring_buffer = RingBuffer(WINDOW_SECONDS, SAMPLE_RATE)
    cooldown = AlertCooldown()
    last_analysis = 0.0
    last_status = 0.0

    while True:
        frame = await queue.get()
        try:
            if frame is None:
                return

            samples = decode_audio_frame(frame.payload, frame.dtype)
            ring_buffer.append(samples)

            now = time.monotonic()
            if now - last_analysis < PROCESS_INTERVAL_SECONDS:
                continue
            last_analysis = now

            current_window = ring_buffer.snapshot(WINDOW_SECONDS)
            if current_window.size < int(0.5 * SAMPLE_RATE):
                continue

            result = await asyncio.to_thread(
                analyze_window,
                current_window,
                SAMPLE_RATE,
                int(runtime_config["vad_level"]),
            )

            # Resolve thresholds each cycle so a mid-stream persona change applies.
            thresholds = get_thresholds(runtime_config.get("persona"))
            for alert in build_alerts(result, thresholds):
                if cooldown.allow(alert["event"]):
                    sent = await send_json_safe(websocket, send_lock, alert)
                    if not sent:
                        return

            if now - last_status >= STATUS_INTERVAL_SECONDS:
                last_status = now
                sent = await send_json_safe(websocket, send_lock, build_status(result))
                if not sent:
                    return
        finally:
            queue.task_done()
