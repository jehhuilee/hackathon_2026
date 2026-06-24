// 3D interviewer avatar (local .glb) rendered with react-three-fiber.
// The TTS Speaker mutates a shared mouth state { visemes: {name:w}, amp };
// each frame we interpolate viseme morphs + jaw opening and add an idle blink.
// The camera auto-frames the head so the face always fits inside the box.
// Mouth/morph handling ported from src/avatar.js.

import { Component, Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";

function AvatarModel({ url, mouthRef, expressionRef }) {
  const { scene } = useGLTF(url);
  const { camera, size } = useThree();

  // Collect meshes with morph targets and resolve viseme + jaw + blink + bone names.
  const rig = useMemo(() => {
    const meshes = [];
    const names = new Set();
    const bones = {};
    scene.traverse((obj) => {
      if (obj.isMesh) obj.frustumCulled = false;
      if (obj.isMesh && obj.morphTargetDictionary && obj.morphTargetInfluences) {
        meshes.push(obj);
        Object.keys(obj.morphTargetDictionary).forEach((k) => names.add(k));
      }
      if (obj.isBone || obj.type === "Bone") bones[obj.name] = obj;
    });
    const all = [...names];
    const visemes = all.filter((n) => /^viseme_/i.test(n));
    const jaw =
      all.find((n) => /jaw.?open/i.test(n)) || all.find((n) => /mouth.?open/i.test(n)) || null;
    let blink = all.filter((n) => /blink/i.test(n));
    if (!blink.length) blink = all.filter((n) => /eyesclosed/i.test(n));

    // Expression channels → concrete ARKit morphs (resolved defensively; a model
    // missing a given morph simply won't drive that channel). Each abstract
    // channel the reaction controller emits maps to one or more real morphs.
    const find = (re) => all.filter((n) => re.test(n));
    const expr = {
      smile: [...find(/mouthSmile/i), ...find(/cheekSquint/i)],
      browUp: [...find(/browInnerUp/i), ...find(/browOuterUp/i)],
      browDown: find(/browDown/i),
      eyeWide: find(/eyeWide/i),
      frown: find(/mouthFrown/i),
    };

    // Head bone drives the affirmative nod. Cache its rest-pose rotation so the
    // nod is applied as an offset and fully restored when not nodding.
    const headBone = bones.Head || bones.head || null;
    const headBaseQuat = headBone ? headBone.quaternion.clone() : null;

    if (typeof console !== "undefined") {
      console.log(
        `[avatar] 표정 morph 매핑: smile=${expr.smile.length} browUp=${expr.browUp.length} ` +
          `browDown=${expr.browDown.length} eyeWide=${expr.eyeWide.length}, nod=${headBone ? "Head본" : "없음"}`,
      );
    }
    return { meshes, visemes, jaw, blink, bones, expr, headBone, headBaseQuat };
  }, [scene]);

  // Frame the camera on the face (centered on the eyes) whenever the model or
  // the canvas size changes, so the head always fits inside the container.
  useEffect(() => {
    scene.updateWorldMatrix(true, true);

    const headPos = new THREE.Vector3();
    if (rig.bones.Head) rig.bones.Head.getWorldPosition(headPos);
    else new THREE.Box3().setFromObject(scene).getCenter(headPos);

    // Look target = midpoint of the eyes (face focal point), else just above head bone.
    const target = new THREE.Vector3();
    if (rig.bones.LeftEye && rig.bones.RightEye) {
      const l = new THREE.Vector3();
      const r = new THREE.Vector3();
      rig.bones.LeftEye.getWorldPosition(l);
      rig.bones.RightEye.getWorldPosition(r);
      target.copy(l).add(r).multiplyScalar(0.5);
    } else {
      target.copy(headPos).add(new THREE.Vector3(0, 0.07, 0.05));
    }
    target.y -= 0.03; // bias down a touch so the crown isn't cut off

    // Distance that fits a head-sized sphere in the tighter of the two FOV axes.
    const aspect = size.width / Math.max(1, size.height);
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const minFov = Math.min(vFov, hFov);
    const headRadius = 0.16; // ~head half-height incl. margin
    const dist = (headRadius / Math.tan(minFov / 2)) * 1.15;

    // The avatar faces +Z, so the camera sits in front along +Z.
    camera.position.set(target.x, target.y, target.z + dist);
    camera.lookAt(target);
    camera.near = 0.01;
    camera.far = 20;
    camera.updateProjectionMatrix();
  }, [scene, rig, camera, size.width, size.height]);

  // Interpolated current weights (avoid popping between target frames).
  const cur = useRef({ visemes: {}, amp: 0 });
  const idle = useRef({ next: 1 + Math.random() * 3, blink: 0 });
  // Smoothed expression channels + nod animation state (driven by expressionRef).
  const curExpr = useRef({ smile: 0, browUp: 0, browDown: 0, eyeWide: 0, frown: 0 });
  const nod = useRef({ pulse: 0, cool: 0 });
  const tmp = useRef({ q: new THREE.Quaternion(), axis: new THREE.Vector3(1, 0, 0) });

  useFrame((_, dt) => {
    const target = mouthRef.current || {};
    const targetVis = target.visemes || {};
    const targetAmp = target.amp || 0;

    const setMorph = (name, v) => {
      for (const m of rig.meshes) {
        const i = m.morphTargetDictionary[name];
        if (i !== undefined) m.morphTargetInfluences[i] = v;
      }
    };
    const setMorphGroup = (names, v) => {
      for (const n of names) setMorph(n, v);
    };

    // viseme interpolation → mouth shapes
    const kv = Math.min(1, dt * 16);
    const c = cur.current;
    for (const n of rig.visemes) {
      const t = targetVis[n] || 0;
      c.visemes[n] = (c.visemes[n] || 0) + (t - (c.visemes[n] || 0)) * kv;
      setMorph(n, c.visemes[n]);
    }

    // amplitude-based jaw opening (free / fallback channel)
    c.amp += (targetAmp - c.amp) * Math.min(1, dt * 18);
    if (rig.jaw) setMorph(rig.jaw, c.amp);

    // idle blink
    const b = idle.current;
    b.next -= dt;
    if (b.next <= 0) { b.blink = 1; b.next = 2.5 + Math.random() * 3.5; }
    if (b.blink > 0) {
      b.blink = Math.max(0, b.blink - dt * 12);
      const w = Math.sin(Math.min(1, b.blink) * Math.PI);
      for (const n of rig.blink) setMorph(n, w);
    }

    // ── Reactive expression (mood) → ARKit morphs, eased in slowly. ──────────
    const expr = expressionRef?.current;
    const ce = curExpr.current;
    const ke = Math.min(1, dt * 6); // ~0.3s ease so mood shifts read as natural
    for (const ch of ["smile", "browUp", "browDown", "eyeWide", "frown"]) {
      const t = expr ? expr[ch] || 0 : 0;
      ce[ch] += (t - ce[ch]) * ke;
      setMorphGroup(rig.expr[ch], ce[ch]);
    }

    // ── Affirmative nod (backchannel) on the Head bone. ──────────────────────
    // Discrete down-up pulses retriggered on an interval while `nodding`.
    if (rig.headBone && rig.headBaseQuat) {
      const n = nod.current;
      if (expr?.nodding) {
        n.cool -= dt;
        if (n.cool <= 0 && n.pulse <= 0) {
          n.pulse = 1;
          n.cool = 1.8 + Math.random() * 1.2; // 1.8–3.0s between nods
        }
      } else {
        n.cool = 0.4; // brief delay before the first nod once speaking resumes
      }
      if (n.pulse > 0) {
        n.pulse = Math.max(0, n.pulse - dt / 0.55); // one nod lasts ~0.55s
        const env = Math.sin((1 - n.pulse) * Math.PI); // 0 → 1 → 0
        const angle = env * 0.13 * (expr?.nodGain ?? 1); // ~7.5° chin-down peak
        const { q, axis } = tmp.current;
        q.setFromAxisAngle(axis, angle);
        rig.headBone.quaternion.copy(rig.headBaseQuat).multiply(q);
      } else {
        rig.headBone.quaternion.copy(rig.headBaseQuat);
      }
    }
  });

  return <primitive object={scene} />;
}

// Hide the canvas if the .glb fails to load so the parent's text question survives.
class ModelErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail?.();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function InterviewerAvatar({ url, mouthRef, expressionRef, onFail }) {
  return (
    <Canvas
      camera={{ position: [0, 1.71, 1.0], fov: 24 }}
      gl={{ alpha: true, antialias: true }}
      style={{ width: "100%", height: "100%", background: "transparent" }}
      dpr={[1, 2]}
    >
      <ambientLight intensity={0.85} />
      <directionalLight position={[1.5, 2, 2]} intensity={1.5} />
      <directionalLight position={[-2, 1, 1]} intensity={0.5} />
      <ModelErrorBoundary onFail={onFail}>
        <Suspense fallback={null}>
          <AvatarModel url={url} mouthRef={mouthRef} expressionRef={expressionRef} />
        </Suspense>
      </ModelErrorBoundary>
    </Canvas>
  );
}
