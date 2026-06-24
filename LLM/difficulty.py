from typing import Any, Dict

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


def normalize_difficulty(difficulty: Any) -> str:
    key = str(difficulty or DEFAULT_DIFFICULTY).strip().upper()
    return key if key in DIFFICULTY_PROFILES else DEFAULT_DIFFICULTY


def get_profile(difficulty: Any) -> Dict[str, Any]:
    return DIFFICULTY_PROFILES[normalize_difficulty(difficulty)]


def question_instruction(difficulty: Any) -> str:
    return load_prompt(get_profile(difficulty)["question_file"]).strip()


def eval_instruction(difficulty: Any) -> str:
    return load_prompt(get_profile(difficulty)["eval_file"]).strip()


def followup_enabled(difficulty: Any) -> bool:
    return bool(get_profile(difficulty)["followup"])
