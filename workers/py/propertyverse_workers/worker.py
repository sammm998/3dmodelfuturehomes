"""BullMQ worker for CPU/GPU-heavy steps. The Node orchestrator enqueues jobs on queue "py"
and awaits their results; this worker only reads/writes object storage and returns JSON."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import signal
import traceback

from bullmq import Worker

from . import storage
from .floorplan.parse import parse_floorplan
from .materials.textures import encode_png, generate
from .media import decode_image, keyframes, rasterize_pdf
from .providers.base import ReconstructionInputs, choose, describe
from .providers.builtin import register_builtin

log = logging.getLogger("pv.worker")
register_builtin()


def _blocking(name: str, data: dict) -> dict:
    if name == "pdf.rasterize":
        pages = rasterize_pdf(storage.get(data["key"]))
        keys = [storage.put(f"{data['prefix']}/page-{i + 1}.png", b, "image/png") for i, b in enumerate(pages)]
        return {"pages": keys}

    if name == "video.keyframes":
        frames, meta = keyframes(storage.get(data["key"]), max_frames=data.get("maxFrames", 24))
        keys = [storage.put(f"{data['prefix']}/frame-{i + 1:03d}.jpg", b, "image/jpeg") for i, b in enumerate(frames)]
        return {"frames": keys, "meta": meta}

    if name == "floorplan.parse":
        img = decode_image(storage.get(data["key"]))
        return {"plan": parse_floorplan(img, data.get("hints") or {})}

    if name == "bake.glb":
        inputs = ReconstructionInputs(options={"plans": data["plans"], "elevations": data.get("elevations")})
        p = choose("A", inputs)
        res = p.run(inputs)
        art = res.artifacts[0]
        storage.put(data["key"], art.data, art.content_type)
        return {"key": data["key"], "bytes": len(art.data), "provider": res.provider, "provenance": res.provenance}

    if name == "textures.generate":
        out = {}
        for i, item in enumerate(data["items"]):
            maps = generate(item["kind"], item["color"], seed=i)
            out[item["id"]] = {
                m: storage.put(f"{data['prefix']}/{item['id']}-{m}.png", encode_png(img), "image/png") for m, img in maps.items()
            }
        return {"textures": out, "provider": "procedural_pbr", "provenance": "illustrative"}

    if name == "panorama.build":
        inputs = ReconstructionInputs(images=[storage.get(k) for k in data["keys"]])
        p = choose("D", inputs, prefer=data.get("prefer") or os.environ.get("PANORAMA_PROVIDER") or "panorama_stitch")
        if not p:
            return {"skipped": "no panorama provider"}
        res = p.run(inputs)
        art = res.artifacts[0]
        storage.put(data["key"], art.data, art.content_type)
        return {"key": data["key"], "provider": res.provider, "provenance": res.provenance, "meta": res.meta}

    if name == "splat.train":
        inputs = ReconstructionInputs(
            images=[storage.get(k) for k in data.get("imageKeys", [])],
            video=storage.get(data["videoKey"]) if data.get("videoKey") else None,
        )
        p = choose("C", inputs, prefer=data.get("prefer") or os.environ.get("SPLAT_PROVIDER"))
        if not p:
            reasons = "; ".join(f"{d['name']}: {d['reason']}" for d in describe() if d["layer"] == "C")
            return {"skipped": f"no photoreal provider available ({reasons})"}
        res = p.run(inputs)
        art = res.artifacts[0]
        key = f"{data['prefix']}/{art.kind}.{art.ext}"
        storage.put(key, art.data, art.content_type)
        return {"key": key, "kind": art.kind, "format": art.ext, "provider": res.provider, "provenance": res.provenance}

    if name == "providers.describe":
        return {"providers": describe()}

    raise ValueError(f"unknown job {name}")


async def process(job, token):
    log.info("job %s %s", job.name, job.id)
    try:
        return await asyncio.to_thread(_blocking, job.name, job.data)
    except Exception:
        log.error("job %s failed\n%s", job.name, traceback.format_exc())
        raise


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    redis = os.environ.get("REDIS_URL", "redis://localhost:6379")
    conc = int(os.environ.get("PY_WORKER_CONCURRENCY", "2"))
    worker = Worker("py", process, {"connection": redis, "concurrency": conc, "lockDuration": 300000})
    safe = re.sub(r"//[^@/]*@", "//***@", redis)  # never log credentials
    log.info("python worker listening on queue 'py' (%s), providers: %s", safe, [d["name"] for d in describe() if d["available"]])
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, stop.set)
    await stop.wait()
    await worker.close()


if __name__ == "__main__":
    asyncio.run(main())
