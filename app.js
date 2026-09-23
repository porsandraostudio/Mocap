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
  cameraRecording: null,
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
  downloadBlob(name, new Blob([text], { type }));
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function setCameraRecording(file) {
  state.cameraRecording = file || null;
  const btn = byId("downloadClipBtn");
  if (btn) btn.disabled = !file;
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

function exportAxes() {
  return Object.keys(state.fitResult?.knot_values || {});
}

function downloadAxisExports(format) {
  if (!state.fitResult) return;
  const axes = exportAxes();
  const extension = format === "csv" ? "csv" : "json";
  const type = format === "csv" ? "text/csv" : "application/json";
  if (axes.length <= 1) {
    const content = format === "csv" ? state.fitResult.csv : state.fitResult.curve;
    download(`${exportBasename()}.${extension}`, content, type);
    return;
  }

  const curve = format === "json" ? JSON.parse(state.fitResult.curve) : null;
  axes.forEach((axis, index) => {
    const content = format === "csv"
      ? formatCsv(state.fitResult.knot_times, { [axis]: state.fitResult.knot_values[axis] })
      : JSON.stringify({ splines: [curve.splines[index]], type: "Curve" }, null, 4);
    download(`${exportBasename()}-${axis}.${extension}`, content, type);
  });
}

function mediaDuration() {
  const d = video.duration;
  if (Number.isFinite(d) && d > 0) return d;
  return 0;
}

function isWebmBlob(file) {
  if (!file) return false;
  if (file.type && /webm/i.test(file.type)) return true;
  return /\.webm$/i.test(file.name || "");
}

function isMp4Like(file) {
  if (!file) return false;
  if (file.type && /(mp4|quicktime|m4v)/i.test(file.type)) return true;
  return /\.(mp4|m4v|mov)$/i.test(file.name || "");
}

function readEbmlId(view, offset) {
  const first = view.getUint8(offset);
  let width = 1;
  let mask = 0x80;
  while (width < 4 && !(first & mask)) {
    width += 1;
    mask >>= 1;
  }
  if (!(first & mask)) throw new Error("bad id");
  let id = 0;
  for (let i = 0; i < width; i += 1) id = (id << 8) | view.getUint8(offset + i);
  return { id, width };
}

function readEbmlSize(view, offset) {
  const first = view.getUint8(offset);
  let width = 1;
  let mask = 0x80;
  while (width < 8 && !(first & mask)) {
    width += 1;
    mask >>= 1;
  }
  if (!(first & mask)) throw new Error("bad size");
  const dataMask = mask - 1;
  let unknown = (first & dataMask) === dataMask;
  let value = first & dataMask;
  for (let i = 1; i < width; i += 1) {
    const b = view.getUint8(offset + i);
    if (b !== 0xff) unknown = false;
    value = value * 256 + b;
  }
  return { value, width, unknown };
}

function readEbmlVint(view, offset) {
  const first = view.getUint8(offset);
  let width = 1;
  let mask = 0x80;
  while (width < 8 && !(first & mask)) {
    width += 1;
    mask >>= 1;
  }
  let value = first & (mask - 1);
  for (let i = 1; i < width; i += 1) value = value * 256 + view.getUint8(offset + i);
  return { value, width };
}

function readEbmlUint(view, offset, len) {
  let n = 0;
  for (let i = 0; i < len; i += 1) n = n * 256 + view.getUint8(offset + i);
  return n;
}

function readWebmTiming(buffer) {
  const view = new DataView(buffer);
  const end = view.byteLength;
  let scale = 1000000;
  let duration = 0;
  let clusterTs = 0;
  let lastBlock = 0;
  let prevBlock = 0;
  let offset = 0;
  while (offset + 2 < end) {
    let id;
    let size;
    try {
      id = readEbmlId(view, offset);
      size = readEbmlSize(view, offset + id.width);
    } catch (_) {
      break;
    }
    const payload = offset + id.width + size.width;
    if (id.id === 0x2ad7b1 && !size.unknown && size.value > 0 && payload + size.value <= end) {
      const n = readEbmlUint(view, payload, size.value);
      if (n > 0) scale = n;
    } else if (id.id === 0x4489 && !size.unknown && (size.value === 4 || size.value === 8) && payload + size.value <= end) {
      duration = size.value === 8 ? view.getFloat64(payload) : view.getFloat32(payload);
    } else if (id.id === 0xe7 && !size.unknown && size.value > 0 && payload + size.value <= end) {
      clusterTs = readEbmlUint(view, payload, size.value);
    } else if ((id.id === 0xa3 || id.id === 0xa1) && !size.unknown && payload + 3 <= end) {
      try {
        const track = readEbmlVint(view, payload);
        const abs = clusterTs + view.getInt16(payload + track.width);
        if (abs > lastBlock) {
          prevBlock = lastBlock;
          lastBlock = abs;
        }
      } catch (_) { /* skip a truncated block */ }
    }
    const enter = id.id === 0x18538067 || id.id === 0x1549a966 || id.id === 0x1f43b675
      || id.id === 0xa0 || id.id === 0x1c53bb6b || id.id === 0xbb || size.unknown;
    offset = enter ? payload : payload + size.value;
  }
  const fromDuration = duration > 0 ? (duration * scale) / 1e9 : 0;
  const lastDelta = lastBlock > prevBlock ? lastBlock - prevBlock : 0;
  const fromBlocks = lastBlock > 0 ? ((lastBlock + lastDelta) * scale) / 1e9 : 0;
  return Math.max(fromDuration, fromBlocks);
}

async function webmDurationSeconds(file) {
  try {
    const buffer = await file.arrayBuffer();
    return readWebmTiming(buffer);
  } catch (_) {
    return 0;
  }
}

function readFourCC(view, offset) {
  if (offset + 4 > view.byteLength) return "";
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function walkIsoBoxes(view, start, end, onBox) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = readFourCC(view, offset + 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isFinite(size) || size < header) break;
    const boxEnd = Math.min(end, offset + size);
    const payload = offset + header;
    const enter = onBox(type, payload, boxEnd);
    if (enter) walkIsoBoxes(view, payload, boxEnd, onBox);
    if (size === 0) break;
    offset = boxEnd;
  }
}

