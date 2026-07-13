"""Xbox 360 Kinect -> web control-change adapter.

Grabs RGB frames from an Xbox 360 Kinect (via libfreenect) or a regular
webcam, runs MediaPipe Pose on them, and broadcasts four normalized
control-change knobs derived from the tracked body:

    knob 8  - left/right rotation of the head                   (head yaw)
    knob 9  - bending forward / back                            (torso pitch)
    knob 3  - distance between the two hands
    knob 4  - height of the hands above the ground

Values are normalized to [0, 1] and smoothed, then broadcast on the same
websocket the web client already connects to, exactly like mouse_control.py /
apc40_control.py.

Hardware / install notes (macOS):
  - The Xbox 360 Kinect talks to the host through libfreenect (the OpenKinect
    project). Install the native library and its Python wrapper:
        brew install libfreenect
        pip install freenect            # or build the wrapper from the
                                        # libfreenect source 'wrappers/python'
    If freenect isn't importable the script falls back to --webcam so the pose
    / control math can still be developed and tuned without the Kinect.
  - Pose estimation and the debug display need:
        pip install mediapipe opencv-python numpy
    This uses MediaPipe's Tasks API (PoseLandmarker), which is what current
    mediapipe wheels ship (the older mp.solutions.pose API is gone on newer
    Python). The .task model file is downloaded automatically on first run.

Run:
    python kinect_control.py                 # use the Kinect, show debug window
    python kinect_control.py --webcam        # use the default webcam instead
    python kinect_control.py --no-debug      # headless, no OpenCV window
"""

import argparse
import asyncio
import json
import math
import pathlib
import time
import urllib.request

import numpy as np
import websockets

from message import MsgControlChange

# Same websocket port the web client connects to (mirrors mouse_control.py /
# adapter.py), so the client connects here unchanged.
WS_PORT = 8766

# MediaPipe Tasks PoseLandmarker model. Downloaded next to this script on first
# run if missing. "full" is a good speed/accuracy tradeoff; swap the URL for
# pose_landmarker_lite / pose_landmarker_heavy to trade accuracy for speed.
MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
             "pose_landmarker_full/float16/latest/pose_landmarker_full.task")
MODEL_PATH = pathlib.Path(__file__).parent / "pose_landmarker_full.task"

# How often we grab a frame, run pose estimation and broadcast, in Hz. Pose
# inference is the real limiter; this just caps the loop.
UPDATE_HZ = 30

# Knob indices each derived control drives. The WebsocketController on the
# client maps a control-change `wheel_idx` straight onto the knob of the same
# index. Knobs 3 and 4 are what the yellow-robot scene binds (x / y spread),
# which lines up with hand distance / hand height.
YAW_WHEEL_IDX = 8     # head rotation about the vertical axis
PITCH_WHEEL_IDX = 9   # bending forward / back
HAND_DIST_WHEEL_IDX = 3
HAND_HEIGHT_WHEEL_IDX = 4

# Input ranges used to normalize each raw measurement into [0, 1]. Tune these
# from the debug display: the on-screen bars show the normalized value, the
# numbers next to them show the raw measurement feeding the normalization.
YAW_RANGE_DEG = 60.0      # +/- this maps to [0, 1], facing the camera -> 0.5;
                          # tighter than a body turn since the head only
                          # rotates so far before the shoulders follow
PITCH_RANGE_DEG = 45.0    # +/- this maps to [0, 1], upright -> 0.5
HAND_DIST_MAX_M = 1.6     # hands together -> 0, full span -> 1
HAND_HEIGHT_MAX_M = 2.0   # hands at the floor -> 0, reaching up -> 1

# Exponential-moving-average factor for smoothing the (jittery) per-frame
# values. Higher = snappier but noisier, lower = smoother but laggier.
SMOOTHING_ALPHA = 0.35

# MediaPipe Pose landmark indices we use (see the Pose model card).
L_EAR, R_EAR = 7, 8
L_SHOULDER, R_SHOULDER = 11, 12
L_WRIST, R_WRIST = 15, 16
L_HIP, R_HIP = 23, 24
L_FOOT, R_FOOT = 31, 32  # foot index (toe) landmarks, our "ground" reference

