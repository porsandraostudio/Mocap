/**
 * In-browser box tracker for GitHub Pages / static hosting.
 *
 * MOSSE correlation filter (Bolme 2010) on 640-capped grayscale frames.
 * Stops when peak-to-sidelobe ratio says the target is lost — same control
 * flow as the Python CSRT path, not the same filter.
 */
"use strict";

const MocapTrack = (() => {
  const TRACK_MAX_SIDE = 640;
  const FILTER = 64;
  const LEARNING = 0.125;
  const PSR_MIN = 5.5;
  const EPS = 1e-5;

  function trackFrameSize(width, height, maxSide = TRACK_MAX_SIDE) {
    width = Math.floor(width);
    height = Math.floor(height);
    if (height > maxSide) {
      const ratio = maxSide / height;
      width = Math.floor(width * ratio);
      height = maxSide;
    }
    if (width > maxSide) {
      const ratio = maxSide / width;
      height = Math.floor(height * ratio);
      width = maxSide;
    }
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  function scaleBbox(bbox, srcW, srcH, dstW, dstH) {
    const sx = srcW ? dstW / srcW : 1;
    const sy = srcH ? dstH / srcH : 1;
    return [
      Math.floor(bbox[0] * sx),
      Math.floor(bbox[1] * sy),
      Math.max(1, Math.floor(bbox[2] * sx)),
      Math.max(1, Math.floor(bbox[3] * sy)),
    ];
  }

  function clampBbox(bbox, frameW, frameH) {
    let [x, y, w, h] = bbox.map((v) => Math.floor(v));
    x = Math.max(0, Math.min(x, Math.max(0, frameW - 1)));
    y = Math.max(0, Math.min(y, Math.max(0, frameH - 1)));
    w = Math.max(1, Math.min(w, frameW - x));
    h = Math.max(1, Math.min(h, frameH - y));
    return [x, y, w, h];
  }

  function boxCenter(box) {
    const [x, y, w, h] = box.map((v) => Math.floor(v));
    return [x + Math.floor(w / 2), y + Math.floor(h / 2)];
  }

  function fft(re, im, invert) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((invert ? 2 : -2) * Math.PI) / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j += 1) {
          const uRe = re[i + j];
          const uIm = im[i + j];
          const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
          const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + half] = uRe - vRe;
          im[i + j + half] = uIm - vIm;
          const nextRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextRe;
        }
      }
    }
    if (invert) {
      for (let i = 0; i < n; i += 1) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }

  function fft2(re, im, w, h, invert) {
    const rowRe = new Float64Array(w);
    const rowIm = new Float64Array(w);
    for (let y = 0; y < h; y += 1) {
      const off = y * w;
      for (let x = 0; x < w; x += 1) {
        rowRe[x] = re[off + x];
        rowIm[x] = im[off + x];
      }
      fft(rowRe, rowIm, invert);
      for (let x = 0; x < w; x += 1) {
        re[off + x] = rowRe[x];
        im[off + x] = rowIm[x];
      }
    }
    const colRe = new Float64Array(h);
    const colIm = new Float64Array(h);
    for (let x = 0; x < w; x += 1) {
      for (let y = 0; y < h; y += 1) {
        colRe[y] = re[y * w + x];
        colIm[y] = im[y * w + x];
      }
      fft(colRe, colIm, invert);
      for (let y = 0; y < h; y += 1) {
        re[y * w + x] = colRe[y];
        im[y * w + x] = colIm[y];
      }
    }
  }

  function hann2d(w, h) {
    const win = new Float64Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / Math.max(1, h - 1));
      for (let x = 0; x < w; x += 1) {
        const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / Math.max(1, w - 1));
        win[y * w + x] = wx * wy;
      }
    }
    return win;
  }

  function gaussianPeak(w, h, sigma) {
    const re = new Float64Array(w * h);
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const s2 = 2 * sigma * sigma;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        re[y * w + x] = Math.exp(-(dx * dx + dy * dy) / s2);
      }
    }
    return re;
  }

  function preprocess(gray, win) {
    const n = gray.length;
    const out = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i += 1) {
      out[i] = Math.log(gray[i] + 1);
      mean += out[i];
    }
    mean /= n;
    let varsum = 0;
    for (let i = 0; i < n; i += 1) {
      out[i] -= mean;
      varsum += out[i] * out[i];
    }
    const std = Math.sqrt(varsum / n) + EPS;
    for (let i = 0; i < n; i += 1) out[i] = (out[i] / std) * win[i];
    return out;
  }

  function samplePatch(gray, frameW, frameH, cx, cy, w, h) {
    const patch = new Float64Array(w * h);
    const x0 = cx - (w - 1) / 2;
    const y0 = cy - (h - 1) / 2;
    for (let y = 0; y < h; y += 1) {
      const fy = y0 + y;
      const y1 = Math.floor(fy);
      const y2 = y1 + 1;
      const wy = fy - y1;
      for (let x = 0; x < w; x += 1) {
        const fx = x0 + x;
        const x1 = Math.floor(fx);
        const x2 = x1 + 1;
        const wx = fx - x1;
        const g = (ix, iy) => {
          if (ix < 0 || iy < 0 || ix >= frameW || iy >= frameH) return 0;
          return gray[iy * frameW + ix];
        };
        patch[y * w + x] = (1 - wy) * ((1 - wx) * g(x1, y1) + wx * g(x2, y1))
          + wy * ((1 - wx) * g(x1, y2) + wx * g(x2, y2));
      }
    }
    return patch;
  }

  function rgbaToGray(imageData) {
    const { width, height, data } = imageData;
    const gray = new Float64Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return gray;
  }

  class MosseTracker {
    constructor() {
      this.w = FILTER;
      this.h = FILTER;
      this.win = hann2d(this.w, this.h);
      const gRe = gaussianPeak(this.w, this.h, 2.0);
      const gIm = new Float64Array(this.w * this.h);
      fft2(gRe, gIm, this.w, this.h, false);
      this.gRe = gRe;
      this.gIm = gIm;
      this.aRe = new Float64Array(this.w * this.h);
      this.aIm = new Float64Array(this.w * this.h);
      this.bRe = new Float64Array(this.w * this.h);
      this.bIm = new Float64Array(this.w * this.h);
      this.cx = 0;
      this.cy = 0;
      this.boxW = 1;
      this.boxH = 1;
    }

    _accumulate(fRe, fIm, rate) {
      const n = fRe.length;
      const keep = 1 - rate;
      for (let i = 0; i < n; i += 1) {
        const aRe = this.gRe[i] * fRe[i] + this.gIm[i] * fIm[i];
        const aIm = this.gIm[i] * fRe[i] - this.gRe[i] * fIm[i];
        const bRe = fRe[i] * fRe[i] + fIm[i] * fIm[i];
        this.aRe[i] = keep * this.aRe[i] + rate * aRe;
        this.aIm[i] = keep * this.aIm[i] + rate * aIm;
        this.bRe[i] = keep * this.bRe[i] + rate * bRe;
      }
    }

    _filterFromPatch(gray, frameW, frameH) {
      const patch = samplePatch(gray, frameW, frameH, this.cx, this.cy, this.w, this.h);
      const pre = preprocess(patch, this.win);
      const re = pre;
      const im = new Float64Array(this.w * this.h);
      fft2(re, im, this.w, this.h, false);
      return { re, im };
    }

    init(imageData, bbox) {
      const frameW = imageData.width;
      const frameH = imageData.height;
      const gray = rgbaToGray(imageData);
      const box = clampBbox(bbox, frameW, frameH);
      const [cx, cy] = boxCenter(box);
      this.cx = cx;
      this.cy = cy;
      this.boxW = box[2];
      this.boxH = box[3];
      this.aRe.fill(0);
      this.aIm.fill(0);
      this.bRe.fill(0);
      this.bIm.fill(0);
      const { re, im } = this._filterFromPatch(gray, frameW, frameH);
      this._accumulate(re, im, 1);
      return true;
    }

    update(imageData) {
      const frameW = imageData.width;
      const frameH = imageData.height;
      const gray = rgbaToGray(imageData);
      const { re: fRe, im: fIm } = this._filterFromPatch(gray, frameW, frameH);
      const n = this.w * this.h;
      const rRe = new Float64Array(n);
      const rIm = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        const denom = this.bRe[i] + EPS;
        const hRe = this.aRe[i] / denom;
        const hIm = this.aIm[i] / denom;
        rRe[i] = hRe * fRe[i] - hIm * fIm[i];
        rIm[i] = hRe * fIm[i] + hIm * fRe[i];
      }
      fft2(rRe, rIm, this.w, this.h, true);

      let peak = -Infinity;
      let px = 0;
      let py = 0;
      for (let y = 0; y < this.h; y += 1) {
        for (let x = 0; x < this.w; x += 1) {
          const v = rRe[y * this.w + x];
          if (v > peak) {
            peak = v;
            px = x;
            py = y;
          }
        }
      }

      let sum = 0;
      let sum2 = 0;
      let count = 0;
      for (let y = 0; y < this.h; y += 1) {
        for (let x = 0; x < this.w; x += 1) {
          if (Math.abs(x - px) <= 5 && Math.abs(y - py) <= 5) continue;
          const v = rRe[y * this.w + x];
          sum += v;
          sum2 += v * v;
          count += 1;
        }
      }
      const mean = count ? sum / count : 0;
      const std = count ? Math.sqrt(Math.max(0, sum2 / count - mean * mean)) + EPS : 1;
      const psr = (peak - mean) / std;
      if (psr < PSR_MIN) return { ok: false, box: [0, 0, 0, 0] };

      this.cx += px - (this.w - 1) / 2;
      this.cy += py - (this.h - 1) / 2;
      this.cx = Math.max(0, Math.min(frameW - 1, this.cx));
      this.cy = Math.max(0, Math.min(frameH - 1, this.cy));

      const { re, im } = this._filterFromPatch(gray, frameW, frameH);
      this._accumulate(re, im, LEARNING);

      const x = Math.round(this.cx - this.boxW / 2);
      const y = Math.round(this.cy - this.boxH / 2);
      const box = clampBbox([x, y, this.boxW, this.boxH], frameW, frameH);
      return { ok: true, box };
    }
  }

  function seekVideo(video, time) {
    const target = Math.max(0, time);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener("seeked", finish);
        resolve();
      };
      if (Math.abs((Number(video.currentTime) || 0) - target) < 0.002) {
        resolve();
        return;
      }
      video.addEventListener("seeked", finish);
      video.currentTime = target;
      setTimeout(finish, 280);
    });
  }

  async function trackHtmlVideo(video, options) {
    const {
      bbox,
      startTime = 0,
      nativeFps = 30,
      timestampFps = nativeFps,
      maxSide = TRACK_MAX_SIDE,
      shouldStop = () => false,
      onProgress = null,
    } = options;

    const nativeW = video.videoWidth || 1;
    const nativeH = video.videoHeight || 1;
    const size = trackFrameSize(nativeW, nativeH, maxSide);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const fps = Number(nativeFps) > 0 ? Number(nativeFps) : 30;
    const stampFps = Number(timestampFps) >= 1 ? Number(timestampFps) : fps;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    let startFrame = Math.round(Math.max(0, startTime) * fps);
    if (duration > 0) {
      const last = Math.max(0, Math.round(duration * fps) - 1);
      startFrame = Math.min(startFrame, last);
    }

    await seekVideo(video, startFrame / fps);
    ctx.drawImage(video, 0, 0, size.width, size.height);
    let frame = ctx.getImageData(0, 0, size.width, size.height);

    const trackBbox = clampBbox(
      scaleBbox(bbox, nativeW, nativeH, size.width, size.height),
      size.width,
      size.height,
    );
    const tracker = new MosseTracker();
    if (!tracker.init(frame, trackBbox)) {
      throw new Error("Tracker failed to initialize on the selected box.");
    }

    const times = [];
    const centerX = [];
    const centerY = [];
    const boxes = [];
    let lostTarget = false;

    const record = (box, timeSec) => {
      const [cx, cy] = boxCenter(box);
      times.push(Number(timeSec));
      centerX.push(cx);
      centerY.push(cy);
      boxes.push(box.map(Number));
    };

    const preview = () => ({
      t: times[times.length - 1] || 0,
      x: centerX[centerX.length - 1] || 0,
      y: centerY[centerY.length - 1] || 0,
      bbox: boxes[boxes.length - 1] ? boxes[boxes.length - 1].slice() : [0, 0, 0, 0],
      n: times.length,
      width: size.width,
      height: size.height,
      lost: lostTarget ? 1 : 0,
      fps: stampFps,
      native_fps: fps,
      start_frame: startFrame,
    });

    record(trackBbox, 0);
    const framesTotal = duration > 0 ? Math.max(Math.round(duration * fps) - startFrame, 1) : 0;
    let framesDone = 1;
    if (onProgress) onProgress(preview(), framesDone, framesTotal || framesDone);

    let sampleIndex = 0;
    while (!shouldStop()) {
      const nextFrame = startFrame + framesDone;
      const nextTime = nextFrame / fps;
      if (duration > 0 && nextTime >= duration - 1e-4) break;
      const before = Number(video.currentTime) || 0;
      await seekVideo(video, nextTime);
      const after = Number(video.currentTime) || 0;
      if (duration > 0 && after >= duration - 1e-3 && after <= before + 1e-4) break;
      if (after + 1e-4 < nextTime && Math.abs(after - before) < 1e-4) break;

      ctx.drawImage(video, 0, 0, size.width, size.height);
      frame = ctx.getImageData(0, 0, size.width, size.height);
      framesDone += 1;
      const { ok, box } = tracker.update(frame);
      if (!ok || box[2] <= 0 || box[3] <= 0) {
        lostTarget = true;
        break;
      }
      sampleIndex += 1;
      record(box, sampleIndex / stampFps);
      if (onProgress && (framesDone % 8 === 0 || (framesTotal && framesDone >= framesTotal))) {
        onProgress(preview(), framesDone, framesTotal || framesDone);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (onProgress) onProgress(preview(), framesDone, framesDone);

    return {
      fps: stampFps,
      native_fps: fps,
      width: size.width,
      height: size.height,
      start_frame: startFrame,
      times,
      x: centerX,
      y: centerY,
      bboxes: boxes,
      lost: lostTarget ? 1 : 0,
    };
  }

  return { trackFrameSize, trackHtmlVideo };
})();
