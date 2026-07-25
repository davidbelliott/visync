"""Xbox 360 Kinect -> web control-change adapter.

Grabs frames from an Xbox 360 Kinect (via libfreenect) or a regular webcam,
runs MediaPipe Pose on them, and broadcasts four normalized control-change
knobs derived from the tracked body (averaged across everyone in frame, up
to MAX_PEOPLE):

    knob 8  - left/right "steering" turn of the two hands         (hand yaw)
    knob 9  - nodding the head up / down                        (head pitch)
    knob 3  - distance between the two hands
    knob 4  - height of the hands above the ground

Values are normalized to [0, 1] and smoothed, then broadcast on the same
websocket the web client already connects to, exactly like mouse_control.py /
apc40_control.py. Every detected person's full skeleton is also broadcast
raw (see MsgPose) for the frontend's PoseScene to draw.

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
    python kinect_control.py                 # use the Kinect's IR camera
                                              # (works in the dark), debug window
    python kinect_control.py --kinect-rgb    # use the Kinect's RGB camera instead
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

from message import MsgControlChange, MsgPose

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

# Maximum number of people MediaPipe will track at once. Knob values are the
# average of every currently-detected person's raw measurements (see
# average_raw_measurements); each person's full skeleton is broadcast too
# (see MsgPose) for PoseScene to draw one per person. Higher costs more
# per-frame inference time.
MAX_PEOPLE = 4

# Pose detector confidence thresholds. MediaPipe's own default (0.5) rejects
# essentially everything on IR footage: the model was trained on RGB photos,
# so its confidence on grainy, dot-patterned IR video runs much lower even
# for a clear, correctly-posed subject. Lowered so IR mode has a chance to
# report anything at all -- raise back toward 0.5 if it proves too
# permissive (jittery/false detections) once tested on hardware.
POSE_DETECTION_CONFIDENCE = 0.3
POSE_PRESENCE_CONFIDENCE = 0.3
POSE_TRACKING_CONFIDENCE = 0.3

# Gaussian blur kernel (odd, pixels) applied to IR frames before pose
# estimation, to smooth over the Kinect's projected IR dot pattern -- a
# dense, high-frequency texture the RGB-trained model has never seen, which
# likely swamps the silhouette-level features it actually keys on. 0 disables it.
IR_BLUR_KERNEL = 5

# CLAHE (adaptive histogram equalization) applied to IR frames after
# blurring, to lift brightness/contrast. The Kinect's IR illuminator falls
# off with distance (inverse-square), so a subject standing several meters
# back -- typical for this rig, vs. ~1m in hand-held testing -- returns a
# much dimmer, lower-contrast signal. CLAHE works on local tiles rather than
# the whole frame, so it copes with a subject and background sitting at very
# different distances/brightnesses. clip_limit bounds how far any single
# tile's histogram gets stretched (higher = more contrast but noisier);
# tile_grid_size is the tile count per side. 0 clip_limit disables it.
IR_CLAHE_CLIP_LIMIT = 3.0
IR_CLAHE_TILE_GRID = 8

# Knob indices each derived control drives. The WebsocketController on the
# client maps a control-change `wheel_idx` straight onto the knob of the same
# index. Knobs 3 and 4 are what the yellow-robot scene binds (x / y spread),
# which lines up with hand distance / hand height.
YAW_WHEEL_IDX = 8     # wrist-to-wrist "bar" rotation about the vertical axis
PITCH_WHEEL_IDX = 9   # head nod up / down
HAND_DIST_WHEEL_IDX = 3
HAND_HEIGHT_WHEEL_IDX = 4

# Input ranges used to normalize each raw measurement into [0, 1]. Tune these
# from the debug display: the on-screen bars show the normalized value, the
# numbers next to them show the raw measurement feeding the normalization.
YAW_RANGE_DEG = 60.0      # +/- this maps to [0, 1], facing the camera -> 0.5.
                          # Carried over from the old head-yaw range; hands
                          # can likely sweep further -- retune from the debug
                          # display if the knob pegs before a comfortable turn.
PITCH_RANGE_DEG = 40.0    # +/- this maps to [0, 1], level gaze -> 0.5; about
                          # as far as a comfortable nod actually goes
HAND_DIST_MIN_M = 0.25    # wrist-to-wrist with hands pressed together (the
                          # wrists never quite touch, plus pose noise) -> 0
HAND_DIST_MAX_M = 1.3     # a comfortable outstretched span -> 1, kept under a
                          # full wingspan so the knob reliably pegs
HAND_HEIGHT_MAX_M = 2.0   # hands at the floor -> 0, reaching up -> 1

# How much of the camera's normalized [0, 1] field of view maps to, in
# metres, when spreading multiple people's skeletons across frame (see
# frame_offset_m) -- centred, so an X span of 3m means someone at the left
# edge of frame offsets -1.5m and someone at the right edge +1.5m. This is
# an approximation (no real camera calibration/depth-dependent FOV), tuned
# for a plausible few-metres-back framing; retune if people land too
# close/far apart on real footage.
FRAME_SPAN_X_M = 3.0
FRAME_SPAN_Y_M = 2.0

# Exponential-moving-average factor for smoothing the (jittery) per-frame
# values -- each broadcast value is lerp(prev, new, SMOOTHING_ALPHA). Higher
# = snappier but noisier, lower = smoother but laggier. 0.35 converges to a
# step change in ~3 frames (~100ms @ UPDATE_HZ), which reads as snappy more
# than smoothed; halved again (twice as much smoothing) for an even subtler
# feel given IR tracking is noisier than RGB to begin with.
SMOOTHING_ALPHA = 0.075

# MediaPipe Pose landmark indices we use (see the Pose model card).
NOSE = 0
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
# Frame sources. Each yields an (H, W, 3) uint8 frame (RGB, or IR replicated
# across 3 channels), or None if no frame is available this tick.
# ---------------------------------------------------------------------------

class KinectSource:
    """IR (default) or RGB frames from an Xbox 360 Kinect via libfreenect's
    sync API.

    Defaults to the IR camera: the Kinect's structured-light depth sensor
    actively projects an IR dot pattern, so the IR feed stays lit -- and
    MediaPipe Pose keeps a frame to track -- in a fully dark room, unlike the
    RGB camera. Pose accuracy on real IR footage (grainy, dot-patterned,
    out-of-distribution for a model trained on RGB photos) hasn't been
    validated on hardware; pass use_ir=False (--kinect-rgb) to fall back to
    RGB for comparison.
    """

    def __init__(self, use_ir=True):
        import freenect  # imported lazily so --webcam works without it
        self._freenect = freenect
        self.use_ir = use_ir
        self._clahe = None
        if self.use_ir and IR_CLAHE_CLIP_LIMIT > 0:
            import cv2  # lazily, like freenect above
            self._clahe = cv2.createCLAHE(
                clipLimit=IR_CLAHE_CLIP_LIMIT,
                tileGridSize=(IR_CLAHE_TILE_GRID, IR_CLAHE_TILE_GRID))
        # Probe once so a missing/unplugged Kinect fails loudly at startup.
        if self.read() is None:
            raise RuntimeError("Kinect returned no video frame")

    def read(self):
        fmt = self._freenect.VIDEO_IR_8BIT if self.use_ir else self._freenect.VIDEO_RGB
        frame, _timestamp = self._freenect.sync_get_video(format=fmt)
        if frame is None:
            return None
        if self.use_ir:
            # Stay in single-channel space for the preprocessing below;
            # freenect may hand back (H, W) or (H, W, 1).
            if frame.ndim == 3:
                frame = frame[:, :, 0]
            if IR_BLUR_KERNEL > 0:
                import cv2  # lazily, like freenect above
                frame = cv2.GaussianBlur(frame, (IR_BLUR_KERNEL, IR_BLUR_KERNEL), 0)
            if self._clahe is not None:
                # Boosts brightness/contrast; run after the blur so it's
                # stretching the smoothed silhouette signal, not amplifying
                # the raw dot-pattern speckle.
                frame = self._clahe.apply(frame)
            # MediaPipe's Image wrapper (and the RGB path WebcamSource
            # shares with it) expects an (H, W, 3) array; replicate the
            # single channel.
            frame = np.repeat(frame[:, :, None], 3, axis=2)
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


def frame_offset_m(norm_landmarks):
    """Approximate where this person's hip centre sits in the camera's field
    of view, as an (x, y, 0) offset in metres to translate their (already
    hip-centred) world landmarks by -- so PoseScene draws multiple people
    spread out roughly where the camera actually saw them instead of
    stacking every skeleton at the origin. z is left alone: world landmarks
    carry each person's own body-relative depth, not an absolute distance
    from the camera to offset by."""
    norm_x = (norm_landmarks[L_HIP].x + norm_landmarks[R_HIP].x) / 2
    norm_y = (norm_landmarks[L_HIP].y + norm_landmarks[R_HIP].y) / 2
    return np.array([
        (norm_x - 0.5) * FRAME_SPAN_X_M,
        (norm_y - 0.5) * FRAME_SPAN_Y_M,
        0.0,
    ])


def compute_raw_measurements(pts):
    """Derive the four raw measurements (degrees / metres) from one person's
    (33, 3) world-landmark array."""
    # Yaw: rotation about the vertical axis, from the horizontal-plane normal
    # of the wrist-to-wrist line (as if the hands were opposite ends of a
    # bar/wheel) rather than head orientation -- a deliberate arm gesture is
    # far steadier than the small, jittery head turns this replaced. The
    # normal of that line, phase-corrected to be 0 facing the camera (a 90
    # degree rotation and its correction cancel out), reduces to exactly the
    # same atan2(z, x) the line itself would give: 0 facing the camera,
    # growing as the "bar" turns.
    hand_vec = pts[L_WRIST] - pts[R_WRIST]
    yaw_deg = math.degrees(math.atan2(hand_vec[2], hand_vec[0]))
    # Fold the +/-180 ambiguity (hands crossed the other way) onto a +/-90 range.
    if yaw_deg > 90:
        yaw_deg -= 180
    elif yaw_deg < -90:
        yaw_deg += 180

    # Pitch: head nod up / down, from the ear-midpoint -> nose vector. A level
    # gaze has no vertical component; y points down, so nodding down tips the
    # vector to positive y. Positive = nodding down/forward, matching the
    # direction the old torso-lean pitch had.
    head_forward = pts[NOSE] - (pts[L_EAR] + pts[R_EAR]) / 2
    pitch_deg = math.degrees(math.atan2(
        head_forward[1], math.hypot(head_forward[0], head_forward[2])))

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
    }


def average_raw_measurements(raw_list):
    """Arithmetic mean of each field across several people's raw-measurement
    dicts (as returned by compute_raw_measurements). Averaging the derived
    per-person measurements -- not the raw landmark positions -- matters:
    averaging positions would blend different people's hands together into
    a meaningless midpoint, e.g. two people each holding their hands 2m
    apart on opposite sides of frame would average to hands ~0 apart in the
    middle, destroying the actual distance signal."""
    keys = raw_list[0].keys()
    return {k: sum(r[k] for r in raw_list) / len(raw_list) for k in keys}


def normalize_controls(raw):
    """Normalize raw measurements (one person's, or an average across
    several -- see average_raw_measurements) into the [0, 1] knob values.

    Returns a dict of the raw values plus their normalized knob values."""
    yaw_deg = raw['yaw_deg']
    pitch_deg = raw['pitch_deg']
    hand_dist_m = raw['hand_dist_m']
    hand_height_m = raw['hand_height_m']
    return {
        **raw,
        YAW_WHEEL_IDX: clamp01(0.5 + yaw_deg / (2 * YAW_RANGE_DEG)),
        PITCH_WHEEL_IDX: clamp01(0.5 + pitch_deg / (2 * PITCH_RANGE_DEG)),
        HAND_DIST_WHEEL_IDX: clamp01((hand_dist_m - HAND_DIST_MIN_M)
                                     / (HAND_DIST_MAX_M - HAND_DIST_MIN_M)),
        HAND_HEIGHT_WHEEL_IDX: clamp01(hand_height_m / HAND_HEIGHT_MAX_M),
    }


# ---------------------------------------------------------------------------
# Debug display
# ---------------------------------------------------------------------------

def draw_skeleton(cv2, bgr, norm_landmarks):
    """Draw one person's pose skeleton from normalized (image-space)
    landmarks."""
    h, w = bgr.shape[:2]
    pts = [(int(lm.x * w), int(lm.y * h)) for lm in norm_landmarks]
    for a, b in POSE_CONNECTIONS:
        cv2.line(bgr, pts[a], pts[b], (0, 180, 255), 2, cv2.LINE_AA)
    for p in pts:
        cv2.circle(bgr, p, 3, (0, 0, 255), -1, cv2.LINE_AA)


def draw_debug(cv2, frame_rgb, norm_landmarks_list, controls, smoothed):
    """Render the camera frame with every detected person's pose skeleton
    and the (averaged) control bars."""
    bgr = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
    for norm_landmarks in norm_landmarks_list:
        draw_skeleton(cv2, bgr, norm_landmarks)

    rows = [
        (f"knob {YAW_WHEEL_IDX} hand yaw",
         smoothed.get(YAW_WHEEL_IDX),
         f"{controls['yaw_deg']:+5.1f} deg" if controls else ""),
        (f"knob {PITCH_WHEEL_IDX} head pitch",
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
        num_poses=MAX_PEOPLE,
        min_pose_detection_confidence=POSE_DETECTION_CONFIDENCE,
        min_pose_presence_confidence=POSE_PRESENCE_CONFIDENCE,
        min_tracking_confidence=POSE_TRACKING_CONFIDENCE,
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
            norm_landmarks_list = []
            if frame_rgb is not None:
                # detect_for_video needs a monotonically increasing timestamp.
                mp_image = mp.Image(
                    image_format=mp.ImageFormat.SRGB, data=frame_rgb)
                result = landmarker.detect_for_video(
                    mp_image, int(tick * 1000))

                if result.pose_world_landmarks:
                    # One entry per detected person (up to MAX_PEOPLE).
                    pts_list = [landmarks_to_array(person)
                                for person in result.pose_world_landmarks]
                    norm_landmarks_list = result.pose_landmarks
                    raw_list = [compute_raw_measurements(pts) for pts in pts_list]
                    controls = normalize_controls(average_raw_measurements(raw_list))
                    for idx in (YAW_WHEEL_IDX, PITCH_WHEEL_IDX,
                                HAND_DIST_WHEEL_IDX, HAND_HEIGHT_WHEEL_IDX):
                        prev = smoothed.get(idx, controls[idx])
                        smoothed[idx] = (SMOOTHING_ALPHA * controls[idx]
                                         + (1 - SMOOTHING_ALPHA) * prev)

                    # Raw (unsmoothed) skeletons, one per detected person,
                    # sent only on frames a pose is actually retrieved --
                    # unlike the knob broadcast below, which repeats the
                    # last-good value every tick. Offset each person's
                    # (hip-centred) world landmarks by roughly where they
                    # stand in the camera's field of view -- pts_list itself
                    # stays untouched (the control math above is translation
                    # invariant, but there's no reason to risk it).
                    positioned_pts_list = [
                        pts + frame_offset_m(norm_landmarks)
                        for pts, norm_landmarks in zip(pts_list, norm_landmarks_list)
                    ]
                    pose_msg = MsgPose(
                        last_msg_latency,
                        [pts.tolist() for pts in positioned_pts_list])
                    websockets.broadcast(connected, pose_msg.to_json())

                # Broadcast every tick once we have values (like mouse_control)
                # so a freshly-connected client gets the current pose promptly.
                for idx, value in smoothed.items():
                    websockets.broadcast(
                        connected,
                        MsgControlChange(last_msg_latency, idx, value).to_json())

                if debug:
                    key = draw_debug(cv2, frame_rgb, norm_landmarks_list,
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


def make_source(use_webcam, webcam_index, kinect_use_ir=True):
    if use_webcam:
        import cv2
        print(f"Using webcam {webcam_index}")
        return WebcamSource(webcam_index, cv2)
    try:
        print(f"Using Xbox 360 Kinect (libfreenect, {'IR' if kinect_use_ir else 'RGB'} camera)")
        return KinectSource(use_ir=kinect_use_ir)
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
    parser.add_argument('--kinect-rgb', action='store_true',
                        help='use the Kinect RGB camera instead of IR '
                             '(IR is the default so tracking keeps working '
                             'in the dark; RGB is here for comparison)')
    parser.add_argument('--no-debug', action='store_true',
                        help='do not open the OpenCV debug window')
    args = parser.parse_args()

    source = make_source(args.webcam, args.webcam_index,
                         kinect_use_ir=not args.kinect_rgb)
    try:
        async with websockets.serve(handler, "0.0.0.0", WS_PORT):
            print(f'Serving on ws://0.0.0.0:{WS_PORT} '
                  f'(hand yaw -> knob {YAW_WHEEL_IDX}, '
                  f'head pitch -> knob {PITCH_WHEEL_IDX}, '
                  f'hand dist -> knob {HAND_DIST_WHEEL_IDX}, '
                  f'hand height -> knob {HAND_HEIGHT_WHEEL_IDX})')
            await main_loop(source, debug=not args.no_debug)
    finally:
        source.close()


if __name__ == "__main__":
    asyncio.run(main())
