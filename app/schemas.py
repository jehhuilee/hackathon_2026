"""Pydantic request/response models for the interview REST API."""

from typing import List

from pydantic import BaseModel, Field


class SessionCreate(BaseModel):
    job_role: str = ""
    company: str = ""
    tech_stack: List[str] = Field(default_factory=list)
    resume_text: str = ""
    question_count: int = 5


class QuestionOut(BaseModel):
    id: int
    order_index: int
    category: str
    question: str
    intent: str


class SessionResponse(BaseModel):
    session_id: int
    questions: List[QuestionOut]


class Evaluation(BaseModel):
    total_score: int
    content_score: int
    structure_score: int
    strength: str
    weakness: str
    improvement: str
    sample_answer: str


class AnswerResponse(BaseModel):
    answer_id: int
    question_id: int
    transcript: str
    evaluation: Evaluation
