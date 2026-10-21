/* ============================================================================
   textures.js — procedural canvas texture laboratory
   Every material map in Maigo-chan is generated at runtime:
   seamless fBm noise, Sobel-derived normal maps, painted stains and decals.
   No external image maps are required for the environment.
   ========================================================================== */
import * as THREE from 'three';
import { TEX } from './assets.js?v=b13';

/* ---------------------------------- RNG ---------------------------------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ----------------------------- seamless noise ----------------------------- */
function valueLayer(size, cells, seed) {
  const rnd = mulberry32(seed);
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const out = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const j0 = Math.floor(fy);
    const ty = smooth(fy - j0);
    const r0 = ((j0 % cells) + cells) % cells;
    const r1 = (r0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const i0 = Math.floor(fx);
      const tx = smooth(fx - i0);
      const c0 = ((i0 % cells) + cells) % cells;
      const c1 = (c0 + 1) % cells;
      const a = grid[r0 * cells + c0], b = grid[r0 * cells + c1];
      const c = grid[r1 * cells + c0], d = grid[r1 * cells + c1];
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      out[y * size + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/** Seamless fBm field in [0,1]. */
export function fbmField(size, { seed = 1, cells = 3, octaves = 5, gain = 0.5, ridged = false } = {}) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, cellCount = cells;
  for (let o = 0; o < octaves; o++) {
    const layer = valueLayer(size, Math.max(2, Math.round(cellCount)), seed + o * 131);
    for (let i = 0; i < out.length; i++) {
      const v = ridged ? 1 - Math.abs(layer[i] * 2 - 1) : layer[i];
      out[i] += v * amp;
    }
    norm += amp; amp *= gain; cellCount *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/* ------------------------------- canvases -------------------------------- */
function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Height field -> tangent-space normal map canvas (Sobel). */
export function normalCanvas(field, size, strength = 2.6) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => field[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function canvasTexture(c, repeatX = 1, repeatY = 1, { srgb = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------ decal helpers ----------------------------- */
function paintCracks(ctx, size, seed, { count = 16, alpha = 0.5, width = 1, color = '10,10,14' } = {}) {
  const rnd = mulberry32(seed);
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    let x = rnd() * size, y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    const segs = 6 + (rnd() * 16 | 0);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < segs; s++) {
      a += (rnd() - 0.5) * 0.9;
      const len = size * (0.004 + rnd() * 0.022);
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${color},${alpha * (0.35 + rnd() * 0.65)})`;
    ctx.lineWidth = width * (0.5 + rnd() * 1.4);
    ctx.stroke();
  }
  ctx.restore();
}

function paintStains(ctx, size, seed, { count = 22, dark = '8,7,6', maxR = 0.14, alpha = 0.35 } = {}) {
  const rnd = mulberry32(seed);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = size * (0.015 + rnd() * maxR);
    const g = ctx.createRadialGradient(x, y, r * 0.05, x, y, r);
    const a = alpha * (0.25 + rnd() * 0.75);
    g.addColorStop(0, `rgba(${dark},${a})`);
    g.addColorStop(0.55, `rgba(${dark},${a * 0.45})`);
    g.addColorStop(1, `rgba(${dark},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r * (0.5 + rnd()), r, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function grainOverlay(ctx, size, seed, amount = 22) {
  const rnd = mulberry32(seed);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    d[i] = clamp01((d[i] + n) / 255) * 255;
    d[i + 1] = clamp01((d[i + 1] + n) / 255) * 255;
    d[i + 2] = clamp01((d[i + 2] + n) / 255) * 255;
  }
  ctx.putImageData(img, 0, 0);
}

/* =========================================================================
   CONCRETE — weathered poured panels with form-tie seams
   ========================================================================= */
export function concreteMaps(size = 512, seed = 7) {
  const base = fbmField(size, { seed, cells: 3, octaves: 6, gain: 0.55 });
  const grit = fbmField(size, { seed: seed + 3, cells: 64, octaves: 2, gain: 0.5 });
  const stainF = fbmField(size, { seed: seed + 9, cells: 6, octaves: 4, gain: 0.55 });
  const wet = fbmField(size, { seed: seed + 31, cells: 4, octaves: 4, gain: 0.6 });

  const col = canvas(size), ctx = col.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const n = base[i], g = grit[i];
    let lum = 0.30 + n * 0.28 + g * 0.09;
    lum -= smoothstep(0.52, 0.9, stainF[i]) * 0.11;                  // damp stains
    lum -= smoothstep(0.6, 0.85, wet[i]) * 0.05;                     // wet patches
    const warm = 0.015 * (stainF[i] - 0.5);
    d[i * 4] = clamp01(lum + 0.012 + warm) * 255;
    d[i * 4 + 1] = clamp01(lum + 0.008) * 255;
    d[i * 4 + 2] = clamp01(lum + 0.028 - warm) * 255;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // form-work seams + tie holes
  ctx.save();
  ctx.strokeStyle = 'rgba(9,9,12,.45)';
  ctx.lineWidth = Math.max(1, size / 400);
  for (let k = 0; k < 4; k++) {
    const y = (k / 4) * size + 2;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.beginPath(); ctx.moveTo(0, y + 2); ctx.lineTo(size, y + 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(9,9,12,.45)';
  }
  for (let k = 0; k < 4; k++) {
    const x = (k / 4) * size + size / 8;
    for (let j = 0; j < 4; j++) {
      const y = (j / 4) * size + size / 8;
      ctx.fillStyle = 'rgba(10,10,13,.5)';
      ctx.beginPath(); ctx.arc(x, y, size * 0.006, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
      ctx.beginPath(); ctx.arc(x, y, size * 0.009, 0.4, 2.6); ctx.stroke();
    }
  }
  ctx.restore();

  paintCracks(ctx, size, seed + 17, { count: 11, alpha: 0.32, width: 0.9 });
  paintStains(ctx, size, seed + 21, { count: 26, dark: '9,10,12', maxR: 0.16, alpha: 0.3 });
  grainOverlay(ctx, size, seed + 77, 17);

  const normalField = new Float32Array(size * size);
  for (let i = 0; i < normalField.length; i++) {
    normalField[i] = base[i] * 0.7 + grit[i] * 0.3 + (stainF[i] > 0.7 ? -0.05 : 0);
  }

  const rough = canvas(size), rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(size, size), rd = rimg.data;
  for (let i = 0; i < size * size; i++) {
    const v = 200 + grad(wet[i]) * 35 - smoothstep(0.6, 0.9, stainF[i]) * 30;
    rd[i * 4] = v; rd[i * 4 + 1] = v; rd[i * 4 + 2] = v; rd[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);

  return {
    map: canvasTexture(col, 1, 1, { srgb: true }),
    normalMap: canvasTexture(normalCanvas(normalField, size, 2.2), 1, 1),
    roughnessMap: canvasTexture(rough, 1, 1),
  };
  function grad(v) { return Math.abs(v - 0.5) * 2; }
}

/* =========================================================================
   WET ASPHALT — deep charcoal, aggregate, hairline cracks, puddle mask
   ========================================================================= */
export function asphaltMaps(size = 512, seed = 21) {
  const base = fbmField(size, { seed, cells: 5, octaves: 6, gain: 0.55 });
  const fine = fbmField(size, { seed: seed + 5, cells: 48, octaves: 3, gain: 0.55 });
  const puddle = fbmField(size, { seed: seed + 12, cells: 3, octaves: 5, gain: 0.62 });
  const grit = fbmField(size, { seed: seed + 44, cells: 128, octaves: 1 });

  const col = canvas(size), ctx = col.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const wet = smoothstep(0.52, 0.78, puddle[i]);
    let lum = 0.115 + base[i] * 0.075 + fine[i] * 0.06;
    lum *= 1 - wet * 0.38;
    d[i * 4] = lum * 250;
    d[i * 4 + 1] = lum * 255;
    d[i * 4 + 2] = lum * 275;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const rnd = mulberry32(seed + 3);
  ctx.save();
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * size, y = rnd() * size;
    const b = 90 + rnd() * 120;
    ctx.fillStyle = `rgba(${b},${b},${b + 8},${0.1 + rnd() * 0.3})`;
    ctx.fillRect(x, y, 1 + rnd() * 1.4, 1 + rnd() * 1.4);
  }
  ctx.restore();
  paintCracks(ctx, size, seed + 19, { count: 24, alpha: 0.65, width: 1.1, color: '4,4,7' });
  paintCracks(ctx, size, seed + 33, { count: 9, alpha: 0.35, width: 2.2, color: '4,4,7' });
  paintStains(ctx, size, seed + 51, { count: 14, dark: '0,0,2', maxR: 0.2, alpha: 0.38 });
  grainOverlay(ctx, size, seed + 4, 12);

  const normalField = new Float32Array(size * size);
  for (let i = 0; i < normalField.length; i++) {
    normalField[i] = fine[i] * 0.62 + grit[i] * 0.2 + base[i] * 0.3 - puddle[i] * 0.18;
  }

  const rough = canvas(size), rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(size, size), rd = rimg.data;
  for (let i = 0; i < size * size; i++) {
    const wet = smoothstep(0.5, 0.76, puddle[i]);
    const v = 255 * (0.94 - wet * 0.66 - fine[i] * 0.12);
    rd[i * 4] = v; rd[i * 4 + 1] = v; rd[i * 4 + 2] = v; rd[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);

  return {
    map: canvasTexture(col, 1, 1, { srgb: true }),
    normalMap: canvasTexture(normalCanvas(normalField, size, 2.9), 1, 1),
    roughnessMap: canvasTexture(rough, 1, 1),
    puddleField: puddle,
  };
}

/* =========================================================================
   RUST — The Rust Shift wall / pole material
   ========================================================================= */
export function rustMaps(size = 512, seed = 71) {
  const base = fbmField(size, { seed, cells: 4, octaves: 6, gain: 0.55 });
  const flake = fbmField(size, { seed: seed + 7, cells: 24, octaves: 4, gain: 0.5 });
  const streak = fbmField(size, { seed: seed + 13, cells: 2, octaves: 4, gain: 0.5 });

  const col = canvas(size), ctx = col.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const n = base[i], f = flake[i];
    const rust = smoothstep(0.25, 0.62, n + f * 0.3);
    const r = (0.16 + rust * 0.38) * (0.8 + f * 0.45);
    const g = (0.10 + rust * 0.19) * (0.8 + f * 0.3);
    const b = (0.085 + rust * 0.10) * (0.8 + f * 0.2);
    const dark = smoothstep(0.62, 0.9, streak[i]) * 0.5;
    d[i * 4] = clamp01(r * (1 - dark)) * 255;
    d[i * 4 + 1] = clamp01(g * (1 - dark)) * 255;
    d[i * 4 + 2] = clamp01(b * (1 - dark)) * 255;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // vertical rust weeping
  const rnd = mulberry32(seed + 8);
  ctx.save();
  for (let i = 0; i < 90; i++) {
    const x = rnd() * size;
    const y0 = rnd() * size * 0.6;
    const len = size * (0.1 + rnd() * 0.55);
    const grad = ctx.createLinearGradient(0, y0, 0, y0 + len);
    grad.addColorStop(0, `rgba(70,32,14,${0.25 + rnd() * 0.35})`);
    grad.addColorStop(1, 'rgba(70,32,14,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y0, 1 + rnd() * 4, len);
  }
  ctx.restore();
  paintCracks(ctx, size, seed + 21, { count: 9, alpha: 0.28, width: 1.2, color: '25,12,6' });

  const normalField = new Float32Array(size * size);
  for (let i = 0; i < normalField.length; i++) normalField[i] = flake[i] * 0.7 + base[i] * 0.3;

  const metal = canvas(size), mctx = metal.getContext('2d');
  const mimg = mctx.createImageData(size, size), md = mimg.data;
  for (let i = 0; i < size * size; i++) {
    const v = 255 * (0.25 + (1 - smoothstep(0.3, 0.75, base[i])) * 0.6);
    md[i * 4] = v; md[i * 4 + 1] = v * 0.85; md[i * 4 + 2] = v * 0.7; md[i * 4 + 3] = 255;
  }
  mctx.putImageData(mimg, 0, 0);

  return {
    map: canvasTexture(col, 1, 1, { srgb: true }),
    normalMap: canvasTexture(normalCanvas(normalField, size, 3.4), 1, 1),
    metalnessMap: canvasTexture(metal, 1, 1),
  };
}

/* =========================================================================
   FABRIC / SKIN — small tiling detail maps
   ========================================================================= */
export function fabricMaps(size = 256, seed = 5, baseColor = [214, 208, 196]) {
  const weave = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const wx = Math.sin((x / size) * Math.PI * 2 * 96) * 0.5 + 0.5;
      const wy = Math.sin((y / size) * Math.PI * 2 * 96 + 1.2) * 0.5 + 0.5;
      weave[y * size + x] = wx * wy;
    }
  }
  const col = canvas(size), ctx = col.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = 0.88 + weave[i] * 0.12;
    d[i * 4] = baseColor[0] * v; d[i * 4 + 1] = baseColor[1] * v; d[i * 4 + 2] = baseColor[2] * v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainOverlay(ctx, size, seed + 2, 8);
  return {
    map: canvasTexture(col, 3, 3, { srgb: true }),
    normalMap: canvasTexture(normalCanvas(weave, size, 0.55), 3, 3),
  };
}

export function skinMaps(size = 256, seed = 9) {
  const pores = fbmField(size, { seed, cells: 48, octaves: 3, gain: 0.55 });
  const blotch = fbmField(size, { seed: seed + 6, cells: 8, octaves: 4, gain: 0.5 });
  const col = canvas(size), ctx = col.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = 0.9 + pores[i] * 0.08 - blotch[i] * 0.03;
    d[i * 4] = 198 * v; d[i * 4 + 1] = 184 * v; d[i * 4 + 2] = 178 * v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const normalField = new Float32Array(size * size);
  for (let i = 0; i < normalField.length; i++) normalField[i] = pores[i] * 0.75 + blotch[i] * 0.25;
  return {
    map: canvasTexture(col, 1, 1, { srgb: true }),
    normalMap: canvasTexture(normalCanvas(normalField, size, 1.8), 2, 2),
  };
}

export function hairMaps(size = 256, seed = 27) {
  const strands = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      strands[y * size + x] =
        Math.sin(u * Math.PI * 2 * 88 + Math.sin(v * 18) * 1.4) * 0.5 + 0.5;
    }
  }
  const col = canvas(size), ctx = col.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = 0.06 + strands[i] * 0.07;
    d[i * 4] = v * 255; d[i * 4 + 1] = v * 255; d[i * 4 + 2] = v * 275; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: canvasTexture(col, 2, 4, { srgb: true }),
    normalMap: canvasTexture(normalCanvas(strands, size, 1.2), 2, 4),
  };
}

/* =========================================================================
   MISSING PERSONS BOARD — painted canvas with embedded photographs
   ========================================================================= */
const boardState = { tex: null, canvas: null, ctx: null, images: {}, dirty: true };
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
export async function preloadPortraits() {
  const [s, a] = await Promise.all([loadImage(TEX.posterStudent), loadImage(TEX.posterSalaryman)]);
  boardState.images.student = s;
  boardState.images.adult = a;
  boardState.dirty = true;
}

export function createMissingBoardTexture() {
  const W = 1600, H = 1100;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  boardState.tex = tex; boardState.canvas = c; boardState.ctx = ctx;

  const SERIF = '"Yu Mincho","Hiragino Mincho ProN","Noto Serif JP",serif';
  const SANS = '"Helvetica Neue",Arial,"Hiragino Kaku Gothic ProN",sans-serif';

  function paper(x, y, w, h) {
    const g = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
    g.addColorStop(0, '#f7f3e9');
    g.addColorStop(0.55, '#efe9dc');
    g.addColorStop(1, '#ddd5c4');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    // fibre speckle
    ctx.save();
    ctx.globalAlpha = 0.10;
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = Math.random() > 0.5 ? '#7a6f5b' : '#ffffff';
      ctx.fillRect(x + Math.random() * w, y + Math.random() * h, 1, 1 + Math.random() * 3);
    }
    ctx.restore();
    // edge wear
    ctx.strokeStyle = 'rgba(90,80,62,.30)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }

  function photo(x, y, w, h, img) {
    ctx.save();
    ctx.fillStyle = '#e8e4da';
    ctx.fillRect(x - 8, y - 8, w + 16, h + 16);
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(x, y, w, h);
    if (img) {
      const s = Math.max(w / img.width, h / img.height);
      const iw = img.width * s, ih = img.height * s;
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      ctx.filter = 'grayscale(1) contrast(1.22) brightness(0.94)';
      ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) * 0.16, iw, ih);
      ctx.filter = 'none';
      // photocopy grain + vignette
      ctx.globalAlpha = 0.16;
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = Math.random() > 0.5 ? '#000' : '#fff';
        ctx.fillRect(x + Math.random() * w, y + Math.random() * h, 1.4, 1.4);
      }
      ctx.globalAlpha = 1;
      const v = ctx.createRadialGradient(x + w / 2, y + h * 0.42, w * 0.18, x + w / 2, y + h * 0.5, w * 0.78);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = v;
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  }

  function ribbon(cx, cy, text) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.135);
    const w = 268, h = 46;
    ctx.fillStyle = '#d51426';
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = 'rgba(120,8,16,.5)';
    ctx.fillRect(-w / 2, h / 2 - 5, w, 5);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 22px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 1);
    ctx.restore();
  }

  function rich(x, y, parts, size = 21, lineH = 30) {
    let cx = x;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const [txt, color] of parts) {
      ctx.font = `400 ${size}px ${SANS}`;
      ctx.fillStyle = color;
      ctx.fillText(txt, cx, y);
      cx += ctx.measureText(txt).width;
    }
    return cx;
  }

  /* word-wrapped copy where colour is decided by the FIRST word of a phrase,
     so a phrase never breaks across lines */
  function wrapRich(x, y, phrases, size, lineH, maxW, grey, red) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `400 ${size}px ${SANS}`;
    const spaceW = ctx.measureText(' ').width;
    const lines = [];
    let line = [], lw = 0;
    for (const p of phrases) {
      const [txt, col] = typeof p === 'string'
        ? [p, p.match(/^(22:40|23:15|No|Ability|Candy|Maigo|trap)/) ? red : grey]
        : p;
      const words = txt.split(' ');
      for (const w of words) {
        const ww = ctx.measureText(w).width;
        const add = (line.length ? spaceW : 0) + ww;
        if (line.length && lw + add > maxW) { lines.push(line); line = []; lw = 0; }
        if (line.length) line.push([' ', col]);
        line.push([w, col]);
        lw += (line.length > 1 ? spaceW : 0) + ww;
      }
    }
    if (line.length) lines.push(line);
    let ly = y;
    for (const ln of lines) {
      let lx = x;
      for (const [txt, col] of ln) {
        ctx.fillStyle = col;
        ctx.fillText(txt, lx, ly);
        lx += ctx.measureText(txt).width;
      }
      ly += lineH;
    }
  }

  function poster(x, y, w, h, d) {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(d.rot);
    ctx.translate(-(x + w / 2), -(y + h / 2));

    ctx.shadowColor = 'rgba(0,0,0,.75)';
    ctx.shadowBlur = 42;
    ctx.shadowOffsetY = 14;
    paper(x, y, w, h);
    ctx.shadowColor = 'transparent';

    const px = x + 32, py = y + 30, pw = w - 64, ph = Math.round(h * 0.60);
    photo(px, py, pw, ph, boardState.images[d.key]);

    // red corner ribbon over the photo edge
    ribbon(px + pw - 104, py + 14, d.tag);

    // name + role
    ctx.textAlign = 'left';
    ctx.fillStyle = '#111114';
    ctx.font = `700 ${d.nameSize}px ${SANS}`;
    const nameY = py + ph + 66;
    ctx.fillText(d.name, px, nameY);
    ctx.font = `700 ${d.nameSize}px ${SANS}`;
    ctx.fillText(d.role, px, nameY + d.nameSize * 1.16);

    // small print
    const bodyY = nameY + d.nameSize * 2.34;
    wrapRich(px, bodyY, d.body, d.bodySize, d.bodySize * 1.32, pw, '#23211c', '#c8101f');

    // torn bottom strip
    ctx.fillStyle = 'rgba(0,0,0,.05)';
    ctx.fillRect(x, y + h - 26, w, 26);
    ctx.fillStyle = '#cf1a2b';
    ctx.font = `700 15px ${SANS}`;
    ctx.fillText('迷子情報 ／ 042-771-0921', px, y + h - 9);

    ctx.restore();
  }

  function draw() {
    // ---- wall ----
    const bg = ctx.createLinearGradient(0, 0, W * 0.3, H);
    bg.addColorStop(0, '#16181d');
    bg.addColorStop(0.55, '#0e1014');
    bg.addColorStop(1, '#07080b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalAlpha = 0.16;
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      ctx.fillStyle = Math.random() > 0.5 ? '#2a2d35' : '#000';
      ctx.fillRect(x, y, 1 + Math.random() * 8, 1 + Math.random() * 2);
    }
    ctx.restore();
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * W;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(255,255,255,.03)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 1 + Math.random() * 4, H);
    }

    // ---- two posters, slightly askew ----
    poster(150, 78, 600, 936, {
      key: 'student', tag: 'JK-03 MISSING', rot: -0.010,
      name: '高橋 美咲 (17)', role: '- High School Student', nameSize: 46,
      bodySize: 25,
      body: ['Last seen:', '22:40,', '2-chome alley.', 'Wearing seifuku.', 'Ability: Candy pacifies Maigo.'],
    });
    poster(850, 92, 600, 936, {
      key: 'adult', tag: 'ADULT MISSING', rot: 0.013,
      name: '佐藤 健二 (34)', role: '- Adult Office Worker', nameSize: 46,
      bodySize: 25,
      body: ['Last seen:', '23:15.', 'No candy allowed — trap detection.', 'Must use psychological protocols.'],
    });

    // ---- corner screws ----
    ctx.save();
    for (const [sx, sy] of [[60, 60], [W - 60, 60], [60, H - 60], [W - 60, H - 60]]) {
      const g = ctx.createRadialGradient(sx - 4, sy - 4, 2, sx, sy, 15);
      g.addColorStop(0, '#6a6f79');
      g.addColorStop(1, '#181a1f');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.beginPath(); ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy); ctx.stroke();
    }
    ctx.restore();

    // ---- heavy vignette ----
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.92);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.46)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    if (boardState.tex) boardState.tex.needsUpdate = true;
  }

  draw();
  preloadPortraits().then(() => { draw(); if (tex) tex.needsUpdate = true; });
  return tex;
}

