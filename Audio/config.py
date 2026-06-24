"""Runtime settings for the local real-time audio analyzer."""

from dataclasses import dataclass
from typing import Literal

SAMPLE_RATE = 16_000
CHANNELS = 1
WINDOW_SECONDS = 3.0
PROCESS_INTERVAL_SECONDS = 0.20
STATUS_INTERVAL_SECONDS = 0.50
# Pitch (PYIN) costs ~hundreds of ms — far more than PROCESS_INTERVAL — so it is
# refreshed on this slower cadence in a background task instead of every cycle.
# F0 stats over a 3s window barely change within 200ms, so 1s loses no real
# signal while keeping the cheap metrics (rate/silence/VAD) fully responsive.
PITCH_INTERVAL_SECONDS = 1.0

# Browser chunks are usually 50-100 ms. Keep the queue bounded to protect
# latency under CPU pressure.
MAX_QUEUED_FRAMES = 20

# Interview/presentation feedback thresholds (standard profile B). Tune these
# with recorded samples.
SYLLABLES_PER_SECOND_TOO_FAST = 7.0
PITCH_STD_UNSTABLE_HZ = 45.0
PITCH_JITTER_UNSTABLE_HZ = 18.0
LONG_SILENCE_SECONDS = 1.20
LOW_ENERGY_DB = -42.0

SUPPORTED_DTYPES = {"int16", "float32"}
AudioDType = Literal["int16", "float32"]


@dataclass(frozen=True)
class FeedbackThresholds:
    """Alert thresholds for one interviewer persona / difficulty level."""

    syllables_per_second_too_fast: float
    pitch_std_unstable_hz: float
    pitch_jitter_unstable_hz: float
    long_silence_seconds: float


# Interviewer personas. Stricter personas use tighter thresholds, so the same
# delivery triggers more alerts; lenient personas tolerate more before warning.
#   A 친근한 면접관 (성장 단계 스타트업) — 널널한 기준, 경고 적게
#   B 표준 면접관 (중견/대기업) — 균형 (기본값)
#   C 엄격한 면접관 (탑티어/외국계) — 빡빡한 기준, 경고 많이
FEEDBACK_PROFILES: dict[str, FeedbackThresholds] = {
    "A": FeedbackThresholds(
        syllables_per_second_too_fast=8.5,
        pitch_std_unstable_hz=58.0,
        pitch_jitter_unstable_hz=26.0,
        long_silence_seconds=2.0,
    ),
    "B": FeedbackThresholds(
        syllables_per_second_too_fast=SYLLABLES_PER_SECOND_TOO_FAST,
        pitch_std_unstable_hz=PITCH_STD_UNSTABLE_HZ,
        pitch_jitter_unstable_hz=PITCH_JITTER_UNSTABLE_HZ,
        long_silence_seconds=LONG_SILENCE_SECONDS,
    ),
    "C": FeedbackThresholds(
        syllables_per_second_too_fast=6.0,
        pitch_std_unstable_hz=34.0,
        pitch_jitter_unstable_hz=13.0,
        long_silence_seconds=0.8,
    ),
}

DEFAULT_PERSONA = "B"


def get_thresholds(persona: str | None) -> FeedbackThresholds:
    """Resolve a persona code to its thresholds, falling back to the default."""
    return FEEDBACK_PROFILES.get(persona or DEFAULT_PERSONA, FEEDBACK_PROFILES[DEFAULT_PERSONA])
