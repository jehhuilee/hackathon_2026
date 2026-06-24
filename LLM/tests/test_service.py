import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from LLM.client import OpenAIClient
from LLM.service import evaluate_answer, generate_questions


class ServiceTests(unittest.TestCase):
    @patch("openai.OpenAI")
    def test_ollama_client_uses_chat_completions(self, mock_openai_cls):
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="안녕하세요"))]
        )
        mock_openai_cls.return_value = mock_client

        client = OpenAIClient(api_key="ollama", backend="ollama", base_url="http://localhost:11434/v1")
        result = client.complete("Hello")

        self.assertEqual(result, "안녕하세요")
        mock_openai_cls.assert_called_once_with(
            api_key="ollama",
            base_url="http://localhost:11434/v1",
        )

    @patch("LLM.service.complete")
    def test_generate_questions_returns_normalized_items(self, mock_complete):
        mock_complete.return_value = (
            '[{"category": "프로젝트 경험", "question": "어떤 프로젝트가 가장 기억에 남나요?", '
            '"intent": "프로젝트 이해도 확인"}]'
        )

        data = {
            "job_role": "AI Backend Intern",
            "company": "Naver",
            "resume_text": "Python, FastAPI, React를 활용한 서비스 개발 경험이 있습니다.",
            "tech_stack": ["Python", "FastAPI", "React"],
            "question_count": 1,
        }

        result = generate_questions(data)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "q1")
        self.assertEqual(result[0]["category"], "프로젝트 경험")
        self.assertEqual(result[0]["question"], "어떤 프로젝트가 가장 기억에 남나요?")
        self.assertEqual(result[0]["intent"], "프로젝트 이해도 확인")

    @patch("LLM.service.complete")
    def test_evaluate_answer_returns_expected_structure(self, mock_complete):
        mock_complete.return_value = (
            '{"total_score": 85, "content_score": 88, "structure_score": 82, '
            '"strength": "구체적인 경험을 포함했습니다.", "weakness": "기술적 깊이가 조금 부족합니다.", '
            '"improvement": "STAR 구조로 더 구체화하면 좋습니다.", '
            '"sample_answer": "저는 ..."}'
        )

        data = {
            "question": "프로젝트에서 가장 어려웠던 문제는 무엇인가요?",
            "intent": "문제 해결 능력 평가",
            "answer_text": "저는 데이터 처리 파이프라인을 최적화했습니다.",
        }

        result = evaluate_answer(data)

        self.assertEqual(result["total_score"], 85)
        self.assertEqual(result["content_score"], 88)
        self.assertEqual(result["structure_score"], 82)
        self.assertIn("구체적인 경험", result["strength"])
        self.assertIn("기술적 깊이", result["weakness"])


if __name__ == "__main__":
    unittest.main()
