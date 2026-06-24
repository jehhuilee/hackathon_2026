// Camera + MediaRecorder + MediaPipe pose/hand hook.
// Extracted from the original PracticeRecorder so it can drive a per-question
// interview flow. Records video+audio, runs live pose + hand analysis, and
// collects a pose-metrics log + summary for each answer.
//
// The live-feedback pipeline mirrors Motion/src/main.py:
//   1) per-frame raw metrics (posture / shoulder / hand-block)
//   2) time-window averaging (smooths out single-frame noise)
//   3) hysteresis + minimum-hold stabilizer (kills feedback flicker)

import { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, PoseLandmarker, HandLandmarker } from "@mediapipe/tasks-vision";

// =========================
// 설정값 (main.py와 동일한 의미)
// =========================

const WINDOW_MS = 5000; // 지표 평균을 내는 윈도우 (5초)

// 손 가림/근접 판정
// - 손이 얼굴 근처로 올라오거나 카메라에 가까이 들이댄 경우에만 "가림"으로 본다.
// - 손을 자연스럽게 내려놓은 상태에서는 가림이 아니다 (오탐 방지).
const HAND_NEAR_FACE_DIST_RATIO = 0.75; // 손-얼굴 중심 거리 <= 얼굴대각선*이 값 -> 얼굴 가림
const HAND_CLOSE_SIZE_RATIO = 0.85; // 손 대각선 >= 얼굴대각선*이 값 -> 카메라에 근접

// 피드백 안정화
// 히스테리시스가 임계값 진동을 막아주므로, 시간 텀은 단일 프레임 튐만 거를 정도로 짧게 둔다.
const MIN_FEEDBACK_HOLD_MS = 800; // 한 번 표시된 피드백 최소 유지 시간
const FEEDBACK_CONFIRM_MS = 300; // 새 피드백이 이 시간 연속 유지돼야 교체 (디바운스)

// 히스테리시스 (임계값 근처 진동 방지): score < ENTER -> 경고 ON, score >= EXIT -> 경고 OFF
const ENTER_THRESHOLD = 72;
const EXIT_THRESHOLD = 80;

// 단일프레임 raw 임계값 (점수화에 사용)
const POSTURE_MOVEMENT_BAD = 0.035;
const SHOULDER_TILT_BAD = 0.14;

function distance(a, b) {
  if (!a || !b) return 0;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// =========================
// 손 가림/근접 판정 (main.py compute_hand_metrics 포팅)
// =========================

function computeHandBlock(handLandmarksList, faceCenter, faceDiag) {
  if (!handLandmarksList || handLandmarksList.length === 0) return false;
  if (!faceCenter || faceDiag <= 1e-6) return false;

  for (const landmarks of handLandmarksList) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const lm of landmarks) {
      if (lm.x < minX) minX = lm.x;
      if (lm.x > maxX) maxX = lm.x;
      if (lm.y < minY) minY = lm.y;
      if (lm.y > maxY) maxY = lm.y;
    }

    const handWidth = maxX - minX;
    const handHeight = maxY - minY;
    const handDiag = Math.sqrt(handWidth * handWidth + handHeight * handHeight);
    const handCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

    const distToFace = distance(handCenter, faceCenter);

    // 손이 얼굴 근처까지 올라옴 -> 가림
    if (distToFace <= HAND_NEAR_FACE_DIST_RATIO * faceDiag) return true;
    // 손이 얼굴 대비 비정상적으로 큼 -> 카메라에 가까이 들이댐
    if (handDiag >= HAND_CLOSE_SIZE_RATIO * faceDiag) return true;
  }
  return false;
}

// =========================
// 단일 프레임 raw 지표
// =========================

