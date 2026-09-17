"""Frame-by-frame box trackers used by the mocap web app."""

from __future__ import annotations

from typing import Callable, Optional

import cv2
import numpy as np

# Optional callback: progress(frames_done, frames_total, preview_snapshot | None)
ProgressCallback = Optional[Callable[..., None]]

# Tracker ids accepted by /api/track (must match <select id="tracker"> values).
TRACKER_NAMES = frozenset({"lk", "ncc", "mil"})


def _clamp_bbox(bbox, frame_shape) -> tuple[int, int, int, int]:
    """Clamp [x, y, w, h] to the frame; force even w/h for template matching."""
    frame_h, frame_w = frame_shape[:2]
    x, y, box_w, box_h = [float(v) for v in bbox]
    x = int(round(max(0, min(x, frame_w - 2))))
    y = int(round(max(0, min(y, frame_h - 2))))
    box_w = int(round(max(8, min(box_w, frame_w - x))))
    box_h = int(round(max(8, min(box_h, frame_h - y))))
    if box_w % 2:
        box_w = min(frame_w - x, box_w + 1)
    if box_h % 2:
        box_h = min(frame_h - y, box_h + 1)
    return x, y, max(8, box_w), max(8, box_h)


def _to_gray(frame: np.ndarray) -> np.ndarray:
    if frame.ndim == 2:
        return frame
    return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)


class TemplateMatchTracker:
    """Follow the box by sliding the initial patch (normalized cross-correlation)."""

    def init(self, frame, bbox) -> bool:
        x, y, w, h = _clamp_bbox(bbox, frame.shape)
        self.bbox = [float(x), float(y), float(w), float(h)]
        gray = _to_gray(frame)
        patch = gray[y : y + h, x : x + w]
        if patch.size == 0:
            return False
        self.template_patch = patch.copy()
        return True

    def update(self, frame):
        gray = _to_gray(frame)
        x, y, w, h = [int(round(v)) for v in self.bbox]
        search_pad = int(max(w, h, 16) * 2.5)
        frame_h, frame_w = gray.shape[:2]
        x1, y1 = max(0, x - search_pad), max(0, y - search_pad)
        x2, y2 = min(frame_w, x + w + search_pad), min(frame_h, y + h + search_pad)
        search_roi = gray[y1:y2, x1:x2]
        if search_roi.shape[0] < h or search_roi.shape[1] < w:
            return False, tuple(self.bbox)
        score_map = cv2.matchTemplate(search_roi, self.template_patch, cv2.TM_CCOEFF_NORMED)
        _, best_score, _, best_loc = cv2.minMaxLoc(score_map)
        if best_score < 0.28:
            return False, tuple(self.bbox)
        self.bbox[0] = float(x1 + best_loc[0])
        self.bbox[1] = float(y1 + best_loc[1])
        nx, ny = int(round(self.bbox[0])), int(round(self.bbox[1]))
        # Slowly adapt the template when the match is strong.
        if 0 <= ny < frame_h - h and 0 <= nx < frame_w - w and best_score > 0.55:
            blended = 0.9 * self.template_patch + 0.1 * np.float32(gray[ny : ny + h, nx : nx + w])
            self.template_patch = np.clip(blended, 0, 255).astype(np.uint8)
        return True, tuple(self.bbox)


