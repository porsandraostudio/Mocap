# Mocap

Track a marker in a video, fit a being-compatible spline, and export CSV or JSON. Everything runs in the browser. Clips never leave your machine.

**[Open the app](https://porsandraostudio.github.io/Mocap/)**

## Features

- Upload, drag-and-drop, or record from the camera
- MOSSE box tracker with a live trail
- Invert image Y, smoothing that drops knots
- CSV (`timestamp [s], y`) and being `Curve` JSON (cubic BPoly)
- Free host on GitHub Pages (HTTPS for camera)

## How to use

1. Load a clip: **Upload**, drop it on **Preview**, or **Camera**.
2. Pause where tracking should start, **Draw box** on the marker, **Track**.
3. Set **Smoothing** (more smoothing → fewer knots).
4. Download **CSV** / **JSON**, or skip tracking and **Load JSON**.

Keep the box tight. Extra background lets the tracker lock onto edges. Tracking stops when the target is lost. Timestamps are `i / fps` from the start frame. Invert flips image Y only.

Open `index.html` locally to try it without deploying. Camera needs HTTPS (the live site) or `localhost`.
