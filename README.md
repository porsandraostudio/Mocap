# Mocap

Local web app that tracks a box in a video, fits a being-compatible smoothing spline, and exports CSV / JSON.

## Run

From this folder:

```bash
pip install -r webapp/requirements.txt
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
2. Pause, **Draw box** around the marker, then **Track**.
3. Set **Curve min / max** (meters) for the output height, then **Smoothing**, **Fit spline**, and download **CSV** / **JSON**.
4. Or skip tracking and **Load JSON** to open an existing being Curve file on the plot.

While tracking, the video steps through frames like the desktop app: everything outside the box is grayed out, and a red trail is drawn. Curve min/max stretch the tracked motion into that output range in meters (Invert still flips image Y).

## Trackers

| Option | Use when |
|---|---|
| Optical flow | Textured motion (default) |
| Template match | Smooth sticker / LED that keeps shape |
| MIL (OpenCV) | Appearance change / clutter (slower) |

## Export format

- CSV: `timestamp [s], y [m]` then one sample per line.
- JSON: being `Curve` of cubic `BPoly` splines (`splrep` → `PPoly` → `BPoly`).

## Health

`GET /api/health` returns `{ "ok": true, "trackers": [...] }`.
