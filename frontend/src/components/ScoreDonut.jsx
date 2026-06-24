// 점수 도넛 (conic-gradient 기반). 종합/내용/구조 점수를 시각화.

export default function ScoreDonut({ value, label, color = "var(--primary)", size = 64 }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const inner = size - 14;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: `conic-gradient(${color} ${v * 3.6}deg, var(--border) 0deg)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: inner,
            height: inner,
            borderRadius: "50%",
            background: "var(--surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 800,
            fontSize: Math.round(size * 0.3),
            color: "var(--text)",
          }}
        >
          {v}
        </div>
      </div>
      {label && <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>{label}</span>}
    </div>
  );
}

export const SCORE_COLORS = {
  total: "var(--primary)",
  content: "#16a34a",
  structure: "#d97706",
};
