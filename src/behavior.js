// ============================================================
// behavior.js — 작은 Behavior Tree로 면접관의 상호작용 제스처를 구동.
//   상태(state): idle / listening(사용자 말하는 중) / thinking(LLM 응답 대기) / speaking(TTS 중)
//   - 상태별 '자세(posture)+표정'은 직접 매핑하고,
//   - '단발 제스처(끄덕임·연필 톡톡 등)'의 타이밍/선택/대기는 Behavior Tree가 시퀀싱한다.
//   매 프레임 본 오프셋 맵을 만들어 avatar.setBoneOffsets()로 넘긴다.
// ============================================================
import { onFrame, onSpeakingChange, setBoneOffsets, setExpression } from './avatar.js';

const d = Math.PI / 180;
const env = p => Math.sin(Math.min(1, Math.max(0, p)) * Math.PI);          // 0→1→0 (들고-내림)
const smooth = p => p < 0.2 ? p / 0.2 : p > 0.8 ? (1 - p) / 0.2 : 1;        // 램프-홀드-램프
function add(out, b, x, y, z) { const o = out[b] || (out[b] = { x: 0, y: 0, z: 0 }); o.x += x; o.y += y; o.z += z; }

// ── 단발 제스처 라이브러리: fn(p 0..1, out) 가 본 오프셋(rad)을 누적 ──
const GESTURES = {
  nod:   { dur: 1100, fn: (p, o) => { const a = Math.sin(p * Math.PI * 2); add(o, 'Head', env(p) * 4 * d + a * 6 * d, 0, 0); add(o, 'Neck', a * 2 * d, 0, 0); } },          // 끄덕
  tilt:  { dur: 1400, fn: (p, o) => { add(o, 'Head', 0, 0, env(p) * 10 * d); add(o, 'Neck', 0, 0, env(p) * 3 * d); } },                                                       // 갸웃
  shake: { dur: 1200, fn: (p, o) => { add(o, 'Head', 0, Math.sin(p * Math.PI * 3) * env(p) * 9 * d, 0); } },                                                                  // 도리
  leanIn:{ dur: 1600, fn: (p, o) => { const e = env(p); add(o, 'Spine', e * 5 * d, 0, 0); add(o, 'Spine1', e * 3 * d, 0, 0); add(o, 'Head', e * -2 * d, 0, 0); } },           // 몸 기울여 경청
  chin:  { dur: 2600, fn: (p, o) => { const e = smooth(p); add(o, 'RightArm', e * 22 * d, 0, e * -16 * d); add(o, 'RightForeArm', 0, e * 42 * d, 0); add(o, 'RightHand', e * -28 * d, 0, 0); add(o, 'Head', e * 5 * d, 0, e * 4 * d); } }, // 턱 괴기
  tap:   { dur: 1500, fn: (p, o) => { const a = Math.abs(Math.sin(p * Math.PI * 4)); add(o, 'RightForeArm', a * -6 * d, 0, 0); add(o, 'RightHand', a * -9 * d, 0, 0); } },     // 연필 톡톡
  lookUp:{ dur: 1800, fn: (p, o) => { const e = env(p); add(o, 'Head', e * -7 * d, e * 6 * d, 0); } },                                                                        // 생각하며 위 보기
  shrug: { dur: 1100, fn: (p, o) => { const e = env(p); add(o, 'LeftShoulder', 0, 0, e * -12 * d); add(o, 'RightShoulder', 0, 0, e * 12 * d); add(o, 'Head', e * 3 * d, 0, 0); } }, // 으쓱
  talk:  { dur: 1300, fn: (p, o) => { add(o, 'RightForeArm', 0, Math.sin(p * Math.PI * 2) * 8 * d, 0); add(o, 'Head', Math.sin(p * Math.PI * 3) * 2 * d, 0, 0); } },           // 말하며 손짓
};

// ── 상태별 지속 자세 + 표정 ────────────────────────────────
function applyState(state, t, out) {
  // 항상: 잔잔한 호흡 + 미세 흔들림
  add(out, 'Spine', Math.sin(t * 0.6) * 1.2 * d, 0, 0);
  add(out, 'Head', Math.sin(t * 0.7) * 1.0 * d, Math.sin(t * 0.4) * 1.5 * d, 0);

  if (state === 'listening') {
    add(out, 'Spine', 4 * d, 0, 0); add(out, 'Spine1', 3 * d, 0, 0); add(out, 'Head', 2 * d, 0, 3 * d);  // 앞으로 기울여 경청
    setExpression({ browInnerUp: 0.18, browOuterUpLeft: 0.14, browOuterUpRight: 0.14, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 });
  } else if (state === 'thinking') {
    add(out, 'Spine', -2 * d, 0, 0); add(out, 'Head', -3 * d, 5 * d, 0);                                  // 살짝 뒤로/위로 시선 분산
    setExpression({ browDownLeft: 0.22, browDownRight: 0.22, browInnerUp: 0.15, mouthPucker: 0.12 });
  } else if (state === 'speaking') {
    add(out, 'Spine', 2 * d, 0, 0);
    setExpression({ browInnerUp: 0.08, mouthSmileLeft: 0.05, mouthSmileRight: 0.05 });
  } else { // idle
    setExpression({ mouthSmileLeft: 0.06, mouthSmileRight: 0.06 });
  }
}

