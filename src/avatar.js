import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from './config.js';

let renderer, scene, camera, controls;
const morphMeshes = [];

// ── 립싱크(입/음량) 채널 ───────────────────────────────────
let AVAIL_VISEME = [], JAW = null, BLINK = [];
const visemeTarget = {}, visemeCur = {};
let ampTarget = 0, ampCur = 0;
const idle = { nextBlink: 1 + Math.random() * 3, blink: 0 };

// ── 본(스켈레톤) 제어 채널 ─────────────────────────────────
// 제스처/포즈로 회전을 제어할 본. (Mixanim/RPM 표준 이름)
const CTRL = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'];
const bone = {};        // name -> Object3D
const boneBase = {};    // name -> Quaternion (rest * 착석 포즈) = 본의 기준 자세
const offTarget = {};   // name -> {x,y,z} 라디안 (기준 대비 추가 회전 목표 — behavior가 매 프레임 설정)
const offCur = {};      // name -> {x,y,z} 보간된 현재값

// ── 표정 모프 채널(ARKit: 눈썹/미소 등). viseme/blink와 별개. ──
const exprTarget = {}, exprCur = {};

// ── 외부 콜백 ──────────────────────────────────────────────
const frameCbs = [];    // 매 프레임 (behavior.tick)
const speakCbs = [];    // 발화 on/off 변화
export function onFrame(fn) { frameCbs.push(fn); }
export function onSpeakingChange(fn) { speakCbs.push(fn); }

const D2R = Math.PI / 180;

// ── 착석 init 포즈(기준 자세) ─ 보이는 대로 여기 숫자만 바꿔 튜닝 ──
// 값은 rest 포즈 대비 추가 회전(도). 팔이 위로 솟거나 반대로 꺾이면 해당 줄 부호를 뒤집으세요.
const POSE_DEG = {
  Spine: [6, 0, 0], Spine1: [4, 0, 0], Spine2: [3, 0, 0],  // 상체 살짝 앞으로
  Neck: [-4, 0, 0], Head: [2, 0, 0],                        // 목/머리는 수평 유지
  LeftShoulder: [0, 0, -2], RightShoulder: [0, 0, 2],
  LeftArm: [28, 26, 86], RightArm: [28, -26, -86],          // 위팔 내림 + 안쪽으로 모음
  LeftForeArm: [10, -82, 0], RightForeArm: [10, 82, 0],     // 팔꿈치 굽혀 두 손을 앞 중앙으로 모음
  LeftHand: [0, 0, 0], RightHand: [12, 0, 0],
};
// 오른손 연필 쥐기(손가락 말기). 펴지거나 과하게 말리면 부호/크기 조절.
const GRIP_DEG = {
  RightHandIndex1: [0, 0, -25], RightHandIndex2: [0, 0, -38], RightHandIndex3: [0, 0, -30],
  RightHandMiddle1: [0, 0, -30], RightHandMiddle2: [0, 0, -42], RightHandMiddle3: [0, 0, -35],
  RightHandRing1: [0, 0, -38], RightHandRing2: [0, 0, -46], RightHandRing3: [0, 0, -40],
  RightHandPinky1: [0, 0, -42], RightHandPinky2: [0, 0, -46], RightHandPinky3: [0, 0, -40],
  RightHandThumb1: [0, 0, 18], RightHandThumb2: [0, 0, 12], RightHandThumb3: [0, 0, 10],
};

// ── behavior.js가 호출하는 API ─────────────────────────────
export function setVisemes(dict) { for (const n of AVAIL_VISEME) visemeTarget[n] = dict[n] || 0; }
export function setAmp(v) { ampTarget = v; }
export function setSpeaking(b) { if (!b) { setVisemes({}); ampTarget = 0; } for (const f of speakCbs) f(b); }
export function getAvatarInfo() { return { visemes: AVAIL_VISEME.slice(), hasJaw: !!JAW, bones: getControlledBones() }; }
export function getControlledBones() { return CTRL.filter(n => bone[n]); }

