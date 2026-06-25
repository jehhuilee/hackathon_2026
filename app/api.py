"""REST routes for the interview pipeline: questions, answers, report.

These run alongside the existing real-time audio WebSocket (``/ws/audio``) on the
same FastAPI app. They reuse the LLM service for question generation/evaluation
and the hybrid STT module for transcription, and persist everything via app.db.
"""

import base64
import io
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import StreamingResponse

from LLM.client import complete, complete_stream
from LLM.service import evaluate_answer, generate_questions
from LLM.utils.json_parser import parse_json_response
from LLM.utils.prompt_loader import render_prompt

from app import db
from app.schemas import SessionCreate, SessionResponse
from app.stt import transcribe

router = APIRouter(prefix="/api", tags=["interview"])

AUDIO_DIR = Path(__file__).resolve().parent / "data" / "audio"

# Guardrails for resume PDF upload.
MAX_RESUME_PDF_BYTES = 10 * 1024 * 1024  # 10 MB

# In-memory store for pre-transcribed STT chunks uploaded during recording.
# Key: client-generated recording_id (UUID). Value: {seq: transcript_text}.
# Entries are consumed (popped) when the matching submit_answer arrives.
# Note: entries are never expired — for a long-running server a TTL eviction
# policy would be needed, but for short interview sessions this is acceptable.
_partial_store: Dict[str, Dict[int, str]] = {}


def _parse_json_field(raw: str, field_name: str) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid JSON in '{field_name}'") from exc
    return value if isinstance(value, dict) else {}


# Whisper's prompt is capped (~224 tokens); a short, term-dense string works best.
STT_PROMPT_MAX_CHARS = 600
_RESUME_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+#.]{1,}")


def _build_stt_prompt(profile: Optional[Dict[str, Any]]) -> str:
    """Build a compact context string to bias STT decoding toward this candidate.

    Combines the user-entered profile (company / role / tech stack) with the
    distinctive technical tokens in the resume (English/alphanumeric terms like
    "FastAPI", "k8s"), which are exactly the proper nouns Whisper most often
    mis-transcribes. Kept short so it stays within Whisper's prompt budget.
    """
    if not profile:
        return ""

    terms: List[str] = []
    seen = set()

    def add(value: str) -> None:
        token = (value or "").strip()
        if not token:
            return
        key = token.lower()
        if key in seen:
            return
        seen.add(key)
        terms.append(token)

    add(profile.get("company", ""))
    add(profile.get("job_role", ""))
    for tech in profile.get("tech_stack", []) or []:
        add(str(tech))
    # Distinctive resume tokens (English/jargon) — these are the likely misreads.
    for match in _RESUME_TOKEN_RE.findall(profile.get("resume_text", "") or ""):
        add(match)

    if not terms:
        return ""

    prompt = "면접 답변입니다. 다음 용어가 등장할 수 있습니다: " + ", ".join(terms) + "."
    return prompt[:STT_PROMPT_MAX_CHARS]


_TYPECAST_URL = "https://api.typecast.ai/v1/text-to-speech"
# Korean professional female voice (Seohyeon) — matches the female avatar.
_TYPECAST_VOICE_ID = os.environ.get("TYPECAST_VOICE_ID", "tc_69f2e455ea79fd197aa0476f")


