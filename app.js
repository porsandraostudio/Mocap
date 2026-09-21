/**
 * Mocap UI — upload/record, draw a box, track, fit being Curve, export CSV/JSON.
 * Tracking (MOSSE) and spline fitting run in the browser.
 */
"use strict";

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const plot = document.getElementById("plot");
const plotCtx = plot.getContext("2d");
const emptyState = document.getElementById("emptyState");
const videoFrame = document.getElementById("videoFrame");

const state = {
  objectUrl: null,
  videoMeta: null,
  isDrawingBox: false,
  drawStartPoint: null,
  bbox: null, // [x, y, w, h] in video pixels
  track: null,
  scaledSeries: null,
  fitResult: null,
  hasLoadedCurve: false,
  loadedCurveSource: null,
  hasResmoothedLoadedCurve: false,
  exportFileName: null,
  cameraStream: null,
  recorder: null,
  isLiveCamera: false,
  recordingClockTimer: null,
  recordingStartedAt: 0,
  isTracking: false,
  mediaTime: null,
  frameClockHandle: null,
  trackSeekPending: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byId(id) {
  return document.getElementById(id);
}

/** Whole seconds for playhead / clip length labels. Snap near the end so 64.8 of 65 shows 65/65. */
function formatSeconds(t) {
  return String(Math.max(0, Math.round(Number(t) || 0)));
}

function formatAxisTick(value, span) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (span < 1) {
    const text = n.toFixed(3);
    return text === "-0.000" ? "0.000" : text;
  }
  if (span < 10) {
    const text = n.toFixed(1);
    return text === "-0.0" ? "0.0" : text;
  }
  return String(Math.round(n));
}

/** Keep the seek thumb visually at 100% when playback is at/near the end. */
function syncSeekBar() {
  if (state.isLiveCamera) return;
  const seek = byId("seek");
  const duration = clipDuration();
  if (!(duration > 0)) {
    seek.max = 0;
    seek.value = 0;
    byId("timeLabel").textContent = "0 / 0";
    return;
  }
  seek.max = duration;
  const current = Number(video.currentTime) || 0;
  const endSlop = Math.max(0.5, 2 / clipFps());
  const atEnd = video.ended || current >= duration - endSlop;
  seek.value = atEnd ? duration : Math.min(current, duration);
  byId("timeLabel").textContent = `${formatSeconds(atEnd ? duration : current)} / ${formatSeconds(duration)}`;
}

