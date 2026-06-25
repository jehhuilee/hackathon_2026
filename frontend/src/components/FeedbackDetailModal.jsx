// 피드백 목록 항목 클릭 시 해당 record의 질문 / 답변 / AI 피드백 상세.
// live 항목은 점수(evaluation)와 전사 보정(원문→보정)까지 함께 보여준다.

import ScoreDonut, { SCORE_COLORS } from "./ScoreDonut";

export default function FeedbackDetailModal({ record, onClose }) {
  if (!record) return null;

  const evaluation = record.evaluation;
  const badge = record.source === "past" ? "지난 면접" : "이번 면접";

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div className="card" style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.head}>
          <div style={styles.badges}>
            <span className="chip">{badge}</span>
            {record.category && <span style={styles.catChip}>{record.category}</span>}
          </div>
          <button type="button" onClick={onClose} style={styles.close} aria-label="닫기">
            ✕
          </button>
        </div>

        <h3 style={styles.question}>{record.question || "(질문 없음)"}</h3>

        {evaluation && (
          <div style={styles.scoreTop}>
            <div style={styles.scoreRow}>
              <ScoreDonut value={evaluation.total_score} label="종합" color={SCORE_COLORS.total} size={72} />
              <ScoreDonut value={evaluation.content_score} label="내용" color={SCORE_COLORS.content} size={72} />
              <ScoreDonut value={evaluation.structure_score} label="구조" color={SCORE_COLORS.structure} size={72} />
            </div>
            {(evaluation.strength || evaluation.weakness) && (
              <div style={styles.assess}>
                {evaluation.strength && (
                  <div style={styles.assessLine}>
                    <span style={styles.assessHeadGood}>강점</span>
                    <span className="chip chip-good">{evaluation.strength}</span>
                  </div>
                )}
                {evaluation.weakness && (
                  <div style={styles.assessLine}>
                    <span style={styles.assessHeadWarn}>개선점</span>
                    <span className="chip chip-warn">{evaluation.weakness}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {record.rawAnswer ? (
          <>
            <Field label="음성 인식 원문">
              <span style={styles.rawText}>{record.rawAnswer}</span>
            </Field>
            <Field label="AI 보정 답변 (평가 기준)">
              {record.answer || <em style={styles.muted}>(답변 기록 없음)</em>}
            </Field>
          </>
        ) : (
          <Field label="내 답변">
            {record.answer ? record.answer : <em style={styles.muted}>(답변 기록 없음)</em>}
          </Field>
        )}

        <div style={styles.feedbackBlock}>
          <span style={styles.feedbackLabel}>🤖 AI 피드백</span>
          {record.feedback ? record.feedback : <em style={styles.muted}>(피드백 없음)</em>}
        </div>

        {evaluation?.sample_answer && (
          <details style={styles.details}>
            <summary style={styles.summary}>💡 모범 답안 보기</summary>
            <p style={styles.sample}>{evaluation.sample_answer}</p>
          </details>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={styles.field}>
      <div style={styles.fieldLabel}>{label}</div>
      <div style={styles.fieldValue}>{children}</div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(20, 16, 50, 0.5)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 100,
  },
  modal: {
    width: "100%",
    maxWidth: 600,
    maxHeight: "88vh",
    overflowY: "auto",
    padding: 28,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  badges: { display: "flex", gap: 8 },
  catChip: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--muted)",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    padding: "4px 11px",
    borderRadius: 999,
  },
  close: {
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    borderRadius: 8,
    padding: "5px 11px",
    cursor: "pointer",
    fontSize: 14,
    color: "var(--muted)",
  },
  question: { margin: 0, color: "var(--text)", fontSize: 19, fontWeight: 800, lineHeight: 1.4 },
  scoreTop: {
    display: "flex",
    gap: 24,
    alignItems: "center",
    flexWrap: "wrap",
    padding: "8px 0 12px",
    borderBottom: "1px solid var(--border)",
  },
  scoreRow: { display: "flex", gap: 24, flexShrink: 0 },
  assess: { flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 8 },
  assessLine: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  assessHeadGood: { fontSize: 13, fontWeight: 800, color: "var(--success)", minWidth: 40 },
  assessHeadWarn: { fontSize: 13, fontWeight: 800, color: "var(--warn)", minWidth: 40 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: 800, color: "var(--muted)" },
  fieldValue: {
    fontSize: 15,
    color: "var(--text)",
    lineHeight: 1.7,
    whiteSpace: "pre-wrap",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "12px 14px",
  },
  rawText: { color: "var(--faint)", textDecoration: "line-through" },
  muted: { color: "var(--faint)" },
  feedbackBlock: {
    fontSize: 15,
    lineHeight: 1.7,
    color: "var(--text)",
    background: "var(--primary-soft)",
    borderRadius: 12,
    padding: "14px 16px",
  },
  feedbackLabel: { display: "block", fontSize: 13, fontWeight: 800, color: "var(--primary-ink)", marginBottom: 6 },
  details: { marginTop: 2 },
  summary: { cursor: "pointer", fontWeight: 700, color: "var(--text)" },
  sample: { color: "var(--text)", lineHeight: 1.7, marginTop: 8 },
};
