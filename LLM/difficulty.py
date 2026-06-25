from typing import Any, Dict, Optional, Tuple

from .utils.prompt_loader import load_prompt


# 난이도(A/B/C) 페르소나.
# 각 레벨은 "기업 티어 + 면접관 성격 + 평가 strictness"를 함께 담는다.
# 실제 지시문 텍스트는 prompts/difficulty/ 아래 개별 파일로 분리해 관리한다.
# - question_file: 질문 생성 시 주입할 난이도/깊이 지시문 파일
# - eval_file: 답변 평가 시 주입할 채점 강도/태도 지시문 파일
# - followup: 답변 기반 꼬리 질문 생성을 활성화할지 여부
DIFFICULTY_PROFILES: Dict[str, Dict[str, Any]] = {
    "A": {
        "label": "친근한 면접관 (성장 단계 스타트업)",
        "question_file": "difficulty/A_question.md",
        "eval_file": "difficulty/A_eval.md",
        "followup": False,
    },
    "B": {
        "label": "표준 면접관 (일반 중견/대기업)",
        "question_file": "difficulty/B_question.md",
        "eval_file": "difficulty/B_eval.md",
        "followup": False,
    },
    "C": {
        "label": "엄격한 면접관 (탑티어/외국계)",
        "question_file": "difficulty/C_question.md",
        "eval_file": "difficulty/C_eval.md",
        "followup": True,
    },
}

DEFAULT_DIFFICULTY = "B"

# strictness 1~5 레벨별 질문 생성 지시문 규칙
_STRICTNESS_QUESTION_RULES: Dict[int, Tuple[str, list]] = {
    1: ("하 / 매우 친근한", [
        "지원자가 편하게 답할 수 있는 기본적이고 쉬운 질문만 생성한다.",
        "경험을 '있는지 확인'하는 수준에서 묻고, 근거를 깊게 파고들지 않는다.",
        "압박 질문, 반박, 트레이드오프, 실패 추궁, 꼬리 질문을 절대 넣지 않는다.",
        "질문 문장은 짧고 부드러우며, 단답이나 가벼운 설명으로 답할 수 있어야 한다.",
    ]),
    2: ("중하 / 친근한", [
        "편안한 분위기에서 기본 역량을 확인하는 질문을 생성한다.",
        "경험의 이유나 결과를 한 단계 정도 물어볼 수 있으나, 강한 압박은 피한다.",
        "실패 추궁이나 공격적인 반박은 넣지 않는다.",
        "질문은 간결하고 부담 없는 수준을 유지한다.",
    ]),
    3: ("중 / 표준", [
        "역량을 균형 있게 점검하는 질문을 생성한다.",
        "경험의 '무엇'과 '왜'를 함께 묻는다 (1단계 탐색).",
        "한정적인 꼬리 질문을 허용하며, 표준 면접 난이도를 유지한다.",
        "무난하되 구체성을 요구하는 수준으로 설정한다.",
    ]),
    4: ("중상 / 꼼꼼한", [
        "역량을 꼼꼼하게 검증하는 질문을 생성한다.",
        "의사결정 근거와 트레이드오프를 요구한다.",
        "모호한 답변에 대해 추가 탐색 질문을 할 수 있다.",
        "성과 주장의 근거와 본인 기여를 확인하는 질문을 포함한다.",
    ]),
    5: ("상 / 엄격한", [
        "모든 질문은 지원자의 주장과 선택을 압박하고 근거를 끝까지 캐묻는 형태다.",
        "정량적 근거 요구, 트레이드오프 검토, 실패·한계 경험, 실제 기여 검증을 포함한다.",
        "'왜 다른 방법이 아니었는가', '그 선택의 단점은 무엇이었는가'처럼 의사결정을 깊게 파고든다.",
        "표면적이거나 단답으로 끝낼 수 있는 무난한 질문은 절대 만들지 않는다.",
    ]),
}


def _build_custom_instructions(custom_persona: Dict[str, Any]) -> Tuple[str, str, bool]:
    """사용자 설정 페르소나 config로부터 (question_instruction, eval_instruction, followup) 생성."""
    strictness = min(5, max(1, int(custom_persona.get("strictness", 3))))
    style = str(custom_persona.get("style", "")).strip()
    name = str(custom_persona.get("name", "")).strip() or "사용자 설정 면접관"
    followup = bool(custom_persona.get("followup", False))

    level_label, rules = _STRICTNESS_QUESTION_RULES[strictness]
    style_line = f"\n스타일: {style}" if style else ""

    q_instr = (
        f"[사용자 설정 면접관: {name} / 질문 강도 {strictness}/5 — {level_label}]{style_line}\n\n"
        + "\n".join(f"- {r}" for r in rules)
    )

    if strictness <= 1:
        eval_tone, score_note = "매우 관대하게, 격려 위주로", "점수는 너그럽게 준다."
    elif strictness <= 2:
        eval_tone, score_note = "친근하고 격려 중심으로", "점수는 관대하게 준다."
    elif strictness <= 3:
        eval_tone, score_note = "객관적이고 균형 있게", "점수는 적정하게 준다."
    elif strictness <= 4:
        eval_tone, score_note = "꼼꼼하고 엄밀하게", "점수는 엄격하게 준다."
    else:
        eval_tone, score_note = "매우 엄격하게, 날카로운 지적 위주로", "점수는 매우 짜게 준다."

    style_eval = f" {style}에 맞게" if style else ""
    e_instr = (
        f"너는 {name} 스타일로{style_eval} {eval_tone} 평가하는 면접관이다.\n"
        f"근거의 구체성과 논리를 {eval_tone} 판단한다. {score_note}"
    )

    return q_instr, e_instr, followup


def normalize_difficulty(difficulty: Any) -> str:
    key = str(difficulty or DEFAULT_DIFFICULTY).strip().upper()
    if key == "D":
        return "D"
    return key if key in DIFFICULTY_PROFILES else DEFAULT_DIFFICULTY


def get_profile(difficulty: Any) -> Dict[str, Any]:
    return DIFFICULTY_PROFILES[normalize_difficulty(difficulty)]


def question_instruction(difficulty: Any, custom_persona: Optional[Dict[str, Any]] = None) -> str:
    if normalize_difficulty(difficulty) == "D" and custom_persona:
        q_instr, _, _ = _build_custom_instructions(custom_persona)
        return q_instr
    return load_prompt(get_profile(difficulty)["question_file"]).strip()


def eval_instruction(difficulty: Any, custom_persona: Optional[Dict[str, Any]] = None) -> str:
    if normalize_difficulty(difficulty) == "D" and custom_persona:
        _, e_instr, _ = _build_custom_instructions(custom_persona)
        return e_instr
    return load_prompt(get_profile(difficulty)["eval_file"]).strip()


def followup_enabled(difficulty: Any, custom_persona: Optional[Dict[str, Any]] = None) -> bool:
    if normalize_difficulty(difficulty) == "D" and custom_persona:
        _, _, followup = _build_custom_instructions(custom_persona)
        return followup
    return bool(get_profile(difficulty)["followup"])
