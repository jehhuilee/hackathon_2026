import { useState } from "react";
import SetupForm from "./components/SetupForm";
import InterviewSession from "./components/InterviewSession";
import ReportView from "./components/ReportView";

// Top-level flow: setup -> interview -> report
function App() {
  const [stage, setStage] = useState("setup");
  const [session, setSession] = useState(null);
  const [sessionId, setSessionId] = useState(null);

  const handleReady = (result) => {
    setSession(result);
    setStage("interview");
  };

  const handleComplete = (id) => {
    setSessionId(id);
    setStage("report");
  };

  const handleRestart = () => {
    setSession(null);
    setSessionId(null);
    setStage("setup");
  };

  return (
    <div style={{ padding: 32, fontFamily: "Arial, sans-serif" }}>
      {stage === "setup" && <SetupForm onReady={handleReady} />}
      {stage === "interview" && (
        <InterviewSession session={session} onComplete={handleComplete} />
      )}
      {stage === "report" && (
        <ReportView sessionId={sessionId} onRestart={handleRestart} />
      )}
    </div>
  );
}

export default App;
