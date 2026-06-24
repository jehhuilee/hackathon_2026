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

# 피드백 안정화 설정
# - MIN_FEEDBACK_HOLD_SECONDS: 한 번 표시된 피드백을 최소 이 시간만큼 유지 (깜빡임 방지)
# - FEEDBACK_CONFIRM_SECONDS: 새로운 피드백이 이 시간만큼 연속으로 유지될 때만 교체 (디바운스)
MIN_FEEDBACK_HOLD_SECONDS = 0.8
FEEDBACK_CONFIRM_SECONDS = 0.3

# 히스테리시스 설정 (임계값 근처 진동 방지)
# - 점수가 ENTER 아래로 떨어지면 해당 항목 경고 시작
# - 점수가 EXIT 위로 올라가야 경고 해제
# - ENTER < EXIT 사이가 데드존이라 경계에서 왔다갔다해도 상태가 안 바뀜
FEEDBACK_ENTER_THRESHOLD = 72
FEEDBACK_EXIT_THRESHOLD = 80

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

# roll은 두 눈을 잇는 선의 기울기 각도(도, degree)로 측정한다. 얼굴 크기와 무관.
ROLL_GOOD = 3.0
ROLL_BAD = 14.0

FACE_DRIFT_GOOD = 0.004
FACE_DRIFT_BAD = 0.030

FACE_SIZE_CHANGE_GOOD = 0.003
FACE_SIZE_CHANGE_BAD = 0.030

SHOULDER_TILT_GOOD = 0.035
SHOULDER_TILT_BAD = 0.140

BODY_SWAY_GOOD = 0.005
BODY_SWAY_BAD = 0.030

EYE_OPEN_MIN = 0.13
MOUTH_OPEN_GOOD_MIN = 0.03
MOUTH_OPEN_BAD_MIN = 0.005

# 손 동작 판단
# - 손이 얼굴 근처로 올라오거나(가림) 카메라에 가까이 들이댄 경우에만 경고한다.
# - 손을 자연스럽게 내려놓은 상태에서는 경고하지 않는다 (오탐 방지).
# HAND_NEAR_FACE_DIST_RATIO: 손 중심-얼굴 중심 거리가 (얼굴 대각선 * 이 값) 이내면 "얼굴 가림"
HAND_NEAR_FACE_DIST_RATIO = 0.75
# HAND_CLOSE_SIZE_RATIO: 손 크기가 (얼굴 대각선 * 이 값) 이상이면 "카메라에 가까이 들이댐"
HAND_CLOSE_SIZE_RATIO = 0.85


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
    # 두 눈 중심을 잇는 선이 수평에서 얼마나 기울었는지(각도, degree)
    # 단순 y 높이 차이는 얼굴이 멀면 과소평가되므로, 눈 간 거리로 정규화되는 각도를 쓴다.
    left_eye_center = {
        "x": (left_eye_left["x"] + left_eye_right["x"]) / 2.0,
        "y": (left_eye_top["y"] + left_eye_bottom["y"]) / 2.0,
    }
    right_eye_center = {
        "x": (right_eye_left["x"] + right_eye_right["x"]) / 2.0,
        "y": (right_eye_top["y"] + right_eye_bottom["y"]) / 2.0,
    }
    eye_dx = right_eye_center["x"] - left_eye_center["x"]
    eye_dy = right_eye_center["y"] - left_eye_center["y"]
    roll_proxy = abs(math.degrees(math.atan2(eye_dy, eye_dx)))

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
# Hands 기반 손 가림/근접 지표
# =========================

