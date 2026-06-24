// D1: pure mapping helpers that translate the existing AI integration's shapes
// (submitAnswer / getReport responses) into the UI's InterviewRecord shape.
//
// These are intentionally free of any network/import.meta dependency so they
// can be unit-tested in plain Node (the live integration itself is exercised
// through feedbackService, which delegates straight to services/api.js).

// The feedback shown to the candidate is the (detailed) improvement text. We no
// longer surface "강점" — it tended to feel forced/boilerplate — so this returns
// the improvement, falling back to the one-line weakness when improvement is empty.
export function summarizeEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== "object") return "";
  return String(evaluation.improvement || evaluation.weakness || "").trim();
}

// Build a normalized InterviewRecord from an answer-feedback result. `question`
// is the current question object ({ id, question, ... }); `transcript` is the
// AI-corrected text used for scoring, `rawTranscript` the pre-correction STT
// text. `rawAnswer` is only set when correction actually changed something, so
// the UI can show 원문 → 보정. Missing pieces degrade to "" rather than throwing.
export function toInterviewRecord({ question, transcript, rawTranscript, evaluation } = {}) {
  const q = question || {};
  const answer = transcript || "";
  const raw = (rawTranscript || "").trim();
  return {
    id: q.id ?? q.question_id ?? null,
    question: q.question || q.title || "",
    answer,
    rawAnswer: raw && raw !== answer ? raw : "",
    feedback: summarizeEvaluation(evaluation),
    evaluation: evaluation || null,
    category: q.category || "",
    source: "live",
  };
}
