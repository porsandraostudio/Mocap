"""Frame-by-frame CSRT box tracker, matching PATHOS mocap 1.2.2-beta."""

from __future__ import annotations

from typing import Callable, Optional

import cv2

# Optional callback: progress(frames_done, frames_total, last_sample_preview | None)
ProgressCallback = Optional[Callable[..., None]]

# mocap_beta.exe Camera.grab_frame: imutils.resize when a side exceeds 640.
EXE_MAX_SIDE = 640


def exe_frame_size(width: int, height: int, max_side: int = EXE_MAX_SIDE) -> tuple[int, int]:
    """Return the size the desktop app would track at (imutils.resize, INTER_AREA)."""
    width, height = int(width), int(height)
    if height > max_side:
        ratio = max_side / float(height)
        width, height = int(width * ratio), max_side
    if width > max_side:
        ratio = max_side / float(width)
        height, width = int(height * ratio), max_side
    return max(1, width), max(1, height)


def resize_like_exe(frame, max_side: int = EXE_MAX_SIDE):
    """Same sequential height-then-width shrink as mocap_beta.exe / imutils.resize."""
    height, width = frame.shape[:2]
    if height > max_side:
        ratio = max_side / float(height)
        frame = cv2.resize(
            frame,
            (int(width * ratio), max_side),
            interpolation=cv2.INTER_AREA,
        )
        height, width = frame.shape[:2]
    if width > max_side:
        ratio = max_side / float(width)
        frame = cv2.resize(
            frame,
            (max_side, int(height * ratio)),
            interpolation=cv2.INTER_AREA,
        )
    return frame


def scale_bbox(bbox, src_w: int, src_h: int, dst_w: int, dst_h: int) -> tuple[int, int, int, int]:
    """Map a box between native video pixels and the exe tracking frame."""
    sx = dst_w / src_w if src_w else 1.0
    sy = dst_h / src_h if src_h else 1.0
    x, y, box_w, box_h = bbox
    return (
        int(x * sx),
        int(y * sy),
        max(1, int(box_w * sx)),
        max(1, int(box_h * sy)),
    )


def _clamp_bbox(bbox, frame_shape) -> tuple[int, int, int, int]:
    """Clamp [x, y, w, h] to the frame using int() truncation like the exe."""
    frame_h, frame_w = frame_shape[:2]
    x, y, box_w, box_h = (int(v) for v in bbox)
    x = max(0, min(x, max(0, frame_w - 1)))
    y = max(0, min(y, max(0, frame_h - 1)))
    box_w = max(1, min(box_w, frame_w - x))
    box_h = max(1, min(box_h, frame_h - y))
    return x, y, box_w, box_h


def _box_center(box) -> tuple[int, int]:
    """Integer center: x + width//2, y + height//2 (BBox.center in the exe)."""
    x, y, box_w, box_h = (int(v) for v in box)
    return x + box_w // 2, y + box_h // 2


def _create_csrt():
    """Build OpenCV TrackerCSRT across 4.x / 5.x layouts (cv2 vs cv2.legacy)."""
    modules = [cv2]
    legacy = getattr(cv2, "legacy", None)
    if legacy is not None:
        modules.append(legacy)

    for module in modules:
        factory = getattr(module, "TrackerCSRT_create", None)
        if callable(factory):
            return factory()
        cls = getattr(module, "TrackerCSRT", None)
        create = getattr(cls, "create", None) if cls is not None else None
        if callable(create):
            return create()

    raise RuntimeError(
        "OpenCV TrackerCSRT is not available. Install opencv-contrib-python "
        "(uninstall opencv-python first if both are present)."
    )


class CsrtTracker:
    """OpenCV TrackerCSRT — same tracker as mocap_beta.exe (TrackerCSRT_create)."""

    def __init__(self):
        self.opencv_tracker = _create_csrt()

    def init(self, frame, bbox) -> bool:
        x, y, w, h = _clamp_bbox(bbox, frame.shape)
        # OpenCV 4.x Python returns None on success; False only on failure.
        result = self.opencv_tracker.init(frame, (x, y, w, h))
        return result is None or bool(result)

    def update(self, frame):
        ok, box = self.opencv_tracker.update(frame)
        if not ok or box is None:
            return False, (0, 0, 0, 0)
        # exe: BBox(*map(int, tracker.update(frame)[1]))
        return True, tuple(int(v) for v in box)


def _safe_fps(capture) -> float:
    """Reject bogus FPS values common with WebM / camera recordings."""
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    if fps <= 1 or fps > 120:
        return 30.0
    return fps


def _read_start_frame(capture, start_frame: int, frame_count: int, fps: float):
    """Seek to start_frame, clamping EOF so the last readable frame still works."""
    start_frame = int(max(0, start_frame))
    if frame_count > 0:
        start_frame = min(start_frame, frame_count - 1)
        if start_frame:
            capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        ok, frame = capture.read()
        if ok:
            return start_frame, frame
        if start_frame > 0:
            start_frame -= 1
            capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
            ok, frame = capture.read()
            if ok:
                return start_frame, frame
        return start_frame, None

    if start_frame <= 0:
        ok, frame = capture.read()
        return 0, frame if ok else None

    t_ms = 1000.0 * start_frame / fps
    for _ in range(24):
        capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t_ms))
        ok, frame = capture.read()
        if ok:
            return int(round(max(0.0, t_ms) / 1000.0 * fps)), frame
        if t_ms <= 0:
            break
        t_ms -= 100.0
    return start_frame, None


