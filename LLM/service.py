from typing import Any, Dict, List

from .client import complete
from .difficulty import eval_instruction, followup_enabled, question_instruction
from .schemas import (
    normalize_evaluation_result,
    normalize_followup_item,
    normalize_question_item,
)
from .utils.json_parser import parse_json_response
from .utils.prompt_loader import render_prompt


def generate_questions(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    prompt = render_prompt(
        "question_generation.md",
        {
            "difficulty_instruction": question_instruction(data.get("difficulty"), data.get("custom_persona")),
            "job_role": data.get("job_role", ""),
            "company": data.get("company", ""),
            "tech_stack": ", ".join(data.get("tech_stack", [])),
            "resume_text": data.get("resume_text", ""),
            "question_count": data.get("question_count", 5),
        },
    )
    response_text = complete(prompt)
    payload = parse_json_response(response_text)

    if isinstance(payload, list):
        items = payload
    else:
        items = payload.get("questions", []) if isinstance(payload, dict) else []

    normalized = []
    for index, item in enumerate(items[: int(data.get("question_count", 5))]):
        if isinstance(item, dict):
            normalized.append(normalize_question_item(item, index))
    return normalized


def evaluate_answer(data: Dict[str, Any]) -> Dict[str, Any]:
    # The candidate profile is passed through so the evaluator can both correct
    # context-specific transcription errors (corrected_transcript) and judge the
    # answer against the role — all in a single LLM call.
    tech_stack = data.get("tech_stack", [])
    if isinstance(tech_stack, (list, tuple)):
        tech_stack = ", ".join(str(t) for t in tech_stack)
    prompt = render_prompt(
        "answer_evaluation.md",
        {
            "difficulty_instruction": eval_instruction(data.get("difficulty"), data.get("custom_persona")),
            "job_role": data.get("job_role", ""),
            "company": data.get("company", ""),
            "tech_stack": tech_stack,
            "question": data.get("question", ""),
            "intent": data.get("intent", ""),
            "answer_text": data.get("answer_text", ""),
        },
    )
    response_text = complete(prompt)
    payload = parse_json_response(response_text)

    if not isinstance(payload, dict):
        raise ValueError("Invalid evaluation response format")
    return normalize_evaluation_result(payload)


def generate_overall_feedback(data: Dict[str, Any]) -> Dict[str, Any]:
    """Synthesize one comprehensive, session-wide feedback from all answers.

    ``data`` carries the candidate profile plus a pre-built ``qa_block`` string
    (each question, its transcript, and per-answer scores). Returns a single
    integrated assessment instead of per-question feedback.
    """
    tech_stack = data.get("tech_stack", [])
    if isinstance(tech_stack, (list, tuple)):
        tech_stack = ", ".join(str(t) for t in tech_stack)
    prompt = render_prompt(
        "overall_feedback.md",
        {
            "job_role": data.get("job_role", ""),
            "company": data.get("company", ""),
            "tech_stack": tech_stack,
            "qa_block": data.get("qa_block", ""),
        },
    )
    response_text = complete(prompt)
    payload = parse_json_response(response_text)
    if not isinstance(payload, dict):
        raise ValueError("Invalid overall feedback response format")

    priorities = payload.get("improvement_priorities") or []
    if not isinstance(priorities, list):
        priorities = [str(priorities)]
    return {
        "overall_feedback": str(payload.get("overall_feedback", "")).strip(),
        "improvement_priorities": [str(p).strip() for p in priorities if str(p).strip()],
        "action_plan": str(payload.get("action_plan", "")).strip(),
    }


def generate_followups(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """지원자 답변의 키워드를 짚어 꼬리 질문을 생성한다.

    난이도에 꼬리 질문 기능이 없으면(예: A/B) 빈 리스트를 반환한다.
    난이도와 무관하게 강제로 생성하려면 force=True 를 넘긴다.
    """
    if not data.get("force") and not followup_enabled(data.get("difficulty"), data.get("custom_persona")):
        return []

    followup_count = int(data.get("followup_count", 2))
    prompt = render_prompt(
        "followup_generation.md",
        {
            "question": data.get("question", ""),
            "intent": data.get("intent", ""),
            "answer_text": data.get("answer_text", ""),
            "followup_count": followup_count,
        },
    )
    response_text = complete(prompt)
    payload = parse_json_response(response_text)

    if isinstance(payload, list):
        items = payload
    else:
        items = payload.get("followups", []) if isinstance(payload, dict) else []

    normalized = []
    for index, item in enumerate(items[:followup_count]):
        if isinstance(item, dict):
            normalized.append(normalize_followup_item(item, index))
    return normalized
