// TTS + lipsync for the interviewer avatar. Ported from src/speech.js:
//   - Azure mode: phoneme-accurate lipsync via Speech SDK viseme events, with an
//     audio-amplitude fallback for voices that emit no visemes.
//   - Free mode: browser Web Speech, with a Korean jamo→viseme timeline so the
//     mouth still approximates phonemes without any cloud call.
// The avatar reads a shared mouth state each frame: { visemes: {name:w}, amp }.

import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

const ENV = import.meta.env;
const AZURE_KEY = ENV.VITE_AZURE_KEY || "";
const AZURE_REGION = ENV.VITE_AZURE_REGION || "";
const AZURE_VOICE = ENV.VITE_AZURE_VOICE || "en-US-AvaMultilingualNeural";
const TTS_LANG = ENV.VITE_TTS_LANG || "ko-KR";
const USE_AZURE = !!(AZURE_KEY && AZURE_REGION);

// Microsoft viseme ID (0..21) → avatar Oculus viseme morph name.
const MS_VISEME_TO_OCULUS = {
  0: "viseme_sil", 1: "viseme_aa", 2: "viseme_aa", 3: "viseme_O", 4: "viseme_E",
  5: "viseme_RR", 6: "viseme_I", 7: "viseme_U", 8: "viseme_O", 9: "viseme_aa",
  10: "viseme_O", 11: "viseme_aa", 12: "viseme_sil", 13: "viseme_RR", 14: "viseme_nn",
  15: "viseme_SS", 16: "viseme_CH", 17: "viseme_TH", 18: "viseme_FF", 19: "viseme_DD",
  20: "viseme_kk", 21: "viseme_PP",
};

// ── Korean jamo → viseme tables (free fallback) ────────────────────────────
const CHO_VISEME = [
  "viseme_kk", "viseme_kk", "viseme_nn", "viseme_DD", "viseme_DD", "viseme_RR",
  "viseme_PP", "viseme_PP", "viseme_PP", "viseme_SS", "viseme_SS", null,
  "viseme_CH", "viseme_CH", "viseme_CH", "viseme_kk", "viseme_DD", "viseme_PP", null,
];
const JUNG_VISEME = [
  "viseme_aa", "viseme_E", "viseme_aa", "viseme_E", "viseme_aa", "viseme_E",
  "viseme_aa", "viseme_E", "viseme_O", "viseme_O", "viseme_E", "viseme_O",
  "viseme_O", "viseme_U", "viseme_U", "viseme_E", "viseme_U", "viseme_U",
  "viseme_I", "viseme_I", "viseme_I",
];
const CODA_CLOSE = new Set([10, 11, 14, 16, 17, 18, 26]); // bilabial finals → close
const SYL_MS = 165;
const PAUSE_MS = 130;

function decompose(ch) {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  return { cho: Math.floor(code / 588), jung: Math.floor((code % 588) / 28), jong: code % 28 };
}

function buildTimeline(text) {
  const frames = [];
  const anchors = [];
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const d = decompose(ch);
    if (!d) {
      if (/[a-zA-Z0-9]/.test(ch)) { frames.push({ t, vis: { viseme_aa: 0.5 } }); t += SYL_MS * 0.8; }
      else { frames.push({ t, vis: {} }); t += PAUSE_MS; }
      continue;
    }
    anchors.push({ i, t });
    const onset = CHO_VISEME[d.cho];
    const vowel = JUNG_VISEME[d.jung];
    if (onset) {
      frames.push({ t, vis: { [onset]: 1 } });
      frames.push({ t: t + SYL_MS * 0.35, vis: { [vowel]: 1 } });
    } else {
      frames.push({ t, vis: { [vowel]: 1 } });
    }
    if (CODA_CLOSE.has(d.jong)) frames.push({ t: t + SYL_MS * 0.78, vis: { viseme_PP: 1 } });
    t += SYL_MS;
  }
  frames.push({ t, vis: {} });
  return { frames, anchors };
}

function anchorFor(anchors, charIndex) {
  for (let k = 0; k < anchors.length; k++) if (anchors[k].i >= charIndex) return anchors[k];
  return anchors[anchors.length - 1] || null;
}