# The standard 33-landmark pose skeleton edges, for drawing the debug overlay
# ourselves (the Tasks API has no drawing helper like the old solutions one).
POSE_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6), (6, 8), (9, 10),
    (11, 12), (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19),
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (27, 29), (27, 31), (29, 31),
    (24, 26), (26, 28), (28, 30), (28, 32), (30, 32),
]


# Connected viewer clients (mirrors adapter.py / mouse_control.py).
connected = set()

# Last message's roundtrip latency divided by two, in seconds. Updated from the
# ack messages clients send back.
last_msg_latency = 0.0


async def handler(websocket):
    global last_msg_latency
    connected.add(websocket)
    print("Client connected")
    try:
        async for message in websocket:
            msg = json.loads(message)
            last_msg_latency = (time.time() - msg['t']) / 2
    finally:
        connected.remove(websocket)
        print("Client disconnected")


def clamp01(v):
    return min(1.0, max(0.0, v))


# ---------------------------------------------------------------------------
# Frame sources. Each yields an RGB (H, W, 3) uint8 frame, or None if no frame
# is available this tick.
# ---------------------------------------------------------------------------

class KinectSource:
    """RGB frames from an Xbox 360 Kinect via libfreenect's sync API."""

    def __init__(self):
        import freenect  # imported lazily so --webcam works without it
        self._freenect = freenect
        # Probe once so a missing/unplugged Kinect fails loudly at startup.
        frame, _ = freenect.sync_get_video()
        if frame is None:
            raise RuntimeError("Kinect returned no video frame")

    def read(self):
        frame, _timestamp = self._freenect.sync_get_video()
        # freenect already returns RGB uint8 (H, W, 3).
        return frame

    def close(self):
        self._freenect.sync_stop()


class WebcamSource:
    """RGB frames from a regular webcam via OpenCV (development fallback)."""

    def __init__(self, index, cv2):
        self._cv2 = cv2
        self._cap = cv2.VideoCapture(index)
        if not self._cap.isOpened():
            raise RuntimeError(f"Could not open webcam {index}")

    def read(self):
        ok, bgr = self._cap.read()
        if not ok:
            return None
        return self._cv2.cvtColor(bgr, self._cv2.COLOR_BGR2RGB)

    def close(self):
        self._cap.release()


# ---------------------------------------------------------------------------
# Pose -> control values
# ---------------------------------------------------------------------------

def landmarks_to_array(world_landmarks):
    """MediaPipe world landmarks (a list of 33 landmarks) -> (33, 3) array of
    metres.

    World-landmark axes: origin at the hip centre, x to the image right, y
    pointing down, z toward the camera (smaller = closer)."""
    return np.array([[lm.x, lm.y, lm.z] for lm in world_landmarks])