function computeFrameMetrics(landmarks, prevLandmarks, handLandmarksList) {
  const nose = landmarks[0];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftWrist = landmarks[15];
  const rightWrist = landmarks[16];
  // 얼굴 크기 기준자: 양 귀(7,8) 간 거리를 얼굴 폭 proxy로 사용
  const leftEar = landmarks[7];
  const rightEar = landmarks[8];

  const faceVisible = nose.visibility > 0.5;

  const shoulderCenter = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y);

  let postureMovement = 0;
  let handMovement = 0;
  if (prevLandmarks) {
    const prevShoulderCenter = {
      x: (prevLandmarks[11].x + prevLandmarks[12].x) / 2,
      y: (prevLandmarks[11].y + prevLandmarks[12].y) / 2,
    };
    postureMovement = distance(shoulderCenter, prevShoulderCenter);
    const leftHandMove = distance(leftWrist, prevLandmarks[15]);
    const rightHandMove = distance(rightWrist, prevLandmarks[16]);
    handMovement = (leftHandMove + rightHandMove) / 2;
  }

  // 얼굴 중심/크기 (손 가림 판정용)
  const faceCenter = { x: nose.x, y: nose.y };
  const earDist = distance(leftEar, rightEar);
  // 귀 간 거리(얼굴 폭) 기반 대각선 근사. 너무 작으면 어깨폭으로 대체.
  const faceWidth = earDist > 0.02 ? earDist : distance(leftShoulder, rightShoulder) * 0.5;
  const faceDiag = faceWidth * 1.4; // 폭 대비 대각선 근사 비율

  const handBlock = computeHandBlock(handLandmarksList, faceCenter, faceDiag);

  return {
    faceVisible,
    postureMovement: Number(postureMovement.toFixed(4)),
    handMovement: Number(handMovement.toFixed(4)),
    shoulderTilt: Number(shoulderTilt.toFixed(4)),
    handBlock,
  };
}

// =========================
// 시간 윈도우 평균 -> 점수화 (main.py compute_scores 포팅)
// =========================

function average(rows, key) {
  if (!rows.length) return 0;
  return rows.reduce((sum, r) => sum + (r[key] || 0), 0) / rows.length;
}

function ratio(rows, predicate) {
  if (!rows.length) return 0;
  return rows.filter(predicate).length / rows.length;
}

function computeScores(window) {
  if (!window.length) {
    return {
      faceCenterScore: 0,
      postureScore: 100,
      shoulderScore: 100,
      handScore: 100,
    };
  }

  const faceVisibleRatio = ratio(window, (r) => r.faceVisible);
  const avgPosture = average(window, "postureMovement");
  const avgShoulder = average(window, "shoulderTilt");
  const handBlockRatio = ratio(window, (r) => r.handBlock);

  // 0(나쁨)~100(좋음). 임계값을 넘으면 0점으로 수렴.
  const postureScore = Math.round(
    100 * (1 - Math.min(avgPosture / POSTURE_MOVEMENT_BAD, 1))
  );
  const shoulderScore = Math.round(
    100 * (1 - Math.min(avgShoulder / SHOULDER_TILT_BAD, 1))
  );
  const handScore = Math.round(100 * (1 - handBlockRatio));
  const faceCenterScore = Math.round(faceVisibleRatio * 100);

  return { faceCenterScore, postureScore, shoulderScore, handScore };
}

// =========================
// 히스테리시스 기반 피드백 선택 (main.py FeedbackEngine 포팅)
// =========================

const CATEGORY_KEYS = ["face", "posture", "shoulder", "hands"];

function categoryScore(scores, key) {
  return {
    face: scores.faceCenterScore,
    posture: scores.postureScore,
    shoulder: scores.shoulderScore,
    hands: scores.handScore,
  }[key];
}

function categoryMessage(scores, key) {
  if (key === "face") return "얼굴이 잘 보이지 않습니다. 화면 중앙을 바라보세요.";
  if (key === "posture") return "상체 움직임이 큽니다. 자세를 안정적으로 유지하세요.";
  if (key === "shoulder") return "어깨 기울어짐이 큽니다. 몸을 정면으로 맞춰보세요.";
  if (key === "hands") {
    if (scores.handScore < 40) return "손이 카메라/얼굴을 가리고 있습니다. 손을 내려주세요.";
    return "손을 내리고 자세를 정돈하세요.";
  }
  return "좋습니다. 현재 자세가 안정적입니다.";
}

