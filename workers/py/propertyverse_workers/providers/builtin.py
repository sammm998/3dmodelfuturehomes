"""Built-in providers.

A  floorplan_extrude     PlanSpec -> GLB shell (always available)
B  procedural_pbr        tinted procedural PBR textures from photo colours
C  gsplat_local          nerfstudio splatfacto on a local CUDA GPU (needs ns-* CLIs)
C  http_splat            any HTTP service implementing the small job contract below (SPLAT_API_URL)
C  http_world            image-to-3D/world generation behind the same contract (WORLDGEN_API_URL), ai_generated
D  panorama_stitch       OpenCV stitching / single-photo sphere
D  http_panorama         generated panoramas via HTTP (PANORAMA_API_URL), ai_generated

HTTP job contract (deliberately vendor-neutral; write a thin adapter per vendor if needed):
  POST {URL}/jobs        multipart: files[]=..., options=<json>   -> {"id": "..."}
  GET  {URL}/jobs/{id}   -> {"status": "queued|running|done|failed", "result_url": "...", "format": "ply|splat|glb|jpg", "error": "..."}
Auth: "Authorization: Bearer {API_KEY}" when the matching *_API_KEY env var is set.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Callable

import cv2

from ..geometry.extrude import plan_to_glb
from ..materials.textures import encode_png, generate
from ..media import decode_image, keyframes
from ..panorama.build import build_panorama
from .base import (
    Artifact,
    ReconstructionInputs,
    ReconstructionProvider,
    ReconstructionResult,
    register,
)


class FloorplanExtrude(ReconstructionProvider):
    name, layer, provenance = "floorplan_extrude", "A", "measured"

    def available(self):
        return True, "built in"

    def supports(self, inputs):
        return bool(inputs.plan or inputs.options.get("plans"))

    def run(self, inputs, progress=None):
        plans = inputs.options.get("plans") or [inputs.plan]
        glb = plan_to_glb(plans, inputs.options.get("elevations"))
        prov = "illustrative" if any(p.get("provenance") == "illustrative" for p in plans) else "measured"
        return ReconstructionResult(self.name, prov, [Artifact("shell_glb", glb, "model/gltf-binary", "glb")])


class ProceduralPBR(ReconstructionProvider):
    name, layer, provenance = "procedural_pbr", "B", "illustrative"

    def available(self):
        return True, "built in"

    def supports(self, inputs):
        return "kind" in inputs.options and "color" in inputs.options

    def run(self, inputs, progress=None):
        maps = generate(inputs.options["kind"], inputs.options["color"], inputs.options.get("seed", 0))
        arts = [Artifact("texture", encode_png(img), "image/png", "png", {"map": m}) for m, img in maps.items()]
        return ReconstructionResult(self.name, "illustrative", arts, {"kind": inputs.options["kind"]})


class PanoramaStitch(ReconstructionProvider):
    name, layer, provenance = "panorama_stitch", "D", "reconstructed"

    def available(self):
        return True, "built in"

    def supports(self, inputs):
        return len(inputs.images) >= 1

    def run(self, inputs, progress=None):
        imgs = [decode_image(b) for b in inputs.images[:12]]
        data, meta = build_panorama(imgs)
        return ReconstructionResult(self.name, meta["provenance"], [Artifact("panorama", data, "image/jpeg", "jpg", meta)], meta)


def _has_cuda() -> bool:
    try:
        import torch  # type: ignore

        return bool(torch.cuda.is_available())
    except Exception:
        return False


class GsplatLocal(ReconstructionProvider):
    """Gaussian Splatting with nerfstudio (splatfacto). Requires a CUDA GPU and nerfstudio installed
    (use the worker-py-gpu image / `docker compose --profile gpu`)."""

    name, layer, provenance = "gsplat_local", "C", "reconstructed"

    def available(self):
        if os.environ.get("SPLAT_LOCAL", "auto") == "off":
            return False, "disabled by SPLAT_LOCAL=off"
        missing = [c for c in ("ns-process-data", "ns-train", "ns-export") if not shutil.which(c)]
        if missing:
            return False, f"nerfstudio CLIs not installed ({', '.join(missing)})"
        if not _has_cuda():
            return False, "no CUDA GPU"
        return True, "nerfstudio + CUDA"

    def supports(self, inputs):
        return inputs.video is not None or len(inputs.images) >= 20

    def run(self, inputs, progress=None):
        say = progress or (lambda m: None)
        work = Path(tempfile.mkdtemp(prefix="splat-"))
        try:
            imgs = work / "images"
            imgs.mkdir()
            frames = inputs.images
            if inputs.video is not None:
                frames, _ = keyframes(inputs.video, max_frames=int(os.environ.get("SPLAT_MAX_FRAMES", "150")), min_gap_s=0.25)
            for i, b in enumerate(frames):
                (imgs / f"{i:04d}.jpg").write_bytes(b)
            say(f"COLMAP poses for {len(frames)} frames…")
            subprocess.run(["ns-process-data", "images", "--data", str(imgs), "--output-dir", str(work / "proc")], check=True)
            say("Training splats…")
            iters = os.environ.get("SPLAT_ITERS", "15000")
            subprocess.run(
                ["ns-train", "splatfacto", "--data", str(work / "proc"), "--output-dir", str(work / "out"),
                 "--max-num-iterations", iters, "--viewer.quit-on-train-completion", "True"],
                check=True,
            )
            cfg = next((work / "out").rglob("config.yml"))
            subprocess.run(["ns-export", "gaussian-splat", "--load-config", str(cfg), "--output-dir", str(work / "export")], check=True)
            ply = next((work / "export").glob("*.ply")).read_bytes()
            return ReconstructionResult(self.name, "reconstructed", [Artifact("splat", ply, "application/octet-stream", "ply")], {"frames": len(frames)})
        finally:
            shutil.rmtree(work, ignore_errors=True)


class HttpJobProvider(ReconstructionProvider):
    """Generic adapter for remote reconstruction/generation services (see module docstring)."""

    def __init__(self, name: str, layer: str, provenance: str, env_prefix: str, kind: str, min_images: int):
        self.name, self.layer, self.provenance = name, layer, provenance  # type: ignore[assignment]
        self.env_prefix, self.kind, self.min_images = env_prefix, kind, min_images

    @property
    def url(self) -> str | None:
        return os.environ.get(f"{self.env_prefix}_API_URL")

    def available(self):
        return (True, self.url) if self.url else (False, f"{self.env_prefix}_API_URL not set")

    def supports(self, inputs):
        return inputs.video is not None or len(inputs.images) >= self.min_images

    def _req(self, method: str, path: str, body: bytes | None = None, ctype: str | None = None):
        req = urllib.request.Request(self.url.rstrip("/") + path, data=body, method=method)
        key = os.environ.get(f"{self.env_prefix}_API_KEY")
        if key:
            req.add_header("Authorization", f"Bearer {key}")
        if ctype:
            req.add_header("Content-Type", ctype)
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()

    def run(self, inputs, progress=None):
        say = progress or (lambda m: None)
        boundary = uuid.uuid4().hex
        parts = []
        files = [("video.mp4", inputs.video, "video/mp4")] if inputs.video else []
        files += [(f"img{i}.jpg", b, "image/jpeg") for i, b in enumerate(inputs.images[:200])]
        for fname, data, ctype in files:
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="{fname}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n"
            )
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n{json.dumps(inputs.options)}\r\n'.encode()
        )
        body = b"".join(parts) + f"--{boundary}--\r\n".encode()
        job = json.loads(self._req("POST", "/jobs", body, f"multipart/form-data; boundary={boundary}"))
        deadline = time.time() + float(os.environ.get(f"{self.env_prefix}_TIMEOUT_S", "5400"))
        while time.time() < deadline:
            st = json.loads(self._req("GET", f"/jobs/{job['id']}"))
            if st["status"] == "done":
                with urllib.request.urlopen(st["result_url"], timeout=600) as r:
                    data = r.read()
                fmt = st.get("format", "ply")
                ctype = {"glb": "model/gltf-binary", "jpg": "image/jpeg"}.get(fmt, "application/octet-stream")
                return ReconstructionResult(self.name, self.provenance, [Artifact(self.kind, data, ctype, fmt)], {"remoteId": job["id"]})  # type: ignore[arg-type]
            if st["status"] == "failed":
                raise RuntimeError(f"{self.name} failed: {st.get('error')}")
            say(f"{self.name}: {st['status']}")
            time.sleep(10)
        raise TimeoutError(f"{self.name} timed out")


def register_builtin() -> None:
    register(FloorplanExtrude())
    register(ProceduralPBR())
    register(GsplatLocal())
    register(HttpJobProvider("http_splat", "C", "reconstructed", "SPLAT", "splat", 20))
    register(HttpJobProvider("http_world", "C", "ai_generated", "WORLDGEN", "world", 1))
    register(PanoramaStitch())
    register(HttpJobProvider("http_panorama", "D", "ai_generated", "PANORAMA", "panorama", 1))


_ = cv2  # keep import for side effects in frozen builds
