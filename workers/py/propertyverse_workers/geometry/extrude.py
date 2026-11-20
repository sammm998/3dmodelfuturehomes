"""PlanSpec -> GLB shell (walls with openings, glass, floor slab, room floors, ceiling).

Mirrors packages/shared/src/geometry.ts::splitWall so the baked GLB matches the live viewer.
World axes: x = plan x, y = up, z = plan y.
"""
from __future__ import annotations

import io
import math
from typing import Any

import numpy as np
import trimesh
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union
from shapely import affinity

FLOOR_COLORS = {
    "wood": "#b98b5e", "tile": "#d9d4cb", "stone": "#c8bfae", "concrete": "#a7a39c", "carpet": "#8d8a86",
}
DEFAULT_ROOM_FLOOR = {
    "bathroom": "#d9d4cb", "wc": "#d9d4cb", "kitchen": "#d4cfc6", "terrace": "#c8bfae", "balcony": "#c8bfae",
    "garage": "#a7a39c", "storage": "#bdb6aa",
}


def _rgba(hex_: str, a: float = 1.0) -> list[float]:
    h = hex_.lstrip("#")
    return [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)] + [a]


def _mat(name: str, color: list[float], rough=0.8, metal=0.0, blend=False):
    return trimesh.visual.material.PBRMaterial(
        name=name, baseColorFactor=color, roughnessFactor=rough, metallicFactor=metal,
        alphaMode="BLEND" if blend else "OPAQUE", doubleSided=blend,
    )


def split_wall(wall: dict, openings: list[dict], height: float) -> list[dict]:
    a, b = np.array(wall["a"], float), np.array(wall["b"], float)
    L = float(np.linalg.norm(b - a))
    ops = []
    for o in openings:
        if o["wallId"] != wall["id"]:
            continue
        half = min(o["width"], L) / 2
        c = o["t"] * L
        ops.append((max(0.0, c - half), min(L, c + half), o))
    ops.sort(key=lambda x: x[0])
    pieces, cursor = [], 0.0
    for s0, s1, o in ops:
        if s0 > cursor + 1e-3:
            pieces.append(dict(s0=cursor, s1=s0, z0=0.0, z1=height, kind="solid"))
        head = min(o.get("head", 2.1), height)
        sill = o.get("sill", 0.0)
        if head < height - 1e-3:
            pieces.append(dict(s0=s0, s1=s1, z0=head, z1=height, kind="solid"))
        if sill > 1e-3:
            pieces.append(dict(s0=s0, s1=s1, z0=0.0, z1=sill, kind="solid"))
        if o["type"] == "window":
            pieces.append(dict(s0=s0, s1=s1, z0=sill, z1=head, kind="glass"))
        cursor = max(cursor, s1)
    if cursor < L - 1e-3:
        pieces.append(dict(s0=cursor, s1=L, z0=0.0, z1=height, kind="solid"))
    return pieces


def _box_along(a: np.ndarray, b: np.ndarray, s0: float, s1: float, z0: float, z1: float, thick: float,
               ext0: float, ext1: float, base_y: float) -> trimesh.Trimesh:
    d = b - a
    L = float(np.linalg.norm(d))
    u = d / L
    length = (s1 - s0) + ext0 + ext1
    mid = a + u * ((s0 - ext0 + s1 + ext1) / 2)
    m = trimesh.creation.box(extents=[length, z1 - z0, thick])
    theta = -math.atan2(u[1], u[0])
    T = trimesh.transformations.rotation_matrix(theta, [0, 1, 0])
    T[:3, 3] = [mid[0], base_y + (z0 + z1) / 2, mid[1]]
    m.apply_transform(T)
    return m


def _extrude(poly: Polygon, y0: float, h: float) -> trimesh.Trimesh:
    m = trimesh.creation.extrude_polygon(poly, h)
    # extrude_polygon builds along +z from the xy polygon; map (x, y, z) -> (x, z, y)
    R = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], float)
    m.apply_transform(R)
    m.apply_translation([0, y0, 0])
    m.invert() if m.volume < 0 else None
    return m