def compute_hand_metrics(multi_hand_landmarks, face_metrics):
    """
    손이 얼굴/몸을 가리거나 카메라에 가까이 들이댄 상태를 판단한다.
    - 손이 안 보이거나 자연스럽게 내려놓은 상태: 가림 아님 (block=False)
    - 손이 얼굴 근처로 올라옴 OR 손이 카메라에 가까워서 비정상적으로 큼: 가림 (block=True)
    반환: num_hands, hand_near_face, hand_close, hand_block
    """
    result = {
        "num_hands": 0,
        "hand_near_face": False,
        "hand_close": False,
        "hand_block": False,
    }

    if not multi_hand_landmarks:
        return result

    face_center = face_metrics["face_center"]
    face_width = face_metrics["face_width"]
    face_height = face_metrics["face_height"]
    face_diag = math.sqrt(face_width * face_width + face_height * face_height)

    if face_diag <= 1e-6:
        return result

    near_face = False
    close = False

    for hand in multi_hand_landmarks:
        xs = [lm.x for lm in hand.landmark]
        ys = [lm.y for lm in hand.landmark]

        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)

        hand_width = max_x - min_x
        hand_height = max_y - min_y
        hand_diag = math.sqrt(hand_width * hand_width + hand_height * hand_height)

        hand_center_x = (min_x + max_x) / 2.0
        hand_center_y = (min_y + max_y) / 2.0

        dist_to_face = math.hypot(
            hand_center_x - face_center["x"],
            hand_center_y - face_center["y"],
        )

        # 손이 얼굴 중심 근처까지 올라옴 -> 얼굴/상체 가림
        if dist_to_face <= HAND_NEAR_FACE_DIST_RATIO * face_diag:
            near_face = True

        # 손이 얼굴 대비 비정상적으로 큼 -> 카메라에 가까이 들이댐
        if hand_diag >= HAND_CLOSE_SIZE_RATIO * face_diag:
            close = True

    result["num_hands"] = len(multi_hand_landmarks)
    result["hand_near_face"] = near_face
    result["hand_close"] = close
    result["hand_block"] = near_face or close
    return result


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

    hand_block_ratio = average([1.0 if m.get("hand_block") else 0.0 for m in metric_buffer])

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

    # 손이 가린 시간 비율이 높을수록 점수가 낮아진다.
    hand_score = int(round((1.0 - hand_block_ratio) * 100))

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
        0.40 * gaze_score
        + 0.27 * posture_score
        + 0.13 * face_stability_score
        + 0.10 * speaking_score
        + 0.10 * hand_score
    ))

    return {
        "overall_score": clamp(overall_score, 0, 100),
        "gaze_score": clamp(gaze_score, 0, 100),
        "posture_score": clamp(posture_score, 0, 100),
        "face_stability_score": clamp(face_stability_score, 0, 100),
        "speaking_score": clamp(speaking_score, 0, 100),
        "hand_score": clamp(hand_score, 0, 100),

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
        "hand_score": 100,
        "face_center_score": 0,
        "yaw_score": 0,
        "pitch_score": 0,
        "roll_score": 0,
        "eye_score": 0,
        "body_sway_score": 0,
        "shoulder_score": 0,
    }


def category_score(scores, key):
    return {
        "gaze": scores["gaze_score"],
        "posture": scores["posture_score"],
        "face": scores["face_stability_score"],
        "roll": scores["roll_score"],
        "speaking": scores["speaking_score"],
        "hands": scores["hand_score"],
    }[key]


def category_message(scores, key):
    if key == "gaze":
        if scores["face_center_score"] < 70:
            return "Feedback: Keep your face near the center of the camera."
        if scores["yaw_score"] < 70:
            return "Feedback: Avoid turning your head sideways."
        if scores["pitch_score"] < 70:
            return "Feedback: Avoid looking too far down or up."
        return "Feedback: Maintain steady camera-facing gaze."

    if key == "posture":
        if scores["shoulder_score"] < 70:
            return "Feedback: Align your shoulders more horizontally."
        if scores["body_sway_score"] < 70:
            return "Feedback: Reduce upper-body swaying."
        return "Feedback: Keep your upper body stable."

    if key == "face":
        return "Feedback: Keep your face position stable."

    if key == "roll":
        return "Feedback: Level your head; it is tilted to one side."

    if key == "speaking":
        return "Feedback: Mouth movement is low; check if you are speaking clearly."

    if key == "hands":
        if scores["hand_score"] < 40:
            return "Feedback: Lower your hands; they block the camera."
        return "Feedback: Lower your hands and reset your posture."

    return "Feedback: Overall stable, but slight improvement is possible."


class FeedbackEngine:
    """
    카테고리(gaze/posture/face/speaking)별로 히스테리시스를 적용해
    임계값 근처에서 피드백이 진동하는 것을 막는다.
    - 점수가 ENTER 아래로 떨어지면 그 항목을 '경고 중' 상태로 켠다.
    - 점수가 EXIT 위로 올라가야 경고를 끈다 (ENTER < EXIT 사이는 데드존).
    - 현재 경고 중인 항목들 중 가장 약한 항목으로 메시지를 만든다.
    """

    CATEGORY_KEYS = ["gaze", "posture", "face", "roll", "speaking", "hands"]

    def __init__(self, enter_threshold, exit_threshold):
        self.enter_threshold = enter_threshold
        self.exit_threshold = exit_threshold
        self.warning = {key: False for key in self.CATEGORY_KEYS}

    def update(self, scores):
        for key in self.CATEGORY_KEYS:
            s = category_score(scores, key)
            if self.warning[key]:
                if s >= self.exit_threshold:
                    self.warning[key] = False
            else:
                if s < self.enter_threshold:
                    self.warning[key] = True

        active = [
            (key, category_score(scores, key))
            for key in self.CATEGORY_KEYS
            if self.warning[key]
        ]

        if not active:
            if scores["overall_score"] >= 85:
                return "Feedback: Good interview posture and gaze stability."
            return "Feedback: Overall stable, but slight improvement is possible."

        weakest = min(active, key=lambda x: x[1])[0]
        return category_message(scores, weakest)


