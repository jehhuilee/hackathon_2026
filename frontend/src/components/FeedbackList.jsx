// 사이드바형 피드백 목록 패널 (본문 흐름에 포함된 우측 컬럼 — 띄우지 않음).
//   - 답변을 제출할 때마다 "이번 면접" 항목이 누적(append)된다.
//   - 각 항목은 클릭 가능하며 onSelect(record)로 상세 보기를 연다.

export default function FeedbackList({ records, collapsed, onToggleCollapse, onSelect }) {
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
        </div>
      )}
    </aside>
  );
}

const styles = {
  panel: {
    width: 320,
    flexShrink: 0,
    alignSelf: "flex-start",
    position: "sticky",
    top: 16,
    maxHeight: "calc(100vh - 32px)",
    display: "flex",
    flexDirection: "column",
    background: "var(--surface)",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    boxShadow: "var(--shadow)",
    overflow: "hidden",
  },
  panelCollapsed: { width: 56, alignItems: "center" },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid var(--border)",
  },
  title: { fontWeight: 800, fontSize: 15, color: "var(--text)" },
  toggle: {
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    borderRadius: 8,
    padding: "4px 9px",
    cursor: "pointer",
    fontSize: 13,
    color: "var(--muted)",
  },
  scroll: { overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 },
  sectionTitle: { fontSize: 12, color: "var(--primary-ink)", fontWeight: 800, letterSpacing: 0.2 },
  empty: { margin: 0, fontSize: 13, color: "var(--faint)" },
  item: {
    textAlign: "left",
    width: "100%",
    border: "1px solid var(--border)",
    background: "var(--surface-2)",
    borderRadius: 12,
    padding: "12px 14px",
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
    padding: "2px 9px",
    borderRadius: 999,
  },
  score: { fontSize: 17, fontWeight: 800, color: "var(--primary)" },
  itemQuestion: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--text)",
    lineHeight: 1.45,
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },
  itemCategory: { fontSize: 12, color: "var(--muted)" },
};