def compute_controls(pts):
    """Derive the four raw measurements from a (33, 3) world-landmark array.

    Returns a dict of raw values plus their normalized [0, 1] knob values."""
    shoulder_mid = (pts[L_SHOULDER] + pts[R_SHOULDER]) / 2
    hip_mid = (pts[L_HIP] + pts[R_HIP]) / 2

    # Yaw: head rotation about the vertical axis, from the ear-to-ear line
    # (so turning just the head steers it, independent of the body). The ear
    # line lies along x when facing the camera; as the head turns, it acquires
    # a z component. atan2(z, x) is 0 facing the camera and grows as you turn.
    ear_vec = pts[L_EAR] - pts[R_EAR]
    yaw_deg = math.degrees(math.atan2(ear_vec[2], ear_vec[0]))
    # Fold the +/-180 ambiguity (facing toward vs away) onto a +/-90 range.
    if yaw_deg > 90:
        yaw_deg -= 180
    elif yaw_deg < -90:
        yaw_deg += 180

    # Pitch: bending forward / back. The torso vector points up (negative y)
    # when upright; leaning tilts it in z. Positive z (toward camera) = forward.
    torso = shoulder_mid - hip_mid
    pitch_deg = math.degrees(math.atan2(torso[2], -torso[1]))

    # Distance between the hands, in metres (3D wrist-to-wrist).
    hand_dist_m = float(np.linalg.norm(pts[L_WRIST] - pts[R_WRIST]))

    # Hand height above the ground. y points down, so the feet have the largest
    # y; height is (foot y) - (mean wrist y).
    ground_y = max(pts[L_FOOT][1], pts[R_FOOT][1])
    mean_wrist_y = (pts[L_WRIST][1] + pts[R_WRIST][1]) / 2
    hand_height_m = float(ground_y - mean_wrist_y)

    return {
        'yaw_deg': yaw_deg,
        'pitch_deg': pitch_deg,
        'hand_dist_m': hand_dist_m,
        'hand_height_m': hand_height_m,
        YAW_WHEEL_IDX: clamp01(0.5 + yaw_deg / (2 * YAW_RANGE_DEG)),
        PITCH_WHEEL_IDX: clamp01(0.5 + pitch_deg / (2 * PITCH_RANGE_DEG)),
        HAND_DIST_WHEEL_IDX: clamp01(hand_dist_m / HAND_DIST_MAX_M),
        HAND_HEIGHT_WHEEL_IDX: clamp01(hand_height_m / HAND_HEIGHT_MAX_M),
    }


# ---------------------------------------------------------------------------
# Debug display
# ---------------------------------------------------------------------------

def draw_skeleton(cv2, bgr, norm_landmarks):
    """Draw the pose skeleton from normalized (image-space) landmarks."""
    h, w = bgr.shape[:2]
    pts = [(int(lm.x * w), int(lm.y * h)) for lm in norm_landmarks]
    for a, b in POSE_CONNECTIONS:
        cv2.line(bgr, pts[a], pts[b], (0, 180, 255), 2, cv2.LINE_AA)
    for p in pts:
        cv2.circle(bgr, p, 3, (0, 0, 255), -1, cv2.LINE_AA)


def draw_debug(cv2, frame_rgb, norm_landmarks, controls, smoothed):
    """Render the camera frame with the pose skeleton and the control bars."""
    bgr = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
    if norm_landmarks is not None:
        draw_skeleton(cv2, bgr, norm_landmarks)

    rows = [
        (f"knob {YAW_WHEEL_IDX} head yaw",
         smoothed.get(YAW_WHEEL_IDX),
         f"{controls['yaw_deg']:+5.1f} deg" if controls else ""),
        (f"knob {PITCH_WHEEL_IDX} pitch",
         smoothed.get(PITCH_WHEEL_IDX),
         f"{controls['pitch_deg']:+5.1f} deg" if controls else ""),
        (f"knob {HAND_DIST_WHEEL_IDX} hand dist",
         smoothed.get(HAND_DIST_WHEEL_IDX),
         f"{controls['hand_dist_m']:.2f} m" if controls else ""),
        (f"knob {HAND_HEIGHT_WHEEL_IDX} hand height",
         smoothed.get(HAND_HEIGHT_WHEEL_IDX),
         f"{controls['hand_height_m']:.2f} m" if controls else ""),
    ]

    x0, y0, bar_w, bar_h, gap = 10, 20, 200, 18, 30
    for i, (label, value, raw) in enumerate(rows):
        y = y0 + i * gap
        bx = x0 + 170
        cv2.rectangle(bgr, (bx, y - bar_h + 4), (bx + bar_w, y + 4),
                      (60, 60, 60), 1)
        if value is not None:
            fill = int(bar_w * clamp01(value))
            cv2.rectangle(bgr, (bx, y - bar_h + 4), (bx + fill, y + 4),
                          (0, 200, 0), -1)
        text = f"{label}: {value:.2f}  {raw}" if value is not None else f"{label}: --"
        cv2.putText(bgr, text, (x0, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (255, 255, 255), 1, cv2.LINE_AA)

    cv2.imshow("kinect_control (q to quit)", bgr)
    return cv2.waitKey(1) & 0xFF


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def ensure_model():
    """Download the PoseLandmarker .task model next to this script if absent."""
    if MODEL_PATH.exists():
        return
    print(f"Downloading pose model -> {MODEL_PATH.name} ...")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    print("Pose model downloaded")


def make_landmarker():
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    ensure_model()
    options = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
    )
    return mp, vision.PoseLandmarker.create_from_options(options)