class OpticalFlowTracker:
    """Move the box by median Lucas–Kanade flow of corner points inside it."""

    def __init__(self):
        self.flow_params = dict(
            winSize=(21, 21),
            maxLevel=3,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
        )
        self.corner_params = dict(maxCorners=80, qualityLevel=0.01, minDistance=4, blockSize=7)

    def init(self, frame, bbox) -> bool:
        x, y, w, h = _clamp_bbox(bbox, frame.shape)
        self.bbox = [float(x), float(y), float(w), float(h)]
        self.prev_gray = _to_gray(frame)
        self.corners = self._detect_corners(self.prev_gray)
        return self.corners is not None and len(self.corners) >= 4

    def update(self, frame):
        gray = _to_gray(frame)
        if self.corners is None or len(self.corners) < 4:
            self.corners = self._detect_corners(gray)
            self.prev_gray = gray
            if self.corners is None:
                return False, tuple(self.bbox)
        next_corners, status, _ = cv2.calcOpticalFlowPyrLK(
            self.prev_gray, gray, self.corners, None, **self.flow_params
        )
        if next_corners is None or status is None:
            self.prev_gray = gray
            return False, tuple(self.bbox)
        tracked_new = next_corners[status.flatten() == 1].reshape(-1, 2)
        tracked_old = self.corners[status.flatten() == 1].reshape(-1, 2)
        if len(tracked_new) < 4:
            self.corners = self._detect_corners(gray)
            self.prev_gray = gray
            return False, tuple(self.bbox)
        shift = np.median(tracked_new - tracked_old, axis=0).reshape(-1)
        self.bbox[0] += float(shift[0])
        self.bbox[1] += float(shift[1])
        frame_h, frame_w = gray.shape[:2]
        self.bbox[0] = float(np.clip(self.bbox[0], 0, frame_w - self.bbox[2]))
        self.bbox[1] = float(np.clip(self.bbox[1], 0, frame_h - self.bbox[3]))
        self.corners = tracked_new.reshape(-1, 1, 2)
        if len(self.corners) < 12:
            redetected = self._detect_corners(gray)
            if redetected is not None:
                self.corners = redetected
        self.prev_gray = gray
        return True, tuple(self.bbox)

    def _detect_corners(self, gray):
        x, y, w, h = [int(round(v)) for v in self.bbox]
        x, y = max(0, x), max(0, y)
        roi = gray[y : y + max(1, h), x : x + max(1, w)]
        if roi.size == 0:
            return None
        corners = cv2.goodFeaturesToTrack(roi, **self.corner_params)
        if corners is None:
            return None
        corners[:, 0, 0] += x
        corners[:, 0, 1] += y
        return corners


class MilTracker:
    """Thin wrapper around OpenCV TrackerMIL (Multiple Instance Learning)."""

    def __init__(self):
        if not hasattr(cv2, "TrackerMIL_create"):
            raise RuntimeError("OpenCV TrackerMIL is not available.")
        self.opencv_tracker = cv2.TrackerMIL_create()

    def init(self, frame, bbox) -> bool:
        x, y, w, h = _clamp_bbox(bbox, frame.shape)
        # OpenCV 4.x Python returns None on success; False only on failure.
        result = self.opencv_tracker.init(frame, (x, y, w, h))
        return result is None or bool(result)

    def update(self, frame):
        ok, box = self.opencv_tracker.update(frame)
        if not ok or box is None:
            return False, (0.0, 0.0, 0.0, 0.0)
        return True, tuple(float(v) for v in box)


def create_tracker(name: str):
    """Build a tracker from an API id: lk | ncc | mil."""
    key = (name or "lk").strip().lower()
    if key == "ncc":
        return TemplateMatchTracker()
    if key == "mil":
        return MilTracker()
    return OpticalFlowTracker()


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


def _snap_labeled_duration(duration: float) -> float:
    """Match the UI whole-second clip length (64.83 s → 65 s)."""
    if duration <= 0:
        return duration
    labeled = int(duration + 0.5)
    if labeled > duration:
        return float(labeled)
    return duration