function createFeedbackEngine() {
  const warning = { face: false, posture: false, shoulder: false, hands: false };

  return function update(scores) {
    for (const key of CATEGORY_KEYS) {
      const s = categoryScore(scores, key);
      if (warning[key]) {
        if (s >= EXIT_THRESHOLD) warning[key] = false;
      } else if (s < ENTER_THRESHOLD) {
        warning[key] = true;
      }
    }

    const active = CATEGORY_KEYS.filter((k) => warning[k]).map((k) => ({
      key: k,
      score: categoryScore(scores, k),
    }));

    if (!active.length) return "좋습니다. 현재 자세가 안정적입니다.";

    active.sort((a, b) => a.score - b.score);
    return categoryMessage(scores, active[0].key);
  };
}

// =========================
// 최소 유지시간 + 디바운스 안정화 (main.py FeedbackStabilizer 포팅)
// =========================

function createFeedbackStabilizer() {
  let current = null;
  let currentSince = 0;
  let candidate = null;
  let candidateSince = 0;

  return function update(raw, now) {
    if (current === null) {
      current = raw;
      currentSince = now;
      candidate = null;
      return current;
    }
    if (raw === current) {
      candidate = null;
      return current;
    }
    if (now - currentSince < MIN_FEEDBACK_HOLD_MS) return current;

    if (raw !== candidate) {
      candidate = raw;
      candidateSince = now;
      return current;
    }
    if (now - candidateSince >= FEEDBACK_CONFIRM_MS) {
      current = candidate;
      currentSince = now;
      candidate = null;
    }
    return current;
  };
}

const EMPTY_METRICS = {
  faceVisible: false,
  postureMovement: 0,
  handMovement: 0,
  shoulderTilt: 0,
  handBlock: false,
};

