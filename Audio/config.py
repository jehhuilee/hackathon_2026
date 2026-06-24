"""Runtime settings for the local real-time audio analyzer."""

from typing import Literal

SAMPLE_RATE = 16_000
CHANNELS = 1
WINDOW_SECONDS = 3.0
PROCESS_INTERVAL_SECONDS = 0.20
STATUS_INTERVAL_SECONDS = 0.50

# Browser chunks are usually 50-100 ms. Keep the queue bounded to protect
# latency under CPU pressure.
MAX_QUEUED_FRAMES = 20

# Interview/presentation feedback thresholds. Tune these with recorded samples.
SYLLABLES_PER_SECOND_TOO_FAST = 7.0
PITCH_STD_UNSTABLE_HZ = 45.0
PITCH_JITTER_UNSTABLE_HZ = 18.0
LONG_SILENCE_SECONDS = 1.20
LOW_ENERGY_DB = -42.0

SUPPORTED_DTYPES = {"int16", "float32"}
AudioDType = Literal["int16", "float32"]