@router.post("/tts")
async def text_to_speech(payload: Dict[str, Any]):
    """TTS via Typecast; returns raw WAV bytes.

    The frontend builds viseme timing from Korean jamo decomposition,
    scaled to the actual audio duration after decoding.
    """
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    api_key = os.environ.get("TYPECAST_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="TYPECAST_API_KEY not configured")

    rate = float(payload.get("rate", 1.0))
    pitch = float(payload.get("pitch", 1.0))

    if pitch > 1.05 or rate > 1.03:
        emotion = "toneup"
    elif pitch < 0.9 or rate < 0.95:
        emotion = "tonedown"
    else:
        emotion = "normal"

    audio_pitch = max(-12, min(12, round((pitch - 1.0) * 8)))

    body = {
        "text": text,
        "voice_id": _TYPECAST_VOICE_ID,
        "model": "ssfm-v30",
        "language": "kor",
        "prompt": {"emotion_type": "preset", "emotion_preset": emotion},
        "output": {
            "audio_tempo": round(max(0.5, min(2.0, rate)), 2),
            "audio_pitch": audio_pitch,
            "audio_format": "wav",
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        tc = await client.post(
            _TYPECAST_URL,
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            json=body,
        )

    if tc.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Typecast error {tc.status_code}")

    return {"audio": base64.b64encode(tc.content).decode()}


@router.post("/resume/extract")
async def extract_resume(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Extract plain text from an uploaded resume/portfolio PDF.

    Returns ``{"text": ...}`` so the frontend can prefill the resume field; the
    user can still edit the text before creating a session.
    """
    filename = file.filename or "resume.pdf"
    content_type = (file.content_type or "").lower()
    if not (filename.lower().endswith(".pdf") or content_type == "application/pdf"):
        raise HTTPException(status_code=400, detail="PDF 파일만 업로드할 수 있습니다.")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="빈 파일입니다.")
    if len(data) > MAX_RESUME_PDF_BYTES:
        raise HTTPException(status_code=413, detail="파일이 너무 큽니다. (최대 10MB)")

    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:  # malformed/encrypted PDF
        raise HTTPException(status_code=422, detail="PDF에서 텍스트를 추출하지 못했습니다.") from exc

    text = "\n".join(pages).strip()
    if not text:
        raise HTTPException(
            status_code=422,
            detail="텍스트를 찾지 못했습니다. 스캔 이미지 PDF는 직접 입력해 주세요.",
        )

    return {"text": text, "page_count": len(reader.pages), "filename": filename}


@router.post("/sessions", response_model=SessionResponse)
def create_session(payload: SessionCreate) -> Dict[str, Any]:
    """Generate interview questions for the given profile and store the session."""
    questions = generate_questions(payload.dict())
    session_id = db.create_session(payload.dict())
    stored = db.add_questions(session_id, questions)
    return {"session_id": session_id, "questions": stored}


@router.post("/transcribe_partial")
async def transcribe_partial(
    recording_id: str = Form(...),
    seq: int = Form(...),
    audio: UploadFile = File(...),
) -> Dict[str, Any]:
    """Store a pre-transcribed audio chunk uploaded while the candidate speaks.

    The client uploads one chunk every STT_CHUNK_SECONDS and a final flush when
    recording stops. When submit_answer later arrives with the same recording_id,
    the stitched transcript is used directly and the full Whisper pass is skipped.
    """
    audio_bytes = await audio.read()
    if not audio_bytes:
        return {"ok": False}
    text = transcribe(audio_bytes, audio.filename or "chunk.wav")
    if recording_id not in _partial_store:
        _partial_store[recording_id] = {}
    _partial_store[recording_id][seq] = text
    return {"ok": True, "seq": seq}


@router.post("/answers")
async def submit_answer(
    question_id: int = Form(...),
    audio: UploadFile = File(...),
    voice_metrics: str = Form("{}"),
    pose_metrics: str = Form("{}"),
    recording_id: Optional[str] = Form(None),
) -> Dict[str, Any]:
    """Transcribe a recorded answer, evaluate it, and persist both results."""
    question = db.get_question(question_id)
    if not question:
        raise HTTPException(status_code=404, detail="question not found")

    # Candidate profile drives both context layers: STT decoding bias and the
    # evaluator's transcript correction. ``session_id`` is on the question row.
    profile = db.get_session(question["session_id"]) if question.get("session_id") else None

    voice = _parse_json_field(voice_metrics, "voice_metrics")
    pose = _parse_json_field(pose_metrics, "pose_metrics")

    audio_bytes = await audio.read()
    filename = audio.filename or "answer.webm"

    # Persist the raw recording so it can be re-transcribed or reviewed later.
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(filename).suffix or ".webm"
    audio_path = AUDIO_DIR / f"{question_id}_{uuid.uuid4().hex}{suffix}"
    audio_path.write_bytes(audio_bytes)

    # Use pre-transcribed chunks when available (uploaded during recording so
    # Whisper was running in the background). Fall back to a full Whisper call
    # if no partials exist (e.g. very short answer, network failure, first chunk
    # hadn't fired yet).
    partials = _partial_store.pop(recording_id, None) if recording_id else None
    if partials:
        raw_transcript = " ".join(partials[k] for k in sorted(partials.keys())).strip()
    else:
        raw_transcript = transcribe(audio_bytes, filename, prompt=_build_stt_prompt(profile))

    # The evaluator also corrects context-specific misreads in the same call.
    evaluation = evaluate_answer(
        {
            "question": question["question"],
            "intent": question["intent"],
            "answer_text": raw_transcript,
            "job_role": (profile or {}).get("job_role", ""),
            "company": (profile or {}).get("company", ""),
            "tech_stack": (profile or {}).get("tech_stack", []),
            "difficulty": (profile or {}).get("difficulty", "B"),
            "custom_persona": (profile or {}).get("custom_persona", {}),
        }
    )

    # Use the corrected transcript when present; fall back to the raw STT text.
    corrected = (evaluation.pop("corrected_transcript", "") or "").strip()
    transcript = corrected or raw_transcript

    answer_id = db.create_answer(question_id, transcript, str(audio_path), voice, pose)
    db.create_evaluation(answer_id, evaluation)

    return {
        "answer_id": answer_id,
        "question_id": question_id,
        "transcript": transcript,
        # Expose the pre-correction STT text so the UI can show 원문 → 보정 when
        # the evaluator fixed context-specific misreads (e.g. "리엑트" → "React").
        "raw_transcript": raw_transcript,
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


def _build_overall_feedback_prompt(session_id: int) -> Optional[tuple]:
    """Return (prompt, answered_count) or None if session not found / nothing answered."""
    report = db.get_report(session_id)
    if not report:
        return None

    answered = [
        item for item in report["items"]
        if item.get("answer") and item.get("evaluation")
    ]
    if not answered:
        return report, []

    blocks: List[str] = []
    for index, item in enumerate(answered):
        evaluation = item["evaluation"]
        transcript = (item["answer"].get("transcript") or "").strip() or "(음성 인식 결과 없음)"
        blocks.append(
            f"[Q{index + 1}] {item['question']['question']}\n"
            f"답변: {transcript}\n"
            f"점수: 종합 {evaluation['total_score']} / 내용 {evaluation['content_score']} / "
            f"구조 {evaluation['structure_score']}\n"
            f"질문 의도: {item['question'].get('intent', '')}"
        )

    session = report["session"]
    tech_stack = session.get("tech_stack", [])
    if isinstance(tech_stack, list):
        tech_stack = ", ".join(str(t) for t in tech_stack)

    prompt = render_prompt(
        "overall_feedback.md",
        {
            "job_role": session.get("job_role", ""),
            "company": session.get("company", ""),
            "tech_stack": tech_stack,
            "qa_block": "\n\n".join(blocks),
        },
    )
    return prompt, answered


def _normalize_overall_feedback_payload(payload: dict, answered_count: int) -> Dict[str, Any]:
    priorities = payload.get("improvement_priorities") or []
    if not isinstance(priorities, list):
        priorities = [str(priorities)]
    return {
        "overall_feedback": str(payload.get("overall_feedback", "")).strip(),
        "improvement_priorities": [str(p).strip() for p in priorities if str(p).strip()],
        "action_plan": str(payload.get("action_plan", "")).strip(),
        "answered_count": answered_count,
    }


@router.get("/sessions/{session_id}/overall_feedback")
def overall_feedback(session_id: int) -> Dict[str, Any]:
    """One comprehensive, session-wide feedback synthesized from all answers.

    Result is cached in the DB after first generation so subsequent calls
    return immediately without hitting the LLM again.
    """
    cached = db.get_overall_feedback_cache(session_id)
    if cached:
        return cached

    built = _build_overall_feedback_prompt(session_id)
    if built is None:
        raise HTTPException(status_code=404, detail="session not found")

    prompt, answered = built
    if not answered:
        return {"overall_feedback": "", "improvement_priorities": [], "action_plan": "", "answered_count": 0}

    payload = parse_json_response(complete(prompt))
    if not isinstance(payload, dict):
        raise ValueError("Invalid overall feedback response format")

    result = _normalize_overall_feedback_payload(payload, len(answered))
    db.save_overall_feedback_cache(session_id, result)
    return result


@router.get("/sessions/{session_id}/overall_feedback/stream")
def overall_feedback_stream(session_id: int):
    """SSE endpoint: streams LLM tokens as they are generated.

    On cache hit the response is a single ``done`` event returned immediately.
    On cache miss, tokens stream via ``chunk`` events and a final ``done`` event
    carries the fully structured result (which is also saved to the DB cache).
    """
    def _iter():
        cached = db.get_overall_feedback_cache(session_id)
        if cached:
            yield f"data: {json.dumps({'type': 'done', **cached})}\n\n"
            return

        built = _build_overall_feedback_prompt(session_id)
        if built is None:
            yield f"data: {json.dumps({'type': 'error', 'message': 'session not found'})}\n\n"
            return

        prompt, answered = built
        if not answered:
            empty = {"overall_feedback": "", "improvement_priorities": [], "action_plan": "", "answered_count": 0}
            yield f"data: {json.dumps({'type': 'done', **empty})}\n\n"
            return

        accumulated = ""
        try:
            for token in complete_stream(prompt):
                accumulated += token
                yield f"data: {json.dumps({'type': 'chunk', 'text': token})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return

        try:
            payload = parse_json_response(accumulated)
            if not isinstance(payload, dict):
                raise ValueError("LLM did not return a JSON object")
            result = _normalize_overall_feedback_payload(payload, len(answered))
            db.save_overall_feedback_cache(session_id, result)
            yield f"data: {json.dumps({'type': 'done', **result})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'parse error: {exc}'})}\n\n"

    return StreamingResponse(
        _iter(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