function findIsoBoxOffset(view, type) {
  for (let i = 4; i + 4 <= view.byteLength; i += 1) {
    if (readFourCC(view, i) === type) return Math.max(0, i - 4);
  }
  return -1;
}

function parseMp4Timing(buffer) {
  const view = new DataView(buffer);
  const tracks = [];

  const readTrack = (payload, boxEnd) => {
    const track = { vide: false, timescale: 0, duration: 0, samples: 0, delta: 0, codec: "" };
    walkIsoBoxes(view, payload, boxEnd, (type, p, end) => {
      if (type === "mdia" || type === "minf" || type === "stbl") return true;
      if (type === "hdlr" && p + 12 <= end) {
        if (readFourCC(view, p + 8) === "vide") track.vide = true;
      } else if (type === "mdhd" && p + 4 <= end) {
        const version = view.getUint8(p);
        if (version === 1 && p + 32 <= end) {
          track.timescale = view.getUint32(p + 20);
          const dur = Number(view.getBigUint64(p + 24));
          if (dur > 0) track.duration = dur;
        } else if (p + 20 <= end) {
          track.timescale = view.getUint32(p + 12);
          const dur = view.getUint32(p + 16);
          if (dur > 0) track.duration = dur;
        }
      } else if (type === "stts" && p + 8 <= end) {
        const count = view.getUint32(p + 4);
        let samples = 0;
        let weighted = 0;
        let firstDelta = 0;
        for (let i = 0; i < count; i += 1) {
          const off = p + 8 + i * 8;
          if (off + 8 > end) break;
          const n = view.getUint32(off);
          const delta = view.getUint32(off + 4);
          samples += n;
          weighted += n * delta;
          if (!firstDelta && delta) firstDelta = delta;
        }
        track.samples = samples;
        track.delta = samples ? weighted / samples : firstDelta;
      } else if (type === "stsd" && p + 16 <= end) {
        track.codec = readFourCC(view, p + 12);
      }
      return false;
    });
    return track;
  };

  const scan = (start) => {
    walkIsoBoxes(view, start, view.byteLength, (type, payload, boxEnd) => {
      if (type === "moov") return true;
      if (type === "trak") {
        tracks.push(readTrack(payload, boxEnd));
        return false;
      }
      return false;
    });
  };
  scan(0);
  if (!tracks.length) {
    const moovAt = findIsoBoxOffset(view, "moov");
    if (moovAt >= 0) scan(moovAt);
  }

  const videoTrack = tracks.find((t) => t.vide && t.timescale > 0) || tracks.find((t) => t.timescale > 0);
  if (!videoTrack) return { fps: 0, duration: 0, codec: "" };
  let fps = 0;
  if (videoTrack.duration > 0 && videoTrack.samples > 1) {
    fps = (videoTrack.samples * videoTrack.timescale) / videoTrack.duration;
  } else if (videoTrack.delta > 0 && videoTrack.timescale > 0) {
    fps = videoTrack.timescale / videoTrack.delta;
  }
  const duration = videoTrack.timescale > 0 && videoTrack.duration > 0
    ? videoTrack.duration / videoTrack.timescale
    : 0;
  if (!(fps >= 1 && fps <= 240)) fps = 0;
  return { fps, duration, codec: videoTrack.codec || "" };
}