async def main_loop(source, debug):
    import cv2

    mp, landmarker = make_landmarker()

    # Smoothed knob values, keyed by wheel index, persisted across frames.
    smoothed = {}
    period = 1.0 / UPDATE_HZ

    try:
        while True:
            tick = time.time()
            frame_rgb = source.read()
            controls = None
            norm_landmarks = None
            if frame_rgb is not None:
                # detect_for_video needs a monotonically increasing timestamp.
                mp_image = mp.Image(
                    image_format=mp.ImageFormat.SRGB, data=frame_rgb)
                result = landmarker.detect_for_video(
                    mp_image, int(tick * 1000))

                if result.pose_world_landmarks:
                    # num_poses=1, so we only ever look at the first person.
                    pts = landmarks_to_array(result.pose_world_landmarks[0])
                    norm_landmarks = result.pose_landmarks[0]
                    controls = compute_controls(pts)
                    for idx in (YAW_WHEEL_IDX, PITCH_WHEEL_IDX,
                                HAND_DIST_WHEEL_IDX, HAND_HEIGHT_WHEEL_IDX):
                        prev = smoothed.get(idx, controls[idx])
                        smoothed[idx] = (SMOOTHING_ALPHA * controls[idx]
                                         + (1 - SMOOTHING_ALPHA) * prev)

                # Broadcast every tick once we have values (like mouse_control)
                # so a freshly-connected client gets the current pose promptly.
                for idx, value in smoothed.items():
                    websockets.broadcast(
                        connected,
                        MsgControlChange(last_msg_latency, idx, value).to_json())

                if debug:
                    key = draw_debug(cv2, frame_rgb, norm_landmarks,
                                     controls, smoothed)
                    if key in (ord('q'), 27):  # q or Esc
                        break

            # Yield to the event loop (services websocket acks) and pace the
            # loop to roughly UPDATE_HZ.
            await asyncio.sleep(max(0.0, period - (time.time() - tick)))
    finally:
        landmarker.close()
        if debug:
            cv2.destroyAllWindows()


def make_source(use_webcam, webcam_index):
    if use_webcam:
        import cv2
        print(f"Using webcam {webcam_index}")
        return WebcamSource(webcam_index, cv2)
    try:
        print("Using Xbox 360 Kinect (libfreenect)")
        return KinectSource()
    except Exception as e:
        import cv2
        print(f"Kinect unavailable ({e}); falling back to webcam {webcam_index}")
        return WebcamSource(webcam_index, cv2)


async def main():
    parser = argparse.ArgumentParser(
        description="Xbox 360 Kinect pose -> web control-change adapter")
    parser.add_argument('--webcam', action='store_true',
                        help='use the default webcam instead of the Kinect')
    parser.add_argument('--webcam-index', type=int, default=0,
                        help='OpenCV webcam index (default 0)')
    parser.add_argument('--no-debug', action='store_true',
                        help='do not open the OpenCV debug window')
    args = parser.parse_args()

    source = make_source(args.webcam, args.webcam_index)
    try:
        async with websockets.serve(handler, "0.0.0.0", WS_PORT):
            print(f'Serving on ws://0.0.0.0:{WS_PORT} '
                  f'(head yaw -> knob {YAW_WHEEL_IDX}, '
                  f'pitch -> knob {PITCH_WHEEL_IDX}, '
                  f'hand dist -> knob {HAND_DIST_WHEEL_IDX}, '
                  f'hand height -> knob {HAND_HEIGHT_WHEEL_IDX})')
            await main_loop(source, debug=not args.no_debug)
    finally:
        source.close()


if __name__ == "__main__":
    asyncio.run(main())
