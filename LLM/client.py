import os
from pathlib import Path
from typing import Optional


def _load_env_file() -> None:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


class OpenAIClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        backend: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        _load_env_file()
        self.backend = (backend or os.getenv("LLM_BACKEND", "ollama")).strip().lower()

        if self.backend == "ollama":
            self.base_url = base_url or os.getenv("OLLAMA_BASE_URL")
            self.api_key = api_key or os.getenv("OLLAMA_API_KEY") or "ollama"
            self.model = model or os.getenv("OLLAMA_MODEL") or "llama3.2:3b"
            self._require_base_url()
        else:
            self.base_url = base_url or os.getenv("OPENAI_BASE_URL")
            self.api_key = api_key or os.getenv("OPENAI_API_KEY")
            self.model = model or os.getenv("OPENAI_MODEL") or "gpt-4o-mini"
            if not self.api_key:
                raise ValueError("OPENAI_API_KEY is required")

        try:
            from openai import OpenAI
        except ImportError as exc:
            raise ImportError(
                "openai package is required to use LLM OpenAIClient. "
                "Install it with `pip install openai`."
            ) from exc

        client_kwargs = {"api_key": self.api_key}
        if self.base_url:
            client_kwargs["base_url"] = self.base_url
        self.client = OpenAI(**client_kwargs)

    def _require_base_url(self) -> None:
        if not self.base_url:
            self.base_url = "http://localhost:11434/v1"

    def _base_request(self, prompt: str) -> dict:
        return {
            "model": self.model,
            "temperature": float(os.getenv("LLM_TEMPERATURE", "0.2")),
            "messages": [
                {
                    "role": "system",
                    "content": "You are a strict JSON generator. Return only valid JSON without markdown.",
                },
                {"role": "user", "content": prompt},
            ],
        }

    def complete(self, prompt: str) -> str:
        request = self._base_request(prompt)
        if self.backend == "ollama":
            request["extra_body"] = {"format": "json"}

        response = self.client.chat.completions.create(**request)
        return response.choices[0].message.content

    def complete_stream(self, prompt: str):
        """Yield string tokens as they are generated. Does not pass format=json to stay compatible with ollama streaming."""
        request = {**self._base_request(prompt), "stream": True}
        response = self.client.chat.completions.create(**request)
        for chunk in response:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta


client = None


def get_client() -> OpenAIClient:
    global client
    if client is None:
        client = OpenAIClient()
    return client


def complete(prompt: str) -> str:
    return get_client().complete(prompt)


def complete_stream(prompt: str):
    return get_client().complete_stream(prompt)
