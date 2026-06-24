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

    @patch(
        "app.api.evaluate_answer",
        return_value={**EVALUATION, "corrected_transcript": "저는 React로 파이프라인을 최적화했습니다."},
    )
    @patch("app.api.transcribe", return_value="저는 리엑트로 파이프라인을 최적화했습니다.")
    @patch("app.api.generate_questions", return_value=QUESTIONS)
    def test_corrected_transcript_overrides_raw_stt(self, _mock_gen, mock_stt, _mock_eval):
        session = self.client.post(
            "/api/sessions",
            json={"job_role": "Frontend", "tech_stack": ["React"], "question_count": 1},
        ).json()
        question_id = session["questions"][0]["id"]

        answer = self.client.post(
            "/api/answers",
            data={"question_id": str(question_id)},
            files={"audio": ("answer.webm", b"fake-audio-bytes", "audio/webm")},
        ).json()

        # The evaluator's context-corrected transcript wins over the raw STT text,
        # and the leaked correction field is not exposed inside `evaluation`.
        self.assertEqual(answer["transcript"], "저는 React로 파이프라인을 최적화했습니다.")
        self.assertNotIn("corrected_transcript", answer["evaluation"])
        # The pre-correction STT text is exposed separately so the UI can show 원문 → 보정.
        self.assertEqual(answer["raw_transcript"], "저는 리엑트로 파이프라인을 최적화했습니다.")

        # STT was biased with a context prompt built from the candidate profile.
        _args, kwargs = mock_stt.call_args
        self.assertIn("React", kwargs.get("prompt", ""))

    @patch(
        "app.api.evaluate_answer",
        return_value={**EVALUATION, "corrected_transcript": "   "},
    )
    @patch("app.api.transcribe", return_value="원문 전사 결과입니다.")
    @patch("app.api.generate_questions", return_value=QUESTIONS)
    def test_blank_correction_falls_back_to_raw_stt(self, _mock_gen, _mock_stt, _mock_eval):
        session = self.client.post(
            "/api/sessions", json={"job_role": "Backend", "question_count": 1}
        ).json()
        question_id = session["questions"][0]["id"]

        answer = self.client.post(
            "/api/answers",
            data={"question_id": str(question_id)},
            files={"audio": ("answer.webm", b"x", "audio/webm")},
        ).json()

        self.assertEqual(answer["transcript"], "원문 전사 결과입니다.")

    @patch("app.api.evaluate_answer", return_value=EVALUATION)
    @patch("app.api.generate_questions", return_value=QUESTIONS)
    def test_partial_chunks_skip_full_whisper(self, _mock_gen, _mock_eval):
        """Pre-transcribed partials are stitched and the full Whisper pass is skipped."""
        session = self.client.post(
            "/api/sessions", json={"job_role": "Backend", "question_count": 1}
        ).json()
        question_id = session["questions"][0]["id"]
        rid = "test-recording-id-001"

        # Upload two pre-transcribed chunks with distinct return values so we can
        # verify the stitched result and confirm submit_answer made no extra call.
        chunk_texts = ["저는 데이터", "파이프라인을 최적화했습니다."]
        with patch("app.api.transcribe", side_effect=chunk_texts) as mock_chunk_stt:
            for seq in range(2):
                r = self.client.post(
                    "/api/transcribe_partial",
                    data={"recording_id": rid, "seq": str(seq)},
                    files={"audio": (f"chunk_{seq}.wav", b"\x00" * 100, "audio/wav")},
                )
                self.assertEqual(r.status_code, 200)
                self.assertTrue(r.json()["ok"])
            # Both chunk uploads consumed the mock — call count is 2.
            self.assertEqual(mock_chunk_stt.call_count, 2)

        # submit_answer with the same recording_id must use the pre-stored partials
        # and NOT call transcribe again (a new mock to detect any extra call).
        with patch("app.api.transcribe") as mock_final_stt:
            answer = self.client.post(
                "/api/answers",
                data={"question_id": str(question_id), "recording_id": rid},
                files={"audio": ("answer.webm", b"fake", "audio/webm")},
            ).json()
            mock_final_stt.assert_not_called()

        self.assertEqual(answer["transcript"], "저는 데이터 파이프라인을 최적화했습니다.")

    @patch("app.api.evaluate_answer", return_value=EVALUATION)
    @patch("app.api.transcribe", return_value="폴백 전사 결과")
    @patch("app.api.generate_questions", return_value=QUESTIONS)
    def test_missing_partials_fall_back_to_whisper(self, _mock_gen, mock_stt, _mock_eval):
        """When no partials exist for a recording_id, full Whisper is called."""
        session = self.client.post(
            "/api/sessions", json={"job_role": "Backend", "question_count": 1}
        ).json()
        question_id = session["questions"][0]["id"]

        answer = self.client.post(
            "/api/answers",
            data={"question_id": str(question_id), "recording_id": "nonexistent-id"},
            files={"audio": ("answer.webm", b"fake", "audio/webm")},
        ).json()

        mock_stt.assert_called_once()
        self.assertEqual(answer["transcript"], "폴백 전사 결과")

    def test_answer_unknown_question_returns_404(self):
        response = self.client.post(
            "/api/answers",
            data={"question_id": "999999"},
            files={"audio": ("a.webm", b"x", "audio/webm")},
        )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
