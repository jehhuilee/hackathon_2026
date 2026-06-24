import cv2
import mediapipe as mp
import time
import math
from collections import deque


# =========================
# 설정값
# =========================

CAMERA_INDEX = 0
WINDOW_SECONDS = 5.0

# 얼굴이 화면 중앙에 있어야 하는 범위
FACE_CENTER_X_MIN = 0.35
FACE_CENTER_X_MAX = 0.65
FACE_CENTER_Y_MIN = 0.12
FACE_CENTER_Y_MAX = 0.58

# FaceMesh landmark index
# MediaPipe FaceMesh 기준
LEFT_EYE_TOP = 159
LEFT_EYE_BOTTOM = 145
LEFT_EYE_LEFT = 33
LEFT_EYE_RIGHT = 133

RIGHT_EYE_TOP = 386
RIGHT_EYE_BOTTOM = 374
RIGHT_EYE_LEFT = 362
RIGHT_EYE_RIGHT = 263

MOUTH_TOP = 13
MOUTH_BOTTOM = 14
MOUTH_LEFT = 78
MOUTH_RIGHT = 308

NOSE_TIP = 1
CHIN = 152
LEFT_FACE = 234
RIGHT_FACE = 454
FOREHEAD = 10

# 점수 기준 threshold
YAW_GOOD = 0.015
YAW_BAD = 0.070

PITCH_GOOD = 0.005
PITCH_BAD = 0.060

ROLL_GOOD = 0.010
ROLL_BAD = 0.060

FACE_DRIFT_GOOD = 0.004
FACE_DRIFT_BAD = 0.030

FACE_SIZE_CHANGE_GOOD = 0.003
FACE_SIZE_CHANGE_BAD = 0.030

SHOULDER_TILT_GOOD = 0.020
SHOULDER_TILT_BAD = 0.090

BODY_SWAY_GOOD = 0.005
BODY_SWAY_BAD = 0.030

EYE_OPEN_MIN = 0.13
MOUTH_OPEN_GOOD_MIN = 0.03
MOUTH_OPEN_BAD_MIN = 0.005


# =========================
# 유틸 함수
# =========================

def clamp(value, min_value, max_value):
    return max(min_value, min(value, max_value))


def average(values):
    if not values:
        return 0.0
    return sum(values) / len(values)


def dist(a, b):
    if a is None or b is None:
        return 0.0
    dx = a["x"] - b["x"]
    dy = a["y"] - b["y"]
    return math.sqrt(dx * dx + dy * dy)


def lm_to_dict(lm):
    return {
        "x": lm.x,
        "y": lm.y,
        "z": getattr(lm, "z", 0.0),
        "visibility": getattr(lm, "visibility", 1.0),
    }


def normalize_penalty(value, good_threshold, bad_threshold):
    if value <= good_threshold:
        return 0.0
    if value >= bad_threshold:
        return 1.0
    return (value - good_threshold) / (bad_threshold - good_threshold)


def score_from_penalty(penalty):
    return int(round(100 * (1.0 - clamp(penalty, 0.0, 1.0))))


def safe_ratio(numerator, denominator):
    if denominator <= 1e-6:
        return 0.0
    return numerator / denominator


# =========================
# Pose 기반 상체 지표
# =========================

def extract_pose_points(pose_landmarks):
    landmarks = pose_landmarks.landmark

    return {
        "nose": lm_to_dict(landmarks[0]),
        "left_shoulder": lm_to_dict(landmarks[11]),
        "right_shoulder": lm_to_dict(landmarks[12]),
        "left_hip": lm_to_dict(landmarks[23]),
        "right_hip": lm_to_dict(landmarks[24]),
    }