// 본 추가회전 목표 설정. map = { boneName: {x,y,z}(rad) }. 빠진 본은 기준자세(0)로 복귀.
export function setBoneOffsets(map) {
  for (const n of CTRL) { const o = map[n]; const t = offTarget[n] || (offTarget[n] = { x: 0, y: 0, z: 0 }); t.x = o ? o.x : 0; t.y = o ? o.y : 0; t.z = o ? o.z : 0; }
}
// 표정 모프 설정. dict에 없는 키는 0으로 수렴.
export function setExpression(dict) {
  for (const k in dict) { exprTarget[k] = dict[k]; if (!(k in exprCur)) exprCur[k] = 0; }
  for (const k in exprTarget) if (!(k in dict)) exprTarget[k] = 0;
}

function setMorph(name, v) {
  for (const m of morphMeshes) { const i = m.morphTargetDictionary[name]; if (i !== undefined) m.morphTargetInfluences[i] = v; }
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
function qOff(o) { _e.set(o.x, o.y, o.z, 'XYZ'); return _q.setFromEuler(_e); }
function worldPos(obj) { const v = new THREE.Vector3(); obj.getWorldPosition(v); return v; }

export async function initAvatar(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.01, 100);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.0));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.0); key.position.set(2, 3, 3); scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.8); rim.position.set(-2.5, 1.5, -1.5); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.4); fill.position.set(-1.5, -0.5, 2); scene.add(fill);

  const gltf = await new GLTFLoader().loadAsync(CONFIG.AVATAR_URL);
  const model = gltf.scene; scene.add(model);

  model.traverse(o => {
    if (o.isMesh && o.morphTargetDictionary) morphMeshes.push(o);
    if (o.isBone || o.type === 'Bone') if (!bone[o.name]) bone[o.name] = o;  // 본 이름으로 등록
  });

  const names = new Set();
  morphMeshes.forEach(m => Object.keys(m.morphTargetDictionary).forEach(k => names.add(k)));
  const all = [...names];
  AVAIL_VISEME = all.filter(n => /^viseme_/i.test(n));
  AVAIL_VISEME.forEach(n => { visemeTarget[n] = 0; visemeCur[n] = 0; });
  JAW = all.find(n => /jaw.?open/i.test(n)) || all.find(n => /mouth.?open/i.test(n)) || null;
  BLINK = all.filter(n => /blink/i.test(n)); if (!BLINK.length) BLINK = all.filter(n => /eyesclosed/i.test(n));

  // ── 착석 포즈 적용 후, 각 제어본의 '기준 자세' 캡처 ──
  if (CONFIG.SEATED) {
    applyDegMap(POSE_DEG);
    if (CONFIG.SHOW_PENCIL) applyDegMap(GRIP_DEG);  // 손가락 말기(정적)
  }
  for (const n of CTRL) { if (bone[n]) { boneBase[n] = bone[n].quaternion.clone(); offCur[n] = { x: 0, y: 0, z: 0 }; offTarget[n] = { x: 0, y: 0, z: 0 }; } }

  if (CONFIG.SHOW_PENCIL && bone.RightHand) addPencil(bone.RightHand);

  model.updateWorldMatrix(true, true);

  // ── 책상 + 카메라(상체) 프레이밍 ──
  const headP = bone.Head ? worldPos(bone.Head) : new THREE.Vector3(0, 1.6, 0);
  const chestP = bone.Spine2 ? worldPos(bone.Spine2) : new THREE.Vector3(0, headP.y - 0.3, headP.z);
  const handP = bone.RightHand ? worldPos(bone.RightHand) : new THREE.Vector3(0, chestP.y - 0.18, chestP.z + 0.4);
  if (CONFIG.SHOW_DESK) addDesk(handP);

  // 머리 위 ~ 책상(손) 높이 구간을 세로로 꽉 채우도록 카메라 거리 자동 계산
  const cx = (headP.x + chestP.x) / 2, cz = chestP.z;
  const topY = headP.y + 0.16;          // 머리 위 여유
  const botY = chestP.y - 0.44;         // 책상 상판이 보이도록 손 아래까지
  const midY = (topY + botY) / 2;
  const fitDist = ((topY - botY) / 2) * CONFIG.CAM_FIT / Math.tan(camera.fov * D2R / 2);
  controls.target.set(cx, midY, cz);
  camera.position.set(cx, midY + CONFIG.CAM_HEIGHT, cz + fitDist);
  controls.update();

  console.log('[avatar] viseme', AVAIL_VISEME.length, '| jaw', JAW, '| bones', getControlledBones().length, '/', CTRL.length);

  addEventListener('resize', onResize); onResize();
  renderer.setAnimationLoop(tick);
  return getAvatarInfo();
}

