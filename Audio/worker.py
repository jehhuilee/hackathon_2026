"""Per-connection analysis worker."""

import asyncio
import time
from typing import Any

from fastapi import WebSocket

from Audio.config import (
    PITCH_INTERVAL_SECONDS,
    PROCESS_INTERVAL_SECONDS,
    SAMPLE_RATE,
    STATUS_INTERVAL_SECONDS,
    WINDOW_SECONDS,
    get_thresholds,
)
from Audio.dsp import analyze_window, decode_audio_frame, estimate_pitch
from Audio.events import AlertCooldown, build_alerts, build_status
from Audio.models import AudioFrame
from Audio.ring_buffer import RingBuffer
from Audio.ws_utils import send_json_safe

_MIN_ANALYSIS_SAMPLES = int(0.5 * SAMPLE_RATE)


async def analysis_worker(
    queue: asyncio.Queue[AudioFrame | None],
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    runtime_config: dict[str, Any],
) -> None:
    """Consumer loop: queue -> ring buffer -> DSP analysis -> WebSocket alerts.

    Pitch (PYIN) is far more expensive than the other analyzers, so it runs in a
    separate background thread on PITCH_INTERVAL_SECONDS cadence and the per-frame
    loop reuses its latest result. This keeps the cheap rate/silence/VAD metrics
    responsive instead of stalling ~hundreds of ms on every cycle.
    """
    ring_buffer = RingBuffer(WINDOW_SECONDS, SAMPLE_RATE)
    cooldown = AlertCooldown()
    last_analysis = 0.0
    last_status = 0.0
    last_pitch = 0.0
    pitch_cache: tuple[float, float, float] = (0.0, 0.0, 0.0)
    pitch_task: asyncio.Task[tuple[float, float, float]] | None = None
    pitch_primed = False

    try:
        while True:
            frame = await queue.get()
            try:
                if frame is None:
                    return

                samples = decode_audio_frame(frame.payload, frame.dtype)
                ring_buffer.append(samples)

                now = time.monotonic()

                # Collect a finished background pitch computation (non-blocking).
                if pitch_task is not None and pitch_task.done():
                    try:
                        pitch_cache = pitch_task.result()
                    except Exception:
                        pass  # keep the previous pitch on failure
                    pitch_task = None

                # Spawn the next pitch computation on the slow cadence (only once
                # primed — see below). Runs in a thread so the event loop keeps
                # draining frames meanwhile.
                if pitch_primed and pitch_task is None and now - last_pitch >= PITCH_INTERVAL_SECONDS:
                    pitch_window = ring_buffer.snapshot(WINDOW_SECONDS)
                    if pitch_window.size >= _MIN_ANALYSIS_SAMPLES:
                        last_pitch = now
                        pitch_task = asyncio.create_task(
                            asyncio.to_thread(estimate_pitch, pitch_window, SAMPLE_RATE)
                        )

                if now - last_analysis < PROCESS_INTERVAL_SECONDS:
                    continue
                last_analysis = now

                current_window = ring_buffer.snapshot(WINDOW_SECONDS)
                if current_window.size < _MIN_ANALYSIS_SAMPLES:
                    continue

                # Prime pitch synchronously on the very first analysis so the
                # first STATUS already carries a real F0 instead of zeros; every
                # later refresh runs in the background (one-time ~hundreds of ms).
                if not pitch_primed:
                    pitch_cache = await asyncio.to_thread(estimate_pitch, current_window, SAMPLE_RATE)
                    last_pitch = now
                    pitch_primed = True

                # Cheap metrics only (~sub-ms); pitch is supplied from the cache.
                result = await asyncio.to_thread(
                    analyze_window,
                    current_window,
                    SAMPLE_RATE,
                    int(runtime_config["vad_level"]),
                    pitch_cache,
                )

                # Resolve thresholds each cycle so a mid-stream persona change applies.
                thresholds = get_thresholds(
                    runtime_config.get("persona"),
                    runtime_config.get("custom_strictness"),
                )
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
    finally:
        # Don't leak the background pitch task when the connection ends.
        if pitch_task is not None:
            pitch_task.cancel()
