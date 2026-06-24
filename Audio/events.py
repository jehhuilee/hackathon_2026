"""Client event builders and alert throttling."""

import time
from typing import Any

from Audio.config import (
    LONG_SILENCE_SECONDS,
    PITCH_JITTER_UNSTABLE_HZ,
    PITCH_STD_UNSTABLE_HZ,
    SYLLABLES_PER_SECOND_TOO_FAST,
)
from Audio.models import AnalysisResult


class AlertCooldown:
    """Small anti-spam helper so the client is not flooded with identical alerts."""

    def __init__(self, seconds: float = 0.75) -> None:
        self.seconds = seconds
        self._last_sent: dict[str, float] = {}

    def allow(self, event: str) -> bool:
        now = time.monotonic()
        previous = self._last_sent.get(event, 0.0)
        if now - previous < self.seconds:
            return False
        self._last_sent[event] = now
        return True


def build_alerts(result: AnalysisResult) -> list[dict[str, Any]]:
    """Convert metrics into client-facing alert event messages."""
    alerts: list[dict[str, Any]] = []

    if result.syllables_per_second > SYLLABLES_PER_SECOND_TOO_FAST:
        alerts.append(
            {
                "event": "TOO_FAST",
                "value": round(result.syllables_per_second, 2),
                "threshold": SYLLABLES_PER_SECOND_TOO_FAST,
            }
        )

    if result.f0_std_hz > PITCH_STD_UNSTABLE_HZ or result.f0_jitter_hz > PITCH_JITTER_UNSTABLE_HZ:
        alerts.append(
            {
                "event": "PITCH_UNSTABLE",
                "value": round(result.f0_std_hz, 2),
                "jitter": round(result.f0_jitter_hz, 2),
                "threshold": PITCH_STD_UNSTABLE_HZ,
            }
        )

    if result.longest_silence_seconds >= LONG_SILENCE_SECONDS:
        alerts.append(
            {
                "event": "LONG_SILENCE",
                "value": round(result.longest_silence_seconds, 2),
                "threshold": LONG_SILENCE_SECONDS,
            }
        )

    return alerts


def build_status(result: AnalysisResult) -> dict[str, Any]:
    """Periodic telemetry message for dashboards or debugging."""
    return {
        "event": "STATUS",
        "syllables_per_second": round(result.syllables_per_second, 2),
        "pitch_mean_hz": round(result.f0_mean_hz, 2),
        "pitch_std_hz": round(result.f0_std_hz, 2),
        "pitch_jitter_hz": round(result.f0_jitter_hz, 2),
        "longest_silence_seconds": round(result.longest_silence_seconds, 2),
        "speech_ratio": round(result.speech_ratio, 2),
        "window_seconds": round(result.window_seconds, 2),
        "timestamp": time.time(),
    }
