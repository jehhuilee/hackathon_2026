// Unit tests for the D1 mapping helpers — verifies that the existing AI
// integration's shapes map correctly onto the UI's InterviewRecord shape
// (the "호출 인자·매핑 검증" required when live calls can't run in test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeEvaluation, toInterviewRecord } from "./feedbackMapping.js";

test("summarizeEvaluation returns the improvement (detailed feedback), not strength", () => {
  assert.equal(
    summarizeEvaluation({ strength: "구조가 명확함", improvement: "수치를 추가" }),
    "수치를 추가",
  );
});

test("summarizeEvaluation falls back to weakness, ignores strength", () => {
  assert.equal(summarizeEvaluation({ strength: "좋음" }), ""); // 강점은 더 이상 노출하지 않음
  assert.equal(summarizeEvaluation({ improvement: "개선" }), "개선");
  assert.equal(summarizeEvaluation({ weakness: "약점만 있음" }), "약점만 있음");
  assert.equal(summarizeEvaluation({}), "");
  assert.equal(summarizeEvaluation(null), "");
  assert.equal(summarizeEvaluation(undefined), "");
});

test("toInterviewRecord maps a live answer result to an InterviewRecord", () => {
  const record = toInterviewRecord({
    question: { id: 7, question: "자기소개?", category: "인성" },
    transcript: "안녕하세요, 백엔드 개발자입니다.",
    evaluation: {
      total_score: 80,
      content_score: 78,
      structure_score: 82,
      strength: "경험이 구체적",
      improvement: "결론을 먼저",
    },
  });

  assert.equal(record.id, 7);
  assert.equal(record.question, "자기소개?");
  assert.equal(record.answer, "안녕하세요, 백엔드 개발자입니다.");
  assert.equal(record.feedback, "결론을 먼저");
  assert.equal(record.category, "인성");
  assert.equal(record.source, "live");
  assert.equal(record.evaluation.total_score, 80);
});

test("toInterviewRecord degrades gracefully on missing inputs", () => {
  const record = toInterviewRecord({});
  assert.equal(record.id, null);
  assert.equal(record.question, "");
  assert.equal(record.answer, "");
  assert.equal(record.feedback, "");
  assert.equal(record.evaluation, null);
  assert.equal(record.source, "live");

  // Called with no argument at all must not throw.
  assert.doesNotThrow(() => toInterviewRecord());
});

test("toInterviewRecord falls back to question_id when id is absent", () => {
  const record = toInterviewRecord({ question: { question_id: 12, question: "Q" } });
  assert.equal(record.id, 12);
});

test("rawAnswer is set only when the corrected transcript differs from raw", () => {
  const corrected = toInterviewRecord({
    question: { id: 1, question: "Q" },
    transcript: "저는 React를 씁니다.",
    rawTranscript: "저는 리엑트를 씁니다.",
  });
  assert.equal(corrected.answer, "저는 React를 씁니다.");
  assert.equal(corrected.rawAnswer, "저는 리엑트를 씁니다."); // 보정이 있었으므로 원문 노출

  const unchanged = toInterviewRecord({
    question: { id: 2, question: "Q" },
    transcript: "보정할 게 없는 답변",
    rawTranscript: "보정할 게 없는 답변",
  });
  assert.equal(unchanged.rawAnswer, ""); // 동일하면 원문을 따로 두지 않음

  const noRaw = toInterviewRecord({ question: { id: 3 }, transcript: "답변" });
  assert.equal(noRaw.rawAnswer, "");
});