function syncPlayButton() {
  if (state.isLiveCamera) {
    byId("playBtn").textContent = "Live";
    return;
  }
  byId("playBtn").textContent = video.paused ? "Play" : "Pause";
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function revokeObjectUrl() {
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
}

function clearFitResult() {
  state.fitResult = null;
  byId("csvBtn").disabled = true;
  byId("jsonBtn").disabled = true;
}

function exportBasename() {
  const name = state.exportFileName || state.videoMeta?.name || "mocap";
  return name.replace(/\.[^.]+$/, "") || "mocap";
}

function mediaDuration() {
  const d = video.duration;
  if (Number.isFinite(d) && d > 0) return d;
  if (video.seekable && video.seekable.length) {
    const end = video.seekable.end(video.seekable.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }
  if (video.buffered && video.buffered.length) {
    const end = video.buffered.end(video.buffered.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }
  return 0;
}

/** Prefer the known clip length; never shrink it to a partial buffer range. */
function clipDuration() {
  const known = Number(state.videoMeta?.duration) || 0;
  const media = mediaDuration();
  if (known > 0 && media > 0) return Math.max(known, media);
  return media || known || 0;
}

/** FPS field: tracking sample rate and curve timestamps. */
function clipFps() {
  const value = Number(byId("fps")?.value);
  if (Number.isFinite(value) && value >= 1 && value <= 240) return value;
  return Number(state.videoMeta?.fps) || 30;
}

function hasClip() {
  return Boolean(state.videoMeta) && !state.isLiveCamera;
}

function formatFps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "30";
  return n.toFixed(2).replace(/\.?0+$/, "") || "30";
}

/** Rebuild track sample times as t = i / clipFps from the selection frame. */
function rebuildTrackTimestamps() {
  if (!state.track?.times?.length) return;
  const fps = clipFps();
  const times = state.track.times;
  for (let i = 0; i < times.length; i += 1) times[i] = i / fps;
  state.track.fps = fps;
}

// ---------------------------------------------------------------------------
// Video layout / overlay
// ---------------------------------------------------------------------------

function videoLayout() {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return {
    scale,
    ox: (rect.width - dw) / 2,
    oy: (rect.height - dh) / 2,
    vw,
    vh,
  };
}

function clientToVideo(event) {
  const rect = overlay.getBoundingClientRect();
  const { scale, ox, oy, vw, vh } = videoLayout();
  const x = (event.clientX - rect.left - ox) / scale;
  const y = (event.clientY - rect.top - oy) / scale;
  return {
    x: Math.max(0, Math.min(vw, x)),
    y: Math.max(0, Math.min(vh, y)),
  };
}

function resizeOverlay() {
  const rect = videoFrame.getBoundingClientRect();
  overlay.width = Math.max(1, Math.floor(rect.width * devicePixelRatio));
  overlay.height = Math.max(1, Math.floor(rect.height * devicePixelRatio));
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  drawOverlay();
}

function trackFrameSize() {
  return {
    tw: Number(state.track?.width) || video.videoWidth || 1,
    th: Number(state.track?.height) || video.videoHeight || 1,
    vw: video.videoWidth || Number(state.videoMeta?.width) || 1,
    vh: video.videoHeight || Number(state.videoMeta?.height) || 1,
  };
}

/** Map tracking-frame pixels onto the native video the player shows. */
function trackToNative(x, y) {
  const { tw, th, vw, vh } = trackFrameSize();
  return { x: x * vw / tw, y: y * vh / th };
}

function boxToNative(box) {
  if (!box) return box;
  if (!state.track) return box;
  const a = trackToNative(box[0], box[1]);
  const b = trackToNative(box[0] + box[2], box[1] + box[3]);
  return [a.x, a.y, b.x - a.x, b.y - a.y];
}

function nativeToTrackBox(box) {
  const tw = Number(state.videoMeta?.track_width) || video.videoWidth || 1;
  const th = Number(state.videoMeta?.track_height) || video.videoHeight || 1;
  const vw = video.videoWidth || Number(state.videoMeta?.width) || 1;
  const vh = video.videoHeight || Number(state.videoMeta?.height) || 1;
  return [
    Math.floor(box[0] * tw / vw),
    Math.floor(box[1] * th / vh),
    Math.max(1, Math.floor(box[2] * tw / vw)),
    Math.max(1, Math.floor(box[3] * th / vh)),
  ];
}

function displayedTime() {
  if (Number.isFinite(state.mediaTime)) return state.mediaTime;
  return Number(video.currentTime) || 0;
}

function startFrameClock() {
  if (state.frameClockHandle != null && typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(state.frameClockHandle);
    state.frameClockHandle = null;
  }
  state.mediaTime = null;
  if (typeof video.requestVideoFrameCallback !== "function") return;
  const tick = (_now, meta) => {
    state.mediaTime = meta.mediaTime;
    state.frameClockHandle = video.requestVideoFrameCallback(tick);
    if (!state.isLiveCamera) drawOverlay();
  };
  state.frameClockHandle = video.requestVideoFrameCallback(tick);
}

function currentIndex() {
  if (!state.track || !state.track.times.length) return -1;
  const n = state.track.times.length;
  const start = Number(state.track.start_frame) || 0;
  const fps = Number(state.track.fps) || clipFps();
  const frame = Math.round(displayedTime() * fps);
  return Math.max(0, Math.min(n - 1, frame - start));
}

function trackSampleVideoTime(startFrame, sampleCount) {
  const fps = Number(state.track?.fps) || clipFps();
  if (!(fps > 0)) return 0;
  const frame = (Number(startFrame) || 0) + Math.max(1, sampleCount) - 1;
  return frame / fps;
}

/** Advance the player to a track sample, but never stack seeks (one in flight). */
function seekToTrackSample(startFrame, sampleCount) {
  const t = trackSampleVideoTime(startFrame, sampleCount);
  if (state.trackSeekPending || video.seeking) return false;
  if (Math.abs((Number(video.currentTime) || 0) - t) < 0.04) return false;
  state.trackSeekPending = true;
  const finish = () => {
    video.removeEventListener("seeked", finish);
    state.trackSeekPending = false;
  };
  video.addEventListener("seeked", finish);
  video.currentTime = t;
  return true;
}

function trackPlayheadTime() {
  if (!state.track?.times?.length) return Number(video.currentTime) || 0;
  const idx = currentIndex();
  if (idx < 0) return state.track.times[0];
  return state.track.times[idx];
}

function currentBox() {
  if (state.isDrawingBox) return state.bbox;
  const idx = currentIndex();
  if (idx < 0) return state.bbox;
  return state.track.bboxes[idx];
}

function toScreen(vx, vy, layout) {
  const native = state.track ? trackToNative(vx, vy) : { x: vx, y: vy };
  return {
    x: layout.ox + native.x * layout.scale,
    y: layout.oy + native.y * layout.scale,
  };
}

function drawBoxAt(box, layout, color = "#e02020") {
  if (!box) return;
  const native = (!state.isDrawingBox && (state.isTracking || state.track)) ? boxToNative(box) : box;
  const x = layout.ox + native[0] * layout.scale;
  const y = layout.oy + native[1] * layout.scale;
  const bw = native[2] * layout.scale;
  const bh = native[3] * layout.scale;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, bw, bh);
  const cx = x + bw / 2;
  const cy = y + bh / 2;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 8, cy);
  ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8);
  ctx.lineTo(cx, cy + 8);
  ctx.stroke();
}

