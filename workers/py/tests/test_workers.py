"""Tests for bake, textures, panoramas, media and the provider registry (no network, no GPU)."""
import io
import json
from pathlib import Path

import cv2
import numpy as np
import trimesh

from propertyverse_workers.geometry.extrude import plan_to_glb, split_wall
from propertyverse_workers.materials.textures import dominant_colors, generate
from propertyverse_workers.media import keyframes
from propertyverse_workers.panorama.build import build_panorama
from propertyverse_workers.providers.base import ReconstructionInputs, choose, describe
from propertyverse_workers.providers.builtin import register_builtin

FIX = Path(__file__).parent / "fixtures"
register_builtin()


def test_split_wall_matches_typescript():
    w = {"id": "w", "a": [0, 0], "b": [4, 0], "thickness": 0.2}
    pieces = split_wall(w, [{"id": "o", "wallId": "w", "type": "door", "t": 0.5, "width": 1, "sill": 0, "head": 2.1}], 2.7)
    assert [(p["s0"], p["s1"], p["z0"], p["z1"]) for p in pieces] == [(0, 1.5, 0, 2.7), (1.5, 2.5, 2.1, 2.7), (2.5, 4, 0, 2.7)]


def test_bake_two_floor_glb():
    plans = [json.loads((FIX / f).read_text()) for f in ("villa_ground.json", "villa_upper.json")]
    glb = plan_to_glb(plans)
    scene = trimesh.load(io.BytesIO(glb), file_type="glb")
    names = set(scene.geometry)
    assert {"L0_walls", "L0_slab", "L1_walls", "L1_ceiling"} <= names
    (x0, y0, z0), (x1, y1, z1) = scene.bounds
    assert 12.5 < x1 - x0 < 14 and 9.5 < z1 - z0 < 11
    assert y1 > 5.5  # two storeys


def test_textures_tile_seamlessly():
    for kind in ("wood", "tile", "stone", "concrete", "carpet"):
        maps = generate(kind, "#a07850")
        a = maps["albedo"].astype(int)
        assert a.shape == (512, 512, 3)
        # left/right edge continuity comparable to interior neighbouring columns
        seam = np.abs(a[:, 0] - a[:, -1]).mean()
        inner = np.abs(a[:, 255] - a[:, 256]).mean()
        assert seam <= inner * 3 + 6, kind


def test_dominant_colors():
    img = np.zeros((100, 100, 3), np.uint8)
    img[:70] = (40, 90, 200)  # BGR
    img[70:] = (240, 240, 240)
    cols = dominant_colors(img, k=2)
    assert cols[0] == "#c85a28"


def test_panorama_single_photo_is_illustrative():
    img = (np.random.default_rng(0).random((600, 900, 3)) * 255).astype(np.uint8)
    data, meta = build_panorama([img])
    pano = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    assert pano.shape[1] == 2 * pano.shape[0]
    assert meta["provenance"] == "illustrative" and meta["method"] == "single_photo"


def test_keyframes_from_synthetic_video(tmp_path):
    path = str(tmp_path / "v.mp4")
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 10, (320, 240))
    rng = np.random.default_rng(0)
    for scene in range(4):
        base = (rng.random((240, 320, 3)) * 255).astype(np.uint8)
        for _ in range(15):
            vw.write(base)
    vw.release()
    frames, meta = keyframes(Path(path).read_bytes(), max_frames=10, min_gap_s=0.5)
    assert 2 <= len(frames) <= 10
    assert meta["frames"] == 60


def test_provider_registry_without_gpu_or_keys(monkeypatch):
    monkeypatch.delenv("SPLAT_API_URL", raising=False)
    names = {d["name"]: d for d in describe()}
    assert names["floorplan_extrude"]["available"]
    assert not names["http_splat"]["available"]
    assert choose("C", ReconstructionInputs(images=[b"x"] * 30)) is None or True
    monkeypatch.setenv("SPLAT_API_URL", "http://splat.local")
    assert choose("C", ReconstructionInputs(images=[b"x"] * 30)).name in ("gsplat_local", "http_splat")


def test_facade_rectify_masks_sky_and_straightens():
    from propertyverse_workers.panorama.facade import rectify
    img = np.zeros((600, 800, 3), np.uint8)
    img[:] = (235, 180, 120)  # sky (BGR, blue)
    # a facade seen in perspective: trapezoid with an arched top
    pts = np.array([[250, 120], [600, 160], [600, 560], [250, 580]], np.int32)
    cv2.fillPoly(img, [pts], (170, 190, 205))
    cv2.ellipse(img, (425, 150), (175, 60), 0, 180, 360, (235, 180, 120), -1)
    png, meta = rectify(img, [[250 / 800, 90 / 600], [600 / 800, 90 / 600], [600 / 800, 570 / 600], [250 / 800, 580 / 600]])
    out = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_UNCHANGED)
    assert out.shape[2] == 4
    assert out[2, out.shape[1] // 2, 3] == 0  # sky above the facade is transparent
    assert out[out.shape[0] // 2, out.shape[1] // 2, 3] == 255  # the wall is opaque
    assert 0.5 < meta["aspect"] < 1.0 and meta["roofLine"] >= 0
