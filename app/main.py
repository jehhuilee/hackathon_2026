"""Unified FastAPI gateway for the AI interview pipeline.

Mounts the existing real-time audio analysis WebSocket (``Audio`` package) and
the new interview REST API (``app.api``) on a single app.

Run with:  uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import router as api_router
from app.db import init_db

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    app = FastAPI(title="AI Interview Gateway", version="1.0.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    init_db()

    # Mount the real-time audio WebSocket (GET /health, WS /ws/audio). Its DSP
    # stack (librosa/scipy/webrtcvad) is heavy and optional — the REST API stays
    # usable even when those deps are not installed.
    try:
        from Audio.routes import router as audio_router

        app.include_router(audio_router)
    except ImportError as exc:
        logger.warning("Audio WebSocket not mounted (missing deps): %s", exc)

        @app.get("/health")
        def health():
            return {"status": "ok", "audio_realtime": False}

    app.include_router(api_router)  # /api/sessions, /api/answers, /api/sessions/{id}/report
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
