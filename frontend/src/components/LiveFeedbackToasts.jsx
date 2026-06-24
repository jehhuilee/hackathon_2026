// 요구: 실시간 피드백을 "영상 위 오버레이 다이얼로그(토스트)"로 표시.
// - 페이드 인/아웃 (index.css의 keyframes)
// - 큐 구조: 새 토스트는 아래쪽에서 등장하고 스택이 위로 자라며, 가장 오래된
//   항목(맨 위)이 먼저 사라진다. 화면에는 최대 3개(useToastQueue가 보장).
// 영상 위에 얹히지만 pointer-events: none 으로 클릭을 방해하지 않는다.

const LEVEL_STYLE = {
  info: { background: "rgba(37,99,235,0.92)", icon: "💬" },
  warn: { background: "rgba(217,119,6,0.94)", icon: "⚠️" },
  danger: { background: "rgba(220,38,38,0.95)", icon: "👀" },
};

export default function LiveFeedbackToasts({ toasts }) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div style={styles.layer}>
      {/* 배열 순서 = 오래된 것(위) → 최신(아래). 컨테이너가 하단 정렬이라 위로 쌓인다. */}
      {toasts.map((toast) => {
        const level = LEVEL_STYLE[toast.level] || LEVEL_STYLE.info;
        return (
          <div
            key={toast.key}
            className={`live-toast${toast.leaving ? " leaving" : ""}`}
            style={{ ...styles.toast, background: level.background }}
          >
            <span style={styles.icon}>{level.icon}</span>
            <span style={styles.message}>{toast.message}</span>
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  layer: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    alignItems: "flex-end", // 우하단 정렬 (목업)
    gap: 8,
    padding: 16,
    pointerEvents: "none", // 영상/버튼 클릭 방해 금지
    zIndex: 5,
  },
  toast: {
    maxWidth: "92%",
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "#fff",
    padding: "8px 14px",
    borderRadius: 999,
    fontSize: 14,
    fontWeight: 700,
    boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
    backdropFilter: "blur(2px)",
  },
  icon: { fontSize: 15 },
  message: { lineHeight: 1.3 },
};
