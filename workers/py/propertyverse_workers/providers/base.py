"""ReconstructionProvider: one interface for every way of turning media into 3D/visual content.

Layers (best first): C photoreal (splats / world generation) > B materials & furniture >
A floor plan extrusion (always available) ; D 360° panoramas as a per-room fallback.
Providers are registered here and chosen per job by availability and inputs, so external
APIs can be swapped without touching the pipeline.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

Layer = Literal["A", "B", "C", "D"]
Provenance = Literal["measured", "reconstructed", "ai_generated", "illustrative"]


@dataclass
class ReconstructionInputs:
    """Everything a provider may use. Media are raw bytes fetched from object storage."""
    images: list[bytes] = field(default_factory=list)
    video: bytes | None = None
    plan: dict | None = None
    room: dict | None = None
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class Artifact:
    kind: Literal["shell_glb", "splat", "panorama", "texture", "world"]
    data: bytes
    content_type: str
    ext: str
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class ReconstructionResult:
    provider: str
    provenance: Provenance
    artifacts: list[Artifact]
    meta: dict[str, Any] = field(default_factory=dict)


class ReconstructionProvider(ABC):
    name: str
    layer: Layer
    provenance: Provenance

    @abstractmethod
    def available(self) -> tuple[bool, str]:
        """(is usable in this deployment, human readable reason)."""

    @abstractmethod
    def supports(self, inputs: ReconstructionInputs) -> bool:
        """Whether these inputs are sufficient for this provider."""

    @abstractmethod
    def run(self, inputs: ReconstructionInputs, progress: Callable[[str], None] | None = None) -> ReconstructionResult:
        ...


_REGISTRY: list[ReconstructionProvider] = []


def register(p: ReconstructionProvider) -> ReconstructionProvider:
    _REGISTRY.append(p)
    return p


def providers(layer: Layer | None = None) -> list[ReconstructionProvider]:
    return [p for p in _REGISTRY if layer is None or p.layer == layer]


def choose(layer: Layer, inputs: ReconstructionInputs, prefer: str | None = None) -> ReconstructionProvider | None:
    cands = [p for p in providers(layer) if p.available()[0] and p.supports(inputs)]
    if prefer:
        cands.sort(key=lambda p: p.name != prefer)
    return cands[0] if cands else None


def describe() -> list[dict[str, Any]]:
    out = []
    for p in _REGISTRY:
        ok, why = p.available()
        out.append({"name": p.name, "layer": p.layer, "provenance": p.provenance, "available": ok, "reason": why})
    return out