def read_video_info(path: str) -> dict:
    """Open a clip once and return fps / size / duration for the UI."""
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open video: {path}")
    fps = _safe_fps(capture)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if frame_count < 1:
        frame_count = 0
    ok, first_frame = capture.read()
    if not ok:
        capture.release()
        raise RuntimeError("Could not read the first frame.")
    if width < 8 or height < 8:
        height, width = int(first_frame.shape[0]), int(first_frame.shape[1])
    duration = frame_count / fps if fps and frame_count > 0 else 0.0
    try:
        capture.set(cv2.CAP_PROP_POS_AVI_RATIO, 1.0)
        end_ms = float(capture.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
        if end_ms > 500:
            duration = max(duration, end_ms / 1000.0)
    except cv2.error:
        pass
    capture.release()
    track_w, track_h = exe_frame_size(width, height)
    return {
        "fps": fps,
        "width": width,
        "height": height,
        "track_width": track_w,
        "track_height": track_h,
        "nframes": frame_count,
        "duration": duration,
    }


def track_video(
    path: str,
    bbox: tuple[float, float, float, float],
    start_frame: int = 0,
    stamp_fps: float | None = None,
    progress: ProgressCallback = None,
) -> dict:
    """Track `bbox` from `start_frame` like mocap_beta.exe (CSRT, 640 resize, stop on loss).

    `bbox` is in native video pixels (the HTML player). It is scaled into the
    same 640-capped frame the desktop app tracks. Sample times are
    `i / stamp_fps` starting at 0, matching the exe videofile timestamps.
    """
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open video: {path}")

    native_fps = _safe_fps(capture)
    fps = float(stamp_fps) if stamp_fps and float(stamp_fps) >= 1 else native_fps
    native_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    native_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if frame_count < 1:
        frame_count = 0
    start_frame, frame = _read_start_frame(capture, start_frame, frame_count, native_fps)
    if frame is None:
        capture.release()
        raise RuntimeError("Could not read the start frame.")

    if native_width < 8 or native_height < 8:
        native_height, native_width = int(frame.shape[0]), int(frame.shape[1])

    frame = resize_like_exe(frame)
    height, width = frame.shape[:2]
    track_bbox = scale_bbox(bbox, native_width, native_height, width, height)
    track_bbox = _clamp_bbox(track_bbox, frame.shape)

    tracker = CsrtTracker()
    if not tracker.init(frame, track_bbox):
        capture.release()
        raise RuntimeError("Tracker failed to initialize on the selected box.")

    times: list[float] = []
    center_x: list[float] = []
    center_y: list[float] = []
    boxes: list[list[float]] = []

    def record_sample(box, time_sec):
        cx, cy = _box_center(box)
        x, y, w, h = (int(v) for v in box)
        times.append(float(time_sec))
        center_x.append(float(cx))
        center_y.append(float(cy))
        boxes.append([float(x), float(y), float(w), float(h)])

    def preview_snapshot() -> dict:
        # Last sample only — the UI accumulates a trail; full arrays go out once at the end.
        return {
            "t": times[-1] if times else 0.0,
            "x": center_x[-1] if center_x else 0.0,
            "y": center_y[-1] if center_y else 0.0,
            "bbox": list(boxes[-1]) if boxes else [0.0, 0.0, 0.0, 0.0],
            "n": len(times),
            "width": width,
            "height": height,
            "lost": int(lost_target),
            "fps": fps,
            "native_fps": native_fps,
            "start_frame": start_frame,
        }

    lost_target = False
    # exe: first trajectory sample is (0,) + bbox.center on the selection frame.
    record_sample(track_bbox, 0.0)
    frames_done = 1
    frames_total = max(frame_count - start_frame, 0)
    sample_index = 0
    if progress:
        progress(frames_done, frames_total or frames_done, preview_snapshot())

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frame = resize_like_exe(frame)
        frames_done += 1
        hit, box = tracker.update(frame)
        if not hit or box[2] <= 0 or box[3] <= 0:
            lost_target = True
            break
        sample_index += 1
        record_sample(box, sample_index / fps)
        if progress and (frames_done % 8 == 0 or (frames_total and frames_done >= frames_total)):
            progress(frames_done, frames_total or frames_done, preview_snapshot())

    capture.release()
    if progress:
        progress(frames_done, frames_done, preview_snapshot())

    return {
        "fps": fps,
        "native_fps": native_fps,
        "width": width,
        "height": height,
        "start_frame": start_frame,
        "times": times,
        "x": center_x,
        "y": center_y,
        "bboxes": boxes,
        "lost": int(lost_target),
    }