def compute_pose_metrics(points, prev_points):
    left_shoulder = points["left_shoulder"]
    right_shoulder = points["right_shoulder"]
    left_hip = points["left_hip"]
    right_hip = points["right_hip"]

    shoulder_center = {
        "x": (left_shoulder["x"] + right_shoulder["x"]) / 2.0,
        "y": (left_shoulder["y"] + right_shoulder["y"]) / 2.0,
    }

    hip_center = {
        "x": (left_hip["x"] + right_hip["x"]) / 2.0,
        "y": (left_hip["y"] + right_hip["y"]) / 2.0,
    }

    body_center = {
        "x": (shoulder_center["x"] + hip_center["x"]) / 2.0,
        "y": (shoulder_center["y"] + hip_center["y"]) / 2.0,
    }

    shoulder_tilt = abs(left_shoulder["y"] - right_shoulder["y"])
    shoulder_width = dist(left_shoulder, right_shoulder)

    body_sway = 0.0

    if prev_points is not None:
        prev_left_shoulder = prev_points["left_shoulder"]
        prev_right_shoulder = prev_points["right_shoulder"]
        prev_left_hip = prev_points["left_hip"]
        prev_right_hip = prev_points["right_hip"]

        prev_shoulder_center = {
            "x": (prev_left_shoulder["x"] + prev_right_shoulder["x"]) / 2.0,
            "y": (prev_left_shoulder["y"] + prev_right_shoulder["y"]) / 2.0,
        }

        prev_hip_center = {
            "x": (prev_left_hip["x"] + prev_right_hip["x"]) / 2.0,
            "y": (prev_left_hip["y"] + prev_right_hip["y"]) / 2.0,
        }

        prev_body_center = {
            "x": (prev_shoulder_center["x"] + prev_hip_center["x"]) / 2.0,
            "y": (prev_shoulder_center["y"] + prev_hip_center["y"]) / 2.0,
        }

        body_sway = dist(body_center, prev_body_center)

    return {
        "shoulder_center": shoulder_center,
        "body_center": body_center,
        "shoulder_tilt": shoulder_tilt,
        "shoulder_width": shoulder_width,
        "body_sway": body_sway,
    }


# =========================
# FaceMesh 기반 얼굴/시선/입 지표
# =========================

def extract_face_points(face_landmarks):
    landmarks = face_landmarks.landmark

    needed = {
        "nose_tip": NOSE_TIP,
        "chin": CHIN,
        "left_face": LEFT_FACE,
        "right_face": RIGHT_FACE,
        "forehead": FOREHEAD,

        "left_eye_top": LEFT_EYE_TOP,
        "left_eye_bottom": LEFT_EYE_BOTTOM,
        "left_eye_left": LEFT_EYE_LEFT,
        "left_eye_right": LEFT_EYE_RIGHT,

        "right_eye_top": RIGHT_EYE_TOP,
        "right_eye_bottom": RIGHT_EYE_BOTTOM,
        "right_eye_left": RIGHT_EYE_LEFT,
        "right_eye_right": RIGHT_EYE_RIGHT,

        "mouth_top": MOUTH_TOP,
        "mouth_bottom": MOUTH_BOTTOM,
        "mouth_left": MOUTH_LEFT,
        "mouth_right": MOUTH_RIGHT,
    }

    return {name: lm_to_dict(landmarks[idx]) for name, idx in needed.items()}


