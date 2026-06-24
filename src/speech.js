import { CONFIG, MS_VISEME_TO_OCULUS } from './config.js';
import { setVisemes, setAmp, setSpeaking } from './avatar.js';

// ── 음성 선택 (Web Speech 무료 모드) ──────────────────────
let koVoice = null;
function loadVoices() {
  const v = speechSynthesis.getVoices();
  koVoice = v.find(x => x.lang.startsWith(CONFIG.TTS_LANG.slice(0, 2))) || v.find(x => x.lang.startsWith('ko')) || v[0] || null;
}
loadVoices();
if (typeof speechSynthesis !== 'undefined') speechSynthesis.onvoiceschanged = loadVoices;

// ── 외부 진입점: interviewer.speak(text) ──────────────────
export async function speak(text) {
  text = (text || '').trim(); if (!text) return;
  if (CONFIG.USE_AZURE) {
    try { await azureSpeak(text); return; }
    catch (e) { console.error('Azure TTS 실패 → 무료 음성으로 대체', e); }
  }
  webSpeechSpeak(text);
}

// (A) 무료: 브라우저 Web Speech. 오디오 분석은 불가하지만, 한글을 자모로 분해해
//     '모음→입모양 / 자음→입닫힘' viseme 시퀀스를 만들어 음소 단위로 근사한다.
//     발화 속도는 추정값을 쓰되, onboundary(어절 경계)로 표류(drift)를 보정한다.

// 초성 19종 → 시작 입모양(자음 폐쇄). null = 뚜렷한 폐쇄 없음(ㅇ·ㅎ).
const CHO_VISEME = [
  'viseme_kk', // ㄱ
  'viseme_kk', // ㄲ
  'viseme_nn', // ㄴ
  'viseme_DD', // ㄷ
  'viseme_DD', // ㄸ
  'viseme_RR', // ㄹ
  'viseme_PP', // ㅁ
  'viseme_PP', // ㅂ
  'viseme_PP', // ㅃ
  'viseme_SS', // ㅅ
  'viseme_SS', // ㅆ
  null,        // ㅇ (무음 초성)
  'viseme_CH', // ㅈ
  'viseme_CH', // ㅉ
  'viseme_CH', // ㅊ
  'viseme_kk', // ㅋ
  'viseme_DD', // ㅌ
  'viseme_PP', // ㅍ
  null,        // ㅎ
];

// 중성 21종 → 모음 입모양(입 벌어지는 형태가 거의 다 결정됨).
const JUNG_VISEME = [
  'viseme_aa', // ㅏ
  'viseme_E',  // ㅐ
  'viseme_aa', // ㅑ
  'viseme_E',  // ㅒ
  'viseme_aa', // ㅓ
  'viseme_E',  // ㅔ
  'viseme_aa', // ㅕ
  'viseme_E',  // ㅖ
  'viseme_O',  // ㅗ
  'viseme_O',  // ㅘ
  'viseme_E',  // ㅙ
  'viseme_O',  // ㅚ
  'viseme_O',  // ㅛ
  'viseme_U',  // ㅜ
  'viseme_U',  // ㅝ
  'viseme_E',  // ㅞ
  'viseme_U',  // ㅟ
  'viseme_U',  // ㅠ
  'viseme_I',  // ㅡ
  'viseme_I',  // ㅢ
  'viseme_I',  // ㅣ
];

// 양순 종성(받침) → 음절 끝에서 입을 닫음(PP). 인덱스는 종성 0~27 기준.
const CODA_CLOSE = new Set([10, 11, 14, 16, 17, 18, 26]); // ㄻ ㄼ ㄿ ㅁ ㅂ ㅄ ㅍ

const SYL_MS = 165;    // 음절당 추정 길이
const PAUSE_MS = 130;  // 공백·구두점 쉼

function decompose(ch) {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;            // 완성형 한글이 아님
  return { cho: Math.floor(code / 588), jung: Math.floor((code % 588) / 28), jong: code % 28 };
}

// 텍스트 → viseme 키프레임 타임라인. frames: [{t(ms), vis:{viseme_x:1}}], 빈 vis는 닫힘/무음.
function buildTimeline(text) {
  const frames = [];
  const anchors = [];   // {i: charIndex, t} — onboundary 재동기화용
  let t = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const d = decompose(ch);
    if (!d) {
      if (/[a-zA-Z0-9]/.test(ch)) { frames.push({ t, vis: { viseme_aa: 0.5 } }); t += SYL_MS * 0.8; }
      else { frames.push({ t, vis: {} }); t += PAUSE_MS; }     // 공백·구두점 → 쉼
      continue;
    }
    anchors.push({ i, t });
    const onset = CHO_VISEME[d.cho];
    const vowel = JUNG_VISEME[d.jung];
    if (onset) {
      frames.push({ t, vis: { [onset]: 1 } });                  // 자음 폐쇄
      frames.push({ t: t + SYL_MS * 0.35, vis: { [vowel]: 1 } }); // 모음 개방
    } else {
      frames.push({ t, vis: { [vowel]: 1 } });
    }
    if (CODA_CLOSE.has(d.jong)) frames.push({ t: t + SYL_MS * 0.78, vis: { viseme_PP: 1 } }); // 양순 받침
    t += SYL_MS;
  }
  frames.push({ t, vis: {} });                                  // 끝맺음(입 닫기)
  return { frames, anchors };
}