# =========================
# 피드백 안정화
# =========================

class FeedbackStabilizer:
    """
    매 프레임 바뀌는 raw 피드백을 받아서, 화면에 표시할 안정화된 피드백을 돌려준다.
    - 현재 피드백은 최소 MIN_FEEDBACK_HOLD_SECONDS 동안 유지된다.
    - 그 시간이 지난 뒤에도, 새 후보가 FEEDBACK_CONFIRM_SECONDS 동안 연속으로
      유지될 때에만 실제로 교체된다 (순간적인 깜빡임 무시).
    """

    def __init__(self, min_hold_seconds, confirm_seconds):
        self.min_hold_seconds = min_hold_seconds
        self.confirm_seconds = confirm_seconds

        self.current = None          # 현재 화면에 표시 중인 피드백
        self.current_since = 0.0     # 현재 피드백이 표시되기 시작한 시각

        self.candidate = None        # 교체 대기 중인 새 후보
        self.candidate_since = 0.0   # 후보가 처음 등장한 시각

    def update(self, raw_feedback, now):
        # 최초 1회는 즉시 표시
        if self.current is None:
            self.current = raw_feedback
            self.current_since = now
            self.candidate = None
            return self.current

        # 지금 들어온 피드백이 이미 표시 중인 것과 같으면 후보 상태 초기화
        if raw_feedback == self.current:
            self.candidate = None
            return self.current

        # 최소 유지 시간을 아직 못 채웠으면 무조건 현재 유지
        if now - self.current_since < self.min_hold_seconds:
            return self.current

        # 새 후보 추적 (디바운스)
        if raw_feedback != self.candidate:
            self.candidate = raw_feedback
            self.candidate_since = now
            return self.current

        # 같은 후보가 confirm_seconds 동안 유지되면 교체
        if now - self.candidate_since >= self.confirm_seconds:
            self.current = self.candidate
            self.current_since = now
            self.candidate = None

        return self.current


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
    panel_h = 375

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
    draw_bar(frame, "Hands", scores["hand_score"], panel_x + 20, y + 225)

    cv2.putText(
        frame,
        f"FPS: {fps:.1f}",
        (panel_x + 20, panel_y + 340),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (200, 200, 200),
        1,
        cv2.LINE_AA,
    )

    cv2.putText(
        frame,
        feedback[:55],
        (panel_x + 20, panel_y + 363),
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
        f"BodySway: {scores['body_sway_score']}  Hand: {scores['hand_score']}",
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
    mp_hands = mp.solutions.hands
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

    hands = mp_hands.Hands(
        static_image_mode=False,
        max_num_hands=2,
        model_complexity=0,
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

    feedback_engine = FeedbackEngine(
        FEEDBACK_ENTER_THRESHOLD,
        FEEDBACK_EXIT_THRESHOLD,
    )

    feedback_stabilizer = FeedbackStabilizer(
        MIN_FEEDBACK_HOLD_SECONDS,
        FEEDBACK_CONFIRM_SECONDS,
    )

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
        hands_result = hands.process(rgb)

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

            multi_hand_landmarks = hands_result.multi_hand_landmarks
            hand_metrics = compute_hand_metrics(multi_hand_landmarks, face_metrics)

            # 손이 가림으로 판단된 경우에만 빨간색, 평소엔 연한 색으로 표시
            if multi_hand_landmarks:
                hand_color = (0, 0, 255) if hand_metrics["hand_block"] else (160, 160, 160)
                for hand_landmarks in multi_hand_landmarks:
                    mp_drawing.draw_landmarks(
                        frame,
                        hand_landmarks,
                        mp_hands.HAND_CONNECTIONS,
                        landmark_drawing_spec=mp_drawing.DrawingSpec(color=hand_color, thickness=1, circle_radius=1),
                        connection_drawing_spec=mp_drawing.DrawingSpec(color=hand_color, thickness=1),
                    )

            combined_metrics = {
                "time": current_time,
                **pose_metrics,
                **face_metrics,
                **hand_metrics,
            }

            metric_buffer.append(combined_metrics)

            while metric_buffer and current_time - metric_buffer[0]["time"] > WINDOW_SECONDS:
                metric_buffer.popleft()

            scores = compute_scores(metric_buffer)
            raw_feedback = feedback_engine.update(scores)
            feedback = feedback_stabilizer.update(raw_feedback, current_time)

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
    hands.close()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()