def compute_face_metrics(points, prev_points):
    nose = points["nose_tip"]
    chin = points["chin"]
    left_face = points["left_face"]
    right_face = points["right_face"]
    forehead = points["forehead"]

    left_eye_top = points["left_eye_top"]
    left_eye_bottom = points["left_eye_bottom"]
    left_eye_left = points["left_eye_left"]
    left_eye_right = points["left_eye_right"]

    right_eye_top = points["right_eye_top"]
    right_eye_bottom = points["right_eye_bottom"]
    right_eye_left = points["right_eye_left"]
    right_eye_right = points["right_eye_right"]

    mouth_top = points["mouth_top"]
    mouth_bottom = points["mouth_bottom"]
    mouth_left = points["mouth_left"]
    mouth_right = points["mouth_right"]

    face_center = {
        "x": (left_face["x"] + right_face["x"]) / 2.0,
        "y": (forehead["y"] + chin["y"]) / 2.0,
    }

    face_width = dist(left_face, right_face)
    face_height = dist(forehead, chin)
    face_size = face_width * face_height

    face_centered = (
        FACE_CENTER_X_MIN <= face_center["x"] <= FACE_CENTER_X_MAX
        and FACE_CENTER_Y_MIN <= face_center["y"] <= FACE_CENTER_Y_MAX
    )

    # yaw proxy:
    # 코가 얼굴 좌우 중심에서 얼마나 벗어났는가
    horizontal_face_center_x = (left_face["x"] + right_face["x"]) / 2.0
    yaw_proxy = abs(nose["x"] - horizontal_face_center_x)

    # pitch proxy:
    # 코가 이마-턱 중심에서 위/아래로 얼마나 벗어났는가
    vertical_face_center_y = (forehead["y"] + chin["y"]) / 2.0
    pitch_proxy = abs(nose["y"] - vertical_face_center_y)

    # roll proxy:
    # 양쪽 눈 높이 차이
    left_eye_center_y = (left_eye_top["y"] + left_eye_bottom["y"]) / 2.0
    right_eye_center_y = (right_eye_top["y"] + right_eye_bottom["y"]) / 2.0
    roll_proxy = abs(left_eye_center_y - right_eye_center_y)

    # eye open ratio
    left_eye_height = dist(left_eye_top, left_eye_bottom)
    left_eye_width = dist(left_eye_left, left_eye_right)
    right_eye_height = dist(right_eye_top, right_eye_bottom)
    right_eye_width = dist(right_eye_left, right_eye_right)

    left_eye_open_ratio = safe_ratio(left_eye_height, left_eye_width)
    right_eye_open_ratio = safe_ratio(right_eye_height, right_eye_width)
    eye_open_ratio = (left_eye_open_ratio + right_eye_open_ratio) / 2.0

    # mouth open ratio
    mouth_height = dist(mouth_top, mouth_bottom)
    mouth_width = dist(mouth_left, mouth_right)
    mouth_open_ratio = safe_ratio(mouth_height, mouth_width)

    face_drift = 0.0
    face_size_change = 0.0
    mouth_movement = 0.0

    if prev_points is not None:
        prev_face_metrics = compute_face_metrics_no_temporal(prev_points)

        prev_center = prev_face_metrics["face_center"]
        prev_face_size = prev_face_metrics["face_size"]
        prev_mouth_open_ratio = prev_face_metrics["mouth_open_ratio"]

        face_drift = dist(face_center, prev_center)
        face_size_change = abs(face_size - prev_face_size)
        mouth_movement = abs(mouth_open_ratio - prev_mouth_open_ratio)

    gaze_stable = (
        face_centered
        and yaw_proxy <= YAW_BAD
        and pitch_proxy <= PITCH_BAD
        and roll_proxy <= ROLL_BAD
        and eye_open_ratio >= EYE_OPEN_MIN
    )

    return {
        "face_center": face_center,
        "face_width": face_width,
        "face_height": face_height,
        "face_size": face_size,
        "face_centered": face_centered,

        "yaw_proxy": yaw_proxy,
        "pitch_proxy": pitch_proxy,
        "roll_proxy": roll_proxy,

        "eye_open_ratio": eye_open_ratio,
        "mouth_open_ratio": mouth_open_ratio,
        "mouth_movement": mouth_movement,

        "face_drift": face_drift,
        "face_size_change": face_size_change,

        "gaze_stable": gaze_stable,
    }


def compute_face_metrics_no_temporal(points):
    nose = points["nose_tip"]
    chin = points["chin"]
    left_face = points["left_face"]
    right_face = points["right_face"]
    forehead = points["forehead"]

    mouth_top = points["mouth_top"]
    mouth_bottom = points["mouth_bottom"]
    mouth_left = points["mouth_left"]
    mouth_right = points["mouth_right"]

    face_center = {
        "x": (left_face["x"] + right_face["x"]) / 2.0,
        "y": (forehead["y"] + chin["y"]) / 2.0,
    }

    face_width = dist(left_face, right_face)
    face_height = dist(forehead, chin)
    face_size = face_width * face_height

    mouth_height = dist(mouth_top, mouth_bottom)
    mouth_width = dist(mouth_left, mouth_right)
    mouth_open_ratio = safe_ratio(mouth_height, mouth_width)

    return {
        "face_center": face_center,
        "face_size": face_size,
        "mouth_open_ratio": mouth_open_ratio,
    }


# =========================
# 점수 계산
# =========================