function parseWebmTimingInfo(buffer) {
  const duration = readWebmTiming(buffer);
  const view = new DataView(buffer);
  const end = view.byteLength;
  let defaultDuration = 0;
  let offset = 0;
  while (offset + 2 < end) {
    let id;
    let size;
    try {
      id = readEbmlId(view, offset);
      size = readEbmlSize(view, offset + id.width);
    } catch (_) {
      break;
    }
    const payload = offset + id.width + size.width;
    if (id.id === 0x23e383 && !size.unknown && size.value > 0 && payload + size.value <= end) {
      defaultDuration = readEbmlUint(view, payload, size.value);
    }
    const enter = id.id === 0x18538067 || id.id === 0x1549a966 || id.id === 0x1f43b675
      || id.id === 0x1654ae6b || id.id === 0xae
      || id.id === 0xa0 || id.id === 0x1c53bb6b || id.id === 0xbb || size.unknown;
    offset = enter ? payload : payload + size.value;
  }
  let fps = 0;
  if (defaultDuration > 0) fps = 1e9 / defaultDuration;
  if (!(fps >= 1 && fps <= 240)) fps = 0;
  return { fps, duration, codec: "vp8" };
}

async function detectMediaTiming(file) {
  const empty = { fps: 0, duration: 0, codec: "" };
  if (!file) return empty;
  try {
    const chunk = 8 * 1024 * 1024;
    const head = await file.slice(0, Math.min(file.size, chunk)).arrayBuffer();
    const tryParse = (buffer) => {
      if (isWebmBlob(file)) return parseWebmTimingInfo(buffer);
      return parseMp4Timing(buffer);
    };
    let timing = tryParse(head);
    if (timing.fps > 0 || timing.duration > 0) return timing;
    if (file.size > chunk) {
      const tail = await file.slice(Math.max(0, file.size - chunk)).arrayBuffer();
      timing = tryParse(tail);
      if (timing.fps > 0 || timing.duration > 0) return timing;
    }
  } catch (_) { /* fall through */ }
  return empty;
}

function writeEbmlSize(value, width) {
  const bytes = new Uint8Array(width);
  let n = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    bytes[i] = n & 0xff;
    n >>= 8;
  }
  bytes[0] |= 1 << (8 - width);
  return bytes;
}

async function withWebmDuration(blob, durationSec) {
  if (!(durationSec > 0) || !isWebmBlob(blob)) return blob;
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let scale = 1000000;
  let infoPayload = -1;
  let infoSizeOffset = -1;
  let infoSizeWidth = 0;
  let infoSizeUnknown = false;
  let infoEnd = -1;
  let durationAt = -1;
  let durationLen = 0;
  let offset = 0;
  const end = bytes.length;
  while (offset + 2 < end) {
    let id;
    let size;
    try {
      id = readEbmlId(view, offset);
      size = readEbmlSize(view, offset + id.width);
    } catch (_) {
      break;
    }
    const payload = offset + id.width + size.width;
    if (id.id === 0x1549a966) {
      infoPayload = payload;
      infoSizeOffset = offset + id.width;
      infoSizeWidth = size.width;
      infoSizeUnknown = size.unknown;
      infoEnd = size.unknown ? end : payload + size.value;
    } else if (id.id === 0x2ad7b1 && !size.unknown && payload + size.value <= end) {
      const n = readEbmlUint(view, payload, size.value);
      if (n > 0) scale = n;
    } else if (id.id === 0x4489 && !size.unknown) {
      durationAt = payload;
      durationLen = size.value;
    }
    if (id.id === 0x18538067 || id.id === 0x1549a966) offset = payload;
    else if (size.unknown) offset = payload;
    else offset = payload + size.value;
    if (infoPayload >= 0 && !infoSizeUnknown && offset >= infoEnd) break;
  }
  const durationValue = (durationSec * 1e9) / scale;
  if (durationAt >= 0 && (durationLen === 4 || durationLen === 8)) {
    const out = bytes.slice();
    const outView = new DataView(out.buffer);
    if (durationLen === 8) outView.setFloat64(durationAt, durationValue);
    else outView.setFloat32(durationAt, durationValue);
    return new Blob([out], { type: blob.type });
  }
  if (infoPayload < 0) return blob;
  const durationEl = new Uint8Array(11);
  durationEl[0] = 0x44;
  durationEl[1] = 0x89;
  durationEl[2] = 0x88;
  new DataView(durationEl.buffer).setFloat64(3, durationValue);
  const before = bytes.subarray(0, infoPayload);
  const after = bytes.subarray(infoPayload);
  if (!infoSizeUnknown && infoSizeWidth > 0) {
    const oldSize = readEbmlSize(view, infoSizeOffset).value;
    const sizeBytes = writeEbmlSize(oldSize + durationEl.length, infoSizeWidth);
    if (sizeBytes.length === infoSizeWidth) {
      const patched = bytes.slice();
      patched.set(sizeBytes, infoSizeOffset);
      const merged = new Uint8Array(patched.length + durationEl.length);
      merged.set(patched.subarray(0, infoPayload), 0);
      merged.set(durationEl, infoPayload);
      merged.set(patched.subarray(infoPayload), infoPayload + durationEl.length);
      return new Blob([merged], { type: blob.type });
    }
  }
  const merged = new Uint8Array(before.length + durationEl.length + after.length);
  merged.set(before, 0);
  merged.set(durationEl, before.length);
  merged.set(after, before.length + durationEl.length);
  return new Blob([merged], { type: blob.type });
}

