/**
 * In-browser MOSSE box tracker (Bolme 2010) on 1080-capped grayscale frames.
 * Weak PSR frames keep the last box and tracking continues to the end of the clip.
 */
"use strict";

const MocapTrack = (() => {
  const TRACK_MAX_SIDE = 1080;
  const FILTER = 64;
  const LEARNING = 0.08;
  const PSR_MIN = 5.0;
  const PSR_LEARN = 6.5;
  const WINDOW_PAD = 2;
  const INIT_SAMPLES = 8;
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
    let [x, y, w, h] = bbox.map(Number);
    w = Math.max(1, w);
    h = Math.max(1, h);
    x = Math.max(0, Math.min(x, Math.max(0, frameW - w)));
    y = Math.max(0, Math.min(y, Math.max(0, frameH - h)));
    w = Math.max(1, Math.min(w, frameW - x));
    h = Math.max(1, Math.min(h, frameH - y));
    return [x, y, w, h];
  }

  function boxCenter(box) {
    return [box[0] + box[2] / 2, box[1] + box[3] / 2];
  }

  function subpixelOffset(resp, w, h, px, py) {
    const at = (x, y) => resp[(((y % h) + h) % h) * w + (((x % w) + w) % w)];
    const c = at(px, py);
    const l = at(px - 1, py);
    const r = at(px + 1, py);
    const u = at(px, py - 1);
    const d = at(px, py + 1);
    const denX = l - 2 * c + r;
    const denY = u - 2 * c + d;
    const dx = denX ? (0.5 * (l - r)) / denX : 0;
    const dy = denY ? (0.5 * (u - d)) / denY : 0;
    return {
      dx: Math.max(-1, Math.min(1, dx)),
      dy: Math.max(-1, Math.min(1, dy)),
    };
  }

  class OneEuro {
    constructor(freq, minCutoff = 1.7, beta = 0.35, dCutoff = 1) {
      this.freq = Math.max(1, freq);
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.xHat = null;
      this.dxHat = 0;
    }

    alpha(cutoff) {
      const tau = 1 / (2 * Math.PI * cutoff);
      const te = 1 / this.freq;
      return 1 / (1 + tau / te);
    }

    filter(value) {
      if (this.xHat == null) {
        this.xHat = value;
        return value;
      }
      const dx = (value - this.xHat) * this.freq;
      const aD = this.alpha(this.dCutoff);
      this.dxHat = aD * dx + (1 - aD) * this.dxHat;
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
      const a = this.alpha(cutoff);
      this.xHat = a * value + (1 - a) * this.xHat;
      return this.xHat;
    }
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

  function sampleWindow(gray, frameW, frameH, cx, cy, winW, winH, outW, outH) {
    const patch = new Float64Array(outW * outH);
    const stepX = winW / outW;
    const stepY = winH / outH;
    const x0 = cx - winW / 2 + stepX / 2;
    const y0 = cy - winH / 2 + stepY / 2;
    const g = (ix, iy) => {
      if (ix < 0 || iy < 0 || ix >= frameW || iy >= frameH) return 0;
      return gray[iy * frameW + ix];
    };
    for (let y = 0; y < outH; y += 1) {
      const fy = y0 + y * stepY;
      const y1 = Math.floor(fy);
      const y2 = y1 + 1;
      const wy = fy - y1;
      for (let x = 0; x < outW; x += 1) {
        const fx = x0 + x * stepX;
        const x1 = Math.floor(fx);
        const x2 = x1 + 1;
        const wx = fx - x1;
        patch[y * outW + x] = (1 - wy) * ((1 - wx) * g(x1, y1) + wx * g(x2, y1))
          + wy * ((1 - wx) * g(x1, y2) + wx * g(x2, y2));
      }
    }
    return patch;
  }

  function pixelLum(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function sampleAppearance(imageData, bbox) {
    const { data, width, height } = imageData;
    const [bx, by, bw, bh] = clampBbox(bbox, width, height);
    const x0 = Math.floor(bx + bw * 0.2);
    const y0 = Math.floor(by + bh * 0.2);
    const x1 = Math.max(x0 + 1, Math.floor(bx + bw * 0.8));
    const y1 = Math.max(y0 + 1, Math.floor(by + bh * 0.8));
    let boxLum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 4;
        boxLum += pixelLum(data[i], data[i + 1], data[i + 2]);
        n += 1;
      }
    }
    boxLum = n ? boxLum / n : 0;
    const pad = Math.max(6, Math.round(Math.max(bw, bh)));
    const rx0 = Math.max(0, Math.floor(bx - pad));
    const ry0 = Math.max(0, Math.floor(by - pad));
    const rx1 = Math.min(width, Math.ceil(bx + bw + pad));
    const ry1 = Math.min(height, Math.ceil(by + bh + pad));
    let ringLum = 0;
    let rn = 0;
    for (let y = ry0; y < ry1; y += 1) {
      for (let x = rx0; x < rx1; x += 1) {
        if (x >= bx && x < bx + bw && y >= by && y < by + bh) continue;
        const i = (y * width + x) * 4;
        ringLum += pixelLum(data[i], data[i + 1], data[i + 2]);
        rn += 1;
      }
    }
    ringLum = rn ? ringLum / rn : boxLum;
    const polarity = boxLum < ringLum - 12 ? "dark" : boxLum > ringLum + 12 ? "bright" : "none";
    return { boxLum, ringLum, mid: (boxLum + ringLum) / 2, polarity };
  }

  function appearanceScore(lum, model) {
    if (!model || model.polarity === "none") return 0;
    if (model.polarity === "dark") {
      const cut = model.ringLum - 6;
      if (lum > cut) return 0;
      return (cut - lum) / Math.max(8, cut - model.boxLum);
    }
    const cut = model.ringLum + 6;
    if (lum < cut) return 0;
    return (lum - cut) / Math.max(8, model.boxLum - cut);
  }

  function appearanceCentroid(imageData, cx, cy, searchW, searchH, model) {
    if (!model || model.polarity === "none") return null;
    const { data, width, height } = imageData;
    const x0 = Math.max(0, Math.floor(cx - searchW / 2));
    const y0 = Math.max(0, Math.floor(cy - searchH / 2));
    const x1 = Math.min(width, Math.ceil(cx + searchW / 2));
    const y1 = Math.min(height, Math.ceil(cy + searchH / 2));
    let sx = 0;
    let sy = 0;
    let wsum = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 4;
        const w = appearanceScore(pixelLum(data[i], data[i + 1], data[i + 2]), model);
        if (w <= 0) continue;
        sx += x * w;
        sy += y * w;
        wsum += w;
      }
    }
    if (wsum < 4) return null;
    return { x: sx / wsum + 0.5, y: sy / wsum + 0.5, weight: wsum };
  }

  /** Find the strongest marker-like pixel, then take a local centroid around it. */
  function appearancePeakCentroid(imageData, model, boxW, boxH) {
    if (!model || model.polarity === "none") return null;
    const { data, width, height } = imageData;
    let best = 0;
    let px = 0;
    let py = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        const w = appearanceScore(pixelLum(data[i], data[i + 1], data[i + 2]), model);
        if (w > best) {
          best = w;
          px = x;
          py = y;
        }
      }
    }
    if (best <= 0) return null;
    return appearanceCentroid(
      imageData, px, py,
      Math.max(16, boxW * 3), Math.max(16, boxH * 3),
      model,
    );
  }

  function rgbaToGray(imageData, model) {
    const { width, height, data } = imageData;
    const gray = new Float64Array(width * height);
    if (model && model.polarity !== "none") {
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        gray[p] = 255 * appearanceScore(pixelLum(data[i], data[i + 1], data[i + 2]), model);
      }
      return gray;
    }
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      gray[p] = pixelLum(data[i], data[i + 1], data[i + 2]);
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
      this.outX = 0;
      this.outY = 0;
      this.boxW = 1;
      this.boxH = 1;
      this.winW = FILTER;
      this.winH = FILTER;
      this.smoothX = null;
      this.smoothY = null;
      this.appearance = null;
      this.initWeight = 0;
      this.vx = 0;
      this.vy = 0;
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
      const patch = sampleWindow(
        gray, frameW, frameH,
        this.cx, this.cy, this.winW, this.winH, this.w, this.h,
      );
      const pre = preprocess(patch, this.win);
      const re = pre;
      const im = new Float64Array(this.w * this.h);
      fft2(re, im, this.w, this.h, false);
      return { re, im };
    }

    _box() {
      return clampBbox(
        [this.outX - this.boxW / 2, this.outY - this.boxH / 2, this.boxW, this.boxH],
        this.frameW,
        this.frameH,
      );
    }

    init(imageData, bbox, fps = 30) {
      const frameW = imageData.width;
      const frameH = imageData.height;
      this.frameW = frameW;
      this.frameH = frameH;
      const box = clampBbox(bbox, frameW, frameH);
      this.appearance = sampleAppearance(imageData, box);
      const gray = rgbaToGray(imageData, this.appearance);
      this.vx = 0;
      this.vy = 0;
      const [cx, cy] = boxCenter(box);
      const seed = appearanceCentroid(imageData, cx, cy, box[2] * 2, box[3] * 2, this.appearance);
      this.initWeight = seed ? seed.weight : 0;
      this.cx = cx;
      this.cy = cy;
      this.outX = cx;
      this.outY = cy;
      this.boxW = box[2];
      this.boxH = box[3];
      this.winW = Math.max(8, this.boxW * WINDOW_PAD);
      this.winH = Math.max(8, this.boxH * WINDOW_PAD);
      this.smoothX = new OneEuro(fps);
      this.smoothY = new OneEuro(fps);
      this.aRe.fill(0);
      this.aIm.fill(0);
      this.bRe.fill(0);
      this.bIm.fill(0);
      const { re, im } = this._filterFromPatch(gray, frameW, frameH);
      this._accumulate(re, im, 1);
      const savedX = this.cx;
      const savedY = this.cy;
      for (let i = 0; i < INIT_SAMPLES; i += 1) {
        this.cx = savedX + (Math.random() - 0.5) * 0.08 * this.winW;
        this.cy = savedY + (Math.random() - 0.5) * 0.08 * this.winH;
        const sample = this._filterFromPatch(gray, frameW, frameH);
        this._accumulate(sample.re, sample.im, 1 / (i + 2));
      }
      this.cx = savedX;
      this.cy = savedY;
      this.outX = this.smoothX.filter(this.cx);
      this.outY = this.smoothY.filter(this.cy);
      return true;
    }

    update(imageData) {
      const frameW = imageData.width;
      const frameH = imageData.height;
      this.frameW = frameW;
      this.frameH = frameH;
      const gray = rgbaToGray(imageData, this.appearance);
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
      const sub = subpixelOffset(rRe, this.w, this.h, px, py);
      const scaleX = this.winW / this.w;
      const scaleY = this.winH / this.h;
      let dx = (px + sub.dx - (this.w - 1) / 2) * scaleX;
      let dy = (py + sub.dy - (this.h - 1) / 2) * scaleY;
      const jump = Math.hypot(dx, dy);
      const limit = 0.35 * Math.hypot(this.winW, this.winH);
      if (jump > limit && jump > 0) {
        dx *= limit / jump;
        dy *= limit / jump;
      }
      const mosseX = this.cx + dx;
      const mosseY = this.cy + dy;
      const mosseOk = psr >= PSR_MIN;

      const predX = this.cx + this.vx;
      const predY = this.cy + this.vy;
      let blob = appearanceCentroid(imageData, predX, predY, this.winW * 2.2, this.winH * 2.2, this.appearance);
      if (!blob) {
        blob = appearanceCentroid(imageData, predX, predY, this.winW * 5, this.winH * 5, this.appearance);
      }
      if (!blob) {
        blob = appearanceCentroid(imageData, predX, predY, this.winW * 10, this.winH * 10, this.appearance);
      }
      const weak = !blob || (this.initWeight > 0 && blob.weight < this.initWeight * 0.28);
      if (weak) {
        const global = appearancePeakCentroid(imageData, this.appearance, this.boxW, this.boxH);
        if (global && (!blob || global.weight > blob.weight * 1.15)) blob = global;
      }

      let nx = this.cx;
      let ny = this.cy;
      let ok = false;
      let fromBlob = false;
      if (blob) {
        nx = blob.x;
        ny = blob.y;
        ok = true;
        fromBlob = true;
      } else if (mosseOk && (!this.appearance || this.appearance.polarity === "none")) {
        nx = mosseX;
        ny = mosseY;
        ok = true;
      }

      if (!ok) return { ok: false, box: this._box(), cx: this.outX, cy: this.outY };

      const prevX = this.cx;
      const prevY = this.cy;
      this.cx = Math.max(0, Math.min(frameW - 1, nx));
      this.cy = Math.max(0, Math.min(frameH - 1, ny));
      this.vx = this.cx - prevX;
      this.vy = this.cy - prevY;
      if (fromBlob) {
        this.outX = this.cx;
        this.outY = this.cy;
        this.smoothX.filter(this.cx);
        this.smoothY.filter(this.cy);
      } else {
        this.outX = this.smoothX.filter(this.cx);
        this.outY = this.smoothY.filter(this.cy);
      }

      if (psr >= PSR_LEARN) {
        const rate = LEARNING * Math.min(1, (psr - PSR_LEARN) / 6 + 0.25);
        const sample = this._filterFromPatch(gray, frameW, frameH);
        this._accumulate(sample.re, sample.im, rate);
      }

      const box = this._box();
      return { ok: true, box, cx: this.outX, cy: this.outY };
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
      fps: fpsOption = 30,
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

    const fps = Number(fpsOption) > 0 ? Number(fpsOption) : 30;
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
    if (!tracker.init(frame, trackBbox, fps)) {
      throw new Error("Tracker failed to initialize on the selected box.");
    }

    const times = [];
    const centerX = [];
    const centerY = [];
    const boxes = [];
    let lostCount = 0;

    const record = (box, timeSec, cx, cy) => {
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
      lost: lostCount,
      fps,
      start_frame: startFrame,
    });

    const [startCx, startCy] = boxCenter(trackBbox);
    record(trackBbox, 0, startCx, startCy);
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
      const { ok, box, cx, cy } = tracker.update(frame);
      sampleIndex += 1;
      if (!ok || box[2] <= 0 || box[3] <= 0) {
        lostCount += 1;
        const lastBox = boxes[boxes.length - 1] || trackBbox;
        record(
          lastBox,
          sampleIndex / fps,
          centerX[centerX.length - 1],
          centerY[centerY.length - 1],
        );
      } else {
        record(box, sampleIndex / fps, cx, cy);
      }
      if (onProgress) onProgress(preview(), framesDone, framesTotal || framesDone);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (onProgress) onProgress(preview(), framesDone, framesDone);

    return {
      fps,
      width: size.width,
      height: size.height,
      start_frame: startFrame,
      times,
      x: centerX,
      y: centerY,
      bboxes: boxes,
      lost: lostCount,
    };
  }

  return { trackFrameSize, trackHtmlVideo };
})();
