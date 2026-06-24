"""End-to-end route tests with the LLM client and STT mocked out.

Mirrors the mocking style in LLM/tests/test_service.py: patch at the import
point used by the route module, feed canned responses, assert on the result.
"""

import os
import tempfile
import unittest
from unittest.mock import patch

# Use an isolated, temporary SQLite file so tests never touch real data.
_TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP_DB.close()
os.environ["DB_PATH"] = _TMP_DB.name

from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402

QUESTIONS = [
    {"id": "q1", "category": "프로젝트 경험", "question": "가장 기억에 남는 프로젝트는?", "intent": "프로젝트 이해도"}
]

EVALUATION = {
    "total_score": 85,
    "content_score": 88,
    "structure_score": 82,
    "strength": "구체적인 경험을 포함했습니다.",
    "weakness": "기술적 깊이가 부족합니다.",
    "improvement": "STAR 구조로 보완하세요.",
    "sample_answer": "저는 ...",
}


class InterviewApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app())

    @patch("app.api.generate_questions", return_value=QUESTIONS)
    def test_create_session_stores_questions(self, _mock_gen):
        response = self.client.post(
            "/api/sessions",
            json={
                "job_role": "Backend Intern",
                "company": "Naver",
                "tech_stack": ["Python", "FastAPI"],
                "resume_text": "FastAPI 경험이 있습니다.",
                "question_count": 1,
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("session_id", body)
        self.assertEqual(len(body["questions"]), 1)
        self.assertEqual(body["questions"][0]["question"], "가장 기억에 남는 프로젝트는?")
        self.assertIsInstance(body["questions"][0]["id"], int)

    @patch("app.api.evaluate_answer", return_value=EVALUATION)
    @patch("app.api.transcribe", return_value="저는 데이터 파이프라인을 최적화했습니다.")
    @patch("app.api.generate_questions", return_value=QUESTIONS)
    def test_answer_and_report_flow(self, _mock_gen, _mock_stt, _mock_eval):
        session = self.client.post(
            "/api/sessions",
            json={"job_role": "Backend", "question_count": 1},
        ).json()
        question_id = session["questions"][0]["id"]
        session_id = session["session_id"]

        answer = self.client.post(
            "/api/answers",
            data={
                "question_id": str(question_id),
                "voice_metrics": '{"syllables_per_second": 4.8}',
                "pose_metrics": '{"shoulder_tilt": 0.02}',
            },
            files={"audio": ("answer.webm", b"fake-audio-bytes", "audio/webm")},
        )
        self.assertEqual(answer.status_code, 200)
        body = answer.json()
        self.assertEqual(body["transcript"], "저는 데이터 파이프라인을 최적화했습니다.")
        self.assertEqual(body["evaluation"]["total_score"], 85)

        report = self.client.get(f"/api/sessions/{session_id}/report").json()
        self.assertEqual(report["answered_count"], 1)
        self.assertEqual(report["average_score"], 85.0)
        item = report["items"][0]
        self.assertEqual(item["answer"]["voice_metrics"]["syllables_per_second"], 4.8)
        self.assertEqual(item["evaluation"]["total_score"], 85)

    def test_answer_unknown_question_returns_404(self):
        response = self.client.post(
            "/api/answers",
            data={"question_id": "999999"},
            files={"audio": ("a.webm", b"x", "audio/webm")},
        )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