/* =========================================================================
   VENDING MACHINE — glowing drink display + brand panel
   ========================================================================= */
export function vendingFrontTexture(theme = 'blue') {
  const W = 512, H = 780;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const neon = theme === 'blue' ? ['#dff4ff', '#3fa9ff'] : ['#fff2ec', '#ff4a5d'];

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#eef9ff');
  bg.addColorStop(0.45, '#dceefb');
  bg.addColorStop(1, '#c8e2f3');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // top brand band
  const band = ctx.createLinearGradient(0, 0, W, 0);
  band.addColorStop(0, neon[1]);
  band.addColorStop(1, theme === 'blue' ? '#0a4a86' : '#8b0f1c');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, W, 96);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 34px "Helvetica Neue",Arial,sans-serif';
  ctx.letterSpacing = '6px';
  ctx.fillText(theme === 'blue' ? 'COOL DRINK' : 'DRINK MARKET', 22, 48);
  ctx.font = '18px "Hiragino Kaku Gothic ProN",sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  ctx.fillText('つめた〜い ／ ICE COLD', 222, 78);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = '700 20px monospace';
  ctx.fillText('100円', W - 88, 44);
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.fillRect(24, 102, W - 48, 3);

  // drink rows behind glass
  const cols = 5, rows = 4;
  const gw = (W - 76) / cols, gh = 118;
  const palette = ['#e63946', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#e67e22', '#16a085', '#ecf0f1', '#c0392b', '#2980b9'];
  let seed = theme === 'blue' ? 4 : 11;
  const rnd = mulberry32(seed);
  for (let r = 0; r < rows; r++) {
    for (let cI = 0; cI < cols; cI++) {
      const x = 38 + cI * gw, y = 126 + r * gh;
      // can
      const col = palette[(r * cols + cI) % palette.length];
      const canW = 52, canH = 84;
      const cx = x + (gw - canW) / 2;
      const grad = ctx.createLinearGradient(cx, 0, cx + canW, 0);
      grad.addColorStop(0, 'rgba(0,0,0,.35)');
      grad.addColorStop(0.22, col);
      grad.addColorStop(0.5, '#ffffff');
      grad.addColorStop(0.6, col);
      grad.addColorStop(1, 'rgba(0,0,0,.4)');
      ctx.fillStyle = grad;
      roundRect(ctx, cx, y + 14, canW, canH, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillRect(cx + 5, y + 44, canW - 10, 13);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.font = '8px monospace';
      ctx.fillText('COLD', cx + 13, y + 54);
      // price chip
      ctx.fillStyle = 'rgba(20,35,50,.82)';
      ctx.fillRect(cx + 4, y + canH + 20, 44, 15);
      ctx.fillStyle = '#9ff0ff';
      ctx.font = '9px monospace';
      ctx.fillText('¥130', cx + 12, y + canH + 31);
      // shelf light
      const shelf = ctx.createLinearGradient(0, y + gh - 14, 0, y + gh);
      shelf.addColorStop(0, 'rgba(140,220,255,0)');
      shelf.addColorStop(1, 'rgba(140,220,255,.55)');
      ctx.fillStyle = shelf;
      ctx.fillRect(x - 6, y + gh - 16, gw, 16);
    }
  }

  // right selection column
  ctx.fillStyle = 'rgba(10,25,40,.9)';
  ctx.fillRect(W - 34, 112, 30, 420);
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 3 === 0 ? '#ffd166' : 'rgba(160,230,255,.75)';
    roundRect(ctx, W - 30, 124 + i * 48, 14, 26, 3);
    ctx.fill();
  }

  // bottom intake mouth + glow
  const glow = ctx.createRadialGradient(W / 2, H - 70, 10, W / 2, H - 70, 220);
  glow.addColorStop(0, 'rgba(140,210,255,.7)');
  glow.addColorStop(1, 'rgba(140,210,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, H - 260, W, 260);
  ctx.fillStyle = '#0c1620';
  roundRect(ctx, 70, H - 108, W - 140, 58, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(160,230,255,.6)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = '13px "Hiragino Kaku Gothic ProN",sans-serif';
  ctx.fillText('おつり ／ つり銭', 84, H - 30);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

/* =========================================================================
   NEON / SIGNAGE
   ========================================================================= */
export function neonSignTexture(text = 'コンビニ', sub = '24H', color = '#ff2f6d', color2 = '#8ff4ff') {
  const W = 512, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#050409';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = 6;
  ctx.strokeRect(14, 14, W - 28, H - 28);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 42;
  ctx.fillStyle = color;
  ctx.font = '700 150px "Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
  const chars = [...text];
  chars.forEach((ch, i) => {
    ctx.fillText(ch, W / 2, 130 + i * 168);
  });
  ctx.shadowBlur = 26;
  ctx.shadowColor = color2;
  ctx.fillStyle = color2;
  ctx.font = '700 92px monospace';
  ctx.fillText(sub, W / 2, H - 150);
  ctx.restore();

  // tube borders
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 24;
  ctx.lineWidth = 5;
  ctx.strokeRect(36, 36, W - 72, H - 72);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function windowTexture(seed = 3, cols = 10, rows = 14) {
  const S = 512;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, S, S);
  const rnd = mulberry32(seed);
  const cw = S / cols, ch = S / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const lit = rnd();
      if (lit > 0.72) {
        const warm = rnd() > 0.22;
        const a = 0.28 + rnd() * 0.6;
        ctx.fillStyle = warm ? `rgba(255,196,120,${a})` : `rgba(160,205,255,${a * 0.7})`;
        ctx.fillRect(x * cw + cw * 0.16, y * ch + ch * 0.2, cw * 0.68, ch * 0.5);
        if (rnd() > 0.55) {
          ctx.fillStyle = 'rgba(0,0,0,.5)';
          ctx.fillRect(x * cw + cw * 0.16, y * ch + ch * 0.2, cw * 0.68, ch * 0.16);
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

export function shutterTexture() {
  const W = 256, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2a2d33');
  g.addColorStop(0.5, '#171a1f');
  g.addColorStop(1, '#25282e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 8) {
    const lg = ctx.createLinearGradient(0, y, 0, y + 8);
    lg.addColorStop(0, 'rgba(255,255,255,.10)');
    lg.addColorStop(0.45, 'rgba(255,255,255,.015)');
    lg.addColorStop(1, 'rgba(0,0,0,.42)');
    ctx.fillStyle = lg;
    ctx.fillRect(0, y, W, 8);
  }
  // graffiti / grime
  const rnd = mulberry32(44);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(70,30,17,${0.04 + rnd() * 0.12})`;
    ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 26, 2 + rnd() * 12);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function glowSpriteTexture(inner = 'rgba(255,214,160,1)', outer = 'rgba(255,160,60,0)') {
  const S = 128;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.25, inner.replace(/[\d.]+\)$/, '0.55)'));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function fogSheetTexture(color = '255,170,200') {
  const S = 256;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const field = fbmField(S, { seed: 91, cells: 3, octaves: 5 });
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) {
    const a = smoothstep(0.35, 0.8, field[i]);
    d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255;
    d[i * 4 + 3] = a * 190;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* =========================================================================
   BLOUSE / SKIRT / POSTER-ADJACENT custom albedo with blood decals
   ========================================================================= */
export function uniformTexture({ base = '#c9c6bd', blood = 0.7, seed = 41, navy = false } = {}) {
  const S = 512;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S);
  const rnd = mulberry32(seed);
  // fabric shading
  for (let i = 0; i < 2400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.045})`;
    ctx.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  if (navy) {
    // white piping at hem
    ctx.fillStyle = 'rgba(234,230,220,.85)';
    ctx.fillRect(0, S - 26, S, 4);
    ctx.fillRect(0, S - 17, S, 2);
  }
  // blood splatter
  const spots = 7 + Math.round(blood * 9);
  for (let i = 0; i < spots; i++) {
    const x = rnd() * S, y = rnd() * S;
    const r = S * (0.012 + rnd() * 0.05);
    const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
    g.addColorStop(0, `rgba(74,4,9,${0.85 * blood})`);
    g.addColorStop(0.55, `rgba(104,6,12,${0.7 * blood})`);
    g.addColorStop(1, 'rgba(60,3,8,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r * (0.6 + rnd() * 0.9), r, rnd() * 6.28, 0, 6.28);
    ctx.fill();
    // droplets
    for (let k = 0; k < 5; k++) {
      ctx.fillStyle = `rgba(70,4,9,${0.5 * blood})`;
      ctx.beginPath();
      ctx.arc(x + (rnd() - 0.5) * r * 2.4, y + (rnd() - 0.5) * r * 2.4, 1 + rnd() * 3.2, 0, 6.28);
      ctx.fill();
    }
  }
  // drips
  for (let i = 0; i < 4; i++) {
    const x = rnd() * S, y = rnd() * S * 0.6;
    const h = S * (0.05 + rnd() * 0.25);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, `rgba(80,5,10,${0.55 * blood})`);
    g.addColorStop(1, 'rgba(80,5,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 2 + rnd() * 4, h);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