// ── 미니 Behavior Tree ─────────────────────────────────────
const RUN = 'running', OK = 'success', FAIL = 'failure';
const Cond = fn => ({ reset() {}, tick: bb => fn(bb) ? OK : FAIL });
const Wait = ms => { let e = 0, tg = null; return { reset() { e = 0; tg = null; }, tick(bb, dt) { if (tg == null) tg = typeof ms === 'function' ? ms() : ms; e += dt * 1000; if (e >= tg) { e = 0; tg = null; return OK; } return RUN; } }; };
const Play = name => { let e = 0; const g = GESTURES[name]; return { reset() { e = 0; }, tick(bb, dt) { e += dt * 1000; g.fn(Math.min(1, e / g.dur), bb.out); if (e >= g.dur) { e = 0; return OK; } return RUN; } }; };
function Sequence(ch) { let i = 0; return { reset() { i = 0; ch.forEach(c => c.reset()); }, tick(bb, dt) { while (i < ch.length) { const s = ch[i].tick(bb, dt); if (s === RUN) return RUN; if (s === FAIL) { i = 0; return FAIL; } i++; } i = 0; return OK; } }; }
function Selector(ch) { let i = 0; return { reset() { i = 0; ch.forEach(c => c.reset()); }, tick(bb, dt) { while (i < ch.length) { const s = ch[i].tick(bb, dt); if (s === RUN) return RUN; if (s === OK) { i = 0; return OK; } i++; } i = 0; return FAIL; } }; }
function Random(ch) { let cur = null; return { reset() { cur = null; ch.forEach(c => c.reset()); }, tick(bb, dt) { if (!cur) cur = ch[(Math.random() * ch.length) | 0]; const s = cur.tick(bb, dt); if (s !== RUN) cur = null; return s; } }; }
function Repeat(c) { return { reset() { c.reset(); }, tick(bb, dt) { if (c.tick(bb, dt) !== RUN) c.reset(); return RUN; } }; }

// 상태별 제스처 시퀀싱(틈틈이 무작위 제스처 + 무작위 대기)
const listening = Repeat(Sequence([Random([Play('nod'), Play('nod'), Play('tilt'), Play('leanIn')]), Wait(() => 1400 + Math.random() * 2600)]));
const thinking  = Repeat(Sequence([Random([Play('chin'), Play('tap'), Play('lookUp'), Play('shake')]), Wait(() => 1100 + Math.random() * 1900)]));
const speaking  = Repeat(Sequence([Random([Play('talk'), Play('nod')]), Wait(() => 600 + Math.random() * 1100)]));
const idleGest  = Repeat(Sequence([Wait(() => 2600 + Math.random() * 4200), Random([Play('nod'), Play('tilt'), Play('shrug')])]));

const tree = Selector([
  Sequence([Cond(bb => bb.eff === 'thinking'), thinking]),
  Sequence([Cond(bb => bb.eff === 'listening'), listening]),
  Sequence([Cond(bb => bb.eff === 'speaking'), speaking]),
  idleGest,
]);

// ── 블랙보드 + 루프 ────────────────────────────────────────
const bb = { state: 'idle', speaking: false, eff: 'idle', t: 0, out: {} };
let oneShot = null, oneShotE = 0;   // 버튼 미리보기용 단발 제스처

function tick(dt) {
  bb.t += dt;
  bb.eff = bb.speaking ? 'speaking' : bb.state;
  const out = bb.out = {};
  applyState(bb.eff, bb.t, out);
  tree.tick(bb, dt);
  if (oneShot) { const g = GESTURES[oneShot]; oneShotE += dt * 1000; g.fn(Math.min(1, oneShotE / g.dur), out); if (oneShotE >= g.dur) oneShot = null; }
  setBoneOffsets(out);
}

// ── 외부 API(버튼 등) ──────────────────────────────────────
export function setState(s) { if (s !== bb.state) { bb.state = s; tree.reset(); } }
export function getState() { return bb.state; }
export function playGesture(name) { if (GESTURES[name]) { oneShot = name; oneShotE = 0; } }
export function listStates() { return ['idle', 'listening', 'thinking']; }
export function listGestures() { return Object.keys(GESTURES); }

// 실제 TTS 발화 중에는 speaking으로 자동 전환, 끝나면 직전 상태로 복귀
onSpeakingChange(b => { bb.speaking = b; tree.reset(); });
onFrame(tick);
