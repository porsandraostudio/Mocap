# Mocap

Web app that tracks a box in a video, fits a being-compatible smoothing spline, and exports CSV / JSON.

Tracking and spline fitting run **in the browser**, so the UI can be hosted as static files for free (GitHub Pages). If you start the local Python server, the same UI uses OpenCV **CSRT** instead.

## Run locally

From this folder:

```bash
pip install -r requirements.txt
python -m webapp.server
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765).

No Python (static only, same as GitHub Pages):

```bash
python -m http.server 8765 --directory webapp/static
```

Optional flags for the FastAPI server:

```bash
python -m webapp.server --reload          # auto-reload while developing
python -m webapp.server --host 127.0.0.1 --port 8765
```

## Deploy for free (GitHub Pages)

No Docker and no paid host. Push this repo, then:

1. GitHub → **Settings** → **Pages** → Source: **GitHub Actions**
2. Push to `main` (or run the **Deploy GitHub Pages** workflow)
3. Open `https://<user>.github.io/<repo>/`

Camera recording needs HTTPS; GitHub Pages provides it. Clips stay in the browser (nothing is uploaded to GitHub).

On Pages the tracker is MOSSE (correlation filter), not CSRT. Use `python -m webapp.server` locally when you need OpenCV CSRT.

## Workflow

1. **Upload** a clip, or **Camera** to record one (live preview while recording).
2. Pause on the frame where tracking should start, **Draw box** around the marker, then **Track**.
3. Set **Curve min / max** (meters; default 0–0.10), then **Smoothing** (0–500 → `0`–`5e-5`), and download **CSV** / **JSON**.
4. Or skip tracking and **Load JSON** to open an existing being Curve file on the plot.

While tracking, the video steps through frames: everything outside the box is grayed out, and a red trail is drawn. The local Python path uses OpenCV **CSRT**; the static/Pages path uses MOSSE. Frames are capped at 640 px on the long side, integer box centers, and tracking stops when the target is lost. Timestamps are `i / fps` from the start frame. Curve min/max stretch the tracked motion into that output range in meters (Invert flips image Y only).

The Python server requires `opencv-contrib-python` (not plain `opencv-python`).

## Export format

- CSV: `timestamp [s], y [m]` then one sample per line.
- JSON: being `Curve` of cubic `BPoly` splines (`splrep` → `PPoly` → `BPoly` on the Python server; CubicSpline not-a-knot → BPoly in the browser).

## Health

`GET /api/health` (local Python server only) returns `{ "ok": true, "tracker": "csrt" }`. The UI uses the in-browser tracker when that endpoint is missing.
