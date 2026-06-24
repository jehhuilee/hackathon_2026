"""REST routes for the interview pipeline: questions, answers, report.

These run alongside the existing real-time audio WebSocket (``/ws/audio``) on the
same FastAPI app. They reuse the LLM service for question generation/evaluation
and the hybrid STT module for transcription, and persist everything via app.db.
"""

import json
import uuid
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from LLM.service import evaluate_answer, generate_questions

from app import db
from app.schemas import SessionCreate, SessionResponse
from app.stt import transcribe

router = APIRouter(prefix="/api", tags=["interview"])

AUDIO_DIR = Path(__file__).resolve().parent / "data" / "audio"


def _parse_json_field(raw: str, field_name: str) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid JSON in '{field_name}'") from exc
    return value if isinstance(value, dict) else {}


@router.post("/sessions", response_model=SessionResponse)
def create_session(payload: SessionCreate) -> Dict[str, Any]:
    """Generate interview questions for the given profile and store the session."""
    questions = generate_questions(payload.dict())
    session_id = db.create_session(payload.dict())
    stored = db.add_questions(session_id, questions)
    return {"session_id": session_id, "questions": stored}


@router.post("/answers")
async def submit_answer(
    question_id: int = Form(...),
    audio: UploadFile = File(...),
    voice_metrics: str = Form("{}"),
    pose_metrics: str = Form("{}"),
) -> Dict[str, Any]:
    """Transcribe a recorded answer, evaluate it, and persist both results."""
    question = db.get_question(question_id)
    if not question:
        raise HTTPException(status_code=404, detail="question not found")

    voice = _parse_json_field(voice_metrics, "voice_metrics")
    pose = _parse_json_field(pose_metrics, "pose_metrics")

    audio_bytes = await audio.read()
    filename = audio.filename or "answer.webm"

    # Persist the raw recording so it can be re-transcribed or reviewed later.
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(filename).suffix or ".webm"
    audio_path = AUDIO_DIR / f"{question_id}_{uuid.uuid4().hex}{suffix}"
    audio_path.write_bytes(audio_bytes)

    transcript = transcribe(audio_bytes, filename)

    evaluation = evaluate_answer(
        {
            "question": question["question"],
            "intent": question["intent"],
            "answer_text": transcript,
        }
    )

    answer_id = db.create_answer(question_id, transcript, str(audio_path), voice, pose)
    db.create_evaluation(answer_id, evaluation)

    return {
        "answer_id": answer_id,
        "question_id": question_id,
        "transcript": transcript,
        "evaluation": evaluation,
        "voice_metrics": voice,
    }


@router.get("/sessions/{session_id}/report")
def get_report(session_id: int) -> Dict[str, Any]:
    """Aggregate every question, answer, and evaluation for a session."""
    report = db.get_report(session_id)
    if not report:
        raise HTTPException(status_code=404, detail="session not found")
    return report
