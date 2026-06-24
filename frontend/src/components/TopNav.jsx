// 상단 네비게이션 바 (브랜드 + 좌/중/우 슬롯). 화면마다 가운데/오른쪽 내용만 갈아끼운다.

export function Brand() {
  return (
    <div style={styles.brand}>
      <div style={styles.mark}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="8" r="4" fill="#fff" />
          <path d="M4 20.5C4 16.4 7.6 14 12 14s8 2.4 8 6.5" fill="#fff" />
        </svg>
      </div>
      <span style={styles.brandText}>AI 면접</span>
    </div>
  );
}

export default function TopNav({ center, right }) {
  return (
    <header style={styles.nav}>
      <div style={styles.inner}>
        <Brand />
        <div style={styles.center}>{center}</div>
        <div style={styles.right}>{right}</div>
      </div>
    </header>
  );
}

const styles = {
  nav: {
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    position: "sticky",
    top: 0,
    zIndex: 40,
  },
  inner: {
    maxWidth: 1320,
    margin: "0 auto",
    height: 64,
    padding: "0 24px",
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  brand: { display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
  mark: {
    width: 34,
    height: 34,
    borderRadius: 10,
    background: "var(--primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 10px rgba(108,92,231,0.35)",
  },
  brandText: { fontWeight: 800, fontSize: 18, color: "var(--text)" },
  center: { flex: 1, display: "flex", justifyContent: "center", gap: 6 },
  right: { display: "flex", alignItems: "center", gap: 12, flexShrink: 0 },
};