function drawMask(layout, box) {
  const w = overlay.width / devicePixelRatio;
  const h = overlay.height / devicePixelRatio;
  ctx.fillStyle = "rgba(128, 128, 128, 0.84)";
  ctx.fillRect(0, 0, w, h);
  if (!box) return;
  const native = (!state.isDrawingBox && (state.isTracking || state.track)) ? boxToNative(box) : box;
  const x = layout.ox + native[0] * layout.scale;
  const y = layout.oy + native[1] * layout.scale;
  ctx.clearRect(x, y, native[2] * layout.scale, native[3] * layout.scale);
}

function drawPolylineScreen(points, color = "#e07070") {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}

function drawDot(x, y, color = "#e07070", r = 4) {
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Tracking trail: gray mask outside the box, red path + crosshair. */
function drawTrajectoryPreview(layout) {
  if (!state.track || state.track.times.length < 2) return;
  const axis = byId("axis").value;
  const idx = Math.max(0, currentIndex());
  const xs = state.track.x;
  const ys = state.track.y;
  const speed = 5;
  const trailColor = "#e02020";
  const cx = xs[idx];
  const cy = ys[idx];

  if (axis === "xy") {
    const pts = [];
    for (let i = 0; i <= idx; i += 1) pts.push(toScreen(xs[i], ys[i], layout));
    drawPolylineScreen(pts, trailColor);
    const cur = toScreen(xs[idx], ys[idx], layout);
    drawDot(cur.x, cur.y, trailColor, 4);
    return;
  }

  if (axis === "y") {
    const guideTop = toScreen(cx, 0, layout);
    const guideBot = toScreen(cx, Number(state.track.height) || 0, layout);
    ctx.beginPath();
    ctx.strokeStyle = trailColor;
    ctx.lineWidth = 2;
    ctx.moveTo(guideTop.x, guideTop.y);
    ctx.lineTo(guideBot.x, guideBot.y);
    ctx.stroke();
    const pts = [];
    for (let k = 0; k <= idx; k += 1) {
      pts.push(toScreen(cx - speed * (idx - k), ys[k], layout));
    }
    drawPolylineScreen(pts, trailColor);
    const cur = toScreen(cx, ys[idx], layout);
    drawDot(cur.x, cur.y, trailColor, 4);
    return;
  }

  const guideLeft = toScreen(0, cy, layout);
  const guideRight = toScreen(Number(state.track.width) || 0, cy, layout);
  ctx.beginPath();
  ctx.strokeStyle = trailColor;
  ctx.lineWidth = 2;
  ctx.moveTo(guideLeft.x, guideLeft.y);
  ctx.lineTo(guideRight.x, guideRight.y);
  ctx.stroke();
  const pts = [];
  for (let k = 0; k <= idx; k += 1) {
    pts.push(toScreen(xs[k], cy - speed * (idx - k), layout));
  }
  drawPolylineScreen(pts, trailColor);
  const cur = toScreen(xs[idx], cy, layout);
  drawDot(cur.x, cur.y, trailColor, 4);
}

function drawOverlay() {
  const w = overlay.width;
  const h = overlay.height;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const layout = videoLayout();
  const box = currentBox();
  if (state.isDrawingBox) {
    drawBoxAt(box, layout, "#4d8dff");
    return;
  }
  if (state.isTracking || state.track) {
    drawMask(layout, box);
    drawTrajectoryPreview(layout);
    drawBoxAt(box, layout, "#e02020");
    return;
  }
  drawBoxAt(box, layout, "#4d8dff");
}

// ---------------------------------------------------------------------------
// Curve mapping / plot
// ---------------------------------------------------------------------------

function formatCsv(times, columns) {
  const names = Object.keys(columns);
  const lines = [`timestamp [s], ${names.join(", ")}`];
  times.forEach((t, i) => {
    const vals = names.map((name) => Number(columns[name][i]).toFixed(6)).join(", ");
    lines.push(`${Number(t).toFixed(3)}, ${vals}`);
  });
  return `${lines.join("\n")}\n`;
}

function invertValues(values) {
  const h = Number(state.track?.height) || 0;
  return values.map((v) => h - v);
}

function trackedSeries() {
  if (!state.track) return null;
  const invert = byId("invert").checked;
  const series = {};
  const axis = byId("axis").value;
  if (axis === "x" || axis === "xy") series.x = state.track.x.slice();
  if (axis === "y" || axis === "xy") {
    series.y = invert ? invertValues(state.track.y) : state.track.y.slice();
  }
  return { times: state.track.times.slice(), series };
}

function applyLoadedSeries() {
  if (!state.loadedCurveSource) return null;
  state.scaledSeries = {
    times: state.loadedCurveSource.dense_times,
    series: state.loadedCurveSource.dense,
  };
  state.fitResult = { ...state.loadedCurveSource.payload };
  return state.scaledSeries;
}

function seriesReadyForFit() {
  if (state.loadedCurveSource) return applyLoadedSeries();
  return trackedSeries();
}

function drawPlot() {
  const cssW = plot.clientWidth || 320;
  const cssH = plot.clientHeight || 220;
  plot.width = Math.floor(cssW * devicePixelRatio);
  plot.height = Math.floor(cssH * devicePixelRatio);
  plotCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  plotCtx.clearRect(0, 0, cssW, cssH);
  plotCtx.fillStyle = "#f6f7f9";
  plotCtx.fillRect(0, 0, cssW, cssH);

  const left = 70;
  const right = 16;
  const top = 16;
  const bottom = 36;
  const plotW = Math.max(1, cssW - left - right);
  const plotH = Math.max(1, cssH - top - bottom);

  plotCtx.fillStyle = "#6b7788";
  plotCtx.font = "11px 'IBM Plex Mono', monospace";
  plotCtx.save();
  plotCtx.translate(12, top + plotH / 2);
  plotCtx.rotate(-Math.PI / 2);
  plotCtx.textAlign = "center";
  plotCtx.textBaseline = "middle";
  plotCtx.fillText(state.hasLoadedCurve ? "value" : "pixels", 0, 0);
  plotCtx.restore();
  plotCtx.fillText("duration (s)", cssW - 92, cssH - 10);

  const data = (!state.hasLoadedCurve && trackedSeries()) || state.scaledSeries;
  if (!data) {
    plotCtx.strokeStyle = "#c9d0d9";
    plotCtx.beginPath();
    plotCtx.moveTo(left, top);
    plotCtx.lineTo(left, top + plotH);
    plotCtx.lineTo(left + plotW, top + plotH);
    plotCtx.stroke();
    return;
  }

  const keys = Object.keys(data.series);
  const all = keys.flatMap((k) => data.series[k]);
  const t0 = data.times[0];
  const t1 = data.times[data.times.length - 1] || 1;
  let yMin = Math.min(...all);
  let yMax = Math.max(...all);
  if (yMax === yMin) {
    yMin -= 0.01;
    yMax += 0.01;
  }

  const tx = (t) => left + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const ty = (v) => top + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

  const ticks = 4;
  plotCtx.font = "10px 'IBM Plex Mono', monospace";
  for (let i = 0; i <= ticks; i += 1) {
    const u = i / ticks;
    const yv = yMin + (yMax - yMin) * (1 - u);
    const y = top + u * plotH;
    const xv = t0 + (t1 - t0) * u;
    const x = left + u * plotW;
    plotCtx.strokeStyle = "#e6ebf1";
    plotCtx.beginPath();
    plotCtx.moveTo(left, y);
    plotCtx.lineTo(left + plotW, y);
    plotCtx.stroke();
    plotCtx.fillStyle = "#6b7788";
    plotCtx.textAlign = "right";
    plotCtx.fillText(formatAxisTick(yv, yMax - yMin), left - 8, y + 3);
    plotCtx.textAlign = "left";
    if (i > 0) plotCtx.fillText(formatAxisTick(xv, t1 - t0), x - 8, top + plotH + 16);
  }

  plotCtx.strokeStyle = "#c9d0d9";
  plotCtx.beginPath();
  plotCtx.moveTo(left, top);
  plotCtx.lineTo(left, top + plotH);
  plotCtx.lineTo(left + plotW, top + plotH);
  plotCtx.stroke();

  keys.forEach((key) => {
    const values = data.series[key];
    const denseTimes = state.fitResult?.dense_times;
    const denseVals = state.fitResult?.dense?.[key];
    const linePts = denseTimes && denseVals
      ? denseTimes.map((t, i) => [t, denseVals[i]])
      : data.times.map((t, i) => [t, values[i]]);

    plotCtx.beginPath();
    plotCtx.strokeStyle = "#111418";
    plotCtx.lineWidth = 1.8;
    linePts.forEach(([t, v], i) => {
      const x = tx(t);
      const y = ty(v);
      if (i === 0) plotCtx.moveTo(x, y);
      else plotCtx.lineTo(x, y);
    });
    plotCtx.stroke();

    const knotTimes = state.fitResult?.knot_times;
    const knotVals = state.fitResult?.knot_values?.[key];
    if (knotTimes && knotVals) {
      knotTimes.forEach((t, i) => {
        plotCtx.beginPath();
        plotCtx.fillStyle = "#111418";
        plotCtx.arc(tx(t), ty(knotVals[i]), 4, 0, Math.PI * 2);
        plotCtx.fill();
      });
    }
  });

  const duration = clipDuration();
  if (!state.isLiveCamera && duration) {
    const playhead = state.track ? trackPlayheadTime() : Math.min(t1, Math.max(t0, video.currentTime || 0));
    const x = tx(Math.min(t1, Math.max(t0, playhead)));
    plotCtx.strokeStyle = "rgba(17, 20, 24, 0.35)";
    plotCtx.beginPath();
    plotCtx.moveTo(x, top);
    plotCtx.lineTo(x, top + plotH);
    plotCtx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Source: upload / camera
// ---------------------------------------------------------------------------

function clipSizeLabel(meta) {
  const tw = Number(meta.track_width);
  const th = Number(meta.track_height);
  if (tw > 0 && th > 0 && (tw !== meta.width || th !== meta.height)) {
    return `${meta.width}×${meta.height} (track ${tw}×${th})`;
  }
  return `${meta.width}×${meta.height}`;
}

function setClipMeta(text) {
  byId("clipMeta").textContent = text;
}

function attachLocalFile(file, extras = {}) {
  byId("sourceHint").textContent = "Loading clip…";
  revokeObjectUrl();
  const url = URL.createObjectURL(file);
  state.objectUrl = url;
  let done = false;
  const onReady = () => {
    if (done) return;
    done = true;
    video.removeEventListener("loadedmetadata", onReady);
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (vw < 8 || vh < 8) {
      byId("sourceHint").textContent = "Video has no usable frames. Record a bit longer and try again.";
      return;
    }
    const size = MocapTrack.trackFrameSize(vw, vh);
    const duration = extras.duration || mediaDuration();
    attachVideo({
      name: file.name || "clip",
      width: vw,
      height: vh,
      track_width: size.width,
      track_height: size.height,
      fps: extras.fps || 30,
      duration,
      nframes: duration > 0 ? Math.round(duration * (extras.fps || 30)) : 0,
    }, url);
  };
  video.addEventListener("loadedmetadata", onReady);
  video.removeAttribute("src");
  video.srcObject = null;
  video.src = url;
  if (video.readyState >= 1) onReady();
}

function attachVideo(meta, srcUrl) {
  stopCamera();
  clearLivePreview();
  state.videoMeta = meta;
  state.track = null;
  state.scaledSeries = null;
  state.hasLoadedCurve = false;
  state.loadedCurveSource = null;
  state.hasResmoothedLoadedCurve = false;
  state.exportFileName = null;
  state.bbox = null;
  state.isTracking = false;
  setBoxDrawing(false);
  clearFitResult();
  byId("invert").checked = true;
  if (byId("fps")) byId("fps").value = formatFps(meta.fps || 30);
  if (srcUrl && video.src !== srcUrl) {
    video.removeAttribute("src");
    video.srcObject = null;
    video.src = srcUrl;
  }
  video.muted = true;
  emptyState.textContent = "Drop a video here, or use Upload / Camera, then draw a box around the thing you want to follow.";
  emptyState.classList.add("hidden");
  setClipMeta(`${meta.name}  ·  ${clipSizeLabel(meta)}  ·  ${clipFps().toFixed(2)} fps  ·  ${formatSeconds(meta.duration)}s`);
  byId("sourceHint").textContent = "";
  byId("seek").max = meta.duration || 0;
  byId("seek").disabled = false;
  byId("playBtn").disabled = false;
  syncPlayButton();
  byId("timeLabel").textContent = `0 / ${formatSeconds(meta.duration)}`;
  startFrameClock();
  drawOverlay();
  drawPlot();
}

function setBoxDrawing(on) {
  state.isDrawingBox = on;
  videoFrame.classList.toggle("drawing", on);
  byId("drawBtn").textContent = on ? "Drawing…" : "Draw box";
  if (on) {
    byId("sourceHint").textContent = "Keep the box tight on the marker only. Extra background lets the tracker lock onto edges instead.";
  }
}

function refreshClipMeta() {
  if (!state.videoMeta || state.isLiveCamera) return;
  const media = mediaDuration();
  const known = Number(state.videoMeta.duration) || 0;
  // Only grow duration. A partial WebM buffer must not replace the recording length.
  const duration = media > known ? media : (known || media);
  const fps = clipFps();
  state.videoMeta.duration = duration;
  setClipMeta(`${state.videoMeta.name}  ·  ${clipSizeLabel(state.videoMeta)}  ·  ${fps.toFixed(2)} fps  ·  ${formatSeconds(duration)}s`);
  if (!state.isLiveCamera) {
    syncSeekBar();
  }
}

function stopCamera() {
  if (state.recordingClockTimer) {
    clearInterval(state.recordingClockTimer);
    state.recordingClockTimer = null;
  }
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
}

function clearLivePreview() {
  state.isLiveCamera = false;
  videoFrame.classList.remove("live");
  byId("seek").disabled = false;
  byId("playBtn").disabled = false;
  byId("playBtn").textContent = "Play";
}

async function showLivePreview(stream) {
  state.isLiveCamera = true;
  state.track = null;
  state.bbox = null;
  state.scaledSeries = null;
  state.hasLoadedCurve = false;
  state.loadedCurveSource = null;
  state.hasResmoothedLoadedCurve = false;
  state.isTracking = false;
  clearFitResult();
  videoFrame.classList.add("live");
  emptyState.classList.add("hidden");
  video.removeAttribute("src");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  byId("seek").disabled = true;
  byId("playBtn").disabled = true;
  byId("playBtn").textContent = "Live";
  setClipMeta("Live camera");
  drawOverlay();
  drawPlot();
  try {
    await video.play();
  } catch (err) {
    byId("sourceHint").textContent = err.message;
  }
  resizeOverlay();
}

function startRecClock() {
  state.recordingStartedAt = Date.now();
  const tick = () => {
    const elapsed = (Date.now() - state.recordingStartedAt) / 1000;
    byId("timeLabel").textContent = `${formatSeconds(elapsed)} / live`;
    byId("seek").value = 0;
  };
  tick();
  state.recordingClockTimer = setInterval(tick, 200);
}

// ---------------------------------------------------------------------------
// Tracking / fit / export
// ---------------------------------------------------------------------------

function applyTrackPreview(preview) {
  if (!preview || !state.track || preview.t == null || !preview.bbox) return;
  const times = state.track.times;
  const last = times.length - 1;
  if (last >= 0 && times[last] === preview.t) {
    state.track.x[last] = preview.x;
    state.track.y[last] = preview.y;
    state.track.bboxes[last] = preview.bbox;
  } else {
    times.push(preview.t);
    state.track.x.push(preview.x);
    state.track.y.push(preview.y);
    state.track.bboxes.push(preview.bbox);
  }
  if (preview.lost != null) state.track.lost = preview.lost;
  if (preview.width) state.track.width = preview.width;
  if (preview.height) state.track.height = preview.height;
  if (preview.fps) state.track.fps = preview.fps;
  if (preview.start_frame != null) state.track.start_frame = preview.start_frame;
}

function failTracking(message) {
  state.isTracking = false;
  byId("progressWrap").classList.remove("hidden");
  byId("progressText").textContent = message || "Tracking failed";
  drawOverlay();
}

function finishTracking(result) {
  state.isTracking = false;
  state.track = result;
  rebuildTrackTimestamps();
  clearFitResult();
  byId("progressWrap").classList.remove("hidden");
  byId("progressText").textContent = `Tracked ${result.times.length} frames, lost ${result.lost}`;
  const seeking = seekToTrackSample(state.track.start_frame, state.track.times.length);
  syncSeekBar();
  if (!seeking) drawOverlay();
  drawPlot();
  scheduleSplineFit();
}

/** UI smoothing 0–500 maps to being.spline s via / 1e7 (100 → 1e-5). */
function currentSmoothing() {
  const slider = Number(byId("smoothing").value);
  if (!Number.isFinite(slider) || slider <= 0) return 0;
  return slider / 1e7;
}

function formatSmoothing(value) {
  if (!(value > 0)) return "0";
  return value.toExponential(1).replace("+", "");
}

let splineFitTimer = null;
function scheduleSplineFit() {
  if (!state.track && !state.loadedCurveSource) return;
  clearTimeout(splineFitTimer);
  splineFitTimer = setTimeout(() => runSplineFit(), 280);
}

async function runSplineFit() {
  const fromLoaded = !!state.loadedCurveSource;
  const mapped = seriesReadyForFit();
  if (!mapped || mapped.times.length < 4) {
    byId("fitHint").textContent = fromLoaded
      ? "Loaded curve needs more samples to smooth."
      : "Track a box before fitting.";
    return;
  }
  byId("fitHint").textContent = "Fitting spline…";
  try {
    const names = Object.keys(mapped.series);
    const splines = names.map((name) => MocapSpline.fitSpline(mapped.times, mapped.series[name], currentSmoothing()));
    const data = MocapSpline.exportPayload(splines, names);
    data.csv = formatCsv(mapped.times, mapped.series);
    state.scaledSeries = mapped;
    state.fitResult = data;
    const durationSec = Number(data.duration);
    const durationLabel = Number.isFinite(durationSec)
      ? ` · ${durationSec.toFixed(1)} s`
      : "";
    if (fromLoaded) {
      state.hasLoadedCurve = true;
      state.hasResmoothedLoadedCurve = true;
      byId("fitHint").textContent = `${data.knots} knots${durationLabel}`;
    } else {
      state.hasLoadedCurve = false;
      state.loadedCurveSource = null;
      state.hasResmoothedLoadedCurve = false;
      byId("fitHint").textContent = `${data.knots} knots${durationLabel}`;
    }
    byId("csvBtn").disabled = false;
    byId("jsonBtn").disabled = false;
    drawPlot();
  } catch (err) {
    byId("fitHint").textContent = err.message || "Fit failed";
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

overlay.addEventListener("pointerdown", (event) => {
  if (!state.isDrawingBox || !video.videoWidth) return;
  if (typeof overlay.setPointerCapture === "function") {
    overlay.setPointerCapture(event.pointerId);
  }
  const p = clientToVideo(event);
  state.drawStartPoint = p;
  state.bbox = [Math.floor(p.x), Math.floor(p.y), 1, 1];
  drawOverlay();
});

overlay.addEventListener("pointermove", (event) => {
  if (!state.isDrawingBox || !state.drawStartPoint) return;
  const p = clientToVideo(event);
  const x = Math.min(state.drawStartPoint.x, p.x);
  const y = Math.min(state.drawStartPoint.y, p.y);
  state.bbox = [
    Math.floor(x),
    Math.floor(y),
    Math.max(1, Math.floor(Math.abs(p.x - state.drawStartPoint.x))),
    Math.max(1, Math.floor(Math.abs(p.y - state.drawStartPoint.y))),
  ];
  drawOverlay();
});

function endBoxDrawing() {
  if (!state.isDrawingBox) return;
  state.drawStartPoint = null;
  setBoxDrawing(false);
  drawOverlay();
}

overlay.addEventListener("pointerup", endBoxDrawing);
overlay.addEventListener("pointercancel", endBoxDrawing);

window.addEventListener("pointerup", endBoxDrawing);
window.addEventListener("pointercancel", endBoxDrawing);

byId("drawBtn").addEventListener("click", () => {
  if (!hasClip()) return;
  if (!video.videoWidth) {
    byId("sourceHint").textContent = "The player cannot decode this clip, so you cannot draw a box. Re-export as H.264 MP4 or WebM.";
    return;
  }
  state.isTracking = false;
  state.track = null;
  state.scaledSeries = null;
  clearFitResult();
  video.pause();
  syncPlayButton();
  setBoxDrawing(true);
  drawOverlay();
  drawPlot();
});

byId("playBtn").addEventListener("click", () => {
  if (state.isLiveCamera) return;
  if (video.paused) {
    video.play().then(syncPlayButton).catch((err) => {
      byId("sourceHint").textContent = err.message || "Could not play this clip.";
      syncPlayButton();
    });
  } else {
    video.pause();
    syncPlayButton();
  }
});

byId("seek").addEventListener("input", () => {
  if (state.isLiveCamera) return;
  video.currentTime = Number(byId("seek").value);
});

video.addEventListener("timeupdate", () => {
  if (state.isLiveCamera) return;
  syncSeekBar();
  syncPlayButton();
  if (video.seeking) return;
  if (typeof video.requestVideoFrameCallback !== "function") drawOverlay();
  if (!state.isTracking) drawPlot();
});

video.addEventListener("seeked", () => {
  if (state.isLiveCamera) return;
  state.trackSeekPending = false;
  syncSeekBar();
  drawOverlay();
  if (!state.isTracking) drawPlot();
});

video.addEventListener("play", () => {
  if (!state.isLiveCamera) syncPlayButton();
});
video.addEventListener("pause", () => {
  if (!state.isLiveCamera) syncPlayButton();
});

video.addEventListener("ended", () => {
  if (state.isLiveCamera) return;
  syncSeekBar();
  syncPlayButton();
  drawOverlay();
  drawPlot();
});

video.addEventListener("error", () => {
  if (state.isLiveCamera || !hasClip()) return;
  emptyState.textContent = "This browser cannot play this clip (unsupported codec). Re-export as H.264 MP4 or WebM.";
  emptyState.classList.remove("hidden");
  byId("sourceHint").textContent = "Clip uploaded, but the player cannot decode it. Use H.264 MP4 or WebM.";
  syncPlayButton();
});

video.addEventListener("loadedmetadata", () => {
  refreshClipMeta();
  resizeOverlay();
  startFrameClock();
});
video.addEventListener("durationchange", refreshClipMeta);
video.addEventListener("progress", refreshClipMeta);

byId("trackBtn").addEventListener("click", async () => {
  if (!hasClip() || !state.bbox) {
    byId("sourceHint").textContent = "Load a clip and draw a box first.";
    return;
  }
  const box = state.bbox;
  const duration = clipDuration();
  const fps = clipFps();
  let startTime = displayedTime();
  if (duration > 0) startTime = Math.min(startTime, Math.max(0, duration - 1 / fps));
  const trackBox = nativeToTrackBox(box);
  const tw = Number(state.videoMeta?.track_width) || video.videoWidth;
  const th = Number(state.videoMeta?.track_height) || video.videoHeight;
  state.isTracking = true;
  state.trackSeekPending = false;
  state.track = {
    times: [0],
    x: [trackBox[0] + trackBox[2] / 2],
    y: [trackBox[1] + trackBox[3] / 2],
    bboxes: [trackBox.slice()],
    width: tw,
    height: th,
    fps,
    start_frame: Math.round(startTime * fps),
    lost: 0,
  };
  state.hasLoadedCurve = false;
  state.loadedCurveSource = null;
  state.hasResmoothedLoadedCurve = false;
  clearFitResult();
  video.pause();
  syncPlayButton();
  drawOverlay();
  byId("progressWrap").classList.remove("hidden");
  byId("progressBar").style.width = "0%";
  byId("progressText").textContent = "Starting…";
  try {
    const result = await MocapTrack.trackHtmlVideo(video, {
      bbox: state.bbox,
      startTime,
      fps,
      shouldStop: () => !state.isTracking,
      onProgress: (preview, done, total) => {
        const pct = Math.round((total ? done / total : 0) * 100);
        byId("progressBar").style.width = `${pct}%`;
        byId("progressText").textContent = `Tracking ${pct}%`;
        applyTrackPreview(preview);
        drawOverlay();
      },
    });
    if (!state.isTracking) return;
    finishTracking(result);
  } catch (err) {
    failTracking(err.message || "Tracking failed");
  }
});

byId("smoothing").addEventListener("input", () => {
  byId("smoothLabel").textContent = formatSmoothing(currentSmoothing());
  if (state.hasLoadedCurve) {
    byId("fitHint").textContent = "Smoothing loaded curve…";
    scheduleSplineFit();
    return;
  }
  state.scaledSeries = null;
  clearFitResult();
  scheduleSplineFit();
});

["axis", "invert"].forEach((id) => {
  byId(id).addEventListener("input", () => {
    if (state.hasLoadedCurve) return;
    state.scaledSeries = null;
    clearFitResult();
    drawOverlay();
    drawPlot();
    scheduleSplineFit();
  });
});

byId("fps").addEventListener("input", () => {
  if (state.videoMeta) refreshClipMeta();
  if (state.hasLoadedCurve || !state.track) {
    drawPlot();
    return;
  }
  rebuildTrackTimestamps();
  state.scaledSeries = null;
  clearFitResult();
  drawOverlay();
  drawPlot();
  scheduleSplineFit();
});

byId("csvBtn").addEventListener("click", () => {
  if (!state.fitResult) return;
  download(`${exportBasename()}.csv`, state.fitResult.csv, "text/csv");
});

byId("jsonBtn").addEventListener("click", () => {
  if (!state.fitResult) return;
  download(`${exportBasename()}.json`, state.fitResult.curve, "application/json");
});

byId("fileInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) attachLocalFile(file);
});

function isVideoFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("video/")) return true;
  return /\.(mp4|m4v|mov|webm|avi|mkv|ogv)$/i.test(file.name || "");
}

function videoFromDrop(event) {
  const files = [...(event.dataTransfer?.files || [])];
  return files.find(isVideoFile) || null;
}

let dropDepth = 0;
function setDropHover(on) {
  videoFrame.classList.toggle("drop-hover", on);
}

window.addEventListener("dragover", (event) => {
  event.preventDefault();
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
});

videoFrame.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dropDepth += 1;
  setDropHover(true);
});
videoFrame.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
videoFrame.addEventListener("dragleave", () => {
  dropDepth = Math.max(0, dropDepth - 1);
  if (dropDepth === 0) setDropHover(false);
});
videoFrame.addEventListener("drop", (event) => {
  event.preventDefault();
  dropDepth = 0;
  setDropHover(false);
  if (state.isLiveCamera || state.recorder) {
    byId("sourceHint").textContent = "Stop recording before dropping a clip.";
    return;
  }
  const file = videoFromDrop(event);
  if (!file) {
    byId("sourceHint").textContent = "Drop a video file (MP4, MOV, or WebM).";
    return;
  }
  attachLocalFile(file);
});

