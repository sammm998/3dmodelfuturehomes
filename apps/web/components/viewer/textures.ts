import * as THREE from "three";
import { fileUrl } from "@/lib/api";

const cache = new Map<string, THREE.Texture>();

function rand(seed: number) {
  let s = seed % 2147483647;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Procedural floor textures (illustrative) drawn on a canvas; tile = 2 m. */
function canvasTexture(kind: string, color: string): THREE.Texture {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const base = new THREE.Color(color);
  const shade = (f: number) => {
    const k = base.clone().multiplyScalar(f);
    return `rgb(${Math.min(255, k.r * 255) | 0},${Math.min(255, k.g * 255) | 0},${Math.min(255, k.b * 255) | 0})`;
  };
  const r = rand(kind.length * 997 + color.length);
  g.fillStyle = shade(1);
  g.fillRect(0, 0, S, S);
  if (kind === "wood") {
    const rows = 8;
    const h = S / rows;
    for (let i = 0; i < rows; i++) {
      let x = -r() * S;
      while (x < S) {
        const w = S * (0.45 + r() * 0.5);
        g.fillStyle = shade(0.86 + r() * 0.24);
        g.fillRect(x, i * h, w, h);
        for (let k = 0; k < 14; k++) {
          g.strokeStyle = shade(0.78 + r() * 0.12);
          g.globalAlpha = 0.25;
          g.beginPath();
          const yy = i * h + r() * h;
          g.moveTo(x, yy);
          g.bezierCurveTo(x + w / 3, yy + (r() - 0.5) * 6, x + (2 * w) / 3, yy + (r() - 0.5) * 6, x + w, yy);
          g.stroke();
        }
        g.globalAlpha = 1;
        g.fillStyle = shade(0.6);
        g.fillRect(x, i * h, 2, h);
        x += w;
      }
      // wrap: duplicate the left edge
      g.fillStyle = shade(0.6);
      g.fillRect(0, i * h, S, 2);
    }
  } else if (kind === "tile" || kind === "stone") {
    const n = kind === "tile" ? 4 : 2;
    const t = S / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        g.fillStyle = shade(0.95 + r() * 0.08);
        g.fillRect(i * t + 2, j * t + 2, t - 4, t - 4);
        if (kind === "stone")
          for (let k = 0; k < 120; k++) {
            g.fillStyle = shade(0.88 + r() * 0.2);
            g.globalAlpha = 0.15;
            g.fillRect(i * t + r() * t, j * t + r() * t, 3 + r() * 10, 2 + r() * 6);
          }
        g.globalAlpha = 1;
      }
    g.fillStyle = shade(0.72);
    for (let i = 0; i <= n; i++) {
      g.fillRect(i * t - 2, 0, 4, S);
      g.fillRect(0, i * t - 2, S, 4);
    }
  } else {
    for (let k = 0; k < 4000; k++) {
      g.fillStyle = shade(0.9 + r() * 0.2);
      g.globalAlpha = 0.12;
      g.fillRect(r() * S, r() * S, 2 + r() * 4, 2 + r() * 4);
    }
    g.globalAlpha = 1;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.5, 0.5);
  tex.anisotropy = 8;
  return tex;
}

export function floorTexture(kind: string, color: string, textureKey?: string): THREE.Texture {
  const k = `${kind}|${color}|${textureKey ?? ""}`;
  const hit = cache.get(k);
  if (hit) return hit;
  let tex: THREE.Texture;
  if (textureKey) {
    tex = new THREE.TextureLoader().load(fileUrl(textureKey)!);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(0.5, 0.5);
    tex.anisotropy = 8;
  } else tex = canvasTexture(kind, color);
  cache.set(k, tex);
  return tex;
}

export function groundTexture(): THREE.Texture {
  const hit = cache.get("ground");
  if (hit) return hit;
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#7f9466";
  g.fillRect(0, 0, S, S);
  const r = rand(42);
  for (let i = 0; i < 6000; i++) {
    g.fillStyle = `rgba(${60 + r() * 60},${90 + r() * 60},${40 + r() * 40},0.35)`;
    g.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(60, 60);
  cache.set("ground", t);
  return t;
}
