"""Media helpers: PDF rasterisation and video keyframe extraction."""
from __future__ import annotations

import os
import tempfile

import cv2
import numpy as np


def rasterize_pdf(data: bytes, dpi: int = 200, max_side: int = 4000, max_pages: int = 12) -> list[bytes]:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    pages = []
    for i, page in enumerate(doc):
        if i >= max_pages:
            break
        zoom = dpi / 72
        r = page.rect
        zoom = min(zoom, max_side / max(r.width, r.height))
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        pages.append(pix.tobytes("png"))
    return pages


def keyframes(data: bytes, max_frames: int = 24, min_gap_s: float = 0.6) -> tuple[list[bytes], dict]:
    """Pick sharp, mutually different frames from a walkthrough video (phone recordings work)."""
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration = total / fps if total else 0
        window = max(1, int(fps * max(min_gap_s, duration / max(1, max_frames * 1.5) if duration else min_gap_s)))
        best, best_score, frames, hists = None, -1.0, [], []
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % 2 == 0:
                small = cv2.resize(frame, (320, int(320 * frame.shape[0] / frame.shape[1])))
                score = cv2.Laplacian(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
                if score > best_score:
                    best, best_score = frame, score
            idx += 1
            if idx % window == 0 and best is not None:
                h = cv2.calcHist([cv2.resize(best, (64, 36))], [0, 1, 2], None, [8, 8, 8], [0, 256] * 3)
                h = cv2.normalize(h, h).flatten()
                if not hists or min(cv2.compareHist(h, o, cv2.HISTCMP_BHATTACHARYYA) for o in hists[-3:]) > 0.12:
                    frames.append(best)
                    hists.append(h)
                best, best_score = None, -1.0
            if len(frames) >= max_frames:
                break
        cap.release()
        out = []
        for fr in frames:
            scale = min(1.0, 2000 / max(fr.shape[:2]))
            if scale < 1:
                fr = cv2.resize(fr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            ok, enc = cv2.imencode(".jpg", fr, [cv2.IMWRITE_JPEG_QUALITY, 90])
            out.append(enc.tobytes())
        return out, {"fps": fps, "frames": total, "durationS": round(duration, 1), "selected": len(out)}
    finally:
        os.unlink(path)


def decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img