function applyLoadedCurve(data, fileName) {
  state.hasLoadedCurve = true;
  state.hasResmoothedLoadedCurve = false;
  state.exportFileName = data.name || fileName;
  byId("invert").checked = false;
  data.csv = data.csv || formatCsv(data.knot_times, data.knot_values);
  state.loadedCurveSource = {
    curve: data.curve,
    dense: data.dense,
    dense_times: data.dense_times,
    knot_times: data.knot_times,
    knot_values: data.knot_values,
    payload: data,
  };
  applyLoadedSeries();
  byId("csvBtn").disabled = false;
  byId("jsonBtn").disabled = false;
  byId("fitHint").textContent = `Loaded ${data.knots} knots. Smoothing still applies.`;
  drawPlot();
}

byId("jsonInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  byId("fitHint").textContent = "Loading curve…";
  try {
    const text = await file.text();
    const splines = MocapSpline.curveFromJson(text);
    const names = MocapSpline.splineAxisNames(splines.length);
    const data = MocapSpline.exportPayload(splines, names, text);
    data.name = file.name;
    applyLoadedCurve(data, file.name);
  } catch (err) {
    byId("fitHint").textContent = err.message || "Could not load JSON";
  }
});

byId("camBtn").addEventListener("click", async () => {
  if (state.recorder) {
    byId("sourceHint").textContent = "Stopping recording…";
    byId("camBtn").textContent = "Camera";
    state.recorder.stop();
    state.recorder = null;
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.cameraStream = stream;
    await showLivePreview(stream);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : undefined;
    const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.recorder = rec;
    const chunks = [];
    rec.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    rec.onstop = () => {
      const elapsed = Math.max(0.1, (Date.now() - state.recordingStartedAt) / 1000);
      stopCamera();
      clearLivePreview();
      video.srcObject = null;
      const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
      if (!blob.size) {
        byId("sourceHint").textContent = "Recording was empty. Click Camera and record a bit longer.";
        return;
      }
      const file = new File([blob], "camera.webm", { type: blob.type });
      attachLocalFile(file, { duration: elapsed });
    };
    rec.start(250);
    startRecClock();
    byId("camBtn").textContent = "Stop rec";
    byId("sourceHint").textContent = "Live preview is recording. Click Stop rec when you are done.";
  } catch (err) {
    stopCamera();
    clearLivePreview();
    byId("sourceHint").textContent = err.message;
  }
});

window.addEventListener("resize", () => {
  resizeOverlay();
  drawPlot();
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    byId("playBtn").click();
  }
});

resizeOverlay();
drawPlot();
