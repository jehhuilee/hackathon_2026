// 카메라/마이크 세팅·점검 준비 페이지.
// 카메라 미리보기 + 장치 선택(카메라/마이크/스피커) + 마이크 입력 레벨 미터.
// 점검을 통과해야 "면접 시작"이 활성화된다. 시작 시 프리뷰 스트림은 정리되고,
// 면접 화면에서 녹화가 자동으로 시작된다.

import { useCallback, useEffect, useRef, useState } from "react";

export default function DeviceCheck({ onReady }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const rafRef = useRef(null);

  const [status, setStatus] = useState("requesting"); // requesting | ready | denied | error
  const [cameraOk, setCameraOk] = useState(false);
  const [micOk, setMicOk] = useState(false);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState({ cameras: [], mics: [], speakers: [] });
  const [selected, setSelected] = useState({ camera: "", mic: "", speaker: "" });

  const stopMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    stopMeter();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [stopMeter]);

  const startMeter = useCallback((stream) => {
    stopMeter();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      setLevel(peak);
      if (peak > 0.06) setMicOk(true);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopMeter]);

  const acquire = useCallback(
    async (cameraId, micId) => {
      teardown();
      const constraints = {
        video: cameraId ? { deviceId: { exact: cameraId } } : true,
        audio: micId ? { deviceId: { exact: micId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOk(stream.getVideoTracks().some((t) => t.readyState === "live"));
      setStatus("ready");
      startMeter(stream);

      // Labels are available once permission is granted.
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === "videoinput");
      const mics = all.filter((d) => d.kind === "audioinput");
      const speakers = all.filter((d) => d.kind === "audiooutput");
      setDevices({ cameras: cams, mics, speakers });
      const vId = stream.getVideoTracks()[0]?.getSettings?.().deviceId || cams[0]?.deviceId || "";
      const aId = stream.getAudioTracks()[0]?.getSettings?.().deviceId || mics[0]?.deviceId || "";
      setSelected((s) => ({
        camera: vId,
        mic: aId,
        speaker: s.speaker || speakers[0]?.deviceId || "",
      }));
      return stream;
    },
    [teardown, startMeter],
  );

  useEffect(() => {
    let alive = true;
    acquire().catch((err) => {
      if (!alive) return;
      setStatus(err?.name === "NotAllowedError" ? "denied" : "error");
    });
    return () => {
      alive = false;
      teardown();
    };
  }, [acquire, teardown]);

  const onPickCamera = (e) => {
    const id = e.target.value;
    setSelected((s) => ({ ...s, camera: id }));
    acquire(id, selected.mic).catch(() => setStatus("error"));
  };
  const onPickMic = (e) => {
    const id = e.target.value;
    setSelected((s) => ({ ...s, mic: id }));
    acquire(selected.camera, id).catch(() => setStatus("error"));
  };

  const testSpeaker = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close().catch(() => {});
      }, 280);
    } catch {
      // ignore — best-effort test tone
    }
  };

  const handleStart = () => {
    teardown();
    onReady();
  };

  const canStart = status === "ready" && cameraOk && micOk;

  return (
    <div style={styles.wrap}>
      <h1 style={styles.title}>카메라 · 마이크 세팅</h1>
      <p style={styles.subtitle}>면접 시작 전 장치를 확인하고 테스트해 주세요</p>

      <div style={styles.previewWrap}>
        <video ref={videoRef} autoPlay muted playsInline style={styles.video} />
        {status !== "ready" ? (
          <div style={styles.placeholder}>
            <div style={styles.camIcon}>📷</div>
            {status === "requesting" && <div>카메라 미리보기</div>}
            {status === "denied" && <div>권한이 거부되었습니다. 허용 후 새로고침하세요.</div>}
            {status === "error" && <div>사용 가능한 카메라/마이크를 찾지 못했습니다.</div>}
          </div>
        ) : (
          <div style={styles.badges}>
            <span style={{ ...styles.badge, opacity: cameraOk ? 1 : 0.5 }}>● 카메라 감지됨</span>
            <span style={{ ...styles.badge, opacity: micOk ? 1 : 0.5 }}>● 마이크 감지됨</span>
          </div>
        )}
      </div>

      <div style={styles.selectRow}>
        <Select label="카메라" value={selected.camera} onChange={onPickCamera} options={devices.cameras} fallback="기본 카메라" />
        <Select label="마이크" value={selected.mic} onChange={onPickMic} options={devices.mics} fallback="기본 마이크" />
        <Select
          label="스피커"
          value={selected.speaker}
          onChange={(e) => setSelected((s) => ({ ...s, speaker: e.target.value }))}
          options={devices.speakers}
          fallback="기본 스피커/헤드폰"
        />
      </div>

      <div className="card" style={styles.micCard}>
        <span style={styles.micLabel}>🎙️ 마이크 입력</span>
        <div style={styles.meterTrack}>
          <div style={{ ...styles.meterFill, width: `${Math.min(100, Math.round(level * 140))}%` }} />
        </div>
        <span style={{ ...styles.micState, color: micOk ? "var(--success)" : "var(--faint)" }}>
          {micOk ? "정상" : "대기"}
        </span>
        <button type="button" className="btn btn-ghost" style={styles.testBtn} onClick={testSpeaker}>
          스피커 테스트
        </button>
      </div>

      <button
        type="button"
        onClick={handleStart}
        disabled={!canStart}
        className="btn btn-primary"
        style={styles.startBtn}
      >
        {canStart ? "준비 완료 — 면접 시작 →" : "점검 중..."}
      </button>
    </div>
  );
}

