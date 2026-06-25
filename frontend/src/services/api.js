// REST client for the interview gateway.
// Base URL comes from VITE_API_URL, defaulting to the local gateway.

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

async function handle(response) {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // non-JSON error body; keep status text
    }
    throw new Error(detail);
  }
  return response.json();
}

// Upload a resume/portfolio PDF and get its extracted plain text.
export async function extractResumePdf(file) {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch(`${BASE_URL}/api/resume/extract`, {
    method: "POST",
    body: form,
  });
  return handle(response); // { text, page_count, filename }
}

// Create an interview session and generate questions.
export async function createSession(profile) {
  const response = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  return handle(response);
}

// Upload a recorded answer (webm blob) + collected metrics; returns transcript + evaluation.
// recordingId links to pre-transcribed STT chunks on the server so the Whisper
// wait is skipped when chunks are available (they were uploaded during recording).
export async function submitAnswer({ questionId, audioBlob, voiceMetrics, poseMetrics, recordingId }) {
  const form = new FormData();
  form.append("question_id", String(questionId));
  form.append("audio", audioBlob, "answer.webm");
  form.append("voice_metrics", JSON.stringify(voiceMetrics || {}));
  form.append("pose_metrics", JSON.stringify(poseMetrics || {}));
  if (recordingId) form.append("recording_id", recordingId);

  const response = await fetch(`${BASE_URL}/api/answers`, {
    method: "POST",
    body: form,
  });
  return handle(response);
}

// Fetch the aggregated report for a session.
export async function getReport(sessionId) {
  const response = await fetch(`${BASE_URL}/api/sessions/${sessionId}/report`);
  return handle(response);
}

// Fetch the single comprehensive, session-wide feedback (LLM-synthesized).
// Returns { overall_feedback, improvement_priorities, action_plan, answered_count }.
export async function getOverallFeedback(sessionId) {
  const response = await fetch(`${BASE_URL}/api/sessions/${sessionId}/overall_feedback`);
  return handle(response);
}

// Stream the overall feedback via SSE.
// onChunk(text) fires for each raw LLM token; onDone(data) fires with the full
// structured result; onError(err) fires on failure. Returns the EventSource so
// the caller can .close() it on unmount.
export function streamOverallFeedback(sessionId, { onChunk, onDone, onError } = {}) {
  const es = new EventSource(`${BASE_URL}/api/sessions/${sessionId}/overall_feedback/stream`);
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "chunk") {
      onChunk?.(msg.text);
    } else if (msg.type === "done") {
      const { type: _t, ...data } = msg;
      onDone?.(data);
      es.close();
    } else if (msg.type === "error") {
      onError?.(new Error(msg.message || "stream error"));
      es.close();
    }
  };
  es.onerror = () => {
    onError?.(new Error("SSE connection failed"));
    es.close();
  };
  return es;
}

export { BASE_URL };
