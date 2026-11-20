import * as THREE from "three";
import { fileUrl } from "@/lib/api";

const cache = new Map<string, THREE.Texture>();

/** canvas colour helper in sRGB (THREE.Color would convert to linear and darken the texture) */
function shader(hex: string) {
  const h = /^#?[0-9a-f]{6}$/i.test(hex) ? hex.replace("#", "") : "c9b59a";
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (f: number) => `rgb(${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * f)))).join(",")})`;
}

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
  const shade = shader(color);
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

/** Facade / roof textures (illustrative, procedural). One texture tile = 2 x 2 m. */
export function surfaceTexture(kind: string, color: string): THREE.Texture {
  const k = `surface|${kind}|${color}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const shade = shader(color);
  const r = rand(kind.length * 131 + color.charCodeAt(2));
  g.fillStyle = shade(1);
  g.fillRect(0, 0, S, S);
  const speckle = (n: number, a: number, size = 3) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = shade(0.85 + r() * 0.3);
      g.globalAlpha = a;
      g.fillRect(r() * S, r() * S, 1 + r() * size, 1 + r() * size);
    }
    g.globalAlpha = 1;
  };
  switch (kind) {
    case "stone": {
      // irregular coursed natural stone
      let y = 0;
      while (y < S) {
        const h = 28 + r() * 36;
        let x = -r() * 60;
        while (x < S) {
          const w = 40 + r() * 90;
          g.fillStyle = shade(0.78 + r() * 0.35);
          g.fillRect(x + 3, y + 3, w - 6, h - 6);
          x += w;
        }
        y += h;
      }
      g.globalAlpha = 0.5;
      speckle(3000, 0.2);
      break;
    }
    case "brick": {
      const bh = S / 16,
        bw = S / 4;
      for (let row = 0; row < 16; row++)
        for (let col = -1; col < 5; col++) {
          g.fillStyle = shade(0.82 + r() * 0.3);
          g.fillRect(col * bw + (row % 2) * (bw / 2) + 2, row * bh + 2, bw - 4, bh - 4);
        }
      break;
    }
    case "wood": {
      // vertical slats / cladding boards
      const n = 16;
      for (let i = 0; i < n; i++) {
        g.fillStyle = shade(0.85 + r() * 0.25);
        g.fillRect((i * S) / n + 2, 0, S / n - 4, S);
      }
      break;
    }
    case "concrete": {
      speckle(6000, 0.12, 4);
      g.strokeStyle = shade(0.8);
      g.lineWidth = 2;
      for (const x of [0, S / 2]) g.strokeRect(x, 0, S / 2, S / 2), g.strokeRect(x, S / 2, S / 2, S / 2);
      g.fillStyle = shade(0.7);
      for (const x of [S / 8, (3 * S) / 8, (5 * S) / 8, (7 * S) / 8]) for (const y of [S / 8, (3 * S) / 8, (5 * S) / 8, (7 * S) / 8]) g.beginPath(), g.arc(x, y, 3, 0, Math.PI * 2), g.fill();
      break;
    }
    case "clay_tiles":
    case "slate": {
      const rows = kind === "slate" ? 20 : 12;
      const h = S / rows;
      for (let i = 0; i < rows; i++) {
        const w = kind === "slate" ? S / 8 : S / 10;
        for (let x = -((i % 2) * w) / 2; x < S; x += w) {
          g.fillStyle = shade(0.8 + r() * 0.3);
          g.fillRect(x + 1, i * h, w - 2, h - 2);
          g.fillStyle = shade(0.65);
          g.fillRect(x + 1, i * h + h - 4, w - 2, 3);
        }
      }
      break;
    }
    case "metal": {
      for (let i = 0; i < 12; i++) {
        g.fillStyle = shade(1.1);
        g.fillRect((i * S) / 12, 0, 4, S);
      }
      break;
    }
    default:
      speckle(5000, 0.1, 2); // render / membrane
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.5, 0.5);
  tex.anisotropy = 8;
  cache.set(k, tex);
  return tex;
}
