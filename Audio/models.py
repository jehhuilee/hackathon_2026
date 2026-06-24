"""Shared data models for streaming and analysis."""

from dataclasses import dataclass

from Audio.config import AudioDType


@dataclass
class AudioFrame:
    """Raw WebSocket payload plus the dtype active when the frame was received."""

    payload: bytes
    dtype: AudioDType
    received_at: float


@dataclass
class AnalysisResult:
    """Metrics calculated from the current sliding window."""

    syllables_per_second: float
    f0_mean_hz: float
    f0_std_hz: float
    f0_jitter_hz: float
    longest_silence_seconds: float
    speech_ratio: float
    window_seconds: float
