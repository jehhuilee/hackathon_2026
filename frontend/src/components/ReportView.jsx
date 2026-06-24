import { useEffect, useState } from "react";
import { getReport } from "../services/api";

// Fetches and renders the aggregated session report: per-question scores,
// transcript, voice/pose metrics, and the model answer.
export default function ReportView({ sessionId, onRestart }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getReport(sessionId)
      .then(setReport)
      .catch((err) => setError(`리포트를 불러오지 못했습니다: ${err.message}`));
  }, [sessionId]);

  if (error) return <p style={styles.error}>{error}</p>;
  if (!report) return <p style={styles.loading}>리포트를 불러오는 중...</p>;

  return (
    <div style={styles.container}>
      <h1>면접 결과 리포트</h1>
      <div style={styles.summary}>
        <div>
          <div style={styles.bigScore}>{report.average_score ?? "-"}</div>
          <div style={styles.scoreLabel}>평균 점수</div>
        </div>
        <div style={styles.meta}>
          <div>직무: {report.session.job_role || "-"}</div>
          <div>회사: {report.session.company || "-"}</div>
          <div>
            답변 완료: {report.answered_count} / {report.items.length}
          </div>
        </div>
      </div>

      {report.items.map((item, i) => (
        <div key={item.question.id} style={styles.card}>
          <h3 style={styles.qTitle}>
            Q{i + 1}. {item.question.question}
          </h3>
          {item.answer ? (
            <>
              <p style={styles.transcript}>
                <strong>내 답변:</strong> {item.answer.transcript || "(음성 인식 없음)"}
              </p>
              {item.evaluation && (
                <>
                  <div style={styles.scoreRow}>
                    <Score label="종합" value={item.evaluation.total_score} />
                    <Score label="내용" value={item.evaluation.content_score} />
                    <Score label="구조" value={item.evaluation.structure_score} />
                  </div>
                  <p>
                    <strong>강점:</strong> {item.evaluation.strength}
                  </p>
                  <p>
                    <strong>약점:</strong> {item.evaluation.weakness}
                  </p>
                  <p>
                    <strong>개선점:</strong> {item.evaluation.improvement}
                  </p>
                  <details style={styles.details}>
                    <summary>모범 답안 보기</summary>
                    <p>{item.evaluation.sample_answer}</p>
                  </details>
                </>
              )}
              <MetricBlock title="음성 지표" metrics={item.answer.voice_metrics} />
              <MetricBlock title="자세 지표" metrics={item.answer.pose_metrics} />
            </>
          ) : (
            <p style={styles.skipped}>답변하지 않은 질문입니다.</p>
          )}
        </div>
      ))}

      <button onClick={onRestart} style={styles.primary}>
        새 면접 시작
      </button>
    </div>
  );
}

function MetricBlock({ title, metrics }) {
  const entries = Object.entries(metrics || {});
  if (!entries.length) return null;
  return (
    <div style={styles.metricBlock}>
      <strong>{title}</strong>
      <div style={styles.metricGrid}>
        {entries.map(([key, value]) => (
          <span key={key} style={styles.metricItem}>
            {key}: {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function Score({ label, value }) {
  return (
    <div style={styles.score}>
      <div style={styles.scoreValue}>{value}</div>
      <div style={styles.scoreLabel}>{label}</div>
    </div>
  );
}

const styles = {
  container: { maxWidth: 820, margin: "0 auto" },
  loading: { textAlign: "center", color: "#52616f" },
  error: { color: "#d64545", fontWeight: 600 },
  summary: {
    display: "flex",
    gap: 32,
    alignItems: "center",
    background: "#f0f6ff",
    padding: 24,
    borderRadius: 12,
    marginBottom: 24,
  },
  bigScore: { fontSize: 48, fontWeight: 800, color: "#2563eb", textAlign: "center" },
  meta: { display: "grid", gap: 6, color: "#1f2933" },
  card: {
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  qTitle: { margin: 0 },
  transcript: { color: "#1f2933" },
  scoreRow: { display: "flex", gap: 16 },
  score: { textAlign: "center" },
  scoreValue: { fontSize: 26, fontWeight: 800, color: "#2563eb" },
  scoreLabel: { fontSize: 13, color: "#52616f" },
  details: { marginTop: 4 },
  skipped: { color: "#94a3b8" },
  metricBlock: { fontSize: 13, color: "#52616f" },
  metricGrid: { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 4 },
  metricItem: { background: "#f1f5f9", padding: "4px 8px", borderRadius: 6 },
  primary: {
    padding: "12px 20px",
    borderRadius: 8,
    border: "none",
    background: "#2563eb",
    color: "white",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
  },
};
