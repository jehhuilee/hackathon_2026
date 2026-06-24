// 종합 피드백 뷰. "종합 피드백 보기" 버튼으로 진입한다.
// 데이터는 기존 AI 연동을 매핑한 getSummaryFeedback(sessionId)로 가져온다
// (= 백엔드 getReport). "면접으로 돌아가기"로 면접 화면에 복귀한다.

import { useEffect, useState } from "react";
import { getSummaryFeedback } from "../services/feedbackService";
import ScoreDonut, { SCORE_COLORS } from "./ScoreDonut";

export default function SummaryFeedbackView({ sessionId, onBack, onFinish }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    getSummaryFeedback(sessionId)
      .then((data) => alive && setReport(data))
      .catch((err) => alive && setError(`종합 피드백을 불러오지 못했습니다: ${err.message}`));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const answered = (report?.items || []).filter((it) => it.evaluation);
  const avgContent = answered.length
    ? Math.round(answered.reduce((s, it) => s + (it.evaluation.content_score || 0), 0) / answered.length)
    : "-";
  const avgStructure = answered.length
    ? Math.round(answered.reduce((s, it) => s + (it.evaluation.structure_score || 0), 0) / answered.length)
    : "-";

  return (
    <div style={styles.shell}>
      <div style={styles.container}>
        <div style={styles.topBar}>
          <button type="button" onClick={onBack} className="btn btn-ghost">
            ← 면접으로 돌아가기
          </button>
          {onFinish && (
            <button type="button" onClick={onFinish} className="btn btn-primary">
              전체 리포트 보기 →
            </button>
          )}
        </div>

        {error && <p style={styles.error}>{error}</p>}
        {!report && !error && <p style={styles.loading}>종합 피드백을 생성하는 중...</p>}

        {report && (
          <>
            <div className="card" style={styles.summaryCard}>
              <ScoreDonut value={report.average_score ?? 0} label="평균 점수" size={108} />
              <div style={styles.summaryMid}>
                <h1 style={styles.heading}>면접 세션 종합 리뷰</h1>
                <div style={styles.metaChips}>
                  <span className="chip">💼 {report.session?.job_role || "-"}</span>
                  {report.session?.company && <span className="chip">🏢 {report.session.company}</span>}
                  <span className="chip chip-good">
                    ✓ {report.answered_count} / {report.items?.length ?? 0} 완료
                  </span>
                </div>
              </div>
              <div style={styles.summaryRight}>
                <div style={styles.miniScore}>
                  <span style={{ ...styles.miniNum, color: SCORE_COLORS.content }}>{avgContent}</span>
                  <span style={styles.miniLabel}>내용</span>
                </div>
                <div style={styles.miniScore}>
                  <span style={{ ...styles.miniNum, color: SCORE_COLORS.structure }}>{avgStructure}</span>
                  <span style={styles.miniLabel}>구조</span>
                </div>
              </div>
            </div>

            {(report.items || []).map((item, i) => (
              <div key={item.question.id} className="card" style={styles.qCard}>
                {item.evaluation ? (
                  <>
                    <div style={styles.qHead}>
                      <span style={styles.qBadge}>Q{i + 1}</span>
                      <div style={{ flex: 1 }}>
                        <div style={styles.qTitle}>{item.question.question}</div>
                        {item.question.category && (
                          <div style={styles.qCategory}>{item.question.category}</div>
                        )}
                      </div>
                      <div style={styles.qScore}>
                        {item.evaluation.total_score}
                        <span style={styles.qScoreUnit}>점</span>
                      </div>
                    </div>

                    {item.answer?.transcript && (
                      <p style={styles.answerText}>{item.answer.transcript}</p>
                    )}

                    <div style={styles.feedbackBlock}>
                      <span style={styles.feedbackLabel}>피드백</span>
                      {item.evaluation.improvement || item.evaluation.weakness || "피드백이 생성되지 않았습니다."}
                    </div>
                  </>
                ) : (
                  <div style={styles.qHead}>
                    <span style={{ ...styles.qBadge, background: "var(--border)", color: "var(--faint)" }}>
                      Q{i + 1}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ ...styles.qTitle, color: "var(--faint)" }}>{item.question.question}</div>
                      <div style={styles.qCategory}>답변하지 않은 질문입니다.</div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  shell: { minHeight: "100vh", background: "var(--bg)" },
  container: { maxWidth: 900, margin: "0 auto", padding: "24px 24px 56px" },
  topBar: { display: "flex", justifyContent: "space-between", marginBottom: 20, gap: 12 },
  loading: { textAlign: "center", color: "var(--muted)" },
  error: { color: "var(--danger)", fontWeight: 600 },
  summaryCard: { display: "flex", gap: 28, alignItems: "center", padding: 28, marginBottom: 20, flexWrap: "wrap" },
  summaryMid: { flex: 1, minWidth: 220 },
  heading: { margin: "0 0 12px", fontSize: 26, fontWeight: 800 },
  metaChips: { display: "flex", gap: 8, flexWrap: "wrap" },
  summaryRight: { display: "flex", gap: 24 },
  miniScore: { display: "flex", flexDirection: "column", alignItems: "center" },
  miniNum: { fontSize: 30, fontWeight: 800 },
  miniLabel: { fontSize: 13, color: "var(--muted)", fontWeight: 600 },
  qCard: { padding: 20, marginBottom: 14, display: "flex", flexDirection: "column", gap: 12 },
  qHead: { display: "flex", alignItems: "center", gap: 14 },
  qBadge: {
    width: 40,
    height: 40,
    borderRadius: 10,
    background: "var(--primary-soft)",
    color: "var(--primary-ink)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 800,
    fontSize: 14,
    flexShrink: 0,
  },
  qTitle: { fontWeight: 700, fontSize: 16, color: "var(--text)", lineHeight: 1.4 },
  qCategory: { fontSize: 13, color: "var(--muted)", marginTop: 2 },
  qScore: { fontSize: 28, fontWeight: 800, color: "var(--primary)", flexShrink: 0 },
  qScoreUnit: { fontSize: 14, marginLeft: 1 },
  answerText: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.7,
    color: "#3b3f4a",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "12px 14px",
    whiteSpace: "pre-wrap",
  },
  feedbackBlock: {
    fontSize: 15,
    lineHeight: 1.7,
    color: "var(--text)",
    background: "var(--warn-soft)",
    borderLeft: "3px solid var(--warn)",
    borderRadius: 10,
    padding: "12px 14px",
  },
  feedbackLabel: { display: "block", fontSize: 12, fontWeight: 800, color: "var(--warn)", marginBottom: 4 },
};