def footprint_polygon(plan: dict) -> Polygon:
    parts = []
    for r in plan["rooms"]:
        if len(r["polygon"]) >= 3:
            parts.append(Polygon(r["polygon"]).buffer(0))
    for w in plan["walls"]:
        a, b = np.array(w["a"]), np.array(w["b"])
        L = float(np.linalg.norm(b - a))
        if L < 1e-6:
            continue
        rect = sbox(-L / 2 - w["thickness"] / 2, -w["thickness"] / 2, L / 2 + w["thickness"] / 2, w["thickness"] / 2)
        ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        rect = affinity.rotate(rect, ang, origin=(0, 0))
        rect = affinity.translate(rect, *((a + b) / 2))
        parts.append(rect)
    u = unary_union(parts).buffer(0.05).buffer(-0.05)
    if u.geom_type == "MultiPolygon":
        u = max(u.geoms, key=lambda g: g.area)
    return Polygon(u.exterior)


def floor_meshes(plan: dict, base_y: float = 0.0, level: int = 0) -> dict[str, trimesh.Trimesh]:
    H = plan.get("ceilingHeight", 2.7)
    slab = plan.get("slabThickness", 0.25)
    out: dict[str, trimesh.Trimesh] = {}
    solids, glass = [], []
    for w in plan["walls"]:
        a, b = np.array(w["a"], float), np.array(w["b"], float)
        L = float(np.linalg.norm(b - a))
        if L < 1e-6:
            continue
        for p in split_wall(w, plan["openings"], H):
            ext0 = w["thickness"] / 2 if p["s0"] <= 1e-6 and p["kind"] == "solid" else 0.0
            ext1 = w["thickness"] / 2 if p["s1"] >= L - 1e-6 and p["kind"] == "solid" else 0.0
            thick = w["thickness"] if p["kind"] == "solid" else 0.02
            m = _box_along(a, b, p["s0"], p["s1"], p["z0"], p["z1"], thick, ext0, ext1, base_y)
            (solids if p["kind"] == "solid" else glass).append(m)
    if solids:
        out["walls"] = trimesh.util.concatenate(solids)
    if glass:
        out["glass"] = trimesh.util.concatenate(glass)
    fp = footprint_polygon(plan)
    out["slab"] = _extrude(fp, base_y - slab, slab)
    out["ceiling"] = _extrude(fp, base_y + H, 0.02)
    for r in plan["rooms"]:
        if len(r["polygon"]) < 3:
            continue
        poly = Polygon(r["polygon"]).buffer(0)
        if poly.is_empty or poly.area < 0.2:
            continue
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)
        out[f"room_{r['id']}"] = _extrude(poly, base_y, 0.01)
    return out


def plan_to_glb(plans: list[dict], elevations: list[float] | None = None) -> bytes:
    """Export one or more stacked floors into a single GLB. Node names: L{level}_{part}."""
    scene = trimesh.Scene()
    elevations = elevations or _stack(plans)
    wall_mat = _mat("wall", _rgba("#f3f0ea"), 0.9)
    glass_mat = _mat("glass", [0.72, 0.82, 0.9, 0.35], 0.05, 0.0, blend=True)
    slab_mat = _mat("slab", _rgba("#d8d2c6"), 0.9)
    ceil_mat = _mat("ceiling", _rgba("#fbfaf7"), 0.95)
    for lvl, (plan, y) in enumerate(zip(plans, elevations)):
        rooms = {r["id"]: r for r in plan["rooms"]}
        for name, mesh in floor_meshes(plan, y, lvl).items():
            if name == "walls":
                mat = wall_mat
            elif name == "glass":
                mat = glass_mat
            elif name == "slab":
                mat = slab_mat
            elif name == "ceiling":
                mat = ceil_mat
            else:
                r = rooms[name[5:]]
                fl = (r.get("materials") or {}).get("floor") or {}
                color = fl.get("color") or DEFAULT_ROOM_FLOOR.get(r["type"]) or FLOOR_COLORS["wood"]
                mat = _mat(f"floor_{r['id']}", _rgba(color), 0.6)
            mesh.visual = trimesh.visual.TextureVisuals(material=mat)
            scene.add_geometry(mesh, node_name=f"L{lvl}_{name}", geom_name=f"L{lvl}_{name}")
    buf = io.BytesIO()
    scene.export(buf, file_type="glb")
    return buf.getvalue()


def _stack(plans: list[dict]) -> list[float]:
    ys, y = [], 0.0
    for p in plans:
        ys.append(y)
        y += p.get("ceilingHeight", 2.7) + p.get("slabThickness", 0.25)
    return ys


def summarize(plan: dict[str, Any]) -> dict[str, Any]:
    fp = footprint_polygon(plan)
    return {"footprintM2": round(fp.area, 1), "footprint": [list(map(float, c)) for c in fp.exterior.coords]}
