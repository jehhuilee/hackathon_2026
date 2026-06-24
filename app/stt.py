"""Hybrid speech-to-text: OpenAI Whisper API or local faster-whisper.

Backend is selected via the ``STT_BACKEND`` env var (``openai`` | ``local``),
mirroring the ``LLM_BACKEND`` switch in ``LLM/client.py``. Transcription runs
once on the full recorded answer (batch), not in real time.
"""

import os
import tempfile
from pathlib import Path
from typing import Optional

# Reuse the .env loader from the LLM module so STT honours the same config file.
from LLM.client import _load_env_file

_local_model = None  # lazily-loaded faster-whisper model (expensive to construct)


def _backend() -> str:
    _load_env_file()
    return os.getenv("STT_BACKEND", "openai").strip().lower()


def _transcribe_openai(audio_bytes: bytes, filename: str, prompt: str = "") -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required for STT_BACKEND=openai")

    try:
        from openai import OpenAI
    except ImportError as exc:  # pragma: no cover - import guard
        raise ImportError("openai package is required for OpenAI STT.") from exc

    # A dedicated client: the LLM client may point at an Ollama base_url that has
    # no audio endpoint, so we never reuse it for transcription.
    client = OpenAI(api_key=api_key)
    model = os.getenv("STT_OPENAI_MODEL", "whisper-1")
    kwargs = {
        "model": model,
        "file": (filename, audio_bytes),
        "language": os.getenv("STT_LANGUAGE", "ko"),
    }
    # Bias decoding toward the candidate's domain (company/role/tech terms) so
    # proper nouns and jargon are transcribed correctly at no extra latency.
    if prompt:
        kwargs["prompt"] = prompt
    response = client.audio.transcriptions.create(**kwargs)
    return (response.text or "").strip()


def _get_local_model():
    global _local_model
    if _local_model is None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # pragma: no cover - import guard
            raise ImportError(
                "faster-whisper is required for STT_BACKEND=local. "
                "Install it with `pip install faster-whisper`."
            ) from exc
        model_name = os.getenv("WHISPER_MODEL", "base")
        compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
        _local_model = WhisperModel(model_name, compute_type=compute_type)
    return _local_model


def _transcribe_local(audio_bytes: bytes, filename: str, prompt: str = "") -> str:
    model = _get_local_model()
    suffix = Path(filename).suffix or ".webm"
    # faster-whisper decodes container formats (webm/opus) via PyAV from a path.
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    kwargs = {"language": os.getenv("STT_LANGUAGE", "ko")}
    # Same context-biasing idea as the OpenAI path; faster-whisper names it
    # ``initial_prompt`` instead of ``prompt``.
    if prompt:
        kwargs["initial_prompt"] = prompt
    try:
        segments, _info = model.transcribe(tmp_path, **kwargs)
        return " ".join(segment.text.strip() for segment in segments).strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def transcribe(audio_bytes: bytes, filename: str = "answer.webm", prompt: str = "") -> str:
    """Transcribe a full recorded answer to text using the configured backend.

    ``prompt`` is an optional context string (company/role/tech-stack terms) used
    to bias decoding toward the candidate's domain — this is the cheapest layer
    of context correction since it adds no extra round trip.
    """
    if not audio_bytes:
        return ""
    if _backend() == "local":
        return _transcribe_local(audio_bytes, filename, prompt)
    return _transcribe_openai(audio_bytes, filename, prompt)