function anchorFor(anchors, charIndex) {
  for (let k = 0; k < anchors.length; k++) if (anchors[k].i >= charIndex) return anchors[k];
  return anchors[anchors.length - 1] || null;
}

let freeAnim = 0;
function webSpeechSpeak(text) {
  speechSynthesis.cancel();
  cancelAnimationFrame(freeAnim);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = CONFIG.TTS_LANG; if (koVoice) u.voice = koVoice;

  const { frames, anchors } = buildTimeline(text);
  let fi = 0, t0 = 0, offset = 0, done = false; // t0: 시작시각, offset: boundary 보정(ms)

  setSpeaking(true); setAmp(0);       // viseme 채널로 구동하므로 음량(jaw)은 0 유지

  // 입 닫기의 '권한'은 추정 타임라인이 아니라 실제 발화 종료(onend)에 둔다.
  const finish = () => { if (done) return; done = true; clearTimeout(wd); cancelAnimationFrame(freeAnim); setVisemes({}); setSpeaking(false); };
  // onend는 브라우저에 따라 누락될 수 있어, 추정 길이 + 여유로 강제 종료(워치독).
  const wd = setTimeout(finish, frames[frames.length - 1].t + 4000);

  u.onstart = () => { t0 = performance.now(); };
  u.onboundary = e => {               // 지금 읽는 어절 시작에 클럭을 다시 맞춤(표류 보정)
    if (!t0) t0 = performance.now();
    const a = anchorFor(anchors, e.charIndex);
    if (a) offset = (performance.now() - t0) - a.t;
  };
  u.onend = u.onerror = finish;

  (function drive() {
    if (done) return;
    if (!t0) t0 = performance.now();  // onstart 미발화 브라우저 대비
    const ms = (performance.now() - t0) - offset;
    while (fi < frames.length && frames[fi].t <= ms) setVisemes(frames[fi++].vis);
    // 프레임이 먼저 소진돼도 멈추지 않는다(입은 마지막=닫힘 상태로 대기). 종료는 finish가 담당.
    freeAnim = requestAnimationFrame(drive);
  })();

  speechSynthesis.speak(u);
}

// (B) Azure: viseme 이벤트가 오면 음소 단위, 아니면(한국어 등) 음량 기반 폴백.
let actx = null;
const audioCtx = () => actx || (actx = new (window.AudioContext || window.webkitAudioContext)());

async function azureSpeak(text) {
  const SDK = window.SpeechSDK;
  if (!SDK) throw new Error('Speech SDK 미로드 (index.html의 SDK <script> 확인)');

  const cfg = SDK.SpeechConfig.fromSubscription(CONFIG.AZURE_KEY, CONFIG.AZURE_REGION);
  cfg.speechSynthesisVoiceName = CONFIG.AZURE_VOICE;
  const synth = new SDK.SpeechSynthesizer(cfg, null);   // null → 스피커 자동재생 X, audioData만 수신

  const visemes = [];
  synth.visemeReceived = (s, e) => visemes.push({ t: e.audioOffset / 10000, id: e.visemeId }); // 100ns → ms

  const result = await new Promise((res, rej) =>
    synth.speakTextAsync(text, r => { synth.close(); res(r); }, er => { synth.close(); rej(er); }));

  const ctx = audioCtx(); await ctx.resume();
  const audio = await ctx.decodeAudioData(result.audioData.slice(0));
  const src = ctx.createBufferSource(); src.buffer = audio;

  const useViseme = visemes.length > 3;
  let analyser = null, buf = null;
  if (useViseme) { src.connect(ctx.destination); }
  else { analyser = ctx.createAnalyser(); analyser.fftSize = 512; src.connect(analyser); analyser.connect(ctx.destination); buf = new Uint8Array(analyser.fftSize); }
  console.log(useViseme ? `[lipsync] viseme 모드 (${visemes.length} events)` : '[lipsync] 음량 모드 (viseme 미수신 — 한국어 등)');

  let playing = true;
  setSpeaking(true);
  const t0 = ctx.currentTime;
  src.onended = () => { playing = false; setSpeaking(false); };
  src.start();

  (function drive() {
    if (!playing) return;
    if (useViseme) {
      const ms = (ctx.currentTime - t0) * 1000;
      let id = 0;
      for (let i = 0; i < visemes.length; i++) { if (visemes[i].t <= ms) id = visemes[i].id; else break; }
      const name = MS_VISEME_TO_OCULUS[id];
      setVisemes(name && name !== 'viseme_sil' ? { [name]: 1 } : {});
    } else {
      analyser.getByteTimeDomainData(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
      setAmp(Math.min(1, Math.sqrt(s / buf.length) * 3.2));
    }
    requestAnimationFrame(drive);
  })();
}
