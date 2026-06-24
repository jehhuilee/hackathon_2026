"""FastAPI application entry point for the local real-time audio analyzer."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from Audio.routes import router


def create_app() -> FastAPI:
    """Create the FastAPI app and attach route modules."""
    app = FastAPI(title="Two-Track Local Audio Analyzer", version="1.0.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("Audio.real_time_server:app", host="0.0.0.0", port=8000, reload=True)