function xmlEscape(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

// rate/pitch (1.0 = neutral) → SSML percentage strings.
function pct(v) {
  const p = Math.round((v - 1) * 100);
  return (p >= 0 ? "+" : "") + p + "%";
}

let koVoice = null;
function loadKoVoice() {
  if (typeof speechSynthesis === "undefined") return;
  const v = speechSynthesis.getVoices();
  koVoice =
    v.find((x) => x.lang && x.lang.startsWith(TTS_LANG.slice(0, 2))) ||
    v.find((x) => x.lang && x.lang.startsWith("ko")) ||
    v[0] || null;
}
if (typeof speechSynthesis !== "undefined") {
  loadKoVoice();
  speechSynthesis.addEventListener("voiceschanged", loadKoVoice);
}

export class Speaker {
  // mouthState shape: { visemes: {name: weight}, amp: number }
  constructor(mouthState) {
    this.mouth = mouthState || { visemes: {}, amp: 0 };
    this.mouth.visemes = this.mouth.visemes || {};
    this.mouth.amp = this.mouth.amp || 0;
    this.available = true;
    this.usingAzure = USE_AZURE;
    this._raf = 0;
    this._azSource = null;
    this._azCtx = null;
    this._token = 0; // bumped on every speak()/cancel() to invalidate in-flight work
  }

  setVisemes(dict) { this.mouth.visemes = dict || {}; }
  setAmp(v) { this.mouth.amp = v; }

  async speak(text, opts = {}) {
    text = (text || "").trim();
    if (!text) { opts.onEnd?.(); return; }
    this.cancel();
    const token = ++this._token;
    if (USE_AZURE) {
      try {
        await this._azureSpeak(text, opts, token);
        return;
      } catch (e) {
        if (token !== this._token) return; // cancelled mid-flight
        console.error("Azure TTS 실패 → 무료 음성으로 대체", e);
      }
    }
    this._webSpeechSpeak(text, opts, token);
  }

  // ── (A) Azure: viseme events when available, else amplitude. ──────────────
  async _azureSpeak(text, { rate = 1, pitch = 1, onStart, onEnd } = {}, token) {
    const cfg = SpeechSDK.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    cfg.speechSynthesisVoiceName = AZURE_VOICE;
    const synth = new SpeechSDK.SpeechSynthesizer(cfg, null); // null → no auto playback, audioData only

    const visemes = [];
    synth.visemeReceived = (s, e) => visemes.push({ t: e.audioOffset / 10000, id: e.visemeId }); // 100ns → ms

    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${TTS_LANG}">` +
      `<voice name="${AZURE_VOICE}"><prosody rate="${pct(rate)}" pitch="${pct(pitch)}">` +
      `${xmlEscape(text)}</prosody></voice></speak>`;

    const result = await new Promise((res, rej) =>
      synth.speakSsmlAsync(ssml, (r) => { synth.close(); res(r); }, (er) => { synth.close(); rej(er); }),
    );
    if (token !== this._token) return; // cancelled while synthesizing
    if (!result.audioData || result.audioData.byteLength === 0) throw new Error("빈 오디오");

    const ctx = this._azCtx || (this._azCtx = new (window.AudioContext || window.webkitAudioContext)());
    await ctx.resume();
    const audio = await ctx.decodeAudioData(result.audioData.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = audio;
    this._azSource = src;

    const useViseme = visemes.length > 3;
    let analyser = null, buf = null;
    if (useViseme) {
      src.connect(ctx.destination);
    } else {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      buf = new Uint8Array(analyser.fftSize);
    }
    console.log(useViseme ? `[lipsync] viseme 모드 (${visemes.length} events)` : "[lipsync] 음량 모드 (viseme 미수신)");

    onStart?.();
    const t0 = ctx.currentTime;
    src.onended = () => { if (token === this._token) { this._stopMouth(); onEnd?.(); } };
    src.start();

    const drive = () => {
      if (token !== this._token || this._azSource !== src) return;
      if (useViseme) {
        const ms = (ctx.currentTime - t0) * 1000;
        let id = 0;
        for (let i = 0; i < visemes.length; i++) { if (visemes[i].t <= ms) id = visemes[i].id; else break; }
        const name = MS_VISEME_TO_OCULUS[id];
        this.setVisemes(name && name !== "viseme_sil" ? { [name]: 1 } : {});
      } else {
        analyser.getByteTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
        this.setAmp(Math.min(1, Math.sqrt(s / buf.length) * 3.2));
      }
      this._raf = requestAnimationFrame(drive);
    };
    drive();
  }

  // ── (B) Free: Web Speech + Korean jamo viseme timeline. ───────────────────
  _webSpeechSpeak(text, { onStart, onEnd } = {}, token) {
    if (typeof speechSynthesis === "undefined") { onEnd?.(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = TTS_LANG;
    if (koVoice) u.voice = koVoice;

    const { frames, anchors } = buildTimeline(text);
    let fi = 0, t0 = 0, offset = 0, finished = false;

    onStart?.();
    this.setAmp(0);

    const finish = () => {
      if (finished || token !== this._token) return;
      finished = true;
      clearTimeout(wd);
      cancelAnimationFrame(this._raf);
      this._stopMouth();
      onEnd?.();
    };
    const wd = setTimeout(finish, frames[frames.length - 1].t + 4000);

    u.onstart = () => { t0 = performance.now(); };
    u.onboundary = (e) => {
      if (!t0) t0 = performance.now();
      const a = anchorFor(anchors, e.charIndex);
      if (a) offset = (performance.now() - t0) - a.t;
    };
    u.onend = u.onerror = finish;

    const drive = () => {
      if (finished || token !== this._token) return;
      if (!t0) t0 = performance.now();
      const ms = (performance.now() - t0) - offset;
      while (fi < frames.length && frames[fi].t <= ms) this.setVisemes(frames[fi++].vis);
      this._raf = requestAnimationFrame(drive);
    };
    drive();

    speechSynthesis.speak(u);
  }

  _stopMouth() {
    this.setVisemes({});
    this.setAmp(0);
  }

  cancel() {
    this._token++;
    cancelAnimationFrame(this._raf);
    if (this._azSource) {
      try { this._azSource.onended = null; this._azSource.stop(); } catch { /* already stopped */ }
      this._azSource = null;
    }
    try { if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); } catch { /* ignore */ }
    this.setVisemes({});
    this.setAmp(0);
  }
}
