from pathlib import Path
from typing import Any, Mapping


PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"


def load_prompt(template_name: str) -> str:
    path = PROMPTS_DIR / template_name
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8")


def render_prompt(template_name: str, values: Mapping[str, Any]) -> str:
    prompt = load_prompt(template_name)
    for key, value in values.items():
        prompt = prompt.replace("{" + key + "}", str(value))
    return prompt
