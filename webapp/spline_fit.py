"""Being-compatible smoothing spline and Curve JSON.

fit via splrep → PPoly → BPoly; serialize with indent=4 and sort_keys=True.
Distance units in CSV are meters.
"""
from __future__ import annotations

import json
from typing import Sequence

import numpy as np
from scipy.interpolate import BPoly, PPoly, splrep


def smoothing_spline(
    x: Sequence[float],
    y: Sequence[float],
    degree: int = 3,
    smoothing: float = 1e-6,
    extrapolate: bool = False,
) -> PPoly:
    """SciPy power-basis spline; `s = smoothing * n` matches being.spline."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    tck = splrep(x, y, k=degree, s=smoothing * len(x))
    return PPoly.from_spline(tck, extrapolate)


def remove_duplicate_knots(spline: PPoly) -> PPoly:
    """Drop zero-width intervals left by PPoly.from_spline (being.spline.remove_duplicates).

    Without this, exported Curve JSON keeps repeated end knots like
    [0, 0, 0, 0, 1.1, …]. Some being players then only run the first real
    segment (~1 s) instead of the full clip.
    """
    _, unique_idx = np.unique(spline.x, return_index=True)
    return type(spline).construct_fast(
        spline.c[:, unique_idx[:-1]],
        spline.x[unique_idx],
        spline.extrapolate,
        spline.axis,
    )


def fit_spline(times: Sequence[float], values: Sequence[float], smoothing: float = 1e-6) -> BPoly:
    """Sort, drop duplicate times, then fit a cubic BPoly (being.spline.fit_spline)."""
    times = np.asarray(times, dtype=float)
    values = np.asarray(values, dtype=float)
    if len(times) < 4:
        raise ValueError("Need at least 4 samples to fit a cubic spline.")
    order = np.argsort(times)
    times, values = times[order], values[order]
    _, unique = np.unique(times, return_index=True)
    times, values = times[unique], values[unique]
    if len(times) < 4:
        raise ValueError("Need at least 4 unique timestamps to fit a cubic spline.")
    ppoly = smoothing_spline(times, values, smoothing=smoothing, extrapolate=False)
    ppoly = remove_duplicate_knots(ppoly)
    return BPoly.from_power_basis(ppoly)


def spline_to_dict(spline: BPoly) -> dict:
    coeffs = np.nan_to_num(np.asarray(spline.c, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    knots = np.asarray(spline.x, dtype=float)
    return {
        "axis": int(spline.axis),
        "coefficients": coeffs.tolist(),
        "extrapolate": bool(spline.extrapolate),
        "knots": knots.tolist(),
        "type": "BPoly",
    }


def curve_to_json(splines: list[BPoly]) -> str:
    """Serialize one or more BPoly splines as a being Curve JSON string."""
    payload = {
        "splines": [spline_to_dict(s) for s in splines],
        "type": "Curve",
    }
    return json.dumps(payload, indent=4, sort_keys=True)


def unique_knot_times(spline: BPoly) -> list[float]:
    return np.unique(np.asarray(spline.x, dtype=float)).tolist()


def sample_spline(spline: BPoly, times: Sequence[float]) -> list[float]:
    """Evaluate spline at times, clipped to the knot span (no NaNs in JSON)."""
    t = np.asarray(times, dtype=float)
    start, end = float(spline.x[0]), float(spline.x[-1])
    clipped = np.clip(t, start, max(start, end - 1e-9))
    values = np.asarray(spline(clipped, extrapolate=True), dtype=float).reshape(-1)
    return np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0).tolist()


def format_csv(times: Sequence[float], columns: dict[str, Sequence[float]]) -> str:
    names = list(columns.keys())
    header = "timestamp [s], " + ", ".join(f"{name} [m]" for name in names)
    lines = [header]
    series = [np.asarray(columns[name], dtype=float) for name in names]
    for i, t in enumerate(times):
        vals = ", ".join(f"{col[i]:.6f}" for col in series)
        lines.append(f"{t:.3f}, {vals}")
    return "\n".join(lines) + "\n"


def curve_from_json(payload) -> list[BPoly]:
    """Parse a being Curve JSON object or string into BPoly instances."""
    data = json.loads(payload) if isinstance(payload, (str, bytes, bytearray)) else payload
    if not isinstance(data, dict) or data.get("type") != "Curve" or not data.get("splines"):
        raise ValueError("Not a being Curve JSON file.")
    splines = []
    for item in data["splines"]:
        coeffs = np.asarray(item["coefficients"], dtype=float)
        knots = np.asarray(item["knots"], dtype=float)
        if coeffs.size == 0 or knots.size < 2:
            raise ValueError("Curve JSON is missing coefficients or knots.")
        splines.append(BPoly(coeffs, knots, extrapolate=bool(item.get("extrapolate", False))))
    return splines


def spline_axis_names(count: int) -> list[str]:
    if count <= 1:
        return ["y"]
    if count == 2:
        return ["x", "y"]
    return [f"y{i}" for i in range(count)]


def export_payload(
    splines: list[BPoly],
    names: Sequence[str],
    sample_times: Sequence[float],
    curve_json: str | None = None,
) -> dict:
    """Build the plot + download payload shared by /api/fit and /api/load-curve."""
    names = list(names)
    times = np.asarray(sample_times, dtype=float)
    sampled = {name: sample_spline(spline, times) for name, spline in zip(names, splines)}
    t0, t1 = float(splines[0].x[0]), float(splines[0].x[-1])
    dense_times = np.linspace(t0, t1, 500).tolist()
    dense = {name: sample_spline(spline, dense_times) for name, spline in zip(names, splines)}
    knot_times = unique_knot_times(splines[0])
    knot_values = {name: sample_spline(spline, knot_times) for name, spline in zip(names, splines)}
    duration = float(max(0.0, t1 - t0))
    return {
        "curve": curve_json if curve_json is not None else curve_to_json(splines),
        "csv": format_csv(times.tolist(), sampled),
        "dense_times": dense_times,
        "dense": dense,
        "knot_times": knot_times,
        "knot_values": knot_values,
        "knots": len(knot_times),
        "duration": duration,
        "primary": names[0],
    }
