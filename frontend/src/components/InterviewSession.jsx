import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecorder } from "../hooks/useRecorder";
import { AudioFeedbackStream } from "../services/audioStream";
import InterviewerAvatar from "./InterviewerAvatar";
import { Speaker } from "../services/tts";
import { ReactionController } from "../services/avatarReactions";
// 실시간 피드백(답변 종료 후 AI 평가, 전사 보정 포함)은 feedbackService 경유.
// 실시간 코칭(발화 중 지적)은 아래 useToastQueue → 영상 위 토스트가 담당한다.
import { getAnswerFeedback, toInterviewRecord } from "../services/feedbackService";
import { useToastQueue } from "../hooks/useToastQueue";
import LiveFeedbackToasts from "./LiveFeedbackToasts";
import FeedbackList from "./FeedbackList";
import FeedbackDetailModal from "./FeedbackDetailModal";
import SummaryFeedbackView from "./SummaryFeedbackView";

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

// Persona-tuned TTS voice: A brighter/faster, C lower/slower (more pressure).
const PERSONA_VOICE = {
  A: { rate: 1.06, pitch: 1.15 },
  B: { rate: 1.0, pitch: 1.0 },
  C: { rate: 0.92, pitch: 0.85 },
};

// Local interviewer avatar (.glb in public/avatars) with ARKit + Oculus visemes.
const AVATAR_URL = import.meta.env.VITE_AVATAR_URL || "/avatars/avaturn.glb";

// Real-time mood (from the reaction controller's engagement score) → small badge.
const MOOD_BADGE = {
  encouraging: { emoji: "😊", label: "좋아요", color: "rgba(22,163,74,0.9)" },
  attentive: { emoji: "🙂", label: "경청 중", color: "rgba(37,99,235,0.9)" },
  thinking: { emoji: "💭", label: "기다리는 중", color: "rgba(99,102,241,0.9)" },
  concerned: { emoji: "🤔", label: "더 편하게", color: "rgba(217,119,6,0.9)" },
};

