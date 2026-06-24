"""SQLite persistence for interview sessions, questions, answers, evaluations.

Uses the stdlib ``sqlite3`` module only (no ORM). Each operation opens a short
lived connection so the helpers are safe to call from FastAPI's threadpool.
"""

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_PATH = Path(os.getenv("DB_PATH", Path(__file__).resolve().parent / "data" / "interview.db"))


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                job_role       TEXT    NOT NULL DEFAULT '',
                company        TEXT    NOT NULL DEFAULT '',
                tech_stack     TEXT    NOT NULL DEFAULT '[]',
                resume_text    TEXT    NOT NULL DEFAULT '',
                question_count INTEGER NOT NULL DEFAULT 0,
                created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS questions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                order_index INTEGER NOT NULL DEFAULT 0,
                category    TEXT    NOT NULL DEFAULT '',
                question    TEXT    NOT NULL DEFAULT '',
                intent      TEXT    NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS answers (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id       INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                transcript        TEXT    NOT NULL DEFAULT '',
                audio_path        TEXT    NOT NULL DEFAULT '',
                voice_metrics     TEXT    NOT NULL DEFAULT '{}',
                pose_metrics      TEXT    NOT NULL DEFAULT '{}',
                created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS evaluations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                answer_id       INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
                total_score     INTEGER NOT NULL DEFAULT 0,
                content_score   INTEGER NOT NULL DEFAULT 0,
                structure_score INTEGER NOT NULL DEFAULT 0,
                strength        TEXT    NOT NULL DEFAULT '',
                weakness        TEXT    NOT NULL DEFAULT '',
                improvement     TEXT    NOT NULL DEFAULT '',
                sample_answer   TEXT    NOT NULL DEFAULT ''
            );
            """
        )


def create_session(data: Dict[str, Any]) -> int:
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO sessions (job_role, company, tech_stack, resume_text, question_count)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                data.get("job_role", ""),
                data.get("company", ""),
                json.dumps(data.get("tech_stack", []), ensure_ascii=False),
                data.get("resume_text", ""),
                int(data.get("question_count", 0)),
            ),
        )
        return int(cursor.lastrowid)


def add_questions(session_id: int, questions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Persist generated questions and return them with their DB ids."""
    stored: List[Dict[str, Any]] = []
    with _connect() as conn:
        for index, item in enumerate(questions):
            cursor = conn.execute(
                """
                INSERT INTO questions (session_id, order_index, category, question, intent)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    index,
                    item.get("category", ""),
                    item.get("question", ""),
                    item.get("intent", ""),
                ),
            )
            stored.append(
                {
                    "id": int(cursor.lastrowid),
                    "order_index": index,
                    "category": item.get("category", ""),
                    "question": item.get("question", ""),
                    "intent": item.get("intent", ""),
                }
            )
    return stored


def get_question(question_id: int) -> Optional[Dict[str, Any]]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM questions WHERE id = ?", (question_id,)).fetchone()
        return dict(row) if row else None


def create_answer(
    question_id: int,
    transcript: str,
    audio_path: str,
    voice_metrics: Dict[str, Any],
    pose_metrics: Dict[str, Any],
) -> int:
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO answers (question_id, transcript, audio_path, voice_metrics, pose_metrics)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                question_id,
                transcript,
                audio_path,
                json.dumps(voice_metrics, ensure_ascii=False),
                json.dumps(pose_metrics, ensure_ascii=False),
            ),
        )
        return int(cursor.lastrowid)


def create_evaluation(answer_id: int, evaluation: Dict[str, Any]) -> int:
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO evaluations (
                answer_id, total_score, content_score, structure_score,
                strength, weakness, improvement, sample_answer
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                answer_id,
                int(evaluation.get("total_score", 0)),
                int(evaluation.get("content_score", 0)),
                int(evaluation.get("structure_score", 0)),
                evaluation.get("strength", ""),
                evaluation.get("weakness", ""),
                evaluation.get("improvement", ""),
                evaluation.get("sample_answer", ""),
            ),
        )
        return int(cursor.lastrowid)


def get_report(session_id: int) -> Optional[Dict[str, Any]]:
    """Aggregate a session with each question, its answer, and evaluation."""
    with _connect() as conn:
        session = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not session:
            return None

        questions = conn.execute(
            "SELECT * FROM questions WHERE session_id = ? ORDER BY order_index",
            (session_id,),
        ).fetchall()

        items: List[Dict[str, Any]] = []
        for question in questions:
            answer = conn.execute(
                "SELECT * FROM answers WHERE question_id = ? ORDER BY id DESC LIMIT 1",
                (question["id"],),
            ).fetchone()

            evaluation = None
            answer_payload = None
            if answer:
                answer_payload = {
                    "id": answer["id"],
                    "transcript": answer["transcript"],
                    "voice_metrics": json.loads(answer["voice_metrics"] or "{}"),
                    "pose_metrics": json.loads(answer["pose_metrics"] or "{}"),
                    "created_at": answer["created_at"],
                }
                eval_row = conn.execute(
                    "SELECT * FROM evaluations WHERE answer_id = ? ORDER BY id DESC LIMIT 1",
                    (answer["id"],),
                ).fetchone()
                if eval_row:
                    evaluation = {
                        key: eval_row[key]
                        for key in (
                            "total_score",
                            "content_score",
                            "structure_score",
                            "strength",
                            "weakness",
                            "improvement",
                            "sample_answer",
                        )
                    }

            items.append(
                {
                    "question": {
                        "id": question["id"],
                        "order_index": question["order_index"],
                        "category": question["category"],
                        "question": question["question"],
                        "intent": question["intent"],
                    },
                    "answer": answer_payload,
                    "evaluation": evaluation,
                }
            )

        scores = [it["evaluation"]["total_score"] for it in items if it["evaluation"]]
        average_score = round(sum(scores) / len(scores), 1) if scores else None

        return {
            "session": {
                "id": session["id"],
                "job_role": session["job_role"],
                "company": session["company"],
                "tech_stack": json.loads(session["tech_stack"] or "[]"),
                "question_count": session["question_count"],
                "created_at": session["created_at"],
            },
            "items": items,
            "average_score": average_score,
            "answered_count": len(scores),
        }
