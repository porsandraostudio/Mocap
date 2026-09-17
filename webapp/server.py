"""HTTP server: upload video, track a box, fit/export being Curve JSON.

Run:  python -m webapp.server
Dev:  python -m webapp.server --reload

Uploaded clips stay in memory only (nothing written under webapp/).
OpenCV still needs a short-lived OS temp file while probing/tracking; it is
deleted immediately afterward.
"""
from __future__ import annotations

import argparse
import os
import tempfile
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import uvicorn
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .spline_fit import (
    curve_from_json,
    export_payload,
    fit_spline,
    format_csv,
    spline_axis_names,
    unique_knot_times,
)
from .tracking import TRACKER_NAMES, read_video_info, track_video

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

# Soft cap so a mis-click upload cannot exhaust RAM during local use.
MAX_UPLOAD_BYTES = 512 * 1024 * 1024

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
VIDEO_MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
}

app = FastAPI(title="Mocap", description="Local video box tracker → being Curve")

# In-memory session store (single-user local app; cleared on process restart).
VIDEO_STORE: dict[str, dict] = {}
JOB_STORE: dict[str, dict] = {}
JOB_LOCK = threading.Lock()


class TrackRequest(BaseModel):
    video_id: str
    bbox: list[float] = Field(min_length=4, max_length=4)
    tracker: str = "lk"
    start_time: float = 0.0
    fps: float | None = None
    duration: float | None = None


class FitRequest(BaseModel):
    times: list[float]
    series: dict[str, list[float]]
    smoothing: float = 1e-5


@contextmanager
def _temp_video_file(data: bytes, suffix: str) -> Iterator[str]:
    """Write bytes to an OS temp file for OpenCV, then delete it."""
    fd, path = tempfile.mkstemp(prefix="mocap_", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        yield path
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _public_video_meta(video: dict) -> dict:
    """Client-facing metadata (never includes raw bytes)."""
    return {k: v for k, v in video.items() if k != "data"}


def _register_video(data: bytes, suffix: str, label: str) -> dict:
    """Probe bytes via a temp file, then keep only the in-memory copy."""
    try:
        with _temp_video_file(data, suffix) as path:
            info = read_video_info(path)
    except Exception as exc:
        raise HTTPException(400, f"Could not read video: {exc}") from exc
    if info["width"] < 8 or info["height"] < 8:
        raise HTTPException(400, "Video has no usable frames. Record a bit longer and try again.")
    video_id = uuid.uuid4().hex[:12]
    payload = {
        "id": video_id,
        "name": label,
        "suffix": suffix,
        "mime": VIDEO_MIME.get(suffix, "application/octet-stream"),
        "data": data,
        **info,
    }
    VIDEO_STORE[video_id] = payload
    return _public_video_meta(payload)


def _range_response(data: bytes, mime: str, filename: str, request: Request) -> Response:
    """Serve in-memory video bytes, honoring HTTP Range for seeking."""
    size = len(data)
    range_header = request.headers.get("range")
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f'inline; filename="{filename}"',
    }
    if not range_header or not range_header.startswith("bytes="):
        headers["Content-Length"] = str(size)
        return Response(content=data, media_type=mime, headers=headers)

    spec = range_header.replace("bytes=", "", 1).strip().split(",", 1)[0].strip()
    start_s, _, end_s = spec.partition("-")
    try:
        if not start_s and end_s:
            # RFC 9110 suffix-byte-range: last N bytes (`bytes=-500`).
            suffix = int(end_s)
            if suffix <= 0:
                raise ValueError("suffix range must be positive")
            start = max(0, size - suffix)
            end = size - 1
        else:
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else size - 1
    except ValueError as exc:
        raise HTTPException(416, "Invalid Range header.") from exc
    if start < 0 or end < start or start >= size:
        raise HTTPException(416, "Requested Range Not Satisfiable.")
    end = min(end, size - 1)
    chunk = data[start : end + 1]
    headers.update({
        "Content-Length": str(len(chunk)),
        "Content-Range": f"bytes {start}-{end}/{size}",
    })
    return Response(content=chunk, status_code=206, media_type=mime, headers=headers)


@app.get("/api/health")
def health():
    return {"ok": True, "trackers": sorted(TRACKER_NAMES)}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    suffix = Path(file.filename or "clip.mp4").suffix.lower()
    if suffix not in VIDEO_EXTS:
        raise HTTPException(400, "Unsupported video type.")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Uploaded file was empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "File is too large (max 512 MB).")
    # Replace any previous clip so RAM does not accumulate across uploads.
    VIDEO_STORE.clear()
    return _register_video(data, suffix, label=file.filename or f"clip{suffix}")


