import { useState } from "react";
import SetupForm from "./components/SetupForm";
import DeviceCheck from "./components/DeviceCheck";
import InterviewSession from "./components/InterviewSession";
import ReportView from "./components/ReportView";
import TopNav from "./components/TopNav";

// Top-level flow: setup -> ready(device check) -> interview -> report
function App() {
  const [stage, setStage] = useState("setup");
  const [session, setSession] = useState(null);
  const [sessionId, setSessionId] = useState(null);

  const handleSessionCreated = (result) => {
    setSession(result);
    setStage("ready");
  };
  const handleDeviceReady = () => setStage("interview");
  const handleComplete = (id) => {
    setSessionId(id);
    setStage("report");
  };
  const handleRestart = () => {
    setSession(null);
    setSessionId(null);
    setStage("setup");
  };

  // The interview screen is full-bleed (own progress header); the others sit
  // under the shared top navigation inside a centered content area.
  if (stage === "interview") {
    return <InterviewSession session={session} onComplete={handleComplete} />;
  }

  return (
    <div style={styles.shell}>
      {stage === "setup" && (
        <>
          <TopNav
            center={
              <>
                <span style={{ ...styles.tab, ...styles.tabActive }}>면접 설정</span>
                <span style={styles.tab}>면접 기록</span>
              </>
            }
            right={
              <span style={styles.userChip}>
                <span style={styles.userAvatar}>나</span> 면접 준비생
              </span>
            }
          />
          <main style={styles.main}>
            <SetupForm onReady={handleSessionCreated} />
          </main>
        </>
      )}

      {stage === "ready" && (
        <>
          <TopNav
            right={
              session && (
                <span style={styles.contextPill}>
                  ● {session.job_role || "면접"} {session.company ? `· ${session.company}` : ""}
                </span>
              )
            }
          />
          <main style={styles.main}>
            <DeviceCheck onReady={handleDeviceReady} />
          </main>
        </>
      )}

      {stage === "report" && (
        <>
          <TopNav
            right={
              <button type="button" className="btn btn-primary" onClick={handleRestart}>
                + 새 면접 시작
              </button>
            }
          />
          <main style={styles.main}>
            <ReportView sessionId={sessionId} onRestart={handleRestart} />
          </main>
        </>
      )}
    </div>
  );
}

const styles = {
  shell: { minHeight: "100vh", background: "var(--bg)" },
  main: { maxWidth: 1320, margin: "0 auto", padding: "32px 24px 56px" },
  tab: {
    padding: "8px 16px",
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 700,
    color: "var(--muted)",
    cursor: "default",
  },
  tabActive: { background: "var(--primary-soft)", color: "var(--primary-ink)" },
  userChip: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    fontWeight: 700,
    color: "var(--text)",
  },
  userAvatar: {
    width: 30,
    height: 30,
    borderRadius: "50%",
    background: "var(--primary-soft)",
    color: "var(--primary-ink)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    fontWeight: 800,
  },
  contextPill: {
    background: "var(--primary-soft)",
    color: "var(--primary-ink)",
    padding: "8px 14px",
    borderRadius: 999,
    fontSize: 14,
    fontWeight: 700,
  },
};

export default App;
