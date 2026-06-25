import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRecorder } from "../hooks/useRecorder";
import { AudioFeedbackStream } from "../services/audioStream";
import InterviewerAvatar from "./InterviewerAvatar";
import { Speaker } from "../services/tts";
import { ReactionController } from "../services/avatarReactions";
// 실시간 피드백(답변 종료 후 AI 평가, 전사 보정 포함)은 feedbackService 경유.
// 실시간 코칭(발화 중 지적)은 아래 useToastQueue → 영상 위 토스트가 담당한다.
import { getAnswerFeedback, toInterviewRecord } from "../services/feedbackService";
import { streamOverallFeedback } from "../services/api";
import { useToastQueue } from "../hooks/useToastQueue";
import { PAST_INTERVIEWS } from "../services/pastInterviews";
import LiveFeedbackToasts from "./LiveFeedbackToasts";
import FeedbackList from "./FeedbackList";
import FeedbackDetailModal from "./FeedbackDetailModal";
import SummaryFeedbackView from "./SummaryFeedbackView";
import ScoreDonut, { SCORE_COLORS } from "./ScoreDonut";

const ALERT_LABELS = {
  TOO_FAST: "말이 빨라지고 있어요",
  PITCH_UNSTABLE: "목소리 떨림이 큽니다",
  LONG_SILENCE: "침묵이 길어지고 있어요",
};

const PERSONA_LABELS = {
  A: "친근한 면접관 (널널한 기준)",
  B: "표준 면접관 (보통 기준)",
  C: "엄격한 면접관 (빡빡한 기준)",
  D: "사용자 설정 면접관",
};

// Persona-tuned TTS voice: A brighter/faster, C lower/slower (more pressure).
const PERSONA_VOICE = {
  A: { rate: 1.06, pitch: 1.15 },
  B: { rate: 1.0, pitch: 1.0 },
  C: { rate: 0.92, pitch: 0.85 },
};

// For custom persona D, interpolate TTS voice between A and C by strictness (1-5).
function resolvePersonaVoice(session) {
  if (session.persona === "D") {
    const s = session.custom_persona?.strictness ?? 3;
    const t = (s - 1) / 4;
    const a = PERSONA_VOICE.A;
    const c = PERSONA_VOICE.C;
    return { rate: a.rate + t * (c.rate - a.rate), pitch: a.pitch + t * (c.pitch - a.pitch) };
  }
  return PERSONA_VOICE[session.persona] || PERSONA_VOICE.B;
}

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

  const [index, setIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState(null); // 답변 분석 결과(인라인 패널)
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
    setLastResult(null);
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
        customStrictness: session.custom_persona?.strictness ?? null,
      });
      audioStreamRef.current.start(stream);
    }
  };
  const beginAnswerRef = useRef(beginAnswer);
  beginAnswerRef.current = beginAnswer;

  const speakQuestion = useCallback(
    (text) => {
      if (!text) return;
      const voice = resolvePersonaVoice(session);
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
    const voice = resolvePersonaVoice(session);
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

  const isLastQuestion = index + 1 >= questions.length;

  // 다음 질문으로 진행(수동). 마지막이면 종합 피드백으로.
  const handleNext = () => {
    setLastResult(null);
    if (isLastQuestion) setView("summary");
    else setIndex((i) => i + 1);
  };

  // 답변 종료 → 실시간 피드백(코칭과 구별): 녹화를 멈추고, 백엔드가 STT → 문맥
  // 기반 전사 보정 → 평가를 수행한 결과를 받아 인라인 결과 패널 + 우측 목록에 표시.
  // 사용자가 결과를 확인하고 "다음 질문"을 눌러야 진행한다(자동 진행 아님).
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
      const nextAnsweredIds = new Set(answeredIds).add(current.id);
      setAnsweredIds(nextAnsweredIds);
      setLastResult(record); // 인라인 결과 패널 표시 → 사용자가 "다음 질문" 클릭

      // 마지막 질문이면 종합 피드백을 미리 생성해 DB에 캐싱해둔다.
      // ReportView가 열릴 때 cache hit으로 즉시 반환된다.
      if (nextAnsweredIds.size >= questions.length) {
        const prefetch = streamOverallFeedback(session.session_id, {});
        setTimeout(() => prefetch.close(), 120_000); // 2분 후 정리
      }
    } catch (err) {
      setError(`답변 처리에 실패했습니다: ${err.message}`);
      answerActiveRef.current = false;
    } finally {
      setSubmitting(false);
    }
  };

  // 면접 종료: stop anything in flight and jump to the summary view.
  const endInterview = async () => {
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

          {lastResult ? (
            <ResultPanel result={lastResult} onNext={handleNext} isLast={isLastQuestion} />
          ) : (
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
          )}
        </div>

        {/* 사이드바형 피드백 목록 (이번 면접 + 지난 면접 기록) */}
        <FeedbackList
          records={records}
          pastRecords={PAST_INTERVIEWS}
          collapsed={listCollapsed}
          onToggleCollapse={() => setListCollapsed((c) => !c)}
          onSelect={setSelectedRecord}
        />
      </div>

      <FeedbackDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
    </div>
  );
}

