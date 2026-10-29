/* ============================================================================
   surfaces.js — photographic surfaces

   The alley's materials used to be pure canvas noise, which is why the walls
   read as a photo of a TV tuned to static: no aggregate, no mortar, no scale.
   Every surface in here is now a real scanned PBR set (ambientCG, CC0) with
   the grime baked back in on top:

     · three JPEGs per set — colour, OpenGL normal, roughness
     · a composite pass that adds rain streaking, splash-back at the bottom of
       the wall, moss in the joints, and a wet sheen gradient
     · correct colour space and anisotropy, plus a mip-friendly power-of-two

   Loaded once, in parallel, with a hard timeout: if a file is missing the
   caller falls back to the old procedural map and nothing breaks.
   ========================================================================== */

import * as THREE from 'three';

const BASE = './assets/tex/';

const _loader = new THREE.TextureLoader();
const _cache = new Map();

function loadImage(url) {
  return new Promise((resolve) => {
    _loader.load(
      url,
      (tex) => resolve(tex.image),
      undefined,
      () => resolve(null),
    );
  });
}

/** wrap an Image in a colour or data texture with sane filtering */
function tex(image, { srgb = false, repeat = [1, 1] } = {}) {
  const t = new THREE.Texture(image);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  /* the alley is seen at a grazing angle for its whole length: 16-tap
     anisotropy is what keeps the road grain from smearing into a blur */
  t.anisotropy = 16;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* --------------------------------------------------------------------------
   composite: take a tileable colour image and weather it.

   `opts.streaks`  vertical rain streaks that fade toward the top
   `opts.splash`   darker, damp band along the bottom edge
   `opts.moss`     green-black bloom in the low joints
   `opts.wet`      vertical sheen gradient (0 = dry)
   -------------------------------------------------------------------------- */
function weather(img, size, seed, opts = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0, size, size);

  let a = seed >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // --- rain streaks: thin vertical washes that thin out toward the top ----
  const streaks = opts.streaks ?? 26;
  g.save();
  for (let i = 0; i < streaks; i++) {
    const x = rnd() * size;
    const w = size * (0.004 + rnd() * 0.02);
    const top = size * rnd() * 0.45;
    const len = size - top;
    const grad = g.createLinearGradient(0, top, 0, top + len);
    const dark = rnd() < 0.7;
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.35, dark ? 'rgba(12,12,10,0.11)' : 'rgba(210,205,190,0.05)');
    grad.addColorStop(1, dark ? 'rgba(8,8,7,0.24)' : 'rgba(190,185,170,0.07)');
    g.fillStyle = grad;
    g.fillRect(x, top, w, len);
  }
  g.restore();

  // --- splash-back: the bottom of every wall in a wet alley is filthy ----
  if (opts.splash) {
    const h = size * 0.34;
    const grad = g.createLinearGradient(0, size, 0, size - h);
    grad.addColorStop(0, 'rgba(9,10,9,0.62)');
    grad.addColorStop(0.35, 'rgba(11,12,10,0.33)');
    grad.addColorStop(1, 'rgba(12,13,11,0)');
    g.fillStyle = grad;
    g.fillRect(0, size - h, size, h);
    // flecks of thrown grit along the very bottom
    for (let i = 0; i < 260; i++) {
      const x = rnd() * size;
      const y = size - Math.pow(rnd(), 2.1) * h * 0.8;
      const r = size * (0.0006 + rnd() * 0.0026);
      g.fillStyle = `rgba(${rnd() < 0.5 ? '6,6,5' : '26,25,22'},${0.16 + rnd() * 0.3})`;
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
  }

  // --- moss / algae bloom, concentrated low and in shadowed patches -------
  if (opts.moss) {
    for (let i = 0; i < 40; i++) {
      const x = rnd() * size;
      const y = size * (0.62 + rnd() * 0.38);
      const r = size * (0.012 + rnd() * 0.055);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(38,52,30,${0.10 + rnd() * 0.16})`);
      grd.addColorStop(1, 'rgba(38,52,30,0)');
      g.fillStyle = grd;
      g.beginPath(); g.ellipse(x, y, r, r * 0.72, rnd() * 3, 0, 6.283); g.fill();
    }
  }

  // --- damp sheen: colder, slightly bluer, as it gets lower ---------------
  if (opts.wet) {
    g.save();
    g.globalCompositeOperation = 'multiply';
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, `rgba(255,255,255,1)`);
    grad.addColorStop(0.55, `rgba(226,232,244,1)`);
    grad.addColorStop(1, `rgba(${255 - opts.wet * 46 | 0},${255 - opts.wet * 34 | 0},${255 - opts.wet * 12 | 0},1)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    g.restore();
  }

  return cv;
}

/* --------------------------------------------------------------------------
   one photographic set → three.js maps
   -------------------------------------------------------------------------- */
async function loadSet(name, { size = 1024, repeat = [1, 1], weather: wopts = null, srgbColor = true } = {}) {
  const [col, nrm, rgh] = await Promise.all([
    loadImage(`${BASE}${name}_col.jpg`),
    loadImage(`${BASE}${name}_nrm.png`),   // lossless: JPEG blocking shows as a grid
    loadImage(`${BASE}${name}_rgh.jpg`),
  ]);
  if (!col) return null;

  const colorSrc = wopts ? weather(col, size, wopts.seed || 7, wopts) : col;

  const out = {
    map: tex(colorSrc, { srgb: srgbColor, repeat }),
    normalMap: nrm ? tex(nrm, { repeat }) : null,   // NoColorSpace, lossless
    roughnessMap: rgh ? tex(rgh, { repeat }) : null,
  };
  return out;
}

/* --------------------------------------------------------------------------
   THE SET — everything the alley needs, in the order it is drawn
   -------------------------------------------------------------------------- */
export const SURFACES = {
  ready: false,
  wall: null,      // plastered concrete, upper storey
  dado: null,      // the brick/stone band along the foot of the wall
  end: null,       // the dead-end wall behind the board
  road: null,      // wet asphalt
  metal: null,     // corrugated shutter steel
  brick: null,     // bare brick, for new/repaired patches
};

let _pending = null;

export function loadSurfaces(timeoutMs = 12000) {
  if (_pending) return _pending;
  const work = (async () => {
    const [wall, dado, end, road, metal, brick] = await Promise.all([
      // 2.4 m of texture per tile: mortar and aggregate read at human scale
      loadSet('wall_plaster', { size: 1024, repeat: [1, 1], weather: { seed: 11, streaks: 30, splash: true, moss: true, wet: 0.5 } }),
      loadSet('wall_brick', { size: 1024, repeat: [1, 1], weather: { seed: 23, streaks: 12, splash: true, moss: true, wet: 0.35 } }),
      loadSet('wall_concrete', { size: 1024, repeat: [1, 1], weather: { seed: 31, streaks: 34, splash: true, wet: 0.6 } }),
      loadSet('road', { size: 1024, repeat: [1, 1], weather: { seed: 47, streaks: 6, wet: 0.25 } }),
      loadSet('shutter_metal', { size: 512, repeat: [1, 1], weather: { seed: 59, streaks: 18, splash: true } }),
      loadSet('wall_brick', { size: 512, repeat: [1, 1], weather: { seed: 67, streaks: 8, splash: true, moss: true } }),
    ]);
    SURFACES.wall = wall;
    SURFACES.dado = dado;
    SURFACES.end = end;
    SURFACES.road = road;
    SURFACES.metal = metal;
    SURFACES.brick = brick;
    SURFACES.ready = !!(wall && road);
    return SURFACES.ready;
  })();
  _pending = Promise.race([
    work,
    new Promise((res) => setTimeout(() => res(false), timeoutMs)),
  ]);
  return _pending;
}

/** clone a map with a different tiling (each mesh needs its own repeat) */
export function retile(map, rx, ry, { offsetX = 0, offsetY = 0 } = {}) {
  if (!map) return null;
  const t = map.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.offset.set(offsetX, offsetY);
  t.needsUpdate = true;
  return t;
}

export default { SURFACES, loadSurfaces, retile };
