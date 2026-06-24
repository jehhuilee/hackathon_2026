import json
from typing import Any


def _escape_control_chars_in_strings(text: str) -> str:
    result = []
    in_string = False
    escaped = False

    for char in text:
        if escaped:
            result.append(char)
            escaped = False
            continue

        if char == "\\":
            result.append(char)
            escaped = in_string
            continue

        if char == '"':
            in_string = not in_string
            result.append(char)
            continue

        if in_string and char == "\n":
            result.append("\\n")
        elif in_string and char == "\r":
            result.append("\\r")
        elif in_string and char == "\t":
            result.append("\\t")
        elif in_string and ord(char) < 32:
            result.append("\\u%04x" % ord(char))
        else:
            result.append(char)

    return "".join(result)


def parse_json_response(text: str) -> Any:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        try:
            return json.loads(_escape_control_chars_in_strings(cleaned))
        except json.JSONDecodeError:
            pass

        start_candidates = [idx for idx in (cleaned.find("{"), cleaned.find("[")) if idx != -1]
        if not start_candidates:
            raise
        start = min(start_candidates)
        end = max(cleaned.rfind("}"), cleaned.rfind("]"))
        if end <= start:
            raise
        extracted = cleaned[start : end + 1]
        try:
            return json.loads(extracted)
        except json.JSONDecodeError:
            return json.loads(_escape_control_chars_in_strings(extracted))
