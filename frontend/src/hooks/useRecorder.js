// Camera + MediaRecorder + MediaPipe pose hook.
// Extracted from the original PracticeRecorder so it can drive a per-question
// interview flow. Records video+audio, runs live pose analysis, and collects a
// pose-metrics log + summary for each answer.

import { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

function distance(a, b) {
  if (!a || !b) return 0;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function computePoseMetrics(landmarks, prevLandmarks) {
  const nose = landmarks[0];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftWrist = landmarks[15];
  const rightWrist = landmarks[16];

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

  return {
    faceVisible,
    postureMovement: Number(postureMovement.toFixed(4)),
    handMovement: Number(handMovement.toFixed(4)),
    shoulderTilt: Number(shoulderTilt.toFixed(4)),
  };
}

function generateLiveFeedback(metrics) {
  if (!metrics.faceVisible) return "얼굴이 잘 보이지 않습니다. 화면 중앙을 바라보세요.";
  if (metrics.postureMovement > 0.035) return "상체 움직임이 큽니다. 자세를 안정적으로 유지하세요.";
  if (metrics.handMovement > 0.08) return "손동작이 많습니다. 핵심 설명 구간에서는 줄여보세요.";
  if (metrics.shoulderTilt > 0.08) return "어깨 기울어짐이 큽니다. 몸을 정면으로 맞춰보세요.";
  return "좋습니다. 현재 자세가 안정적입니다.";
}

const EMPTY_METRICS = {
  faceVisible: false,
  postureMovement: 0,
  handMovement: 0,
  shoulderTilt: 0,
};

export function useRecorder() {
  const videoRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const poseLandmarkerRef = useRef(null);
  const animationFrameRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);
  const lastLandmarksRef = useRef(null);
  const poseLogRef = useRef([]);
  const isRecordingRef = useRef(false);

  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [liveMetrics, setLiveMetrics] = useState(EMPTY_METRICS);
  const [liveFeedback, setLiveFeedback] = useState("대기 중");
  const [statusMessage, setStatusMessage] = useState("카메라를 시작하세요.");

  const initPoseLandmarker = useCallback(async () => {
    if (poseLandmarkerRef.current) return;
    setStatusMessage("포즈 분석 모델을 불러오는 중입니다.");
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );
    poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    setStatusMessage("포즈 분석 모델 준비 완료.");
  }, []);

  const runPoseLoop = useCallback(() => {
    const analyze = () => {
      const video = videoRef.current;
      const poseLandmarker = poseLandmarkerRef.current;
      if (!video || !poseLandmarker || video.readyState < 2) {
        animationFrameRef.current = requestAnimationFrame(analyze);
        return;
      }
      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        const result = poseLandmarker.detectForVideo(video, performance.now());
        const landmarks = result.landmarks?.[0];
        if (landmarks) {
          const metrics = computePoseMetrics(landmarks, lastLandmarksRef.current);
          setLiveMetrics(metrics);
          setLiveFeedback(generateLiveFeedback(metrics));
          if (isRecordingRef.current) {
            poseLogRef.current.push({ time: Number(video.currentTime.toFixed(2)), ...metrics });
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
    await initPoseLandmarker();
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    mediaStreamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;
    setIsCameraOn(true);
    setStatusMessage("카메라가 켜졌습니다.");
    setTimeout(runPoseLoop, 500);
    return stream;
  }, [initPoseLandmarker, runPoseLoop]);

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
  return {
    sample_count: log.length,
    face_visible_ratio: faceVisibleRatio,
    avg_posture_movement: avg("postureMovement"),
    avg_hand_movement: avg("handMovement"),
    avg_shoulder_tilt: avg("shoulderTilt"),
  };
}
