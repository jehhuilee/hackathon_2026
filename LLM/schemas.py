from typing import Any, Dict, List, Optional


class QuestionItem(dict):
    pass


def normalize_question_item(item: Dict[str, Any], index: int) -> Dict[str, Any]:
    return {
        "id": f"q{index + 1}",
        "category": item.get("category") or "일반",
        "question": item.get("question") or "",
        "intent": item.get("intent") or "",
    }


def normalize_followup_item(item: Dict[str, Any], index: int) -> Dict[str, Any]:
    return {
        "id": f"f{index + 1}",
        "category": "꼬리 질문",
        "keyword": item.get("keyword") or "",
        "question": item.get("question") or "",
        "intent": item.get("intent") or "",
    }


def normalize_evaluation_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "total_score": int(payload.get("total_score", 0)),
        "content_score": int(payload.get("content_score", 0)),
        "structure_score": int(payload.get("structure_score", 0)),
        "strength": str(payload.get("strength", "")),
        "weakness": str(payload.get("weakness", "")),
        "improvement": str(payload.get("improvement", "")),
        "sample_answer": str(payload.get("sample_answer", "")),
    }
