"""Floor plan parsing tests.

Fixtures are PlanSpecs exported from the TypeScript plan builder (packages/shared/scripts/export-fixtures.ts),
rendered to plan-style images (walls, door swings, window glazing, labels, furniture outlines),
then parsed back. We check scale, room count, room labelling, openings and areas.
"""
import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from propertyverse_workers.floorplan.parse import parse_floorplan
from propertyverse_workers.floorplan.render import render_plan

FIX = Path(__file__).parent / "fixtures"
NAMES = ["simple", "apartment", "villa_ground", "villa_upper"]


def load(name):
    return json.loads((FIX / f"{name}.json").read_text())


def gross_area(plan, ext=0.3):
    xs = [p[0] for w in plan["walls"] for p in (w["a"], w["b"])]
    ys = [p[1] for w in plan["walls"] for p in (w["a"], w["b"])]
    return (max(xs) - min(xs) + ext) * (max(ys) - min(ys) + ext)


def semantic_hints(plan, meta):
    """Simulate what the vision model returns: room label centres, normalised."""
    W, H = meta["width"], meta["height"]
    ox, oy = meta["origin_m"]
    ppm = meta["px_per_m"]
    rooms = []
    for r in plan["rooms"]:
        c = np.mean(r["polygon"], axis=0)
        rooms.append({
            "name": r["name"], "type": r["type"],
            "cx": (c[0] - ox) * ppm / W, "cy": (c[1] - oy) * ppm / H,
            "areaM2": None, "widthM": None, "depthM": None,
        })
    return rooms


def count(plan, *types):
    return sum(1 for o in plan["openings"] if o["type"] in types)


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("ppm", [25, 45, 80])
def test_scale_rooms_and_openings(name, ppm):
    plan = load(name)
    img, meta = render_plan(plan, px_per_m=ppm)
    out = parse_floorplan(img, {"totalAreaM2": gross_area(plan)})
    mpp = out["scale"]["metersPerPixel"]
    assert out["scale"]["source"] == "area"
    assert abs(mpp * ppm - 1) < 0.05, f"scale off: {mpp * ppm:.3f}"
    assert len(out["rooms"]) == len(plan["rooms"])
    # doors+openings and windows (+sliding) within tolerance
    assert abs(count(out, "door", "opening") - count(plan, "door", "opening")) <= 2
    assert abs(count(out, "window", "sliding") - count(plan, "window", "sliding")) <= 2
    assert any(w["exterior"] for w in out["walls"])
    assert out["confidence"] >= 0.7


@pytest.mark.parametrize("name", NAMES)
def test_room_labels_from_semantic_hints(name):
    plan = load(name)
    img, meta = render_plan(plan, px_per_m=45)
    out = parse_floorplan(img, {"totalAreaM2": gross_area(plan), "rooms": semantic_hints(plan, meta)})
    got = sorted(r["name"] for r in out["rooms"])
    assert got == sorted(r["name"] for r in plan["rooms"])
    # net areas: parsed area is inside the walls, so a little below the centre-line area
    by_name = {r["name"]: r for r in out["rooms"]}
    for r in plan["rooms"]:
        a = by_name[r["name"]]["areaM2"]
        assert 0.6 * r["areaM2"] <= a <= 1.05 * r["areaM2"], (r["name"], a, r["areaM2"])


def test_scale_from_printed_room_dimensions():
    plan = load("simple")
    img, meta = render_plan(plan, px_per_m=40)
    hints = semantic_hints(plan, meta)
    for h, r in zip(hints, plan["rooms"]):
        xs = [p[0] for p in r["polygon"]]
        ys = [p[1] for p in r["polygon"]]
        # plans print net (inner) dimensions
        h["widthM"], h["depthM"] = max(xs) - min(xs) - 0.2, max(ys) - min(ys) - 0.2
    out = parse_floorplan(img, {"rooms": hints})
    assert out["scale"]["source"] == "dimension"
    assert abs(out["scale"]["metersPerPixel"] * 40 - 1) < 0.08


def test_scale_fallback_wall_thickness_is_plausible():
    plan = load("villa_ground")
    img, _ = render_plan(plan, px_per_m=45)
    out = parse_floorplan(img, {})
    assert out["scale"]["source"] == "wall_thickness"
    assert abs(out["scale"]["metersPerPixel"] * 45 - 1) < 0.3
    assert any("wall thickness" in n for n in out["notes"])


def test_robust_to_noise_and_jpeg():
    plan = load("apartment")
    img, _ = render_plan(plan, px_per_m=50)
    rng = np.random.default_rng(1)
    noisy = np.clip(img.astype(np.int16) + rng.normal(0, 12, img.shape), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", noisy, [cv2.IMWRITE_JPEG_QUALITY, 60])
    dec = cv2.imdecode(enc, cv2.IMREAD_COLOR)
    out = parse_floorplan(dec, {"totalAreaM2": gross_area(plan)})
    assert len(out["rooms"]) == len(plan["rooms"])


def test_manual_scale_wins():
    plan = load("simple")
    img, _ = render_plan(plan, px_per_m=30)
    out = parse_floorplan(img, {"metersPerPixel": 1 / 30, "totalAreaM2": 999})
    assert out["scale"]["source"] == "manual"
    assert abs(out["scale"]["metersPerPixel"] * 30 - 1) < 1e-6


def test_output_is_centred_and_underlay_maps_back():
    plan = load("villa_upper")
    img, meta = render_plan(plan, px_per_m=45)
    out = parse_floorplan(img, {"totalAreaM2": gross_area(plan)})
    xs = [p[0] for w in out["walls"] for p in (w["a"], w["b"])]
    assert abs((min(xs) + max(xs)) / 2) < 0.3
    u = out["underlay"]
    assert u["widthPx"] == img.shape[1] and u["heightPx"] == img.shape[0]
    # a wall endpoint mapped back to pixels lands on a dark pixel
    w = max(out["walls"], key=lambda w: abs(w["b"][0] - w["a"][0]) + abs(w["b"][1] - w["a"][1]))
    mid = (np.array(w["a"]) + np.array(w["b"])) / 2
    px = ((mid - np.array(u["originM"])) / u["metersPerPixel"]).astype(int)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    patch = gray[px[1] - 3 : px[1] + 4, px[0] - 3 : px[0] + 4]
    assert patch.min() < 100


def test_blank_image_raises():
    with pytest.raises(ValueError):
        parse_floorplan(np.full((600, 800, 3), 255, np.uint8), {})