export function useRecorder() {
  const videoRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const poseLandmarkerRef = useRef(null);
  const handLandmarkerRef = useRef(null);
  const animationFrameRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);
  const lastLandmarksRef = useRef(null);
  const poseLogRef = useRef([]);
  const isRecordingRef = useRef(false);

  // 안정화 파이프라인 상태
  const windowRef = useRef([]); // 최근 WINDOW_MS 동안의 프레임 지표
  const feedbackEngineRef = useRef(createFeedbackEngine());
  const feedbackStabilizerRef = useRef(createFeedbackStabilizer());

  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [liveMetrics, setLiveMetrics] = useState(EMPTY_METRICS);
  const [liveFeedback, setLiveFeedback] = useState("대기 중");
  const [statusMessage, setStatusMessage] = useState("카메라를 시작하세요.");

  const initLandmarkers = useCallback(async () => {
    if (poseLandmarkerRef.current && handLandmarkerRef.current) return;
    setStatusMessage("포즈/손 분석 모델을 불러오는 중입니다.");
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );
    if (!poseLandmarkerRef.current) {
      poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    }
    if (!handLandmarkerRef.current) {
      handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
      });
    }
    setStatusMessage("분석 모델 준비 완료.");
  }, []);

  const runPoseLoop = useCallback(() => {
    const analyze = () => {
      const video = videoRef.current;
      const poseLandmarker = poseLandmarkerRef.current;
      const handLandmarker = handLandmarkerRef.current;
      if (!video || !poseLandmarker || video.readyState < 2) {
        animationFrameRef.current = requestAnimationFrame(analyze);
        return;
      }
      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        const now = performance.now();
        const poseResult = poseLandmarker.detectForVideo(video, now);
        const landmarks = poseResult.landmarks?.[0];

        if (landmarks) {
          // 손 추적 (실패해도 무시)
          let handLandmarksList = null;
          if (handLandmarker) {
            try {
              const handResult = handLandmarker.detectForVideo(video, now);
              handLandmarksList = handResult.landmarks || null;
            } catch {
              handLandmarksList = null;
            }
          }

          const frame = computeFrameMetrics(landmarks, lastLandmarksRef.current, handLandmarksList);

          // 시간 윈도우 갱신
          const win = windowRef.current;
          win.push({ time: now, ...frame });
          while (win.length && now - win[0].time > WINDOW_MS) win.shift();

          const scores = computeScores(win);
          const rawFeedback = feedbackEngineRef.current(scores);
          const stableFeedback = feedbackStabilizerRef.current(rawFeedback, now);

          setLiveMetrics(frame);
          setLiveFeedback(stableFeedback);

          if (isRecordingRef.current) {
            poseLogRef.current.push({ time: Number(video.currentTime.toFixed(2)), ...frame });
          }
          lastLandmarksRef.current = landmarks;
        } else {
          setLiveMetrics(EMPTY_METRICS);
          setLiveFeedback("사람이 화면에서 잘 보이지 않습니다.");
        }
      }
      animationFrameRef.current = requestAnimationFrame(analyze);
    };
    analyze();
  }, []);

  const startCamera = useCallback(async () => {
    // Guard against StrictMode's double effect invocation opening two streams.
    if (mediaStreamRef.current) return mediaStreamRef.current;
    await initLandmarkers();
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    mediaStreamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;
    setIsCameraOn(true);
    setStatusMessage("카메라가 켜졌습니다.");
    setTimeout(runPoseLoop, 500);
    return stream;
  }, [initLandmarkers, runPoseLoop]);

  const stopCamera = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    // 안정화 상태 초기화
    windowRef.current = [];
    feedbackEngineRef.current = createFeedbackEngine();
    feedbackStabilizerRef.current = createFeedbackStabilizer();
    lastLandmarksRef.current = null;
    setIsCameraOn(false);
    setLiveFeedback("대기 중");
    setStatusMessage("카메라가 종료되었습니다.");
  }, []);

  const startRecording = useCallback(() => {
    if (!mediaStreamRef.current) return;
    recordedChunksRef.current = [];
    poseLogRef.current = [];
    const recorder = new MediaRecorder(mediaStreamRef.current, { mimeType: "video/webm" });
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordedChunksRef.current.push(event.data);
    };
    recorder.start();
    isRecordingRef.current = true;
    setIsRecording(true);
    setStatusMessage("녹화 중입니다.");
  }, []);

  // Stops recording and resolves with { blob, poseLog, poseSummary }.
  const stopRecording = useCallback(
    () =>
      new Promise((resolve) => {
        const recorder = mediaRecorderRef.current;
        if (!recorder) {
          resolve(null);
          return;
        }
        recorder.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
          isRecordingRef.current = false;
          setIsRecording(false);
          setStatusMessage("녹화가 종료되었습니다.");
          resolve({
            blob,
            poseLog: poseLogRef.current,
            poseSummary: summarizePose(poseLogRef.current),
          });
        };
        recorder.stop();
      }),
    []
  );

  useEffect(() => () => stopCamera(), [stopCamera]);

  return {
    videoRef,
    mediaStreamRef,
    isCameraOn,
    isRecording,
    liveMetrics,
    liveFeedback,
    statusMessage,
    startCamera,
    stopCamera,
    startRecording,
    stopRecording,
  };
}

function summarizePose(log) {
  if (!log.length) return {};
  const avg = (key) =>
    Number((log.reduce((sum, row) => sum + (row[key] || 0), 0) / log.length).toFixed(4));
  const faceVisibleRatio = Number(
    (log.filter((row) => row.faceVisible).length / log.length).toFixed(2)
  );
  const handBlockRatio = Number(
    (log.filter((row) => row.handBlock).length / log.length).toFixed(2)
  );
  return {
    sample_count: log.length,
    face_visible_ratio: faceVisibleRatio,
    avg_posture_movement: avg("postureMovement"),
    avg_hand_movement: avg("handMovement"),
    avg_shoulder_tilt: avg("shoulderTilt"),
    hand_block_ratio: handBlockRatio,
  };
}
