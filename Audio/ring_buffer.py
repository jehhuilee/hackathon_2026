"""Numpy ring buffer for the latest mono audio samples."""

import numpy as np


class RingBuffer:
    """Fixed-size mono float32 ring buffer for the latest N seconds of audio."""

    def __init__(self, seconds: float, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.max_samples = int(seconds * sample_rate)
        self.buffer = np.zeros(self.max_samples, dtype=np.float32)
        self.write_index = 0
        self.samples_seen = 0

    def append(self, samples: np.ndarray) -> None:
        """Append mono float32 samples, keeping only the newest max_samples."""
        if samples.size == 0:
            return

        samples = np.asarray(samples, dtype=np.float32)
        if samples.size >= self.max_samples:
            self.buffer[:] = samples[-self.max_samples :]
            self.write_index = 0
            self.samples_seen += samples.size
            return

        end_index = self.write_index + samples.size
        if end_index <= self.max_samples:
            self.buffer[self.write_index : end_index] = samples
        else:
            first_part = self.max_samples - self.write_index
            self.buffer[self.write_index :] = samples[:first_part]
            self.buffer[: end_index % self.max_samples] = samples[first_part:]

        self.write_index = end_index % self.max_samples
        self.samples_seen += samples.size

    def snapshot(self, seconds: float | None = None) -> np.ndarray:
        """Return a chronological copy of the latest audio."""
        available = min(self.samples_seen, self.max_samples)
        if available <= 0:
            return np.zeros(0, dtype=np.float32)

        requested = available if seconds is None else min(available, int(seconds * self.sample_rate))
        start = (self.write_index - requested) % self.max_samples

        if start < self.write_index:
            return self.buffer[start : self.write_index].copy()
        return np.concatenate((self.buffer[start:], self.buffer[: self.write_index])).copy()