def compute_scores(metric_buffer):
    if not metric_buffer:
        return empty_scores()

    gaze_ratio = average([1.0 if m["gaze_stable"] else 0.0 for m in metric_buffer])
    face_center_ratio = average([1.0 if m["face_centered"] else 0.0 for m in metric_buffer])

    avg_yaw = average([m["yaw_proxy"] for m in metric_buffer])
    avg_pitch = average([m["pitch_proxy"] for m in metric_buffer])
    avg_roll = average([m["roll_proxy"] for m in metric_buffer])
    avg_eye_open = average([m["eye_open_ratio"] for m in metric_buffer])
    avg_mouth_open = average([m["mouth_open_ratio"] for m in metric_buffer])
    avg_mouth_movement = average([m["mouth_movement"] for m in metric_buffer])

    avg_face_drift = average([m["face_drift"] for m in metric_buffer])
    avg_face_size_change = average([m["face_size_change"] for m in metric_buffer])

    avg_body_sway = average([m["body_sway"] for m in metric_buffer])
    avg_shoulder_tilt = average([m["shoulder_tilt"] for m in metric_buffer])

    yaw_score = score_from_penalty(normalize_penalty(avg_yaw, YAW_GOOD, YAW_BAD))
    pitch_score = score_from_penalty(normalize_penalty(avg_pitch, PITCH_GOOD, PITCH_BAD))
    roll_score = score_from_penalty(normalize_penalty(avg_roll, ROLL_GOOD, ROLL_BAD))

    face_drift_score = score_from_penalty(
        normalize_penalty(avg_face_drift, FACE_DRIFT_GOOD, FACE_DRIFT_BAD)
    )

    face_size_score = score_from_penalty(
        normalize_penalty(avg_face_size_change, FACE_SIZE_CHANGE_GOOD, FACE_SIZE_CHANGE_BAD)
    )

    body_sway_score = score_from_penalty(
        normalize_penalty(avg_body_sway, BODY_SWAY_GOOD, BODY_SWAY_BAD)
    )

    shoulder_score = score_from_penalty(
        normalize_penalty(avg_shoulder_tilt, SHOULDER_TILT_GOOD, SHOULDER_TILT_BAD)
    )

    eye_score = 100 if avg_eye_open >= EYE_OPEN_MIN else 60

    # 입 움직임은 "말하고 있는지" proxy라서 너무 강한 점수로 쓰지 않음
    if avg_mouth_open >= MOUTH_OPEN_GOOD_MIN or avg_mouth_movement >= 0.008:
        speaking_score = 100
    elif avg_mouth_open <= MOUTH_OPEN_BAD_MIN and avg_mouth_movement <= 0.003:
        speaking_score = 50
    else:
        speaking_score = 75

    face_center_score = int(round(face_center_ratio * 100))

    gaze_score = int(round(
        0.35 * gaze_ratio * 100
        + 0.25 * face_center_score
        + 0.20 * yaw_score
        + 0.10 * pitch_score
        + 0.10 * eye_score
    ))

    face_stability_score = int(round(
        0.35 * face_drift_score
        + 0.25 * face_size_score
        + 0.20 * roll_score
        + 0.20 * pitch_score
    ))

    posture_score = int(round(
        0.55 * body_sway_score
        + 0.35 * shoulder_score
        + 0.10 * face_size_score
    ))

    overall_score = int(round(
        0.45 * gaze_score
        + 0.30 * posture_score
        + 0.15 * face_stability_score
        + 0.10 * speaking_score
    ))

    return {
        "overall_score": clamp(overall_score, 0, 100),
        "gaze_score": clamp(gaze_score, 0, 100),
        "posture_score": clamp(posture_score, 0, 100),
        "face_stability_score": clamp(face_stability_score, 0, 100),
        "speaking_score": clamp(speaking_score, 0, 100),

        "face_center_score": clamp(face_center_score, 0, 100),
        "yaw_score": clamp(yaw_score, 0, 100),
        "pitch_score": clamp(pitch_score, 0, 100),
        "roll_score": clamp(roll_score, 0, 100),
        "eye_score": clamp(eye_score, 0, 100),
        "body_sway_score": clamp(body_sway_score, 0, 100),
        "shoulder_score": clamp(shoulder_score, 0, 100),

        "avg_yaw": avg_yaw,
        "avg_pitch": avg_pitch,
        "avg_roll": avg_roll,
        "avg_eye_open": avg_eye_open,
        "avg_mouth_open": avg_mouth_open,
        "avg_mouth_movement": avg_mouth_movement,
        "avg_body_sway": avg_body_sway,
        "avg_shoulder_tilt": avg_shoulder_tilt,
        "avg_face_drift": avg_face_drift,
        "avg_face_size_change": avg_face_size_change,
    }


def empty_scores():
    return {
        "overall_score": 0,
        "gaze_score": 0,
        "posture_score": 0,
        "face_stability_score": 0,
        "speaking_score": 0,
        "face_center_score": 0,
        "yaw_score": 0,
        "pitch_score": 0,
        "roll_score": 0,
        "eye_score": 0,
        "body_sway_score": 0,
        "shoulder_score": 0,
    }


