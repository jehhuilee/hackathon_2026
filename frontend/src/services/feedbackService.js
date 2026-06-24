// D1: thin façade over the EXISTING AI feedback integration (services/api.js).
//
// Terminology — two distinct things, do not conflate:
//   · 실시간 코칭 (live coaching): pointed out WHILE the candidate is speaking
//     (gaze/speed/silence/posture). Lives entirely in the frontend as toasts
//     over the video (useToastQueue + LiveFeedbackToasts) — NOT here.
//   · 실시간 피드백 (answer feedback): produced AFTER the answer ends — the AI
//     transcribes, corrects context-specific misreads (e.g. 리엑트 → React),
//     then scores/critiques the answer. That is `getAnswerFeedback` below.
//
// Escape hatch: if a real call fails the error propagates to the caller, which
// surfaces it in the UI — we do NOT silently swap in mock data.

import { submitAnswer, getReport } from "./api";
import { toInterviewRecord, summarizeEvaluation } from "./feedbackMapping";

// Post-answer AI feedback. Delegates to the existing submitAnswer integration,
// which runs STT → context-aware transcript correction → evaluation on the
// backend. Returns { answer_id, question_id, transcript, raw_transcript, evaluation }.
export async function getAnswerFeedback(params) {
  return submitAnswer(params);
}

// Aggregated/summary feedback for the whole session. Maps onto the existing
// getReport integration: returns { session, items, average_score, answered_count }.
export async function getSummaryFeedback(sessionId) {
  return getReport(sessionId);
}

export { toInterviewRecord, summarizeEvaluation };