/** Prefer the known clip length. Do not follow a growing WebM buffer. */
function clipDuration() {
  const known = Number(state.videoMeta?.duration) || 0;
  if (known > 0) return known;
  return mediaDuration();
}

/** FPS field: tracking sample rate. Timestamps come from the media clock. */
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
  if (extras.camera) setCameraRecording(file);
  else setCameraRecording(null);
  byId("sourceHint").textContent = "Loading clip…";
  revokeObjectUrl();
  const url = URL.createObjectURL(file);
  state.objectUrl = url;
  let done = false;
  const onReady = async () => {
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
    const timing = await detectMediaTiming(file);
    let duration = Number(extras.duration) || mediaDuration();
    if (!(duration > 0) && timing.duration > 0) duration = timing.duration;
    if (!(duration > 0) && isWebmBlob(file)) {
      duration = await webmDurationSeconds(file);
    }
    const fps = extras.fps || timing.fps || 30;
    attachVideo({
      name: file.name || "clip",
      width: vw,
      height: vh,
      track_width: size.width,
      track_height: size.height,
      fps,
      duration,
      nframes: duration > 0 ? Math.round(duration * fps) : 0,
      codec: timing.codec || "",
    }, url);
    if (/^(hvc1|hev1|hvcC)$/i.test(timing.codec || "")) {
      byId("sourceHint").textContent = "This clip is HEVC. If it will not play, re-export as H.264 MP4.";
    }
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
  byId("progressWrap").classList.add("hidden");
  byId("fitHint").textContent = "Track or load JSON. Black dots are knots.";
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
  byId("sourceHint").textContent = state.cameraRecording
    ? "Recording ready. Use Download to save the clip, or draw a box to track."
    : "";
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
}

function refreshClipMeta() {
  if (!state.videoMeta || state.isLiveCamera) return;
  const known = Number(state.videoMeta.duration) || 0;
  const media = mediaDuration();
  const duration = known > 0 ? known : media;
  if (duration > 0) state.videoMeta.duration = duration;
  const fps = clipFps();
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
  clearFitResult();
  byId("progressWrap").classList.remove("hidden");
  const extra = result.stopped_early ? " (lost the marker)" : "";
  byId("progressText").textContent = `Tracked ${result.times.length} frames, lost ${result.lost}${extra}`;
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
  if (state.isTracking) {
    state.isTracking = false;
    byId("trackBtn").textContent = "Track";
    byId("progressText").textContent = "Stopping…";
    return;
  }
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
  byId("trackBtn").textContent = "Stop";
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
        const lost = preview.lost ? ` · lost ${preview.lost}` : "";
        byId("progressText").textContent = `Tracking ${pct}%${lost}`;
        applyTrackPreview(preview);
        drawOverlay();
      },
    });
    if (result?.times?.length >= 4) {
      finishTracking(result);
    } else {
      failTracking(state.isTracking ? "Tracking failed" : "Stopped");
    }
  } catch (err) {
    failTracking(err.message || "Tracking failed");
  } finally {
    byId("trackBtn").textContent = "Track";
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
  drawPlot();
});

byId("csvBtn").addEventListener("click", () => {
  downloadAxisExports("csv");
});

byId("jsonBtn").addEventListener("click", () => {
  downloadAxisExports("json");
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

byId("downloadClipBtn").addEventListener("click", async () => {
  const file = state.cameraRecording;
  if (!file) return;
  const duration = clipDuration() || await webmDurationSeconds(file);
  const out = await withWebmDuration(file, duration);
  downloadBlob(file.name || "camera.webm", out);
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
    rec.onstop = async () => {
      const elapsed = Math.max(0.1, (Date.now() - state.recordingStartedAt) / 1000);
      stopCamera();
      clearLivePreview();
      video.srcObject = null;
      const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
      if (!blob.size) {
        byId("sourceHint").textContent = "Recording was empty. Click Camera and record a bit longer.";
        return;
      }
      const fixed = await withWebmDuration(blob, elapsed);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = new File([fixed], `camera-${stamp}.webm`, { type: blob.type });
      attachLocalFile(file, { duration: elapsed, camera: true });
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
