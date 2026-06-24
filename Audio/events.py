"""Client event builders and alert throttling."""

import time
from typing import Any

from Audio.config import FeedbackThresholds, get_thresholds
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


def build_alerts(
    result: AnalysisResult,
    thresholds: FeedbackThresholds | None = None,
) -> list[dict[str, Any]]:
    """Convert metrics into client-facing alert event messages.

    ``thresholds`` selects the interviewer persona's strictness; when omitted the
    standard (default) persona is used.
    """
    if thresholds is None:
        thresholds = get_thresholds(None)

    alerts: list[dict[str, Any]] = []

    if result.syllables_per_second > thresholds.syllables_per_second_too_fast:
        alerts.append(
            {
                "event": "TOO_FAST",
                "value": round(result.syllables_per_second, 2),
                "threshold": thresholds.syllables_per_second_too_fast,
            }
        )

    if (
        result.f0_std_hz > thresholds.pitch_std_unstable_hz
        or result.f0_jitter_hz > thresholds.pitch_jitter_unstable_hz
    ):
        alerts.append(
            {
                "event": "PITCH_UNSTABLE",
                "value": round(result.f0_std_hz, 2),
                "jitter": round(result.f0_jitter_hz, 2),
                "threshold": thresholds.pitch_std_unstable_hz,
            }
        )

    if result.longest_silence_seconds >= thresholds.long_silence_seconds:
        alerts.append(
            {
                "event": "LONG_SILENCE",
                "value": round(result.longest_silence_seconds, 2),
                "threshold": thresholds.long_silence_seconds,
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
