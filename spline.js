/**
 * Being-compatible cubic BPoly fit / sample / Curve JSON.
 *
 * Interpolating path: CubicSpline not-a-knot → PPoly power basis → BPoly Bernstein.
 * Smoothing > 0 drops knots (Visvalingam–Whyatt), then interpolates the rest.
 */
"use strict";

const MocapSpline = (() => {
  function comb(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    let out = 1;
    for (let i = 1; i <= k; i += 1) out = (out * (n - k + i)) / i;
    return out;
  }

  function nanToNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
      const out = {};
      Object.keys(value).sort().forEach((key) => {
        out[key] = sortKeys(value[key]);
      });
      return out;
    }
    return value;
  }

  function uniqueSorted(times, values) {
    const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
    const x = [];
    const y = [];
    for (const i of order) {
      const t = Number(times[i]);
      if (x.length && t === x[x.length - 1]) continue;
      x.push(t);
      y.push(Number(values[i]));
    }
    return { x, y };
  }

  function triangleArea(ax, ay, bx, by, cx, cy) {
    return Math.abs(ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) / 2;
  }

  /** Keep endpoints and the strongest corners (Visvalingam–Whyatt). */
  function thinToCount(x, y, keep) {
    const n = x.length;
    keep = Math.max(4, Math.min(n, Math.round(keep)));
    if (keep >= n) return { x: x.slice(), y: y.slice() };

    const t0 = x[0];
    const tSpan = (x[n - 1] - t0) || 1;
    let yMin = y[0];
    let yMax = y[0];
    for (let i = 1; i < n; i += 1) {
      if (y[i] < yMin) yMin = y[i];
      if (y[i] > yMax) yMax = y[i];
    }
    const ySpan = (yMax - yMin) || 1;
    const tx = x.map((t) => (t - t0) / tSpan);
    const ty = y.map((v) => (v - yMin) / ySpan);
    const prev = new Int32Array(n);
    const next = new Int32Array(n);
    const alive = new Uint8Array(n);
    const area = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      prev[i] = i - 1;
      next[i] = i + 1;
      alive[i] = 1;
    }
    next[n - 1] = -1;

    function updateArea(i) {
      if (i <= 0 || i >= n - 1 || !alive[i]) {
        area[i] = Infinity;
        return;
      }
      const p = prev[i];
      const q = next[i];
      if (p < 0 || q < 0) {
        area[i] = Infinity;
        return;
      }
      area[i] = triangleArea(tx[p], ty[p], tx[i], ty[i], tx[q], ty[q]);
    }

    for (let i = 0; i < n; i += 1) updateArea(i);

    let remaining = n;
    while (remaining > keep) {
      let best = -1;
      let bestA = Infinity;
      for (let i = 1; i < n - 1; i += 1) {
        if (alive[i] && area[i] < bestA) {
          bestA = area[i];
          best = i;
        }
      }
      if (best < 0) break;
      alive[best] = 0;
      remaining -= 1;
      const p = prev[best];
      const q = next[best];
      if (p >= 0) next[p] = q;
      if (q >= 0) prev[q] = p;
      if (p >= 0) updateArea(p);
      if (q >= 0) updateArea(q);
    }

    const ox = [];
    const oy = [];
    for (let i = 0; i < n; i += 1) {
      if (!alive[i]) continue;
      ox.push(x[i]);
      oy.push(y[i]);
    }
    return { x: ox, y: oy };
  }

  /** Slider 0 → every sample; 500 (s = 5e-5) → 4 knots. */
  function knotBudget(n, smoothing) {
    if (!(smoothing > 0) || n <= 4) return n;
    const t = Math.min(1, smoothing / 5e-5);
    const minK = 4;
    return Math.max(minK, Math.round(minK + (n - minK) * ((1 - t) ** 1.6)));
  }

  function solveTridiagonal(lower, diag, upper, rhs) {
    const n = diag.length;
    const c = upper.slice();
    const d = rhs.slice();
    const bp = diag.slice();
    for (let i = 1; i < n; i += 1) {
      const w = lower[i] / bp[i - 1];
      bp[i] -= w * c[i - 1];
      d[i] -= w * d[i - 1];
    }
    const x = new Array(n);
    x[n - 1] = d[n - 1] / bp[n - 1];
    for (let i = n - 2; i >= 0; i -= 1) {
      x[i] = (d[i] - c[i] * x[i + 1]) / bp[i];
    }
    return x;
  }

  /** First derivatives at knots for a not-a-knot cubic spline (SciPy CubicSpline). */
  function notAKnotSlopes(x, y) {
    const n = x.length;
    const dx = [];
    const slope = [];
    for (let i = 0; i < n - 1; i += 1) {
      dx[i] = x[i + 1] - x[i];
      slope[i] = (y[i + 1] - y[i]) / dx[i];
    }

    const lower = new Array(n).fill(0);
    const diag = new Array(n).fill(0);
    const upper = new Array(n).fill(0);
    const rhs = new Array(n).fill(0);

    for (let i = 1; i < n - 1; i += 1) {
      lower[i] = dx[i];
      diag[i] = 2 * (dx[i - 1] + dx[i]);
      upper[i] = dx[i - 1];
      rhs[i] = 3 * (dx[i] * slope[i - 1] + dx[i - 1] * slope[i]);
    }

    const d0 = x[2] - x[0];
    diag[0] = dx[1];
    upper[0] = d0;
    rhs[0] = ((dx[0] + 2 * d0) * dx[1] * slope[0] + dx[0] * dx[0] * slope[1]) / d0;

    const dn = x[n - 1] - x[n - 3];
    diag[n - 1] = dx[n - 3];
    lower[n - 1] = dn;
    rhs[n - 1] = ((dx[n - 2] * dx[n - 2] * slope[n - 3] + (2 * dn + dx[n - 2]) * dx[n - 3] * slope[n - 2]) / dn);

    return solveTridiagonal(lower, diag, upper, rhs);
  }

  /** PPoly coefficients, highest degree first, one column per interval. */
  function hermitePowerCoeffs(x, y, dydx) {
    const n = x.length - 1;
    const c0 = [];
    const c1 = [];
    const c2 = [];
    const c3 = [];
    for (let i = 0; i < n; i += 1) {
      const dx = x[i + 1] - x[i];
      const slope = (y[i + 1] - y[i]) / dx;
      const t = (dydx[i] + dydx[i + 1] - 2 * slope) / dx;
      c0.push(t / dx);
      c1.push((slope - dydx[i]) / dx - t);
      c2.push(dydx[i]);
      c3.push(y[i]);
    }
    return [c0, c1, c2, c3];
  }

  /** SciPy BPoly.from_power_basis. */
  function fromPowerBasis(ppC, knots) {
    const k = ppC.length - 1;
    const m = knots.length - 1;
    const c = Array.from({ length: k + 1 }, () => Array(m).fill(0));
    for (let i = 0; i < m; i += 1) {
      const dx = knots[i + 1] - knots[i];
      for (let a = 0; a <= k; a += 1) {
        const pow = k - a;
        const factor = comb(k, pow) === 0 ? 0 : (ppC[a][i] / comb(k, pow)) * (dx ** pow);
        for (let j = pow; j <= k; j += 1) {
          c[j][i] += factor * comb(j, pow);
        }
      }
    }
    return c;
  }

  function findInterval(knots, t) {
    const last = knots.length - 2;
    if (t <= knots[0]) return 0;
    if (t >= knots[knots.length - 1]) return last;
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (knots[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function evalBPoly(spline, t) {
    const knots = spline.knots;
    const coeffs = spline.coefficients;
    const k = coeffs.length - 1;
    const i = findInterval(knots, t);
    const dx = knots[i + 1] - knots[i] || 1e-12;
    const u = (t - knots[i]) / dx;
    const pts = coeffs.map((row) => nanToNum(row[i]));
    for (let r = 1; r <= k; r += 1) {
      for (let j = 0; j <= k - r; j += 1) {
        pts[j] = (1 - u) * pts[j] + u * pts[j + 1];
      }
    }
    return nanToNum(pts[0]);
  }

  function sampleSpline(spline, times) {
    const start = spline.knots[0];
    const end = spline.knots[spline.knots.length - 1];
    const hi = Math.max(start, end - 1e-9);
    return times.map((t) => {
      const clipped = Math.min(hi, Math.max(start, Number(t)));
      return evalBPoly(spline, clipped);
    });
  }

  function uniqueKnotTimes(spline) {
    const seen = new Set();
    const out = [];
    spline.knots.forEach((t) => {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    });
    return out;
  }

  function splineToDict(spline) {
    return {
      axis: 0,
      coefficients: spline.coefficients.map((row) => row.map(nanToNum)),
      extrapolate: false,
      knots: spline.knots.map(Number),
      type: "BPoly",
    };
  }

  function curveToJson(splines) {
    return JSON.stringify(sortKeys({
      splines: splines.map(splineToDict),
      type: "Curve",
    }), null, 4);
  }

  function fitSpline(times, values, smoothing = 0) {
    const unique = uniqueSorted(times, values);
    if (unique.x.length < 4) {
      throw new Error("Need at least 4 unique timestamps to fit a cubic spline.");
    }
    const keep = knotBudget(unique.x.length, smoothing);
    const pts = thinToCount(unique.x, unique.y, keep);
    const slopes = notAKnotSlopes(pts.x, pts.y);
    const pp = hermitePowerCoeffs(pts.x, pts.y, slopes);
    const coefficients = fromPowerBasis(pp, pts.x);
    return { knots: pts.x, coefficients };
  }

  function splineAxisNames(count) {
    if (count <= 1) return ["y"];
    if (count === 2) return ["x", "y"];
    return Array.from({ length: count }, (_, i) => `y${i}`);
  }

  function exportPayload(splines, names, curveJson = null) {
    const keys = [...names];
    const dense = {};
    const knotValues = {};
    const t0 = splines[0].knots[0];
    const t1 = splines[0].knots[splines[0].knots.length - 1];
    const denseTimes = [];
    for (let i = 0; i < 500; i += 1) {
      denseTimes.push(t0 + ((t1 - t0) * i) / 499);
    }
    const knotTimes = uniqueKnotTimes(splines[0]);
    keys.forEach((name, idx) => {
      dense[name] = sampleSpline(splines[idx], denseTimes);
      knotValues[name] = sampleSpline(splines[idx], knotTimes);
    });
    return {
      curve: curveJson != null ? curveJson : curveToJson(splines),
      dense_times: denseTimes,
      dense,
      knot_times: knotTimes,
      knot_values: knotValues,
      knots: knotTimes.length,
      duration: Math.max(0, t1 - t0),
      primary: keys[0],
    };
  }

  function curveFromJson(payload) {
    const data = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!data || data.type !== "Curve" || !data.splines?.length) {
      throw new Error("Not a being Curve JSON file.");
    }
    return data.splines.map((item) => {
      const coefficients = item.coefficients;
      const knots = item.knots;
      if (!coefficients?.length || !knots || knots.length < 2) {
        throw new Error("Curve JSON is missing coefficients or knots.");
      }
      return {
        axis: item.axis ?? 0,
        coefficients,
        extrapolate: !!item.extrapolate,
        knots,
        type: "BPoly",
      };
    });
  }

  return {
    fitSpline,
    exportPayload,
    curveFromJson,
    splineAxisNames,
  };
})();
