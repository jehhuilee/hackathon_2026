from typing import Any, Dict, List

from .client import complete
from .schemas import normalize_evaluation_result, normalize_question_item
from .utils.json_parser import parse_json_response
from .utils.prompt_loader import render_prompt


def generate_questions(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    prompt = render_prompt(
        "question_generation.md",
        {
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
