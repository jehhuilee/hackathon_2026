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
export async function submitAnswer({ questionId, audioBlob, voiceMetrics, poseMetrics }) {
  const form = new FormData();
  form.append("question_id", String(questionId));
  form.append("audio", audioBlob, "answer.webm");
  form.append("voice_metrics", JSON.stringify(voiceMetrics || {}));
  form.append("pose_metrics", JSON.stringify(poseMetrics || {}));

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

export { BASE_URL };
