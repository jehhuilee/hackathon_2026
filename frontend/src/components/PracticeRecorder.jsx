import { useRef, useState } from "react";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

export default function PracticeRecorder() {
  const videoRef = useRef(null);
  const previewRef = useRef(null);

  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const poseLandmarkerRef = useRef(null);
  const animationFrameRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);
  const lastLandmarksRef = useRef(null);
  const realtimeLogRef = useRef([]);

  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [statusMessage, setStatusMessage] = useState("카메라를 시작하세요.");

  const [liveFeedback, setLiveFeedback] = useState("대기 중");
  const [liveMetrics, setLiveMetrics] = useState({
    faceVisible: false,
    postureMovement: 0,
    handMovement: 0,
    shoulderTilt: 0,
  });

  const initPoseLandmarker = async () => {
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
  };

  const startCamera = async () => {
    try {
      await initPoseLandmarker();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      mediaStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      setIsCameraOn(true);
      setStatusMessage("카메라가 켜졌습니다.");

      setTimeout(() => {
        startRealtimePoseAnalysis();
      }, 500);
    } catch (error) {
      console.error(error);
      setStatusMessage("카메라 또는 마이크 접근에 실패했습니다.");
    }
  };

  const stopCamera = () => {
    stopRealtimePoseAnalysis();

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsCameraOn(false);
    setLiveFeedback("대기 중");
    setStatusMessage("카메라가 종료되었습니다.");
  };

  const startRealtimePoseAnalysis = () => {
    const analyze = () => {
      const video = videoRef.current;
      const poseLandmarker = poseLandmarkerRef.current;

      if (!video || !poseLandmarker || video.readyState < 2) {
        animationFrameRef.current = requestAnimationFrame(analyze);
        return;
      }

      const nowInMs = performance.now();

      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;

        const result = poseLandmarker.detectForVideo(video, nowInMs);
        const landmarks = result.landmarks?.[0];

        if (landmarks) {
          const metrics = computePoseMetrics(landmarks, lastLandmarksRef.current);
          const feedback = generateLiveFeedback(metrics);

          setLiveMetrics(metrics);
          setLiveFeedback(feedback);

          if (isRecording) {
            realtimeLogRef.current.push({
              time: Number(video.currentTime.toFixed(2)),
              ...metrics,
              feedback,
            });
          }

          lastLandmarksRef.current = landmarks;
        } else {
          setLiveMetrics({
            faceVisible: false,
            postureMovement: 0,
            handMovement: 0,
            shoulderTilt: 0,
          });
          setLiveFeedback("사람이 화면에서 잘 보이지 않습니다.");
        }
      }

      animationFrameRef.current = requestAnimationFrame(analyze);
    };

    analyze();
  };

  const stopRealtimePoseAnalysis = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  const computePoseMetrics = (landmarks, prevLandmarks) => {
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
      const prevLeftShoulder = prevLandmarks[11];
      const prevRightShoulder = prevLandmarks[12];
      const prevLeftWrist = prevLandmarks[15];
      const prevRightWrist = prevLandmarks[16];

      const prevShoulderCenter = {
        x: (prevLeftShoulder.x + prevRightShoulder.x) / 2,
        y: (prevLeftShoulder.y + prevRightShoulder.y) / 2,
      };

      postureMovement = distance(shoulderCenter, prevShoulderCenter);

      const leftHandMove = distance(leftWrist, prevLeftWrist);
      const rightHandMove = distance(rightWrist, prevRightWrist);
      handMovement = (leftHandMove + rightHandMove) / 2;
    }

    return {
      faceVisible,
      postureMovement: Number(postureMovement.toFixed(4)),
      handMovement: Number(handMovement.toFixed(4)),
      shoulderTilt: Number(shoulderTilt.toFixed(4)),
    };
  };

  const distance = (a, b) => {
    if (!a || !b) return 0;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const generateLiveFeedback = (metrics) => {
    if (!metrics.faceVisible) {
      return "얼굴이 잘 보이지 않습니다. 화면 중앙을 바라보세요.";
    }

    if (metrics.postureMovement > 0.035) {
      return "상체 움직임이 큽니다. 자세를 조금 더 안정적으로 유지하세요.";
    }

    if (metrics.handMovement > 0.08) {
      return "손동작이 많습니다. 핵심 설명 구간에서는 손동작을 줄여보세요.";
    }

    if (metrics.shoulderTilt > 0.08) {
      return "어깨 기울어짐이 큽니다. 몸을 정면으로 맞춰보세요.";
    }

    return "좋습니다. 현재 자세가 안정적입니다.";
  };

  const startRecording = () => {
    if (!mediaStreamRef.current) {
      setStatusMessage("먼저 카메라를 시작하세요.");
      return;
    }

    recordedChunksRef.current = [];
    realtimeLogRef.current = [];

    const recorder = new MediaRecorder(mediaStreamRef.current, {
      mimeType: "video/webm",
    });

    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, {
        type: "video/webm",
      });

      setRecordedBlob(blob);

      const videoUrl = URL.createObjectURL(blob);

      if (previewRef.current) {
        previewRef.current.src = videoUrl;
      }

      console.log("실시간 분석 로그:", realtimeLogRef.current);

      setStatusMessage(
        `녹화 완료. 실시간 분석 로그 ${realtimeLogRef.current.length}개 생성.`
      );
    };

    recorder.start();
    setIsRecording(true);
    setStatusMessage("녹화 중입니다.");
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current) return;

    mediaRecorderRef.current.stop();
    setIsRecording(false);
  };

  const downloadRecording = () => {
    if (!recordedBlob) return;

    const url = URL.createObjectURL(recordedBlob);
    const a = document.createElement("a");

    a.href = url;
    a.download = `practice_${Date.now()}.webm`;
    a.click();

    URL.revokeObjectURL(url);
  };

  return (
    <div style={styles.container}>
      <h1>실시간 발표·면접 연습</h1>

      <p style={styles.status}>{statusMessage}</p>

      <div style={styles.feedbackBox}>
        <h2>실시간 피드백</h2>
        <p style={styles.feedbackText}>{liveFeedback}</p>

        <div style={styles.metricGrid}>
          <div>얼굴 감지: {liveMetrics.faceVisible ? "O" : "X"}</div>
          <div>상체 움직임: {liveMetrics.postureMovement}</div>
          <div>손동작량: {liveMetrics.handMovement}</div>
          <div>어깨 기울기: {liveMetrics.shoulderTilt}</div>
        </div>
      </div>

      <div style={styles.videoArea}>
        <div>
          <h2>실시간 화면</h2>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={styles.video}
          />
        </div>

        <div>
          <h2>녹화 미리보기</h2>
          <video ref={previewRef} controls style={styles.video} />
        </div>
      </div>

      <div style={styles.buttonArea}>
        <button onClick={startCamera} disabled={isCameraOn}>
          카메라 시작
        </button>

        <button onClick={stopCamera} disabled={!isCameraOn || isRecording}>
          카메라 종료
        </button>

        <button onClick={startRecording} disabled={!isCameraOn || isRecording}>
          녹화 시작
        </button>

        <button onClick={stopRecording} disabled={!isRecording}>
          녹화 종료
        </button>

        <button onClick={downloadRecording} disabled={!recordedBlob}>
          녹화 다운로드
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    padding: "32px",
    fontFamily: "Arial, sans-serif",
  },
  status: {
    padding: "12px",
    backgroundColor: "#f3f3f3",
    borderRadius: "8px",
    marginBottom: "24px",
  },
  feedbackBox: {
    padding: "16px",
    borderRadius: "12px",
    backgroundColor: "#f8f8f8",
    marginBottom: "24px",
  },
  feedbackText: {
    fontSize: "20px",
    fontWeight: "bold",
  },
  metricGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "12px",
    marginTop: "12px",
  },
  videoArea: {
    display: "flex",
    gap: "24px",
    flexWrap: "wrap",
  },
  video: {
    width: "480px",
    height: "360px",
    backgroundColor: "black",
    borderRadius: "12px",
  },
  buttonArea: {
    marginTop: "24px",
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
  },
};