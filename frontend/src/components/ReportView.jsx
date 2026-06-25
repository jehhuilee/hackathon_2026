import { useEffect, useRef, useState } from "react";
import { getReport, streamOverallFeedback } from "../services/api";
import ScoreDonut from "./ScoreDonut";

// Extract the overall_feedback text progressively from a partial JSON stream.
// Works because overall_feedback is always the first key in the JSON object.
function extractStreamingText(raw) {
  const markerIdx = raw.indexOf('"overall_feedback"');
  if (markerIdx === -1) return null;
  const afterMarker = raw.slice(markerIdx + '"overall_feedback"'.length);
  const colonQuote = afterMarker.match(/^\s*:\s*"/);
  if (!colonQuote) return null;
  const content = afterMarker.slice(colonQuote[0].length);
  return content.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export default function ReportView({ sessionId, onRestart }) {
  const [report, setReport] = useState(null);
  const [overall, setOverall] = useState(null);
  const [streamRaw, setStreamRaw] = useState(""); // accumulated raw LLM tokens
  const [error, setError] = useState("");
  const [overallError, setOverallError] = useState("");
  const esRef = useRef(null);

  useEffect(() => {
    let alive = true;

    getReport(sessionId)
      .then((data) => alive && setReport(data))
      .catch((err) => alive && setError(`리포트를 불러오지 못했습니다: ${err.message}`));

    esRef.current = streamOverallFeedback(sessionId, {
      onChunk: (text) => alive && setStreamRaw((prev) => prev + text),
      onDone: (data) => {
        if (alive) {
          setOverall(data);
          setStreamRaw(""); // structured data is now available; clear raw buffer
        }
      },
      onError: (err) => alive && setOverallError(`종합 피드백 생성 실패: ${err.message}`),
    });

    return () => {
      alive = false;
      esRef.current?.close();
    };
  }, [sessionId]);

  if (error) return <p style={styles.error}>{error}</p>;
  if (!report) return <p style={styles.loading}>리포트를 불러오는 중...</p>;

  const answeredItems = (report.items || []).filter((it) => it.evaluation);

  // Progressive text shown while streaming; switches to structured data on done.
  const streamingText = streamRaw ? extractStreamingText(streamRaw) : null;
  const feedbackText = overall?.overall_feedback ?? streamingText;
  const isStreaming = !overall && !overallError;

  return (
    <div style={styles.container}>
      <div className="card" style={styles.summary}>
        <ScoreDonut value={report.average_score ?? 0} label="평균 점수" size={108} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={styles.h1}>면접 결과 리포트</h1>
          <div style={styles.metaChips}>
            <span className="chip">💼 {report.session.job_role || "-"}</span>
            {report.session.company && <span className="chip">🏢 {report.session.company}</span>}
            <span className="chip chip-good">
              ✓ {report.answered_count} / {report.items.length} 완료
            </span>
          </div>
        </div>
      </div>

      {answeredItems.length > 0 && (
        <div style={styles.scoreOverview}>
          {answeredItems.map((item, i) => (
            <div key={item.question.id} style={styles.scoreChip} title={item.question.question}>
              <span style={styles.chipQ}>Q{i + 1}</span>
              <span style={styles.chipScore}>{item.evaluation.total_score}</span>
            </div>
          ))}
        </div>
      )}

      <h2 style={styles.sectionHeading}>종합 피드백</h2>
      {overallError && <p style={styles.error}>{overallError}</p>}

      {!overallError && (
        <div className="card" style={styles.overallCard}>
          {feedbackText ? (
            <p style={styles.overallText}>
              {feedbackText}
              {isStreaming && <span style={styles.cursor}>▌</span>}
            </p>
          ) : (
            <p style={styles.loading}>종합 피드백을 생성하는 중입니다...</p>
          )}

          {overall?.improvement_priorities?.length > 0 && (
            <div style={styles.subBlock}>
              <h3 style={styles.subHeading}>🎯 개선 우선순위</h3>
              <ol style={styles.priorityList}>
                {overall.improvement_priorities.map((p, i) => (
                  <li key={i} style={styles.priorityItem}>
                    {p}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {overall?.action_plan && (
            <div style={styles.subBlock}>
              <h3 style={styles.subHeading}>🚀 다음 면접까지의 실행 계획</h3>
              <p style={styles.actionText}>{overall.action_plan}</p>
            </div>
          )}
        </div>
      )}

      <button type="button" onClick={onRestart} className="btn btn-primary" style={styles.restart}>
        + 새 면접 시작
      </button>
    </div>
  );
}

const styles = {
  container: { maxWidth: 860, margin: "0 auto" },
  loading: { textAlign: "center", color: "var(--muted)", padding: 24 },
  error: { color: "var(--danger)", fontWeight: 600 },
  summary: { display: "flex", gap: 28, alignItems: "center", padding: 28, marginBottom: 20, flexWrap: "wrap" },
  h1: { margin: "0 0 12px", fontSize: 26, fontWeight: 800 },
  metaChips: { display: "flex", gap: 8, flexWrap: "wrap" },
  scoreOverview: { display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 },
  scoreChip: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    minWidth: 60,
    padding: "10px 12px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "var(--shadow-sm)",
  },
  chipQ: { fontSize: 12, color: "var(--muted)", fontWeight: 700 },
  chipScore: { fontSize: 22, fontWeight: 800, color: "var(--primary)" },
  sectionHeading: { margin: "0 0 12px", fontSize: 20, fontWeight: 800 },
  overallCard: { padding: 26, marginBottom: 24, display: "flex", flexDirection: "column", gap: 18 },
  overallText: { margin: 0, fontSize: 15, lineHeight: 1.85, color: "var(--text)", whiteSpace: "pre-wrap" },
  cursor: { display: "inline-block", animation: "blink 1s step-end infinite", marginLeft: 2 },
  subBlock: { borderTop: "1px solid var(--border)", paddingTop: 16 },
  subHeading: { margin: "0 0 10px", fontSize: 15, fontWeight: 800, color: "var(--primary-ink)" },
  priorityList: { margin: 0, paddingLeft: 20, display: "grid", gap: 8 },
  priorityItem: { fontSize: 15, lineHeight: 1.6, color: "var(--text)" },
  actionText: { margin: 0, fontSize: 15, lineHeight: 1.85, color: "var(--text)", whiteSpace: "pre-wrap" },
  skipped: { color: "var(--faint)" },
  restart: { width: "100%", padding: "15px", fontSize: 16 },
};
