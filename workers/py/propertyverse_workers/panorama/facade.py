"""Rectify a building facade from a listing photo into a flat, front-on texture.

Input: the photo and the facade outline (4 corners, normalised, TL TR BR BL) located by the vision model.
Output: RGBA PNG of the facade with the sky (above curved/stepped roof lines) made transparent.
"""
from __future__ import annotations

import cv2
import numpy as np


def _line_score(grad: np.ndarray, p0: np.ndarray, p1: np.ndarray, n: int = 60) -> float:
    h, w = grad.shape
    t = np.linspace(0.08, 0.92, n)
    xs = np.clip((p0[0] + (p1[0] - p0[0]) * t).astype(int), 0, w - 1)
    ys = np.clip((p0[1] + (p1[1] - p0[1]) * t).astype(int), 0, h - 1)
    return float(grad[ys, xs].mean())


def refine_corners(img: np.ndarray, src: np.ndarray, search: float = 0.05) -> np.ndarray:
    """Snap the facade's left and right edges to the strongest nearby vertical building edges.

    The vision model's corners are approximate; building corners are strong, long, near-vertical
    intensity edges. Each side edge (top point + bottom point) is shifted independently within a
    window of +-search * facade width and the shift with the highest mean edge strength wins.
    """
    gray = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (3, 3), 0)
    grad = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
    tl, tr, br, bl = src.copy()
    width = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2
    r = max(3.0, search * width)
    steps = np.linspace(-r, r, 17)
    out = src.copy()
    for top_i, bot_i in ((0, 3), (1, 2)):
        best, best_s = (0.0, 0.0), _line_score(grad, src[top_i], src[bot_i])
        for dt in steps:
            for db in steps:
                p0 = src[top_i] + [dt, 0]
                p1 = src[bot_i] + [db, 0]
                sc = _line_score(grad, p0, p1)
                if sc > best_s * 1.05:
                    best, best_s = (dt, db), sc
        out[top_i] = src[top_i] + [best[0], 0]
        out[bot_i] = src[bot_i] + [best[1], 0]
    return out


def rectify(img: np.ndarray, corners: list[list[float]], max_side: int = 2048, refine: bool = True) -> tuple[bytes, dict]:
    h, w = img.shape[:2]
    src = np.array([[c[0] * w, c[1] * h] for c in corners], np.float32)
    if refine:
        src = refine_corners(img, src).astype(np.float32)
    tl, tr, br, bl = src
    width = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2
    height = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2
    if width < 20 or height < 20:
        raise ValueError("facade outline too small")
    s = min(1.0, max_side / max(width, height))
    W, H = int(round(width * s)), int(round(height * s))
    dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    alpha = _sky_alpha(out)
    rgba = np.dstack([out, alpha])
    ok, enc = cv2.imencode(".png", rgba)
    if not ok:
        raise RuntimeError("png encode failed")
    # perspective-foreshortened height/width is only approximate: the aspect is a best estimate
    # roof line: where the facade becomes solid at its left/right edges (curved/stepped tops sit above it)
    cols = np.concatenate([alpha[:, : max(1, W // 12)], alpha[:, -max(1, W // 12):]], axis=1)
    solid_rows = np.nonzero((cols > 0).mean(axis=1) > 0.9)[0]
    roof_line = float(solid_rows[0] / H) if len(solid_rows) else 0.0
    return enc.tobytes(), {
        "width": W, "height": H, "aspect": round(W / H, 4),
        "skyShare": round(float((alpha == 0).mean()), 4), "roofLine": round(roof_line, 4),
        "corners": [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in src],
    }


def _sky_alpha(bgr: np.ndarray) -> np.ndarray:
    """Transparent where the pixel is sky connected to the top edge (blue or near-white, low texture)."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hue, sat, val = hsv[..., 0].astype(int), hsv[..., 1].astype(int), hsv[..., 2].astype(int)
    blue = (hue >= 90) & (hue <= 130) & (sat > 25) & (val > 120)
    pale = (sat < 25) & (val > 215)
    grad = cv2.Laplacian(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), cv2.CV_32F, ksize=3)
    smooth = cv2.GaussianBlur(np.abs(grad), (9, 9), 0) < 12
    cand = ((blue | pale) & smooth).astype(np.uint8)
    cand = cv2.morphologyEx(cand, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels = cv2.connectedComponents(cand, connectivity=4)
    top = set(np.unique(labels[0, :])) - {0}
    sky = np.isin(labels, list(top)) if top else np.zeros(cand.shape, bool)
    # only the upper part of a facade can be sky
    sky[int(bgr.shape[0] * 0.6):, :] = False
    alpha = np.where(sky, 0, 255).astype(np.uint8)
    # pull the cut-out 2 px into the building so no light sky fringe remains along the roof line
    return cv2.erode(cv2.dilate(alpha, np.ones((3, 3), np.uint8)), np.ones((7, 7), np.uint8))
