// Real-time interviewer-avatar reaction controller.
//
// Turns the live candidate signals into how the interviewer should *look* and
// *behave* right now. Two separate channels, matching the agreed priority for
// a real-time (not batch) score — the LLM content score is excluded because it
// only exists after the answer is recorded:
//
//   1) 발화 활성도 / 턴테이킹  → 끄덕임(backchannel nod)
//   2) 시선 + 운율 + 자세      → 종합 engagement 점수 → 표정(mood)
//
// The controller mutates a shared `state` object in place (same pattern as the
// TTS Speaker + mouthRef). The avatar reads that object each frame and smoothly
// interpolates expression morphs + drives a Head-bone nod. Nothing here touches
// React state except an optional onMood callback that fires only on change.

// ── Composite engagement weights (real-time priority, descending) ───────────
const W = {
  turnTaking: 0.35, // 말하는 중 / 멈칫 / 유창성 — 가장 즉각적
  eyeContact: 0.30, // 시선·아이컨택 — 가장 강한 비언어 신호
  prosody: 0.20, // 말속도 + 음성 안정성 — 반응 강도
  posture: 0.15, // 자세 안정성 — 느리게 변하는 ambient 신호
};

// ── Tuning thresholds (mirror Audio/config.py + useRecorder.js where possible) ─
const GAZE_DEV_BAD = 0.5; // eyeLook* 편차가 이 값이면 시선 0점
const POSTURE_MOVE_BAD = 0.035; // 상체 움직임 임계 (useRecorder POSTURE_MOVEMENT_BAD)
const SHOULDER_TILT_BAD = 0.14; // 어깨 기울기 임계 (useRecorder SHOULDER_TILT_BAD)
const SILENCE_OK = 0.5; // 이 이하 침묵은 정상
const SILENCE_BAD = 2.0; // 이 이상 침묵이면 유창성 0
const PACE_OK = 6.0; // 이 이하 말속도는 편안
const PACE_BAD = 9.0; // 이 이상이면 너무 빠름 (persona B fast=7.0의 상한)
const PITCH_STD_OK = 25.0; // 이 이하 피치 표준편차는 안정
const PITCH_STD_BAD = 60.0; // 이 이상이면 떨림 큼
const SPEAKING_RATIO = 0.35; // recent speech_ratio가 이 이상이면 "지금 말하는 중"
const SPEAKING_SILENCE = 1.0; // 단, 최근 침묵이 이 이상이면 말 멈춘 것으로 봄
const VOICE_FRESH_MS = 1500; // 오디오 STATUS가 이 시간 내면 유효, 아니면 무음 취급

// ── Mood → target expression channels (0..1) ────────────────────────────────
// Abstract channels; the avatar maps each to concrete ARKit morphs it owns.
// IMPORTANT: only `encouraging` smiles. The default listening face (`attentive`)
// is deliberately neutral — otherwise the interviewer looks like it's always
// grinning. Each mood is visually distinct so reactions feel responsive.
const MOOD_CHANNELS = {
  idle: { smile: 0, browUp: 0, browDown: 0, eyeWide: 0, frown: 0 },
  // 답변이 약하거나 신호가 나쁠 때: 미간 찌푸림 + 입꼬리 내림 (걱정/집중)
  concerned: { smile: 0, browUp: 0, browDown: 0.32, eyeWide: 0, frown: 0.16 },
  // 기본 경청 상태: 미소 없음. 아주 미세한 눈/눈썹 주의만 (중립)
  attentive: { smile: 0, browUp: 0.05, browDown: 0, eyeWide: 0.1, frown: 0 },
  // 답변이 멈칫/침묵일 때: 안쪽 눈썹 올림 = "음, 천천히 하세요" (생각/기다림)
  thinking: { smile: 0, browUp: 0.3, browDown: 0.06, eyeWide: 0.04, frown: 0 },
  // 답변이 정말 좋을 때만 미소 (과하지 않게)
  encouraging: { smile: 0.34, browUp: 0.16, browDown: 0, eyeWide: 0.1, frown: 0 },
};
const NOD_GAIN = { idle: 0, concerned: 0.4, attentive: 0.8, thinking: 0.3, encouraging: 1 };

// Engagement band thresholds (sticky: enter is stricter than exit). Smile is
// reserved for genuinely high engagement so it is no longer the default.
const ENCOURAGING_ENTER = 0.72;
const ENCOURAGING_EXIT = 0.62;
const CONCERNED_ENTER = 0.45;
const CONCERNED_EXIT = 0.52;
const THINKING_SPEECH_RATIO = 0.2; // 발화 비율이 이 이하이고 말 멈춤이면 "생각 중"

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// Linear falloff: returns 1 at `good`, 0 at `bad`, ramped between.
const score = (value, good, bad) => clamp01(1 - (value - good) / (bad - good));