def generate_feedback(scores):
    candidates = [
        ("gaze", scores["gaze_score"]),
        ("posture", scores["posture_score"]),
        ("face", scores["face_stability_score"]),
        ("speaking", scores["speaking_score"]),
    ]

    weakest = min(candidates, key=lambda x: x[1])[0]

    if weakest == "gaze" and scores["gaze_score"] < 75:
        if scores["face_center_score"] < 70:
            return "Feedback: Keep your face near the center of the camera."
        if scores["yaw_score"] < 70:
            return "Feedback: Avoid turning your head sideways."
        if scores["pitch_score"] < 70:
            return "Feedback: Avoid looking too far down or up."
        return "Feedback: Maintain steady camera-facing gaze."

    if weakest == "posture" and scores["posture_score"] < 75:
        if scores["shoulder_score"] < 70:
            return "Feedback: Align your shoulders more horizontally."
        if scores["body_sway_score"] < 70:
            return "Feedback: Reduce upper-body swaying."
        return "Feedback: Keep your upper body stable."

    if weakest == "face" and scores["face_stability_score"] < 75:
        if scores["roll_score"] < 70:
            return "Feedback: Keep your head from tilting."
        return "Feedback: Keep your face position stable."

    if weakest == "speaking" and scores["speaking_score"] < 75:
        return "Feedback: Mouth movement is low; check if you are speaking clearly."

    if scores["overall_score"] >= 85:
        return "Feedback: Good interview posture and gaze stability."

    return "Feedback: Overall stable, but slight improvement is possible."


# =========================
# 그리기 함수
# =========================

def draw_bar(frame, label, score, x, y, width=220, height=16):
    score = int(clamp(score, 0, 100))
    filled = int(width * score / 100)

    if score >= 80:
        color = (0, 200, 0)
    elif score >= 60:
        color = (0, 200, 255)
    else:
        color = (0, 0, 255)

    cv2.putText(
        frame,
        f"{label}: {score}",
        (x, y - 8),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (255, 255, 255),
        1,
        cv2.LINE_AA,
    )

    cv2.rectangle(frame, (x, y), (x + width, y + height), (80, 80, 80), -1)
    cv2.rectangle(frame, (x, y), (x + filled, y + height), color, -1)
    cv2.rectangle(frame, (x, y), (x + width, y + height), (220, 220, 220), 1)


def draw_panel(frame, scores, feedback, fps):
    overlay = frame.copy()

    panel_x = 20
    panel_y = 20
    panel_w = 360
    panel_h = 330

    cv2.rectangle(
        overlay,
        (panel_x, panel_y),
        (panel_x + panel_w, panel_y + panel_h),
        (20, 20, 20),
        -1,
    )

    alpha = 0.65
    cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)

    cv2.putText(
        frame,
        "Interview Stability",
        (panel_x + 18, panel_y + 35),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.75,
        (255, 255, 255),
        2,
        cv2.LINE_AA,
    )

    y = panel_y + 70
    draw_bar(frame, "Overall", scores["overall_score"], panel_x + 20, y)
    draw_bar(frame, "Gaze", scores["gaze_score"], panel_x + 20, y + 45)
    draw_bar(frame, "Posture", scores["posture_score"], panel_x + 20, y + 90)
    draw_bar(frame, "FaceStable", scores["face_stability_score"], panel_x + 20, y + 135)
    draw_bar(frame, "Speaking", scores["speaking_score"], panel_x + 20, y + 180)

    cv2.putText(
        frame,
        f"FPS: {fps:.1f}",
        (panel_x + 20, panel_y + 295),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (200, 200, 200),
        1,
        cv2.LINE_AA,
    )

    cv2.putText(
        frame,
        feedback[:45],
        (panel_x + 20, panel_y + 318),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (0, 255, 255),
        1,
        cv2.LINE_AA,
    )


def draw_face_guides(frame, face_metrics):
    h, w, _ = frame.shape

    face_center = face_metrics["face_center"]

    cx = int(face_center["x"] * w)
    cy = int(face_center["y"] * h)

    cv2.circle(frame, (cx, cy), 6, (0, 255, 255), -1)

    x1 = int(FACE_CENTER_X_MIN * w)
    x2 = int(FACE_CENTER_X_MAX * w)
    y1 = int(FACE_CENTER_Y_MIN * h)
    y2 = int(FACE_CENTER_Y_MAX * h)

    cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 255, 0), 2)