function applyDegMap(map) {
  for (const n in map) {
    const b = bone[n]; if (!b) continue;
    const [x, y, z] = map[n];
    _e.set(x * D2R, y * D2R, z * D2R, 'XYZ');
    b.quaternion.multiply(_q.setFromEuler(_e));  // rest 자세에 로컬 추가회전
  }
}

function addPencil(hand) {
  const g = new THREE.CylinderGeometry(0.0045, 0.0045, 0.17, 8);
  const m = new THREE.MeshStandardMaterial({ color: 0x316b88, roughness: 0.6 });
  const pencil = new THREE.Mesh(g, m);
  // 손바닥 안에 비스듬히 놓기(손 로컬좌표 기준 — 안 맞으면 위치/회전만 조절)
  pencil.position.set(0.0, 0.03, 0.02);
  pencil.rotation.set(Math.PI / 2.2, 0, Math.PI / 10);
  hand.add(pencil);
}

function addDesk(handP) {
  const top = handP.y - 0.012;                 // 상판을 손 바로 아래 → 손이 책상에 얹힘
  const g = new THREE.BoxGeometry(2.4, 0.05, 1.2);
  const m = new THREE.MeshStandardMaterial({ color: 0x2a2d3a, roughness: 0.85, metalness: 0.0 });
  const desk = new THREE.Mesh(g, m);
  desk.position.set(0, top - 0.025, handP.z + 0.18);  // 손 z에 맞추고 앞으로 살짝
  scene.add(desk);
}

function onResize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}

const clock = new THREE.Clock();
function tick() {
  const dt = clock.getDelta();
  const kv = Math.min(1, dt * 16);

  // behavior가 이번 프레임의 본 오프셋/표정/(필요시)입을 설정
  for (const f of frameCbs) f(dt);

  // viseme 보간 → 입(음소)
  for (const n of AVAIL_VISEME) { visemeCur[n] += (visemeTarget[n] - visemeCur[n]) * kv; setMorph(n, visemeCur[n]); }
  // 음량 기반 입벌림(무료/폴백)
  ampCur += (ampTarget - ampCur) * Math.min(1, dt * 18);
  if (JAW) setMorph(JAW, ampCur);

  // 표정 모프 보간
  for (const k in exprCur) { exprCur[k] += (exprTarget[k] - exprCur[k]) * Math.min(1, dt * 10); setMorph(k, exprCur[k]); }

  // 눈 깜빡임
  idle.nextBlink -= dt;
  if (idle.nextBlink <= 0) { idle.blink = 1; idle.nextBlink = 2.5 + Math.random() * 3.5; }
  if (idle.blink > 0) { idle.blink = Math.max(0, idle.blink - dt * 12); const b = Math.sin(Math.min(1, idle.blink) * Math.PI); for (const n of BLINK) setMorph(n, b); }

  // 본: 기준자세 × 보간된 추가회전 적용
  const kb = Math.min(1, dt * 12);
  for (const n of CTRL) {
    const b = bone[n]; if (!b || !boneBase[n]) continue;
    const c = offCur[n], t = offTarget[n];
    c.x += (t.x - c.x) * kb; c.y += (t.y - c.y) * kb; c.z += (t.z - c.z) * kb;
    b.quaternion.copy(boneBase[n]).multiply(qOff(c));
  }

  controls.update();
  renderer.render(scene, camera);
}