export class ReactionController {
  // state: the shared object the avatar reads (mutated in place).
  // onMood: optional callback fired only when the mood label changes (for UI).
  constructor(state, { onMood } = {}) {
    this.state = state || {};
    this.onMood = onMood;
    this.active = false;
    this.mood = "idle";
    this.band = "attentive"; // engagement band (hysteresis state, excludes thinking)
    this.motion = null; // latest recorder.liveMetrics
    this.voice = null; // latest AudioFeedbackStream STATUS
    this.voiceAt = 0; // performance.now() of last voice sample
    this._writeMood("idle");
    this._writeChannels(MOOD_CHANNELS.idle, false, 0, 0);
  }

  // Candidate is answering (recording) → react. Otherwise relax to neutral.
  setActive(active) {
    this.active = active;
    if (!active) {
      this.mood = "idle";
      this.voice = null;
      this._writeMood("idle");
      this._writeChannels(MOOD_CHANNELS.idle, false, 0, 0);
    }
  }

  setMotion(metrics) {
    this.motion = metrics;
    if (this.active) this._compute();
  }

  setVoice(status) {
    this.voice = status;
    this.voiceAt = (typeof performance !== "undefined" ? performance.now() : 0);
    if (this.active) this._compute();
  }

  // ── Core: blend live signals → engagement → mood + nod ────────────────────
  _compute() {
    const m = this.motion || {};
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const voiceFresh = this.voice && now - this.voiceAt <= VOICE_FRESH_MS;
    const v = voiceFresh ? this.voice : null;

    // 1) 시선·아이컨택 (motion). 얼굴 미검출이면 중립값(섣부른 감점 방지).
    let eyeContact = 0.6;
    if (m.faceTracked) {
      eyeContact = score(m.gazeDev || 0, 0, GAZE_DEV_BAD);
      if (m.eyeClosed) eyeContact *= 0.4;
    }

    // 2) 자세 안정성 (motion).
    let posture = 0.6;
    if (m.faceVisible) {
      const still = score(m.postureMovement || 0, 0, POSTURE_MOVE_BAD);
      const level = score(m.shoulderTilt || 0, 0, SHOULDER_TILT_BAD);
      posture = 0.6 * still + 0.4 * level;
    }

    // 3) 턴테이킹·유창성 + 운율 (audio). 무음/오프라인이면 중립값.
    let speaking = 0;
    let fluency = 0.7;
    let prosody = 0.6;
    let speakingNow = false;
    if (v) {
      speaking = clamp01(v.speech_ratio || 0);
      fluency = score(v.longest_silence_seconds || 0, SILENCE_OK, SILENCE_BAD);
      const sps = v.syllables_per_second || 0;
      const pace = sps < 0.5 ? 0.6 : score(sps, PACE_OK, PACE_BAD);
      const pitchStab = score(v.pitch_std_hz || 0, PITCH_STD_OK, PITCH_STD_BAD);
      prosody = 0.6 * pace + 0.4 * pitchStab;
      speakingNow =
        (v.speech_ratio || 0) > SPEAKING_RATIO &&
        (v.longest_silence_seconds || 0) < SPEAKING_SILENCE;
    }
    const turnTaking = 0.6 * speaking + 0.4 * fluency;

    // Composite real-time engagement (0..1).
    const engagement =
      W.turnTaking * turnTaking +
      W.eyeContact * eyeContact +
      W.prosody * prosody +
      W.posture * posture;

    // Engagement drives the positive↔negative band (with hysteresis). A mid-answer
    // pause overrides it with a distinct "thinking/waiting" face.
    const band = this._nextBand(engagement);
    const paused = !!v && !speakingNow && (v.speech_ratio || 0) < THINKING_SPEECH_RATIO;
    const mood = paused ? "thinking" : band;

    // Nod is the backchannel: nod only while the candidate is actively speaking.
    const nodding = speakingNow;
    this._writeChannels(MOOD_CHANNELS[mood], nodding, NOD_GAIN[mood], engagement);
    this._writeMood(mood);
  }

  _nextBand(engagement) {
    const b = this.band;
    // enter/exit thresholds (enter is stricter than exit → sticky, no flip-flop)
    if (b === "encouraging") {
      if (engagement < ENCOURAGING_EXIT)
        this.band = engagement <= CONCERNED_ENTER ? "concerned" : "attentive";
    } else if (b === "concerned") {
      if (engagement > CONCERNED_EXIT)
        this.band = engagement >= ENCOURAGING_ENTER ? "encouraging" : "attentive";
    } else {
      if (engagement >= ENCOURAGING_ENTER) this.band = "encouraging";
      else if (engagement <= CONCERNED_ENTER) this.band = "concerned";
      else this.band = "attentive";
    }
    return this.band;
  }

  _writeChannels(ch, nodding, nodGain, engagement) {
    const s = this.state;
    s.smile = ch.smile;
    s.browUp = ch.browUp;
    s.browDown = ch.browDown;
    s.eyeWide = ch.eyeWide;
    s.frown = ch.frown || 0;
    s.nodding = nodding;
    s.nodGain = nodGain;
    s.engagement = Number(engagement.toFixed(3));
  }

  _writeMood(mood) {
    this.state.mood = mood;
    if (mood !== this._lastMood) {
      this._lastMood = mood;
      this.onMood?.(mood);
    }
  }
}
