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
            "difficulty_instruction": question_instruction(data.get("difficulty")),
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
    prompt = render_prompt(
        "answer_evaluation.md",
        {
            "difficulty_instruction": eval_instruction(data.get("difficulty")),
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


def generate_followups(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """지원자 답변의 키워드를 짚어 꼬리 질문을 생성한다.

    난이도에 꼬리 질문 기능이 없으면(예: A/B) 빈 리스트를 반환한다.
    난이도와 무관하게 강제로 생성하려면 force=True 를 넘긴다.
    """
    if not data.get("force") and not followup_enabled(data.get("difficulty")):
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