@app.get("/api/video/{video_id}/file")
def video_file(video_id: str, request: Request):
    video = VIDEO_STORE.get(video_id)
    if not video or "data" not in video:
        raise HTTPException(404, "Unknown video.")
    return _range_response(video["data"], video["mime"], video["name"], request)


def _run_track(job_id: str, req: TrackRequest):
    """Background worker: write progress/preview into JOB_STORE until done or error."""
    video = VIDEO_STORE.get(req.video_id)
    if not video or "data" not in video:
        with JOB_LOCK:
            JOB_STORE[job_id] = {"status": "error", "error": "Unknown video.", "progress": 0}
        return

    native_fps = float(video["fps"] or 30.0)
    stamp_fps = native_fps
    if req.fps is not None:
        if req.fps < 1 or req.fps > 240:
            with JOB_LOCK:
                JOB_STORE[job_id] = {"status": "error", "error": "FPS must be between 1 and 240.", "progress": 0}
            return
        stamp_fps = float(req.fps)
    start_frame = int(round(max(0.0, req.start_time) * native_fps))
    nframes = int(video.get("nframes") or 0)
    if nframes > 0:
        start_frame = min(start_frame, nframes - 1)

    def progress(done, total, preview=None):
        with JOB_LOCK:
            job = JOB_STORE.get(job_id)
            if job and job.get("status") == "running":
                job["progress"] = 0 if total == 0 else done / total
                job["done"] = done
                job["total"] = total
                if preview:
                    job["preview"] = preview

    try:
        with _temp_video_file(video["data"], video["suffix"]) as path:
            result = track_video(
                path,
                tuple(req.bbox),
                tracker_name=req.tracker,
                start_frame=start_frame,
                stamp_fps=stamp_fps,
                clip_duration=req.duration or video.get("duration"),
                progress=progress,
            )
        with JOB_LOCK:
            JOB_STORE[job_id] = {"status": "done", "progress": 1, "result": result}
    except Exception as exc:
        with JOB_LOCK:
            JOB_STORE[job_id] = {"status": "error", "progress": 0, "error": str(exc)}


@app.post("/api/track")
def start_track(req: TrackRequest):
    if req.video_id not in VIDEO_STORE:
        raise HTTPException(404, "Unknown video.")
    if req.tracker not in TRACKER_NAMES:
        raise HTTPException(400, f"Unknown tracker. Choose one of: {', '.join(sorted(TRACKER_NAMES))}")
    if req.bbox[2] < 8 or req.bbox[3] < 8:
        raise HTTPException(400, "Bounding box is too small.")
    if req.fps is not None and (req.fps < 1 or req.fps > 240):
        raise HTTPException(400, "FPS must be between 1 and 240.")
    job_id = uuid.uuid4().hex[:12]
    with JOB_LOCK:
        JOB_STORE[job_id] = {"status": "running", "progress": 0}
    threading.Thread(target=_run_track, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with JOB_LOCK:
        job = JOB_STORE.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job.")
    return job


@app.post("/api/fit")
def fit(req: FitRequest):
    """Fit a being-compatible BPoly spline to each series and return plot/export payloads."""
    if len(req.times) < 4:
        raise HTTPException(400, "Need at least 4 samples to fit a spline.")
    splines = []
    try:
        for name, values in req.series.items():
            if len(values) != len(req.times):
                raise HTTPException(400, f"Series {name} length does not match times.")
            splines.append(fit_spline(req.times, values, smoothing=req.smoothing))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    payload = export_payload(splines, list(req.series), req.times)
    # CSV keeps the height-mapped track samples (not re-sampled spline values).
    payload["csv"] = format_csv(req.times, req.series)
    return payload


@app.post("/api/load-curve")
async def load_curve(file: UploadFile = File(...)):
    """Open an existing being Curve JSON for plotting / height remap / re-export."""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Uploaded file was empty.")
    try:
        text = raw.decode("utf-8")
        splines = curve_from_json(text)
    except (UnicodeDecodeError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(400, f"Could not load Curve JSON: {exc}") from exc
    if not splines:
        raise HTTPException(400, "Curve JSON has no splines.")
    payload = export_payload(
        splines,
        spline_axis_names(len(splines)),
        unique_knot_times(splines[0]),
        curve_json=text,
    )
    payload["name"] = Path(file.filename or "curve.json").name
    return payload


# Static UI must be mounted last so /api/* routes stay above it.
app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")


def main() -> None:
    parser = argparse.ArgumentParser(description="Mocap local web app")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Auto-reload when Python sources change (dev only)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind address")
    parser.add_argument("--port", type=int, default=8765, help="Bind port")
    args, _ = parser.parse_known_args()
    uvicorn.run(
        "webapp.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
