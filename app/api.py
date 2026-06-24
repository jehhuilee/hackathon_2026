"""REST routes for the interview pipeline: questions, answers, report.

These run alongside the existing real-time audio WebSocket (``/ws/audio``) on the
same FastAPI app. They reuse the LLM service for question generation/evaluation
and the hybrid STT module for transcription, and persist everything via app.db.
"""

import io
import json
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from LLM.service import evaluate_answer, generate_overall_feedback, generate_questions

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


@router.get("/sessions/{session_id}/overall_feedback")
def overall_feedback(session_id: int) -> Dict[str, Any]:
    """One comprehensive, session-wide feedback synthesized from all answers.

    Computed on demand (the final report is viewed once), so the LLM cost is not
    paid on every report read. Returns empty fields when nothing was answered.
    """
    report = db.get_report(session_id)
    if not report:
        raise HTTPException(status_code=404, detail="session not found")

    answered = [
        item
        for item in report["items"]
        if item.get("answer") and item.get("evaluation")
    ]
    if not answered:
        return {
            "overall_feedback": "",
            "improvement_priorities": [],
            "action_plan": "",
            "answered_count": 0,
        }

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
    result = generate_overall_feedback(
        {
            "job_role": session.get("job_role", ""),
            "company": session.get("company", ""),
            "tech_stack": session.get("tech_stack", []),
            "qa_block": "\n\n".join(blocks),
        }
    )
    result["answered_count"] = len(answered)
    return result