def draw_debug_values(frame, scores):
    x = 20
    y = frame.shape[0] - 190
    gap = 22

    debug_lines = [
        f"FaceCenter: {scores['face_center_score']}",
        f"Yaw: {scores['yaw_score']}  Pitch: {scores['pitch_score']}  Roll: {scores['roll_score']}",
        f"Eye: {scores['eye_score']}  Shoulder: {scores['shoulder_score']}",
        f"BodySway: {scores['body_sway_score']}",
    ]

    for i, line in enumerate(debug_lines):
        cv2.putText(
            frame,
            line,
            (x, y + i * gap),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (220, 220, 220),
            1,
            cv2.LINE_AA,
        )


# =========================
# 메인 실행
# =========================

def main():
    mp_pose = mp.solutions.pose
    mp_face_mesh = mp.solutions.face_mesh
    mp_drawing = mp.solutions.drawing_utils

    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    face_mesh = mp_face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_AVFOUNDATION)

    if not cap.isOpened():
        raise RuntimeError("카메라를 열 수 없습니다. 카메라 연결 또는 권한을 확인하세요.")

    prev_time = time.time()
    prev_pose_points = None
    prev_face_points = None
    metric_buffer = deque()

    print("Pose + FaceMesh interview estimator started.")
    print("Press 'q' to quit.")

    while True:
        ret, frame = cap.read()

        if not ret:
            print("프레임을 읽지 못했습니다.")
            break

        frame = cv2.flip(frame, 1)
        current_time = time.time()

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        pose_result = pose.process(rgb)
        face_result = face_mesh.process(rgb)

        fps = 1.0 / max(current_time - prev_time, 1e-6)
        prev_time = current_time

        has_pose = pose_result.pose_landmarks is not None
        has_face = face_result.multi_face_landmarks is not None

        if has_pose and has_face:
            # Pose skeleton은 상체 중심만 볼 것이므로 전체 skeleton은 너무 진하면 지저분함
            mp_drawing.draw_landmarks(
                frame,
                pose_result.pose_landmarks,
                mp_pose.POSE_CONNECTIONS,
                landmark_drawing_spec=mp_drawing.DrawingSpec(color=(120, 120, 120), thickness=1, circle_radius=1),
                connection_drawing_spec=mp_drawing.DrawingSpec(color=(180, 180, 180), thickness=1),
            )

            face_landmarks = face_result.multi_face_landmarks[0]

            # FaceMesh 전체를 다 그리면 너무 지저분하므로 눈/입/얼굴 윤곽 일부만 점으로 표시
            for idx in [
                LEFT_EYE_TOP, LEFT_EYE_BOTTOM, LEFT_EYE_LEFT, LEFT_EYE_RIGHT,
                RIGHT_EYE_TOP, RIGHT_EYE_BOTTOM, RIGHT_EYE_LEFT, RIGHT_EYE_RIGHT,
                MOUTH_TOP, MOUTH_BOTTOM, MOUTH_LEFT, MOUTH_RIGHT,
                NOSE_TIP, CHIN, LEFT_FACE, RIGHT_FACE, FOREHEAD
            ]:
                lm = face_landmarks.landmark[idx]
                px = int(lm.x * frame.shape[1])
                py = int(lm.y * frame.shape[0])
                cv2.circle(frame, (px, py), 2, (0, 0, 255), -1)

            pose_points = extract_pose_points(pose_result.pose_landmarks)
            face_points = extract_face_points(face_landmarks)

            pose_metrics = compute_pose_metrics(pose_points, prev_pose_points)
            face_metrics = compute_face_metrics(face_points, prev_face_points)

            combined_metrics = {
                "time": current_time,
                **pose_metrics,
                **face_metrics,
            }

            metric_buffer.append(combined_metrics)

            while metric_buffer and current_time - metric_buffer[0]["time"] > WINDOW_SECONDS:
                metric_buffer.popleft()

            scores = compute_scores(metric_buffer)
            feedback = generate_feedback(scores)

            draw_face_guides(frame, face_metrics)
            draw_panel(frame, scores, feedback, fps)
            draw_debug_values(frame, scores)

            prev_pose_points = pose_points
            prev_face_points = face_points

        else:
            msg = "No face/pose detected"
            if not has_face and has_pose:
                msg = "Pose detected, but face not detected"
            elif has_face and not has_pose:
                msg = "Face detected, but upper body not detected"

            cv2.putText(
                frame,
                msg,
                (20, 50),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 0, 255),
                2,
                cv2.LINE_AA,
            )

        cv2.imshow("Interview Motion, Gaze, and Face Estimator", frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    pose.close()
    face_mesh.close()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()