// 답변 종료 후 인라인 결과 패널: 전사 + 점수 도넛 + 강점/개선점 + 다음 질문.
// 칩에는 한 줄 요약 격인 강점/약점을 '전부' 표시한다(말줄임 없이 줄바꿈). 더 자세한
// 개선 방법(improvement)은 상세 모달의 "AI 피드백"에서 본다.
function ResultPanel({ result, onNext, isLast }) {
  const e = result.evaluation || {};
  const fix = e.weakness || e.improvement; // 약점(중간 길이) 우선, 없으면 개선점
  return (
    <div className="card" style={styles.resultPanel}>
      <div style={styles.transcriptBlock}>
        <span style={styles.transcriptLabel}>📋 답변 전사</span>
        <p style={styles.transcriptText}>{result.answer || "(인식된 음성이 없습니다)"}</p>
      </div>
      <div style={styles.resultBottom}>
        <div style={styles.resultDonuts}>
          <ScoreDonut value={e.total_score} label="종합" color={SCORE_COLORS.total} size={62} />
          <ScoreDonut value={e.content_score} label="내용" color={SCORE_COLORS.content} size={62} />
          <ScoreDonut value={e.structure_score} label="구조" color={SCORE_COLORS.structure} size={62} />
        </div>
        <div style={styles.resultAssess}>
          {e.strength && (
            <div style={styles.assessLine}>
              <span style={styles.assessHead}>강점</span>
              <span className="chip chip-good" style={styles.assessChip}>
                {e.strength}
              </span>
            </div>
          )}
          {fix && (
            <div style={styles.assessLine}>
              <span style={styles.assessHead}>개선점</span>
              <span className="chip chip-warn" style={styles.assessChip}>
                {fix}
              </span>
            </div>
          )}
        </div>
        <button type="button" onClick={onNext} className="btn btn-primary" style={styles.nextBtn}>
          {isLast ? "종합 피드백 보기 →" : "다음 질문 →"}
        </button>
      </div>
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
  resultPanel: { padding: 20, display: "flex", flexDirection: "column", gap: 16 },
  transcriptBlock: {
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "12px 16px",
  },
  transcriptLabel: { fontSize: 13, fontWeight: 800, color: "var(--muted)" },
  transcriptText: { margin: "6px 0 0", fontSize: 14, lineHeight: 1.7, color: "#3b3f4a", whiteSpace: "pre-wrap" },
  resultBottom: { display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" },
  resultDonuts: { display: "flex", gap: 20, flexShrink: 0 },
  resultAssess: { flex: 1, minWidth: 220, maxWidth: 460, display: "flex", flexDirection: "column", gap: 8 },
  assessLine: { display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 },
  assessHead: { fontSize: 13, fontWeight: 800, color: "var(--muted)", minWidth: 40, flexShrink: 0, paddingTop: 5 },
  assessChip: {
    flex: "1 1 0",
    minWidth: 0,
    whiteSpace: "normal", // 말줄임 없이 줄바꿈으로 전체 표시
    wordBreak: "keep-all",
    overflowWrap: "anywhere",
    lineHeight: 1.45,
    borderRadius: 12,
    textAlign: "left",
  },
  nextBtn: { padding: "13px 22px", fontSize: 15, flexShrink: 0 },
};
