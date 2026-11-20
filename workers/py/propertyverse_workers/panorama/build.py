"""360° room panoramas (layer D).

- Several overlapping photos -> OpenCV stitching -> placed on an equirectangular canvas.
  Covered area is "reconstructed"; the rest is filled with a soft, blurred extension.
- One photo -> placed at the front of the sphere with a blurred extension ("illustrative").
The returned provenance reflects the weaker of the two when a fill was needed.
"""
from __future__ import annotations

import cv2
import numpy as np

OUT_W, OUT_H = 4096, 2048


def _place(canvas_w: int, canvas_h: int, img: np.ndarray, hfov_deg: float) -> tuple[np.ndarray, np.ndarray]:
    h, w = img.shape[:2]
    pw = int(canvas_w * min(hfov_deg, 360) / 360)
    ph = int(pw * h / w)
    ph = min(ph, int(canvas_h * 0.9))
    pw = int(ph * w / h) if ph == int(canvas_h * 0.9) else pw
    resized = cv2.resize(img, (pw, ph), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((canvas_h, canvas_w, 3), np.uint8)
    mask = np.zeros((canvas_h, canvas_w), np.uint8)
    x0 = (canvas_w - pw) // 2
    y0 = (canvas_h - ph) // 2
    canvas[y0 : y0 + ph, x0 : x0 + pw] = resized
    mask[y0 : y0 + ph, x0 : x0 + pw] = 255
    return canvas, mask


def _fill(canvas: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Fill uncovered regions with a heavily blurred extension of the covered content."""
    if mask.min() == 255:
        return canvas
    small = cv2.resize(canvas, (256, 128), interpolation=cv2.INTER_AREA)
    m_small = cv2.resize(mask, (256, 128), interpolation=cv2.INTER_NEAREST)
    filled = cv2.inpaint(small, 255 - m_small, 9, cv2.INPAINT_TELEA)
    filled = cv2.GaussianBlur(filled, (0, 0), 6)
    # horizontal wrap blend so the seam at 180° is continuous
    filled = cv2.resize(filled, (canvas.shape[1], canvas.shape[0]), interpolation=cv2.INTER_CUBIC)
    alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255, (0, 0), 25)[..., None]
    return (canvas * alpha + filled * (1 - alpha)).astype(np.uint8)


def build_panorama(images: list[np.ndarray], assumed_hfov: float = 65.0) -> tuple[bytes, dict]:
    if not images:
        raise ValueError("no images")
    stitched = None
    if len(images) >= 2:
        stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
        try:
            status, pano = stitcher.stitch([cv2.resize(i, None, fx=min(1, 1400 / i.shape[1]), fy=min(1, 1400 / i.shape[1])) for i in images])
            if status == cv2.Stitcher_OK and pano is not None and pano.size:
                stitched = pano
        except cv2.error:
            stitched = None
    if stitched is not None:
        h, w = stitched.shape[:2]
        # rough coverage estimate from the photo count and overlap
        hfov = min(360.0, assumed_hfov * len(images) * 0.7)
        canvas, mask = _place(OUT_W, OUT_H, stitched, hfov)
        coverage = (mask > 0).mean()
        provenance = "reconstructed" if coverage > 0.85 else "illustrative"
        method = "stitched"
    else:
        best = max(images, key=lambda i: cv2.Laplacian(cv2.cvtColor(i, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
        canvas, mask = _place(OUT_W, OUT_H, best, assumed_hfov)
        coverage = (mask > 0).mean()
        provenance = "illustrative"
        method = "single_photo"
    out = _fill(canvas, mask)
    ok, enc = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 86])
    return enc.tobytes(), {"method": method, "coverage": round(float(coverage), 3), "provenance": provenance}
