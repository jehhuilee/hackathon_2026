// 사이드바형 피드백 목록 패널 (본문 흐름에 포함된 우측 컬럼 — 띄우지 않음).
//   - 답변을 제출할 때마다 "이번 면접" 항목이 누적(append)된다.
//   - 각 항목은 클릭 가능하며 onSelect(record)로 상세 보기를 연다.

export default function FeedbackList({ records, pastRecords = [], collapsed, onToggleCollapse, onSelect }) {
  return (
    <aside style={{ ...styles.panel, ...(collapsed ? styles.panelCollapsed : {}) }}>
      <div style={styles.head}>
        {!collapsed && <span style={styles.title}>📋 피드백 목록</span>}
        <button type="button" onClick={onToggleCollapse} style={styles.toggle} aria-label="접기">
          {collapsed ? "📋" : "✕"}
        </button>
      </div>

      {!collapsed && (
        <div style={styles.scroll}>
          <div style={styles.sectionTitle}>이번 면접 ({records.length})</div>
          {records.length === 0 ? (
            <p style={styles.empty}>아직 제출한 답변이 없습니다.</p>
          ) : (
            records.map((record, i) => {
              const score = record.evaluation?.total_score;
              return (
                <button
                  type="button"
                  key={`${record.id}-${i}`}
                  onClick={() => onSelect(record)}
                  style={styles.item}
                >
                  <div style={styles.itemTop}>
                    <span style={styles.qBadge}>Q{i + 1} 완료</span>
                    {score != null && <span style={styles.score}>{score}점</span>}
                  </div>
                  <div style={styles.itemQuestion}>{record.question || "(질문 없음)"}</div>
                  {record.category && <div style={styles.itemCategory}>{record.category}</div>}
                </button>
              );
            })
          )}

          {pastRecords.length > 0 && (
            <>
              <div style={{ ...styles.sectionTitle, marginTop: 6, color: "var(--muted)" }}>
                지난 면접 기록
              </div>
              {pastRecords.map((record) => (
                <button
                  type="button"
                  key={record.id}
                  onClick={() => onSelect(record)}
                  style={styles.pastItem}
                >
                  <div style={styles.itemTop}>
                    <span style={styles.pastCompany}>
                      {record.company} · {record.role}
                    </span>
                    {record.evaluation?.total_score != null && (
                      <span style={styles.pastScore}>{record.evaluation.total_score}점</span>
                    )}
                  </div>
                  <div style={styles.itemCategory}>
                    {record.date} · {record.category}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

const styles = {
  panel: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    height: "100%",
  },
  panelCollapsed: { alignItems: "center" },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "15px 18px",
    borderBottom: "1px solid var(--border)",
    background: "var(--surface)",
  },
  title: { fontWeight: 800, fontSize: 15, color: "var(--text)" },
  toggle: {
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    borderRadius: 8,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
    color: "var(--muted)",
  },
  scroll: { overflowY: "auto", padding: "14px 14px 20px", display: "flex", flexDirection: "column", gap: 8 },
  sectionTitle: { fontSize: 11, color: "var(--primary-ink)", fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", padding: "4px 2px" },
  empty: { margin: 0, fontSize: 13, color: "var(--faint)", padding: "4px 2px" },
  item: {
    textAlign: "left",
    width: "100%",
    border: "1px solid var(--border)",
    background: "var(--surface-2)",
    borderRadius: 12,
    padding: "13px 15px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  itemTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  qBadge: {
    fontSize: 11,
    fontWeight: 800,
    color: "var(--success)",
    background: "var(--success-soft)",
    padding: "3px 10px",
    borderRadius: 999,
  },
  score: { fontSize: 18, fontWeight: 800, color: "var(--primary)" },
  itemQuestion: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text)",
    lineHeight: 1.5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },
  itemCategory: { fontSize: 12, color: "var(--muted)" },
  pastItem: {
    textAlign: "left",
    width: "100%",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    borderRadius: 12,
    padding: "13px 15px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  pastCompany: { fontSize: 13, fontWeight: 700, color: "var(--text)" },
  pastScore: { fontSize: 16, fontWeight: 800, color: "var(--muted)" },
};
