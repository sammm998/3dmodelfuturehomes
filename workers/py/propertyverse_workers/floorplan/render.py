"""Render a PlanSpec into a floor-plan style image (used for seed data and parser tests)."""
from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np


def render_plan(plan: dict[str, Any], px_per_m: float = 50.0, margin_m: float = 1.5,
                labels: bool = True, furniture: bool = True) -> tuple[np.ndarray, dict]:
    pts = [p for w in plan["walls"] for p in (w["a"], w["b"])]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    minx, miny = min(xs) - margin_m, min(ys) - margin_m
    W = int((max(xs) - min(xs) + 2 * margin_m) * px_per_m)
    H = int((max(ys) - min(ys) + 2 * margin_m) * px_per_m)
    img = np.full((H, W, 3), 255, np.uint8)

    def P(p):
        return int(round((p[0] - minx) * px_per_m)), int(round((p[1] - miny) * px_per_m))

    walls = {w["id"]: w for w in plan["walls"]}
    # walls minus openings
    for w in plan["walls"]:
        a, b = np.array(w["a"], float), np.array(w["b"], float)
        L = float(np.linalg.norm(b - a))
        if L < 1e-6:
            continue
        d = (b - a) / L
        ops = sorted(
            [(o["t"] * L - o["width"] / 2, o["t"] * L + o["width"] / 2, o) for o in plan["openings"] if o["wallId"] == w["id"]],
            key=lambda x: x[0],
        )
        cur = 0.0
        thick = max(1, int(round(w["thickness"] * px_per_m)))
        segs = []
        for s0, s1, o in ops:
            segs.append((cur, s0))
            cur = s1
            pa, pb = a + d * s0, a + d * s1
            if o["type"] == "window":
                n = np.array([-d[1], d[0]])
                for off in (-0.33, 0, 0.33):
                    q = n * w["thickness"] * off
                    cv2.line(img, P(pa + q), P(pb + q), (0, 0, 0), 1)
                # jambs
                for pp in (pa, pb):
                    cv2.line(img, P(pp + n * w["thickness"] / 2), P(pp - n * w["thickness"] / 2), (0, 0, 0), 1)
            elif o["type"] == "sliding":
                n = np.array([-d[1], d[0]])
                for off, (u0, u1) in ((-0.2, (0, 0.55)), (0.2, (0.45, 1))):
                    q = n * w["thickness"] * off
                    cv2.line(img, P(pa + (pb - pa) * u0 + q), P(pa + (pb - pa) * u1 + q), (0, 0, 0), 2)
            elif o["type"] in ("door",):
                # door leaf + swing arc
                n = np.array([-d[1], d[0]])
                hinge = pa + n * w["thickness"] / 2
                r = o["width"]
                cv2.line(img, P(hinge), P(hinge + n * r), (0, 0, 0), 1)
                c = P(hinge)
                ang0 = math.degrees(math.atan2(d[1], d[0]))
                ang1 = math.degrees(math.atan2(n[1], n[0]))
                cv2.ellipse(img, c, (int(r * px_per_m), int(r * px_per_m)), 0, min(ang0, ang1), max(ang0, ang1), (0, 0, 0), 1)
        segs.append((cur, L))
        for s0, s1 in segs:
            if s1 - s0 < 0.01:
                continue
            p0, p1 = a + d * s0, a + d * s1
            # draw as filled rectangle so ends are square
            n = np.array([-d[1], d[0]]) * w["thickness"] / 2
            ext = d * (w["thickness"] / 2 if (s0 == 0) else 0)
            ext1 = d * (w["thickness"] / 2 if (s1 == L) else 0)
            quad = np.array([P(p0 - ext + n), P(p1 + ext1 + n), P(p1 + ext1 - n), P(p0 - ext - n)], np.int32)
            cv2.fillPoly(img, [quad], (25, 25, 25))
        _ = thick

    for r in plan["rooms"]:
        poly = np.array(r["polygon"], float)
        c = poly.mean(axis=0)
        if furniture and r["type"] in ("bedroom", "living") and r["areaM2"] > 8:
            # thin furniture outline
            w_, h_ = (1.6, 2.0) if r["type"] == "bedroom" else (2.2, 0.9)
            cv2.rectangle(img, P(c - [w_ / 2, h_ / 2]), P(c + [w_ / 2, h_ / 2]), (90, 90, 90), 1)
        if labels:
            txt = r["name"].upper()
            fs = 0.4 * px_per_m / 50
            (tw, th), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, fs, 1)
            x, y = P(c)
            cv2.putText(img, txt, (x - tw // 2, y - 4), cv2.FONT_HERSHEY_SIMPLEX, fs, (40, 40, 40), 1, cv2.LINE_AA)
            sub = f"{r['areaM2']:.1f} m2"
            (sw, _), _ = cv2.getTextSize(sub, cv2.FONT_HERSHEY_SIMPLEX, fs * 0.85, 1)
            cv2.putText(img, sub, (x - sw // 2, y + th + 2), cv2.FONT_HERSHEY_SIMPLEX, fs * 0.85, (60, 60, 60), 1, cv2.LINE_AA)
    meta = {"px_per_m": px_per_m, "origin_m": [minx, miny], "width": W, "height": H}
    return img, meta
