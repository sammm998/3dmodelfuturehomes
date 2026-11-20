"""Procedural, tileable PBR textures tinted to colours extracted from listing photos (layer B).

Output per material: albedo (sRGB), normal (OpenGL convention) and roughness maps, PNG.
These are ILLUSTRATIVE: they approximate the material class and colour, not the exact surface.
"""
from __future__ import annotations

import cv2
import numpy as np

SIZE = 512


def _periodic_noise(size: int, scale: float, rng: np.random.Generator, aniso: tuple[float, float] = (1, 1)) -> np.ndarray:
    """Band-limited noise that tiles seamlessly (built in the frequency domain)."""
    f = rng.normal(size=(size, size)) + 1j * rng.normal(size=(size, size))
    ky = np.fft.fftfreq(size)[:, None] * aniso[1]
    kx = np.fft.fftfreq(size)[None, :] * aniso[0]
    k = np.sqrt(kx**2 + ky**2) + 1e-6
    spec = f * np.exp(-((k * size / scale) ** 2))
    n = np.real(np.fft.ifft2(spec))
    n -= n.min()
    return n / (n.max() + 1e-9)


def _hex(c: str) -> np.ndarray:
    c = c.lstrip("#")
    return np.array([int(c[i : i + 2], 16) for i in (0, 2, 4)], float) / 255


def _normal_from_height(h: np.ndarray, strength: float) -> np.ndarray:
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    n = np.dstack([-dx, dy, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return ((n * 0.5 + 0.5) * 255).astype(np.uint8)


def generate(kind: str, color: str, seed: int = 0) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    base = _hex(color)
    S = SIZE
    yy, xx = np.mgrid[0:S, 0:S]
    if kind == "wood":
        plank_h = S // 8
        row = yy // plank_h
        offsets = rng.integers(0, S, size=8)
        lengths = rng.integers(S // 2, S, size=8)
        seam_x = ((xx + offsets[row]) % lengths[row]) < 2
        seam_y = (yy % plank_h) < 2
        grain = _periodic_noise(S, 6, rng, aniso=(0.08, 1.0))
        tone = rng.uniform(0.85, 1.12, size=8)[row]
        v = tone * (0.82 + 0.3 * grain)
        height = 1 - (seam_x | seam_y) * 1.0 + 0.15 * grain
        rough = 0.55 + 0.2 * grain
    elif kind == "tile":
        t = S // 4
        grout = ((xx % t) < 3) | ((yy % t) < 3)
        n = _periodic_noise(S, 40, rng)
        tone = rng.uniform(0.95, 1.04, size=(4, 4))[(yy // t) % 4, (xx // t) % 4]
        v = np.where(grout, 0.7, tone * (0.97 + 0.05 * n))
        height = np.where(grout, 0.0, 1.0)
        rough = np.where(grout, 0.9, 0.25 + 0.1 * n)
    elif kind == "stone":
        t = S // 2
        n1 = _periodic_noise(S, 10, rng)
        n2 = _periodic_noise(S, 60, rng)
        grout = ((xx % t) < 3) | (((yy + (xx // t) * (t // 2)) % t) < 3)
        v = np.where(grout, 0.65, 0.85 + 0.15 * n1 + 0.08 * n2)
        height = np.where(grout, 0.0, 0.7 + 0.3 * n1)
        rough = np.where(grout, 0.9, 0.5 + 0.2 * n2)
    elif kind == "carpet":
        n = _periodic_noise(S, 200, rng)
        v = 0.9 + 0.12 * n
        height = n
        rough = np.full((S, S), 0.95)
    else:  # concrete / unknown
        n1 = _periodic_noise(S, 8, rng)
        n2 = _periodic_noise(S, 90, rng)
        v = 0.88 + 0.1 * n1 + 0.05 * n2
        height = 0.6 * n1 + 0.4 * n2
        rough = 0.75 + 0.15 * n2
    albedo = np.clip(base[None, None, :] * v[..., None], 0, 1)
    albedo = (albedo * 255).astype(np.uint8)
    return {
        "albedo": cv2.cvtColor(albedo, cv2.COLOR_RGB2BGR),
        "normal": cv2.cvtColor(_normal_from_height(height.astype(float), 2.0), cv2.COLOR_RGB2BGR),
        "roughness": (np.clip(rough, 0, 1) * 255).astype(np.uint8),
    }


def encode_png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("png encode failed")
    return buf.tobytes()


def dominant_colors(img: np.ndarray, k: int = 3) -> list[str]:
    """k-means colours (most frequent first) as hex strings."""
    small = cv2.resize(img, (96, 96), interpolation=cv2.INTER_AREA).reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, labels, centers = cv2.kmeans(small, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.ravel(), minlength=k)
    order = np.argsort(-counts)
    out = []
    for i in order:
        b, g, r = centers[i]
        out.append("#%02x%02x%02x" % (int(r), int(g), int(b)))
    return out