def _times_cover_clip(
    times: list[float],
    start_frame: int,
    frame_count: int,
    fps: float,
    clip_duration: float | None = None,
    reached_eof: bool = False,
) -> None:
    """Stamp samples onto the real clip length (not just nframes/fps).

    OpenCV often reports fewer frames than the container duration (MOV/NTSC
    29.97). If we reached EOF, pin the last sample to that duration so a 65 s
    clip does not export as 64.8 s.
    """
    n = len(times)
    if n == 0 or fps <= 0:
        return
    counted = n / fps
    file_dur = frame_count / fps if frame_count > 1 else counted
    duration = max(file_dur, counted)
    if clip_duration and clip_duration > 0:
        duration = max(duration, float(clip_duration))
    duration = _snap_labeled_duration(duration)

    if frame_count > 1 and start_frame > 0:
        t_start = start_frame / (frame_count - 1) * duration
    else:
        t_start = 0.0 if start_frame <= 0 else start_frame / fps

    at_end = reached_eof or (
        frame_count > 0 and start_frame + n >= frame_count
    )
    if at_end:
        t_end = duration
    elif frame_count > 1:
        t_end = (start_frame + n - 1) / (frame_count - 1) * duration
    else:
        t_end = t_start + n / fps
    if t_end < t_start:
        t_end = t_start

    if n == 1:
        times[0] = t_end if at_end else t_start
        return
    span = t_end - t_start
    for i in range(n):
        times[i] = t_start + i / (n - 1) * span
    times[-1] = t_end


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
    # MOV/MP4 headers are often a bit longer than FRAME_COUNT / fps.
    try:
        capture.set(cv2.CAP_PROP_POS_AVI_RATIO, 1.0)
        end_ms = float(capture.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
        if end_ms > 500:
            duration = max(duration, end_ms / 1000.0)
    except cv2.error:
        pass
    capture.release()
    return {
        "fps": fps,
        "width": width,
        "height": height,
        "nframes": frame_count,
        "duration": duration,
    }


def track_video(
    path: str,
    bbox: tuple[float, float, float, float],
    tracker_name: str = "lk",
    start_frame: int = 0,
    stamp_fps: float | None = None,
    clip_duration: float | None = None,
    progress: ProgressCallback = None,
) -> dict:
    """Track `bbox` from `start_frame` to EOF; optionally report live previews."""
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open video: {path}")

    native_fps = _safe_fps(capture)
    fps = float(stamp_fps) if stamp_fps and float(stamp_fps) >= 1 else native_fps
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if frame_count < 1:
        frame_count = 0
    start_frame, frame = _read_start_frame(capture, start_frame, frame_count, native_fps)
    if frame is None:
        capture.release()
        raise RuntimeError("Could not read the start frame.")

    tracker = create_tracker(tracker_name)
    if not tracker.init(frame, bbox):
        capture.release()
        raise RuntimeError("Tracker failed to initialize on the selected box.")

    times: list[float] = []
    center_x: list[float] = []
    center_y: list[float] = []
    boxes: list[list[float]] = []
    hits: list[bool] = []

    def record_sample(box, time_sec, hit):
        x, y, w, h = box
        times.append(float(time_sec))
        center_x.append(float(x + w / 2.0))
        center_y.append(float(y + h / 2.0))
        boxes.append([float(x), float(y), float(w), float(h)])
        hits.append(bool(hit))

    def preview_snapshot() -> dict:
        return {
            "times": times[:],
            "x": center_x[:],
            "y": center_y[:],
            "bboxes": [list(b) for b in boxes],
            "width": width,
            "height": height,
            "lost": int(sum(1 for hit in hits if not hit)),
            "fps": fps,
            "native_fps": native_fps,
            "nframes": max(frame_count, frame_index + 1),
            "start_frame": start_frame,
        }

    record_sample(bbox, start_frame / fps, True)
    frame_index = start_frame
    frames_done = 1
    frames_total = max(frame_count - start_frame, 0)
    if progress:
        progress(frames_done, frames_total or frames_done, preview_snapshot())

    last_good_box = tuple(float(v) for v in bbox)
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frame_index += 1
        frames_done += 1
        hit, box = tracker.update(frame)
        if hit:
            last_good_box = box
        # On a miss, hold the last good box so the UI trail stays continuous.
        record_sample(last_good_box, frame_index / fps, hit)
        if progress and (frames_done % 8 == 0 or (frames_total and frames_done >= frames_total)):
            progress(frames_done, frames_total or frames_done, preview_snapshot())

    # Some MOV files stop sequential reads a few frames early; hunt a little.
    expected = frame_count
    if clip_duration and clip_duration > 0 and native_fps > 0:
        expected = max(expected, int(round(float(clip_duration) * native_fps)))
    extra = 0
    while expected > 0 and frame_index + 1 < expected and extra < 15:
        capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index + 1)
        ok, frame = capture.read()
        if not ok:
            break
        extra += 1
        frame_index += 1
        frames_done += 1
        hit, box = tracker.update(frame)
        if hit:
            last_good_box = box
        record_sample(last_good_box, frame_index / fps, hit)
        if progress and (frames_done % 8 == 0 or frames_done >= expected):
            progress(frames_done, expected, preview_snapshot())

    capture.release()
    _times_cover_clip(
        times,
        start_frame,
        max(frame_count, frames_done),
        fps,
        clip_duration=clip_duration,
        reached_eof=True,
    )
    if progress:
        progress(frames_done, frames_done, preview_snapshot())

    return {
        "fps": fps,
        "native_fps": native_fps,
        "width": width,
        "height": height,
        "nframes": max(frame_count, frames_done),
        "start_frame": start_frame,
        "tracker": tracker_name,
        "times": times,
        "x": center_x,
        "y": center_y,
        "bboxes": boxes,
        "hits": hits,
        "lost": int(sum(1 for hit in hits if not hit)),
    }
