"""Floor plan image -> PlanSpec (layer A).

Pipeline
--------
1. binarise; estimate the exterior wall thickness T by progressive morphological opening
2. wall mask = opening with a kernel ~0.45*T (removes text, furniture, door arcs, hatching)
3. extract axis-aligned wall runs (horizontal / vertical) as centre-line segments
4. footprint = wall mask closed + hole-filled; gives the building outline and its pixel area
5. scale (m/px) from, in order: manual value, printed room dimensions, printed total area,
   listing area, typical exterior wall thickness
6. merge collinear runs; gaps of door/window size become openings (window if the gap contains
   thin glazing lines, door/opening otherwise)
7. rooms = connected free space inside the footprint, with openings closed by virtual barriers
8. label rooms with the vision model's semantic hints (normalised label centres), otherwise heuristics

All coordinates in the returned PlanSpec are metres, centred on the footprint.
Diagonal walls are not detected (they are left to the 2D editor).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

MAX_SIDE = 1600
DEFAULT_EXTERIOR_WALL_M = 0.30


@dataclass
class Run:
    orient: str  # "h" or "v"
    c: float  # centre-line coordinate (y for h, x for v), px
    s: float  # start along the run, px
    e: float  # end, px
    t: float  # thickness, px


@dataclass
class Line:
    orient: str
    c: float
    s: float
    e: float
    t: float
    gaps: list[tuple[float, float, str]] = field(default_factory=list)  # (s,e,type)
    exterior: bool = False


def _load(img: np.ndarray) -> tuple[np.ndarray, float]:
    if img.ndim == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img.copy()
    h, w = gray.shape
    s = min(1.0, MAX_SIDE / max(h, w))
    if s < 1.0:
        gray = cv2.resize(gray, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    elif max(h, w) < 900:
        # upscale small plans so thin walls survive morphology
        s = 900 / max(h, w)
        gray = cv2.resize(gray, (int(w * s), int(h * s)), interpolation=cv2.INTER_CUBIC)
    return gray, s


def _binarise(gray: np.ndarray) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    thr, _ = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    thr = min(thr, 170)
    return (blur < thr).astype(np.uint8) * 255


def _max_span(mask: np.ndarray) -> int:
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return 0
    return int(max(max(stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]) for i in range(1, n)))


def estimate_wall_thickness(dark: np.ndarray) -> int:
    """Largest square kernel for which a long structure (>=8% of the image) survives opening."""
    h, w = dark.shape
    need = 0.08 * max(h, w)
    best = 3
    for k in range(2, 60):
        opened = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
        if _max_span(opened) >= need:
            best = k
        else:
            break
    return best


def _runs(wall: np.ndarray, orient: str, min_len: int) -> list[Run]:
    kernel = np.ones((1, min_len), np.uint8) if orient == "h" else np.ones((min_len, 1), np.uint8)
    m = cv2.morphologyEx(wall, cv2.MORPH_OPEN, kernel)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=4)
    out: list[Run] = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        comp = labels[y : y + bh, x : x + bw] == i
        if orient == "h":
            prof = comp.sum(axis=0)  # thickness per column
            t = float(np.median(prof[prof > 0]))
            ys = np.nonzero(comp.any(axis=1))[0]
            rows_w = comp.sum(axis=1)
            c = y + float((np.arange(bh) * rows_w).sum() / max(1, rows_w.sum()))
            out.append(Run("h", c, float(x), float(x + bw), t))
        else:
            prof = comp.sum(axis=1)
            t = float(np.median(prof[prof > 0]))
            cols_w = comp.sum(axis=0)
            c = x + float((np.arange(bw) * cols_w).sum() / max(1, cols_w.sum()))
            out.append(Run("v", c, float(y), float(y + bh), t))
    return out


def _footprint(wall: np.ndarray, close_px: int) -> np.ndarray:
    k = max(3, close_px | 1)
    closed = cv2.morphologyEx(wall, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    h, w = closed.shape
    flood = closed.copy()
    pad = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(flood, pad, (0, 0), 128)
    inside = (flood != 128).astype(np.uint8) * 255
    # keep the largest component
    n, labels, stats, _ = cv2.connectedComponentsWithStats(inside, connectivity=4)
    if n <= 1:
        return inside
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (labels == i).astype(np.uint8) * 255


def _run_points(runs: list[Run]) -> np.ndarray:
    pts = []
    for r in runs:
        if r.orient == "h":
            pts += [(r.s, r.c - r.t / 2), (r.e, r.c - r.t / 2), (r.s, r.c + r.t / 2), (r.e, r.c + r.t / 2)]
        else:
            pts += [(r.c - r.t / 2, r.s), (r.c - r.t / 2, r.e), (r.c + r.t / 2, r.s), (r.c + r.t / 2, r.e)]
    return np.array(pts, np.float32)


def _hull_area(runs: list[Run]) -> float:
    return float(cv2.contourArea(cv2.convexHull(_run_points(runs))))


def _hull_mask(runs: list[Run], shape: tuple[int, int]) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    cv2.fillPoly(m, [cv2.convexHull(_run_points(runs)).astype(np.int32)], 255)
    return m


def _merge_runs(runs: list[Run], T: float, mpp: float, dark: np.ndarray, fp: np.ndarray) -> list[Line]:
    lines: list[Line] = []
    for orient in ("h", "v"):
        rs = sorted([r for r in runs if r.orient == orient], key=lambda r: r.c)
        # group by centre-line coordinate
        groups: list[list[Run]] = []
        for r in rs:
            if groups and abs(groups[-1][-1].c - r.c) <= max(2.0, 0.5 * max(r.t, groups[-1][-1].t)):
                groups[-1].append(r)
            else:
                groups.append([r])
        for g in groups:
            g.sort(key=lambda r: r.s)
            c = float(np.average([r.c for r in g], weights=[r.e - r.s for r in g]))
            cur = Line(orient, c, g[0].s, g[0].e, g[0].t)
            for r in g[1:]:
                gap = r.s - cur.e
                gap_m = gap * mpp
                if gap <= max(T, 0.15 / mpp):
                    cur.e = max(cur.e, r.e)
                    cur.t = max(cur.t, r.t)
                elif 0.55 <= gap_m <= 8.0 and (
                    gap_m <= 3.3 or _classify_gap(orient, c, cur.e, r.s, max(cur.t, r.t), dark) == "window"
                ):
                    # door/window-sized gap, or a long glazed stretch (window bands, sliding walls)
                    cur.gaps.append((cur.e, r.s, _classify_gap(orient, c, cur.e, r.s, max(cur.t, r.t), dark)))
                    cur.e = max(cur.e, r.e)
                    cur.t = max(cur.t, r.t)
                else:
                    lines.append(cur)
                    cur = Line(orient, c, r.s, r.e, r.t)
            lines.append(cur)
    # drop tiny fragments (furniture remnants, door leaves)
    lines = [ln for ln in lines if (ln.e - ln.s) * mpp >= 0.35 or ln.t * mpp >= 0.2]
    for ln in lines:
        ln.exterior = _is_exterior(ln, fp)
    return lines


def _classify_gap(orient: str, c: float, s: float, e: float, t: float, dark: np.ndarray) -> str:
    """Windows are drawn as thin parallel lines inside the wall gap; doors leave it empty."""
    h, w = dark.shape
    half = max(2, int(t / 2))
    s_i, e_i = int(s) + 2, int(e) - 2
    if e_i <= s_i:
        return "door"
    if orient == "h":
        y0, y1 = max(0, int(c) - half), min(h, int(c) + half + 1)
        patch = dark[y0:y1, s_i:e_i]
        filled_rows = (patch > 0).mean(axis=1) if patch.size else np.array([0])
    else:
        x0, x1 = max(0, int(c) - half), min(w, int(c) + half + 1)
        patch = dark[s_i:e_i, x0:x1]
        filled_rows = (patch > 0).mean(axis=0) if patch.size else np.array([0])
    # a glazing line runs (almost) the full gap length; sliding doors show overlapping panels
    if (filled_rows > 0.8).sum() >= 1:
        return "window"
    return "window" if (filled_rows > 0.5).sum() >= 2 else "door"


def _is_exterior(ln: Line, fp: np.ndarray) -> bool:
    h, w = fp.shape
    off = ln.t / 2 + 4
    samples = np.linspace(ln.s, ln.e, 9)[1:-1]
    outside_hits = 0
    for s in samples:
        for sign in (-1, 1):
            if ln.orient == "h":
                x, y = int(s), int(ln.c + sign * off)
            else:
                x, y = int(ln.c + sign * off), int(s)
            if not (0 <= x < w and 0 <= y < h) or fp[y, x] == 0:
                outside_hits += 1
    return outside_hits >= len(samples) * 0.5


def _snap(lines: list[Line], T: float) -> None:
    """Extend/trim run ends onto perpendicular wall centre-lines so corners close."""
    tol = 1.6 * T
    for ln in lines:
        perp = [p for p in lines if p.orient != ln.orient]
        for end in ("s", "e"):
            v = getattr(ln, end)
            best, bestd = None, tol
            for p in perp:
                # p crosses ln's centre-line coordinate?
                if p.s - tol <= ln.c <= p.e + tol and abs(p.c - v) < bestd:
                    best, bestd = p.c, abs(p.c - v)
            if best is not None:
                setattr(ln, end, best)


def _rooms(wall: np.ndarray, fp: np.ndarray, lines: list[Line], mpp: float) -> list[np.ndarray]:
    barrier = wall.copy()
    for ln in lines:
        for s, e, _ in ln.gaps:
            t = max(2, int(ln.t))
            if ln.orient == "h":
                cv2.line(barrier, (int(s) - 1, int(ln.c)), (int(e) + 1, int(ln.c)), 255, t)
            else:
                cv2.line(barrier, (int(ln.c), int(s) - 1), (int(ln.c), int(e) + 1), 255, t)
    free = cv2.bitwise_and(fp, cv2.bitwise_not(barrier))
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    out = []
    min_px = 1.5 / (mpp * mpp)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < min_px:
            continue
        out.append((labels == i).astype(np.uint8) * 255)
    return out


def _poly(mask: np.ndarray, eps: float) -> np.ndarray:
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    c = max(cnts, key=cv2.contourArea)
    ap = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(float)
    if len(ap) < 3:
        x, y, w, h = cv2.boundingRect(c)
        ap = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], float)
    return ap


ROOM_TYPES = {
    "living", "kitchen", "dining", "bedroom", "bathroom", "wc", "hall", "office", "storage",
    "laundry", "terrace", "balcony", "garage", "stairs", "other",
}


def _heuristic_type(area: float, aspect: float, rank: int) -> tuple[str, str]:
    if rank == 0 and area > 14:
        return "living", "Living room"
    if aspect > 2.8 and area < 18:
        return "hall", "Hall"
    if area < 2.5:
        return "storage", "Storage"
    if area < 5.5:
        return "bathroom", "Bathroom"
    if area >= 8:
        return "bedroom", "Bedroom"
    return "other", "Room"


def parse_floorplan(img: np.ndarray, hints: dict[str, Any] | None = None) -> dict[str, Any]:
    hints = hints or {}
    notes: list[str] = []
    gray, s = _load(img)
    H, W = gray.shape
    dark = _binarise(gray)
    T = estimate_wall_thickness(dark)
    k_open = max(3, int(round(T * 0.28)))
    wall = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((k_open, k_open), np.uint8))
    min_len = max(12, int(1.5 * T))
    runs = _runs(wall, "h", min_len) + _runs(wall, "v", min_len)
    if not runs:
        raise ValueError("no walls detected")

    # footprint from the full dark mask: window glazing lines keep the outline closed
    fp = _footprint(cv2.bitwise_or(wall, dark), close_px=int(5 * T))
    hull_area = _hull_area(runs)
    if (fp > 0).sum() < 0.6 * hull_area:
        notes.append("Building outline not closed; used the wall bounding hull.")
        fp = _hull_mask(runs, (H, W))
    fp_area_px = float((fp > 0).sum())
    ys, xs = np.nonzero(fp)
    bx0, bx1, by0, by1 = xs.min(), xs.max(), ys.min(), ys.max()

    # ---------- scale ----------
    mpp, scale_src = None, "default"
    if hints.get("metersPerPixel"):
        mpp, scale_src = float(hints["metersPerPixel"]) / s, "manual"  # given for original px
    area_hint = hints.get("totalAreaM2") or None
    listing_area = hints.get("listingSqm") or None
    if mpp is None and area_hint:
        mpp, scale_src = math.sqrt(float(area_hint) / fp_area_px), "area"
    if mpp is None and listing_area:
        mpp, scale_src = math.sqrt(float(listing_area) / fp_area_px), "area"
        notes.append("Scale estimated from the listing's stated area; verify in the editor.")
    if mpp is None:
        mpp, scale_src = DEFAULT_EXTERIOR_WALL_M / T, "wall_thickness"
        notes.append("Scale estimated from typical exterior wall thickness (0.30 m); verify in the editor.")
    span_m = max(bx1 - bx0, by1 - by0) * mpp
    if not (3 <= span_m <= 120):
        notes.append(f"Implausible size ({span_m:.1f} m) from {scale_src} scale, fell back to wall thickness.")
        mpp, scale_src = DEFAULT_EXTERIOR_WALL_M / T, "wall_thickness"

    lines = _merge_runs(runs, T, mpp, dark, fp)
    _snap(lines, T)

    # ---------- rooms ----------
    room_masks = _rooms(wall, fp, lines, mpp)
    sem_rooms = hints.get("rooms") or []

    # refine scale with printed room dimensions if available (median ratio)
    if scale_src not in ("manual",) and sem_rooms:
        ratios = []
        for sr in sem_rooms:
            if not (sr.get("widthM") and sr.get("depthM")):
                continue
            px, py = sr["cx"] * W, sr["cy"] * H
            for m in room_masks:
                if 0 <= int(py) < H and 0 <= int(px) < W and m[int(py), int(px)]:
                    x, y, w_, h_ = cv2.boundingRect(m)
                    a, b = sorted([w_, h_]), sorted([sr["widthM"], sr["depthM"]])
                    ratios += [b[0] / a[0], b[1] / a[1]]
        if len(ratios) >= 2:
            mpp, scale_src = float(np.median(ratios)), "dimension"

    cx_px, cy_px = (bx0 + bx1) / 2, (by0 + by1) / 2

    def to_m(x: float, y: float) -> list[float]:
        return [round((x - cx_px) * mpp, 3), round((y - cy_px) * mpp, 3)]

    walls, openings = [], []
    for i, ln in enumerate(lines):
        wid = f"w{i + 1}"
        if ln.orient == "h":
            a, b = to_m(ln.s, ln.c), to_m(ln.e, ln.c)
        else:
            a, b = to_m(ln.c, ln.s), to_m(ln.c, ln.e)
        thick = max(0.08, round(ln.t * mpp, 3))
        walls.append({"id": wid, "a": a, "b": b, "thickness": thick, "exterior": bool(ln.exterior)})
        L = max(1e-6, ln.e - ln.s)
        for gs, ge, typ in ln.gaps:
            width = (ge - gs) * mpp
            if typ == "door" and width > 1.3:
                typ = "opening"
            if ln.exterior and width > 2.3 and typ in ("door", "window"):
                typ = "sliding"
            o = {
                "id": f"o{len(openings) + 1}",
                "wallId": wid,
                "type": typ,
                "t": round(((gs + ge) / 2 - ln.s) / L, 4),
                "width": round(width, 3),
                "sill": 0.9 if typ == "window" else 0.0,
                "head": 2.2 if typ == "window" else 2.1,
            }
            openings.append(o)

    rooms = []
    eps = max(1.5, 0.35 * T)
    labelled = []
    for m in room_masks:
        labels_here = [
            sr for sr in sem_rooms
            if 0 <= int(sr["cy"] * H) < H and 0 <= int(sr["cx"] * W) < W and m[int(sr["cy"] * H), int(sr["cx"] * W)]
        ]
        labelled.append(labels_here)
    order = np.argsort([-(m > 0).sum() for m in room_masks])
    rank = {int(i): r for r, i in enumerate(order)}
    for idx, (m, labels_here) in enumerate(zip(room_masks, labelled)):
        poly = _poly(m, eps)
        x, y, w_, h_ = cv2.boundingRect(m)
        # inner faces are half a wall thickness away from centre-lines: grow the polygon so
        # floors meet the walls (and area matches what plans print)
        area = float((m > 0).sum()) * mpp * mpp
        aspect = max(w_, h_) / max(1, min(w_, h_))
        if labels_here:
            name = " / ".join(dict.fromkeys(l["name"] for l in labels_here))
            rtype = labels_here[0].get("type") or "other"
            rtype = rtype if rtype in ROOM_TYPES else "other"
            if labels_here[0].get("areaM2"):
                area = float(labels_here[0]["areaM2"])
        else:
            rtype, name = _heuristic_type(area, aspect, rank[idx])
        rooms.append({
            "id": f"r{idx + 1}",
            "name": name,
            "type": rtype,
            "polygon": [to_m(px, py) for px, py in poly],
            "areaM2": round(area, 1),
        })
    # de-duplicate generic names
    counts: dict[str, int] = {}
    for r in rooms:
        counts[r["name"]] = counts.get(r["name"], 0) + 1
    seen: dict[str, int] = {}
    for r in rooms:
        if counts[r["name"]] > 1:
            seen[r["name"]] = seen.get(r["name"], 0) + 1
            r["name"] = f"{r['name']} {seen[r['name']]}"

    covered = sum(float((m > 0).sum()) for m in room_masks) / max(1.0, fp_area_px)
    conf = 0.25
    conf += 0.25 if len(rooms) >= 2 else 0
    conf += 0.2 * min(1.0, covered / 0.75)
    conf += {"manual": 0.3, "dimension": 0.3, "area": 0.2, "wall_thickness": 0.05, "default": 0.0}[scale_src]
    conf = round(min(1.0, conf), 2)
    if not sem_rooms:
        notes.append("Room names guessed from size/shape (no semantic labels available).")

    mpp_orig = mpp * s  # metres per ORIGINAL image pixel
    return {
        "version": 1,
        "ceilingHeight": float(hints.get("ceilingHeightM") or 2.7),
        "slabThickness": 0.25,
        "walls": walls,
        "openings": openings,
        "rooms": rooms,
        "stairs": [],
        "scale": {"metersPerPixel": mpp_orig, "source": scale_src},
        "underlay": {
            "widthPx": int(img.shape[1]),
            "heightPx": int(img.shape[0]),
            "originM": [round(-cx_px * mpp, 3), round(-cy_px * mpp, 3)],
            "metersPerPixel": mpp_orig,
        },
        "confidence": conf,
        "provenance": "measured",
        "notes": notes,
        "debug": {"wallThicknessPx": T, "runs": len(runs), "lines": len(lines), "scale": float(s)},
    }