function Select({ label, value, onChange, options, fallback }) {
  return (
    <label style={styles.selectLabel}>
      <span style={styles.selectCaption}>{label}</span>
      <select value={value} onChange={onChange} className="input" style={styles.select}>
        {options.length === 0 && <option value="">{fallback}</option>}
        {options.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${fallback} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

const styles = {
  wrap: { maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 },
  title: { fontSize: 30, fontWeight: 800, textAlign: "center", margin: "8px 0 0" },
  subtitle: { color: "var(--muted)", textAlign: "center", margin: "0 0 8px", fontSize: 15 },
  previewWrap: {
    position: "relative",
    width: "100%",
    aspectRatio: "16 / 10",
    background: "#0b1020",
    borderRadius: 18,
    overflow: "hidden",
  },
  video: { width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" },
  placeholder: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    color: "#7b86a3",
    textAlign: "center",
    padding: 24,
    fontWeight: 600,
  },
  camIcon: { fontSize: 34, opacity: 0.6 },
  badges: { position: "absolute", top: 14, right: 14, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" },
  badge: {
    background: "var(--success)",
    color: "#fff",
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700,
  },
  selectRow: { display: "flex", gap: 12, flexWrap: "wrap" },
  selectLabel: { flex: "1 1 180px", display: "flex", flexDirection: "column", gap: 6 },
  selectCaption: { fontSize: 13, fontWeight: 700, color: "var(--muted)" },
  select: { cursor: "pointer", appearance: "auto" },
  micCard: { display: "flex", alignItems: "center", gap: 14, padding: "14px 18px" },
  micLabel: { fontSize: 14, fontWeight: 700, whiteSpace: "nowrap" },
  meterTrack: { flex: 1, height: 12, background: "var(--border)", borderRadius: 999, overflow: "hidden" },
  meterFill: { height: "100%", background: "var(--success)", borderRadius: 999, transition: "width 80ms linear" },
  micState: { fontSize: 13, fontWeight: 700, minWidth: 28 },
  testBtn: { padding: "8px 14px", fontSize: 13, whiteSpace: "nowrap" },
  startBtn: { width: "100%", padding: "16px", fontSize: 16, marginTop: 4 },
};
