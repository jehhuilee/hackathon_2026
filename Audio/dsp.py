"""Lightweight DSP analysis used by the real-time track."""

import librosa
import numpy as np
import scipy.signal
import webrtcvad

from Audio.config import LOW_ENERGY_DB, AudioDType
from Audio.models import AnalysisResult


def decode_audio_frame(payload: bytes, dtype: AudioDType) -> np.ndarray:
    """Decode a browser binary frame to normalized mono float32 samples."""
    if dtype == "float32":
        samples = np.frombuffer(payload, dtype=np.float32)
        return np.nan_to_num(samples, copy=False).astype(np.float32, copy=False)

    samples = np.frombuffer(payload, dtype=np.int16).astype(np.float32)
    return samples / 32768.0


def estimate_syllable_rate(audio: np.ndarray, sample_rate: int) -> float:
    """Estimate syllables/second from RMS-energy peaks."""
    if audio.size < int(0.5 * sample_rate):
        return 0.0

    frame_length = int(0.025 * sample_rate)
    hop_length = int(0.010 * sample_rate)
    rms = librosa.feature.rms(y=audio, frame_length=frame_length, hop_length=hop_length)[0]
    if not np.any(rms):
        return 0.0

    kernel = np.ones(5, dtype=np.float32) / 5.0
    smoothed = np.convolve(rms, kernel, mode="same")

    floor = float(np.percentile(smoothed, 35))
    ceiling = float(np.percentile(smoothed, 90))
    height = max(floor + (ceiling - floor) * 0.35, 1e-4)

    peaks, _ = scipy.signal.find_peaks(
        smoothed,
        height=height,
        distance=max(1, int(0.075 * sample_rate / hop_length)),
        prominence=max(1e-5, height * 0.25),
    )

    return float(len(peaks) / (audio.size / sample_rate))


def estimate_pitch(audio: np.ndarray, sample_rate: int) -> tuple[float, float, float]:
    """Extract F0 mean, F0 standard deviation, and local F0 jitter with PYIN."""
    if audio.size < int(0.5 * sample_rate) or float(np.max(np.abs(audio))) < 1e-4:
        return 0.0, 0.0, 0.0

    try:
        f0, _voiced_flag, _voiced_prob = librosa.pyin(
            audio,
            sr=sample_rate,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C7"),
            frame_length=1024,
            hop_length=256,
        )
    except Exception:
        return 0.0, 0.0, 0.0

    if f0 is None:
        return 0.0, 0.0, 0.0

    voiced = f0[np.isfinite(f0)]
    if voiced.size < 3:
        return 0.0, 0.0, 0.0

    f0_deltas = np.abs(np.diff(voiced))
    jitter = float(np.median(f0_deltas)) if f0_deltas.size else 0.0
    return float(np.mean(voiced)), float(np.std(voiced)), jitter


def detect_silence_by_energy(audio: np.ndarray, sample_rate: int) -> float:
    """Return the longest continuous low-energy region in seconds."""
    if audio.size < int(0.2 * sample_rate):
        return 0.0

    frame_length = int(0.025 * sample_rate)
    hop_length = int(0.010 * sample_rate)
    rms = librosa.feature.rms(y=audio, frame_length=frame_length, hop_length=hop_length)[0]
    if not np.any(rms):
        return audio.size / sample_rate

    rms_db = librosa.amplitude_to_db(rms, ref=np.max)
    silent = rms_db < LOW_ENERGY_DB

    longest = 0
    current = 0
    for is_silent in silent:
        if is_silent:
            current += 1
            longest = max(longest, current)
        else:
            current = 0

    return float(longest * hop_length / sample_rate)


def estimate_recent_speech_ratio(audio: np.ndarray, sample_rate: int, vad: webrtcvad.Vad) -> float:
    """Use WebRTC VAD on the latest 300 ms as a cheap speech indicator."""
    frame_ms = 30
    frame_samples = int(sample_rate * frame_ms / 1000)
    target_samples = int(0.3 * sample_rate)
    recent = audio[-target_samples:]

    if recent.size < frame_samples:
        return 0.0

    pcm16 = np.clip(recent * 32768.0, -32768, 32767).astype(np.int16)
    speech_frames = 0
    total_frames = 0

    for start in range(0, pcm16.size - frame_samples + 1, frame_samples):
        frame = pcm16[start : start + frame_samples].tobytes()
        total_frames += 1
        if vad.is_speech(frame, sample_rate):
            speech_frames += 1

    return float(speech_frames / total_frames) if total_frames else 0.0


def analyze_window(
    audio: np.ndarray,
    sample_rate: int,
    vad_level: int,
    pitch: tuple[float, float, float] | None = None,
) -> AnalysisResult:
    """Run the DSP analyzers over the current sliding window.

    ``pitch`` lets the caller supply a previously computed (f0_mean, f0_std,
    f0_jitter) so the expensive PYIN pass can run on a slower cadence than the
    cheap rate/silence/VAD metrics. When ``None`` the pitch is computed inline
    (original behaviour, unchanged output).
    """
    vad = webrtcvad.Vad(vad_level)
    f0_mean, f0_std, f0_jitter = pitch if pitch is not None else estimate_pitch(audio, sample_rate)

    return AnalysisResult(
        syllables_per_second=estimate_syllable_rate(audio, sample_rate),
        f0_mean_hz=f0_mean,
        f0_std_hz=f0_std,
        f0_jitter_hz=f0_jitter,
        longest_silence_seconds=detect_silence_by_energy(audio, sample_rate),
        speech_ratio=estimate_recent_speech_ratio(audio, sample_rate, vad),
        window_seconds=float(audio.size / sample_rate),
    )
