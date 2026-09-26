# Mocap

Track a marker in a video, fit a being-compatible spline, and export CSV or JSON directly from the browser.

**[Open the app](https://porsandraostudio.github.io/Mocap/)**

## Features

- Upload a local clip or drag and drop it onto the preview
- Record live from the camera and save the resulting WebM
- Draw a box around the target and track it frame by frame
- Use a MOSSE tracker with a trail preview and optional frame review
- Export CSV or being `Curve` JSON with adjustable smoothing and axis controls
- Load an existing Curve JSON and re-fit it with smoothing applied

## How to use

1. Load a clip from **Upload**, drag it onto **Preview**, or use **Camera**.
2. Pause at the start of the motion and click **Draw box** to select the marker.
3. Click **Track** to follow the target across the clip.
4. Adjust **Axis**, **FPS**, and **Smoothing** to shape the output.
5. Export **CSV** or **JSON**, or load a saved curve with **Load JSON**.

Keep the box tight around the marker. Extra background can make the tracker latch onto edges or other bright regions. Tracking stops automatically if the marker is lost for too long. Invert flips the image Y axis for exported values.

For local testing, open the project in a browser from the workspace or serve it locally with a static web server. Camera capture requires HTTPS or `localhost` access.
