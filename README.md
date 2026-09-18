# Mocap

Local web app that tracks a box in a video, fits a being-compatible smoothing spline, and exports CSV / JSON.

## Run

From this folder:

```bash
pip install -r requirements.txt
python -m webapp.server
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765).

Optional flags:

```bash
python -m webapp.server --reload          # auto-reload while developing
python -m webapp.server --host 127.0.0.1 --port 8765
```

## Workflow

1. **Upload** a clip, or **Camera** to record one (live preview while recording).
2. Pause on the frame where tracking should start, **Draw box** around the marker, then **Track**.
3. Set **Curve min / max** (meters; default 0–0.10), then **Smoothing** (0–500 → `0`–`5e-5`), and download **CSV** / **JSON**.
4. Or skip tracking and **Load JSON** to open an existing being Curve file on the plot.

While tracking, the video steps through frames: everything outside the box is grayed out, and a red trail is drawn. Tracking uses OpenCV **CSRT**, frames capped at 640 px on the long side, integer box centers, and stops when the target is lost. Timestamps are `i / fps` from the start frame. Curve min/max stretch the tracked motion into that output range in meters (Invert flips image Y only).

Requires `opencv-contrib-python` (not plain `opencv-python`).

## Export format

- CSV: `timestamp [s], y [m]` then one sample per line.
- JSON: being `Curve` of cubic `BPoly` splines (`splrep` → `PPoly` → `BPoly`, including duplicate end knots).

## Health

`GET /api/health` returns `{ "ok": true, "tracker": "csrt" }`.