// Auto-driven interview: the interviewer reads each question, recording then
// starts automatically; the candidate only ends the answer (or the interview).
export default function InterviewSession({ session, onComplete }) {
  const recorder = useRecorder();
  const audioStreamRef = useRef(null);
  const answerActiveRef = useRef(false); // guards against double auto-start
  const advanceTimerRef = useRef(null);

  const [index, setIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [avatarSpeaking, setAvatarSpeaking] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [avatarMood, setAvatarMood] = useState("idle"); // live engagement → expression

  // Feedback UI state (layered on top of the interview flow).
  const [records, setRecords] = useState([]); // this session's accumulated feedback
  const [answeredIds, setAnsweredIds] = useState(() => new Set()); // completion gate
  const [listCollapsed, setListCollapsed] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [view, setView] = useState("interview"); // "interview" | "summary"

  // 실시간 코칭: 발화 중 지적(시선/말속도/침묵/손)을 영상 위 토스트로(최대 3개).
  // 답변 종료 후의 AI 점수/분석(실시간 피드백)은 이 채널에 넣지 않는다.
  const { toasts, push: pushCoaching, clear: clearCoaching } = useToastQueue();

  // Shared mouth state mutated by the Speaker and read by the avatar each frame.
  const mouthRef = useRef({ visemes: {}, amp: 0 });
  const speaker = useMemo(() => new Speaker(mouthRef.current), []);

  // Shared expression state: the ReactionController turns live candidate signals
  // into the interviewer's mood/nod; the avatar reads this object each frame.
  const expressionRef = useRef({
    smile: 0,
    browUp: 0,
    browDown: 0,
    eyeWide: 0,
    frown: 0,
    nodding: false,
    nodGain: 0,
    mood: "idle",
    engagement: 0,
  });
  const reactions = useMemo(
    () => new ReactionController(expressionRef.current, { onMood: setAvatarMood }),
    [],
  );

  const questions = session.questions;
  const current = questions[index];
  // The summary button is gated until every question has been answered.
  const allAnswered = questions.length > 0 && answeredIds.size >= questions.length;

  // Start recording + live audio analysis for the current question. Idempotent
  // per question via answerActiveRef so the avatar's onEnd and the safety timer
  // can't double-start. Kept in a ref so the auto-start effect has no stale deps.
  const beginAnswer = () => {
    if (answerActiveRef.current) return;
    if (!recorder.mediaStreamRef.current) return;
    answerActiveRef.current = true;
    setError("");
    clearCoaching();
    speaker.cancel(); // silence the interviewer so its voice isn't recorded
    setAvatarSpeaking(false);
    recorder.startRecording();
    reactions.setActive(true); // interviewer starts reacting to the candidate
    const stream = recorder.mediaStreamRef.current;
    if (stream) {
      audioStreamRef.current = new AudioFeedbackStream({
        onAlert: (msg) => pushCoaching(ALERT_LABELS[msg.event] || msg.event, "warn"),
        onStatus: (status) => reactions.setVoice(status), // feed live voice metrics
        onError: (err) => setError(err.message),
        persona: session.persona,
      });
      audioStreamRef.current.start(stream);
    }
  };
  const beginAnswerRef = useRef(beginAnswer);
  beginAnswerRef.current = beginAnswer;

  const speakQuestion = useCallback(
    (text) => {
      if (!text) return;
      const voice = PERSONA_VOICE[session.persona] || PERSONA_VOICE.B;
      speaker.speak(text, {
        ...voice,
        onStart: () => setAvatarSpeaking(true),
        onEnd: () => setAvatarSpeaking(false),
      });
    },
    [speaker, session.persona],
  );

  useEffect(() => {
    recorder.startCamera().catch(() => setError("카메라/마이크 접근에 실패했습니다."));
    return () => recorder.stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto flow: when a question appears (and the camera is live), the interviewer
  // reads it aloud, then recording starts automatically on the avatar's onEnd.
  // A safety timer covers TTS that never fires onEnd (muted / unsupported).
  useEffect(() => {
    if (view !== "interview" || !recorder.isCameraOn) return;
    answerActiveRef.current = false;
    let cancelled = false;
    let started = false;
    const start = () => {
      if (cancelled || started) return;
      started = true;
      beginAnswerRef.current();
    };
    const voice = PERSONA_VOICE[session.persona] || PERSONA_VOICE.B;
    speaker.speak(current.question, {
      ...voice,
      onStart: () => setAvatarSpeaking(true),
      onEnd: () => {
        setAvatarSpeaking(false);
        start();
      },
    });
    const fallback = setTimeout(start, 9000);
    return () => {
      cancelled = true;
      clearTimeout(fallback);
      speaker.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, recorder.isCameraOn, view]);

  // Feed per-frame motion metrics to the avatar reaction controller. liveMetrics
  // already updates each analyzed frame; the controller ignores input while
  // inactive (not recording), so this is cheap and self-gating.
  useEffect(() => {
    reactions.setMotion(recorder.liveMetrics);
  }, [recorder.liveMetrics, reactions]);

  // Immediate gaze feedback (요구: 조금이라도 시선이 벗어나면 곧바로). The metric is
  // unsmoothed per-frame, so this fires the moment gaze leaves the camera.
  useEffect(() => {
    if (recorder.isRecording && recorder.liveMetrics.gazeAway) {
      pushCoaching("시선이 정면을 벗어났어요. 카메라를 바라보세요", "danger");
    }
  }, [recorder.isRecording, recorder.liveMetrics.gazeAway, pushCoaching]);

  useEffect(() => {
    if (recorder.isRecording && recorder.liveMetrics.eyeClosed) {
      pushCoaching("눈이 자주 감기고 있어요", "warn");
    }
  }, [recorder.isRecording, recorder.liveMetrics.eyeClosed, pushCoaching]);

  useEffect(() => {
    if (recorder.isRecording && recorder.liveMetrics.handBlock) {
      pushCoaching("손이 얼굴을 가리고 있어요", "warn");
    }
  }, [recorder.isRecording, recorder.liveMetrics.handBlock, pushCoaching]);

  // Clear any pending auto-advance timer on unmount.
  useEffect(() => () => clearTimeout(advanceTimerRef.current), []);

  const scheduleAdvance = (fromIndex) => {
    const isLast = fromIndex + 1 >= questions.length;
    clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = setTimeout(() => {
      if (isLast) setView("summary");
      else setIndex(fromIndex + 1);
    }, 1400);
  };

  // 답변 종료 → 실시간 피드백(코칭과 구별): 녹화를 멈추고, 백엔드가 STT → 문맥
  // 기반 전사 보정 → 평가를 수행한 결과를 받아 우측 "피드백 목록"에 누적한다.
  // (점수/분석은 코칭 토스트에 섞지 않는다 — 피드백 채널은 목록/상세/종합이다.)
  const endAnswer = async () => {
    if (!recorder.isRecording || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const recording = await recorder.stopRecording();
      const voice = audioStreamRef.current?.getVoiceSummary() || {};
      // Capture recordingId before stop() — stop() flushes the final STT chunk
      // and awaits all in-flight uploads so the server store is ready when
      // submit_answer arrives.
      const recordingId = audioStreamRef.current?.recordingId;
      await audioStreamRef.current?.stop();
      audioStreamRef.current = null;
      answerActiveRef.current = false;
      reactions.setActive(false); // candidate done → relax interviewer to neutral

      const result = await getAnswerFeedback({
        questionId: current.id,
        audioBlob: recording.blob,
        voiceMetrics: voice,
        poseMetrics: recording.poseSummary,
        recordingId,
      });

      const record = toInterviewRecord({
        question: current,
        transcript: result.transcript, // AI 보정된 전사 (평가 기준)
        rawTranscript: result.raw_transcript, // STT 원문 (보정 전)
        evaluation: result.evaluation,
      });
      setRecords((prev) => [...prev.filter((r) => r.id !== record.id), record]);
      setAnsweredIds((prev) => new Set(prev).add(current.id));
      scheduleAdvance(index);
    } catch (err) {
      setError(`답변 처리에 실패했습니다: ${err.message}`);
      answerActiveRef.current = false;
    } finally {
      setSubmitting(false);
    }
  };

  // 면접 종료: stop anything in flight and jump to the summary view.
  const endInterview = async () => {
    clearTimeout(advanceTimerRef.current);
    if (recorder.isRecording) {
      try {
        await recorder.stopRecording();
      } catch {
        // ignore — we're tearing down anyway
      }
    }
    await audioStreamRef.current?.stop();
    audioStreamRef.current = null;
    answerActiveRef.current = false;
    reactions.setActive(false);
    setView("summary");
  };

  // Summary view replaces the interview screen; back returns here.
  if (view === "summary") {
    return (
      <SummaryFeedbackView
        sessionId={session.session_id}
        onBack={() => setView("interview")}
        onFinish={() => onComplete(session.session_id)}
      />
    );
  }

  const progress = Math.round(((index + 1) / questions.length) * 100);

  return (
    <div style={styles.container}>
      {/* 진행 헤더 + 진행 막대 */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.counter}>
            질문 {index + 1} / {questions.length}
          </span>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${progress}%` }} />
          </div>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.categoryPill}>{current.category}</span>
          {allAnswered && (
            <button type="button" onClick={() => setView("summary")} className="btn btn-primary" style={styles.summaryBtn}>
              종합 피드백 보기
            </button>
          )}
        </div>
      </header>

      <div style={styles.bodyRow}>
        <div style={styles.mainCol}>
          {/* 면접관(왼쪽) + 사용자 영상(오른쪽) — 하나의 다크 스테이지 */}
          <div style={styles.stage}>
            <div style={styles.avatarSide}>
              <span style={styles.tileLabel}>AI 면접관</span>
              {!avatarFailed && (
                <InterviewerAvatar
                  url={AVATAR_URL}
                  mouthRef={mouthRef}
                  expressionRef={expressionRef}
                  onFail={() => setAvatarFailed(true)}
                />
              )}
              {avatarFailed && <div style={styles.avatarFallback}>면접관</div>}
              {avatarSpeaking && <span style={styles.speakingBadge}>● 말하는 중</span>}
              {!avatarSpeaking && recorder.isRecording && MOOD_BADGE[avatarMood] && (
                <span style={{ ...styles.moodBadge, background: MOOD_BADGE[avatarMood].color }}>
                  {MOOD_BADGE[avatarMood].emoji} {MOOD_BADGE[avatarMood].label}
                </span>
              )}
              {/* 질문 오버레이 */}
              <div style={styles.questionOverlay}>
                <p style={styles.questionText}>{current.question}</p>
                <button
                  type="button"
                  onClick={() => speakQuestion(current.question)}
                  disabled={avatarSpeaking || recorder.isRecording}
                  style={styles.replayBtn}
                >
                  🔊 질문 다시 듣기
                </button>
              </div>
            </div>

            <div style={styles.videoSide}>
              {recorder.isRecording && <span style={styles.recDot}>● REC</span>}
              <video ref={recorder.videoRef} autoPlay muted playsInline style={styles.video} />
              {/* 실시간 코칭 토스트 (영상 위, 우하단) */}
              <LiveFeedbackToasts toasts={toasts} />
            </div>
          </div>

          {error && <p style={styles.error}>{error}</p>}

          {/* 자동 진행: 사용자는 답변 종료 / 면접 종료만 가능 */}
          <div style={styles.controls}>
            <button type="button" onClick={endInterview} className="btn btn-ghost" style={styles.endBtn}>
              면접 종료
            </button>
            {recorder.isRecording ? (
              <button onClick={endAnswer} disabled={submitting} style={styles.stopBtn}>
                {submitting ? "분석 중..." : "■ 답변 종료"}
              </button>
            ) : submitting ? (
              <button disabled style={styles.stopBtn}>
                분석 중...
              </button>
            ) : (
              <span style={styles.waiting}>다음 질문을 준비 중입니다...</span>
            )}
          </div>
        </div>

        {/* 사이드바형 피드백 목록 (이번 면접) */}
        <FeedbackList
          records={records}
          collapsed={listCollapsed}
          onToggleCollapse={() => setListCollapsed((c) => !c)}
          onSelect={setSelectedRecord}
        />
      </div>

      <FeedbackDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
    </div>
  );
}

const styles = {
  container: { maxWidth: 1320, margin: "0 auto", padding: "20px 24px 40px" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20 },
  headerLeft: { display: "flex", alignItems: "center", gap: 14, flex: 1, minWidth: 0 },
  counter: { fontWeight: 800, color: "var(--text)", fontSize: 15, whiteSpace: "nowrap" },
  progressTrack: {
    flex: 1,
    maxWidth: 420,
    height: 6,
    background: "var(--border)",
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: { height: "100%", background: "var(--primary)", borderRadius: 999, transition: "width 0.3s ease" },
  headerRight: { display: "flex", alignItems: "center", gap: 12, flexShrink: 0 },
  categoryPill: {
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    color: "var(--muted)",
    padding: "6px 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700,
  },
  summaryBtn: { padding: "9px 16px", fontSize: 14 },
  bodyRow: { display: "flex", gap: 20, alignItems: "flex-start", marginTop: 16, flexWrap: "wrap" },
  mainCol: { flex: 1, minWidth: 360, display: "flex", flexDirection: "column", gap: 16 },
  // 하나의 다크 스테이지에 면접관(왼쪽) + 영상(오른쪽)
  stage: {
    display: "flex",
    height: 460,
    borderRadius: 18,
    overflow: "hidden",
    background: "#0b1020",
  },
  avatarSide: {
    position: "relative",
    width: "44%",
    minWidth: 240,
    background: "radial-gradient(circle at 50% 30%, #243042, #0b1020)",
    borderRight: "1px solid rgba(255,255,255,0.06)",
  },
  videoSide: { position: "relative", flex: 1, minWidth: 0, background: "#000" },
  avatarFallback: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#64748b",
    fontWeight: 700,
    fontSize: 18,
  },
  tileLabel: {
    position: "absolute",
    top: 12,
    left: 12,
    zIndex: 6,
    color: "#e2e8f0",
    background: "rgba(11,16,32,0.72)",
    padding: "4px 12px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
  },
  speakingBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    color: "#fff",
    background: "rgba(108,92,231,0.92)",
    padding: "4px 11px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
  },
  moodBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    color: "#fff",
    padding: "4px 11px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
  },
  questionOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    background: "linear-gradient(to top, rgba(11,16,32,0.92), rgba(11,16,32,0))",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    alignItems: "flex-start",
    zIndex: 5,
  },
  questionText: { margin: 0, color: "#fff", fontSize: 16, fontWeight: 700, lineHeight: 1.45 },
  replayBtn: {
    padding: "8px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.1)",
    color: "#e2e8f0",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    flexShrink: 0,
  },
  video: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  recDot: {
    position: "absolute",
    top: 12,
    left: 12,
    color: "#fff",
    background: "rgba(220,38,38,0.92)",
    padding: "4px 10px",
    borderRadius: 999,
    fontWeight: 700,
    fontSize: 12,
    zIndex: 6,
  },
  controls: { marginTop: 4, display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" },
  waiting: { color: "var(--muted)", fontWeight: 600 },
  stopBtn: {
    padding: "13px 26px",
    borderRadius: 10,
    border: "none",
    background: "var(--danger)",
    color: "white",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
  },
  endBtn: { padding: "13px 20px", fontSize: 15 },
  error: { color: "var(--danger)", fontWeight: 600 },
};
