import { useEffect, useRef, useState } from "react";
import { useRecorder } from "../hooks/useRecorder";
import { AudioFeedbackStream } from "../services/audioStream";
import { submitAnswer } from "../services/api";

const ALERT_LABELS = {
  TOO_FAST: "말이 빨라지고 있어요",
  PITCH_UNSTABLE: "목소리 떨림이 큽니다",
  LONG_SILENCE: "침묵이 길어지고 있어요",
};

const PERSONA_LABELS = {
  A: "친근한 면접관 (널널한 기준)",
  B: "표준 면접관 (보통 기준)",
  C: "엄격한 면접관 (빡빡한 기준)",
};

// Drives the per-question interview: live video+audio coaching, record an
// answer, upload it for transcription + evaluation, then advance.
export default function InterviewSession({ session, onComplete }) {
  const recorder = useRecorder();
  const audioStreamRef = useRef(null);

  const [index, setIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [audioAlert, setAudioAlert] = useState("");
  const [voiceMetrics, setVoiceMetrics] = useState(null);
  const [error, setError] = useState("");

  const questions = session.questions;
  const current = questions[index];

  useEffect(() => {
    recorder.startCamera().catch(() => setError("카메라/마이크 접근에 실패했습니다."));
    return () => recorder.stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStart = () => {
    setLastResult(null);
    setAudioAlert("");
    setVoiceMetrics(null);
    setError("");
    recorder.startRecording();
    const stream = recorder.mediaStreamRef.current;
    if (stream) {
      audioStreamRef.current = new AudioFeedbackStream({
        onAlert: (msg) => setAudioAlert(ALERT_LABELS[msg.event] || msg.event),
        onStatus: (status) => setVoiceMetrics(status),
        onError: (err) => setError(err.message),
        persona: session.persona,
      });
      audioStreamRef.current.start(stream);
    }
  };

  const handleStop = async () => {
    setSubmitting(true);
    setError("");
    try {
      const recording = await recorder.stopRecording();
      const voiceMetrics = audioStreamRef.current?.getVoiceSummary() || {};
      await audioStreamRef.current?.stop();
      audioStreamRef.current = null;

      const result = await submitAnswer({
        questionId: current.id,
        audioBlob: recording.blob,
        voiceMetrics,
        poseMetrics: recording.poseSummary,
      });
      setLastResult(result);
    } catch (err) {
      setError(`답변 처리에 실패했습니다: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => {
    if (index + 1 >= questions.length) {
      onComplete(session.session_id);
    } else {
      setIndex(index + 1);
      setLastResult(null);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.counter}>
          질문 {index + 1} / {questions.length}
        </span>
        <span style={styles.category}>{current.category}</span>
      </div>

      <h2 style={styles.question}>{current.question}</h2>

      <div style={styles.stage}>
        <div style={styles.videoWrap}>
          <video ref={recorder.videoRef} autoPlay muted playsInline style={styles.video} />
          {recorder.isRecording && <span style={styles.recDot}>● REC</span>}
        </div>

        <div style={styles.feedbackPanel}>
          <h3>실시간 피드백</h3>
          <p style={styles.personaTag}>
            🎯 {PERSONA_LABELS[session.persona] || PERSONA_LABELS.B}
          </p>
          <p style={styles.feedbackText}>{recorder.liveFeedback}</p>
          {audioAlert && <p style={styles.audioAlert}>🔊 {audioAlert}</p>}
          <div style={styles.metrics}>
            <div>얼굴 감지: {recorder.liveMetrics.faceVisible ? "O" : "X"}</div>
            <div>상체 움직임: {recorder.liveMetrics.postureMovement}</div>
            <div>손동작량: {recorder.liveMetrics.handMovement}</div>
            <div>어깨 기울기: {recorder.liveMetrics.shoulderTilt}</div>
            {voiceMetrics && (
              <>
                <div>말 빠르기: {voiceMetrics.syllables_per_second?.toFixed(1)} 음절/초</div>
                <div>평균 피치: {voiceMetrics.pitch_mean_hz?.toFixed(0)} Hz</div>
                <div>최장 침묵: {voiceMetrics.longest_silence_seconds?.toFixed(1)} 초</div>
              </>
            )}
          </div>
        </div>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {!lastResult ? (
        <div style={styles.controls}>
          {!recorder.isRecording ? (
            <button
              onClick={handleStart}
              disabled={!recorder.isCameraOn || submitting}
              style={styles.primary}
            >
              답변 녹화 시작
            </button>
          ) : (
            <button onClick={handleStop} disabled={submitting} style={styles.stopBtn}>
              {submitting ? "분석 중..." : "답변 종료 및 분석"}
            </button>
          )}
        </div>
      ) : (
        <ResultCard result={lastResult} onNext={handleNext} isLast={index + 1 >= questions.length} />
      )}
    </div>
  );
}

function ResultCard({ result, onNext, isLast }) {
  const { transcript, evaluation } = result;
  return (
    <div style={styles.resultCard}>
      <h3>이번 답변 결과</h3>
      <p style={styles.transcript}>
        <strong>전사:</strong> {transcript || "(인식된 음성이 없습니다)"}
      </p>
      <div style={styles.scoreRow}>
        <Score label="종합" value={evaluation.total_score} />
        <Score label="내용" value={evaluation.content_score} />
        <Score label="구조" value={evaluation.structure_score} />
      </div>
      <p>
        <strong>강점:</strong> {evaluation.strength}
      </p>
      <p>
        <strong>개선점:</strong> {evaluation.improvement}
      </p>
      <button onClick={onNext} style={styles.primary}>
        {isLast ? "결과 리포트 보기" : "다음 질문"}
      </button>
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
  container: { maxWidth: 960, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  counter: { fontWeight: 700, color: "#2563eb" },
  category: { color: "#52616f", fontSize: 14 },
  question: { margin: "8px 0 20px" },
  stage: { display: "flex", gap: 20, flexWrap: "wrap" },
  videoWrap: { position: "relative" },
  video: { width: 520, height: 390, background: "black", borderRadius: 12 },
  recDot: {
    position: "absolute",
    top: 12,
    left: 12,
    color: "#fff",
    background: "rgba(214,69,69,0.85)",
    padding: "4px 8px",
    borderRadius: 6,
    fontWeight: 700,
    fontSize: 13,
  },
  feedbackPanel: {
    flex: 1,
    minWidth: 260,
    background: "#f8f8f8",
    borderRadius: 12,
    padding: 16,
  },
  personaTag: { fontSize: 13, fontWeight: 600, color: "#2563eb", margin: "0 0 8px" },
  feedbackText: { fontSize: 18, fontWeight: 700 },
  audioAlert: { color: "#d64545", fontWeight: 600 },
  metrics: { display: "grid", gap: 8, marginTop: 12, fontSize: 14 },
  controls: { marginTop: 20 },
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
  stopBtn: {
    padding: "12px 20px",
    borderRadius: 8,
    border: "none",
    background: "#d64545",
    color: "white",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
  },
  resultCard: {
    marginTop: 20,
    padding: 20,
    borderRadius: 12,
    background: "#f0f6ff",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  transcript: { color: "#1f2933" },
  scoreRow: { display: "flex", gap: 16 },
  score: { textAlign: "center" },
  scoreValue: { fontSize: 28, fontWeight: 800, color: "#2563eb" },
  scoreLabel: { fontSize: 13, color: "#52616f" },
  error: { color: "#d64545", fontWeight: 600 },
};
