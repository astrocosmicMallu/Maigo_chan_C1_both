/* ============================================================================
   world.js — Three.js stage, cinematic shading pipeline and the alley itself.
   ----------------------------------------------------------------------------
   • ACES Filmic tone mapping, exposure 0.70, PCF soft shadows
   • Custom EffectComposer chain: Render → ACES Output → Horror grade pass
     (organic ISO grain that clusters in shadow, chromatic aberration, vignette)
   • Every wall / prop is built from procedural displaced geometry — no
     BoxGeometry, CylinderGeometry or SphereGeometry is used for any asset.
   • GLTF streaming hooks (MODEL_URLS) with a material override engine.
   ========================================================================== */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import {
  concreteMaps, asphaltMaps, rustMaps, fabricMaps, shutterTexture,
  createMissingBoardTexture, vendingFrontTexture, neonSignTexture, windowTexture, DIFFICULTY_ART,
  difficultyTagTexture,
  glowSpriteTexture, fogSheetTexture, mulberry32, fbmField,
} from './textures.js?v=b89';
import {
  extrudedSlab, loftGeometry, tubeGeometry, blobGeometry, displacedPlaneGeometry,
  roundedRectShape,
} from './geo.js?v=b89';
import { makeCandy, makeCloth } from './items.js?v=b89';
import { loadSurfaces, SURFACES, retile } from './surfaces.js?v=b89';

/* ---------------------------------------------------------------------------
   STREAMING SLOTS — inject your hosted .glb URLs here.
   Leave empty to run the fully procedural fallback (shipped, tested, 60 fps).
   ------------------------------------------------------------------------- */
export const MODEL_URLS = {
  // same VRM as before, re-encoded: the 2048px normal map, the 2048px body
  // map and the 1.19 MB embedded thumbnail were the bulk of the 10.3 MB, and
  // none of them are read at arm's length in the dark. 10.3 -> 5.3 MB, and
  // 2.0 MB over the wire with gzip. The untouched original stays beside it.
  maigo: 'assets/maigo-lite.vrm',       // humanoid avatar (see assets/VRM-LICENSE.txt)
  maigoFull: 'assets/maigo.vrm',        // second attempt if the lite file fails
  concreteWall: '',     // photogrammetry concrete panel / wall module
  utilityPole: '',      // rusted Japanese utility pole
  vendingMachine: '',   // beverage vending machine
};
// alias kept for readability in engine code
export const ASSET_URLS = MODEL_URLS;

/* ============================================================================
   Horror grade shader (applied after ACES, in display space)
   ========================================================================== */
const HorrorShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uGrain: { value: 0.05 },
    uAberration: { value: 0.0019 },
    uVignette: { value: 0.8 },
    uRed: { value: 0.0 },
    uDesat: { value: 0.1 },
    uPulse: { value: 0.0 },
    uFade: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uAberration, uVignette, uRed, uDesat, uPulse, uFade;
    uniform vec2 uResolution;
    varying vec2 vUv;

    /* Hoskins-style hash: the previous hash left a visible 7 px lattice in
       the shadows, which read as TV static over every wall. This one is
       decorrelated per pixel, so the grain looks like film, not a screen. */
    float hash21(vec2 p){
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      /* --- radial chromatic aberration (wide-angle eye feel) --- */
      vec2 dir = normalize(c + vec2(1e-6));
      float ca = uAberration * (0.25 + r2 * 2.2);
      vec3 col;
      col.r = texture2D(tDiffuse, uv - dir * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + dir * ca).b;

      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));

      /* --- organic ISO grain : 24 fps stepped, clustered in darkness --- */
      float frame = floor(uTime * 24.0);
      vec2 px = uv * uResolution;
      float fine   = hash21(px + vec2(frame * 13.71, frame * 7.13));
      float coarse = hash21(floor(px * 0.5) + vec2(frame * 3.19, frame * 5.77));
      float blotch = hash21(floor(px * 0.143) + vec2(frame * 1.37, frame * 2.11));
      float grain = (fine - 0.5) * 0.52 + (coarse - 0.5) * 0.46 + (blotch - 0.5) * 0.26;
      float shadowClump = smoothstep(0.55, 0.015, lum);
      float gAmt = uGrain * mix(0.30, 1.0, shadowClump);
      col += grain * gAmt * vec3(0.95, 0.98, 1.06);
      /* slight grain-driven distortion inside deep shadow */
      col.r += (hash21(px * 1.7 + vec2(frame * 1.9, frame * 1.3)) - 0.5) * shadowClump * 0.012;

      /* --- heavy claustrophobic vignette --- */
      float vig = smoothstep(0.96, 0.24, length(c) * 1.22);
      col *= mix(1.0, vig, uVignette);
      /* red pressure ring */
      col.r += r2 * uPulse * 0.55;
      col.g *= 1.0 - r2 * uPulse * 0.35;

      /* --- grade : desaturate cold shadows toward indigo --- */
      float grey = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(grey) * vec3(0.78, 0.86, 1.12), uDesat);
      col = pow(max(col, 0.0), vec3(1.02, 1.0, 0.985));

      /* --- blood wash for damage / forbidden action --- */
      if (uRed > 0.001) {
        vec3 blood = vec3(lum * 1.55 + 0.10, lum * 0.055, lum * 0.075);
        col = mix(col, blood, clamp(uRed, 0.0, 1.0));
      }

      /* --- two floating dust specks + horizontal gate weave --- */
      vec2 weave = vec2(sin(uTime * 7.3) * 0.00035, cos(uTime * 5.1) * 0.0004);
      col = texture2D(tDiffuse, uv + weave * 0.4).rgb * 0.08 + col * 0.92;
      col = max(col, vec3(0.004, 0.005, 0.011));
      col *= (1.0 - uFade);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* ---------------------------------------------------------------------------
   small helpers
   ------------------------------------------------------------------------- */

/* ============================================================================
   PUDDLE RIPPLES — GPU water displacement

   The sheet is a 26×26 grid lying in XZ, so `position.xz` is the water surface
   and local +Y is the world up axis. A footfall drops a ring at a point; the
   vertex stage integrates three rings per sheet and writes both the displaced
   height and an analytically derived normal, so the specular highlight rolls
   outward with the wave instead of staying pinned to the flat plane.

   Everything is in the sheet's own unrotated metric frame: JS converts the
   world-space footfall into (local x, local z) once, when the boot lands.
   Three vec4 uniforms are the entire per-frame CPU cost, and they are only
   written on a footfall — the shader animates from `uTime` alone.
   ========================================================================== */
const RIPPLE_HEAD = `
uniform float uRipT;
uniform vec4 uRip[3];
uniform vec2 uRipScale;
uniform float uRain;          // 0 = dry (Amateur), 1 = it is raining
varying float vRipLift;

/* one cheap hash: it only has to look random, never be reproducible */
float maigoHash(float n) { return fract(sin(n * 127.1) * 43758.5453123); }
`;

/* Runs straight after <beginnormal_vertex>, which is the last moment the
   object-space normal can still influence the shading normal — it is consumed
   by <defaultnormal_vertex> a few lines later. The height is stashed in a
   local so <begin_vertex> can lift the vertex by exactly the same amount. */
const RIPPLE_CALC = `
  vec2 ripP = position.xz * uRipScale;
  float ripLift = 0.0;
  vec2 ripGrad = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    vec4 r = uRip[i];
    if (r.w <= 0.001) continue;
    float age = uRipT - r.z;
    if (age < 0.0 || age > 2.6) continue;
    vec2 d2 = ripP - r.xy;
    float d = length(d2);
    if (d < 0.0001) continue;

    /* A body in the water throws a ring that keeps growing with the weight
       of the step: r.w is 0.55 for a walking player and 1.35 for her. */
    float radius = age * (0.78 + 0.42 * r.w) + 0.06;
    float q = (d - radius) / 0.20;
    float env = exp(-q * q);
    float decay = exp(-age * 1.30) * r.w;
    float k = 6.2831853 / 0.30;
    float phase = k * (d - radius);

    ripLift += env * sin(phase) * decay * 0.055;
    float dwave = decay * env * (cos(phase) * k - sin(phase) * (2.0 * q / 0.20));
    ripGrad += (d2 / d) * (dwave * 0.055);
  }
  /* --- rain on the water ------------------------------------------------
     Every sheet carries seven independent drop cells. Each one owns its own
     clock, so a drop lands, rings out over ~half a second and the next one
     is already falling somewhere else. Nothing here touches the CPU: the
     whole field is a function of uRipT, and uRain simply switches it off in
     Amateur, where there is no rain at all. The rings are deliberately
     small — 30 cm at their widest — so a footstep still reads as the big
     event in the water. */
  if (uRain > 0.001) {
    for (int i = 0; i < 10; i++) {
      float fi = float(i);
      float life = 0.55 + 0.35 * maigoHash(fi * 3.71 + 0.31);
      float tt = uRipT / life + maigoHash(fi * 7.13 + 1.77) * 13.0;
      float cyc = floor(tt);
      float ph = fract(tt);
      vec2 seed = vec2(maigoHash(fi * 1.31 + cyc * 3.17), maigoHash(fi * 5.77 + cyc * 7.31));
      vec2 c = (seed - 0.5) * uRipScale * 0.86;
      float age = ph * life;
      float rad = age * 0.46 + 0.012;          // ~32 cm at its widest
      vec2 dd = ripP - c;
      float d = length(dd) + 0.0001;
      float q = (d - rad) / 0.075;
      float env = exp(-q * q);
      float dec = (1.0 - ph) * (1.0 - ph) * uRain;
      float kk = 6.2831853 / 0.090;
      float phs = kk * (d - rad);
      ripLift += env * sin(phs) * dec * 0.0450;
      float dw = dec * env * (cos(phs) * kk - sin(phs) * (2.0 * q / 0.075));
      ripGrad += (dd / d) * (dw * 0.0450);
    }
  }

  objectNormal = normalize(vec3(-ripGrad.x, 1.0, -ripGrad.y));
  vRipLift = ripLift;
`;

const RIPPLE_APPLY = `
  transformed.y += ripLift;
`;

/* wrap one material in the ripple stage; returns its uniform bundle */
function makeRippleMaterial(mat, sx, sz) {
  const u = {
    uRipT: { value: 0 },
    uRip: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uRipScale: { value: new THREE.Vector2(sx, sz) },
    uRain: { value: 1 },
  };
  mat.onBeforeCompile = (shader) => {
    // if this build of three does not expose the hooks we patch, leave the
    // material exactly as it was: a clean puddle beats a broken shader
    if (!shader.vertexShader.includes('#include <beginnormal_vertex>') ||
        !shader.vertexShader.includes('#include <begin_vertex>')) return;
    Object.assign(shader.uniforms, u);
    shader.vertexShader = RIPPLE_HEAD + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n' + RIPPLE_CALC
    ).replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + RIPPLE_APPLY
    );

    /* A mirror in a black alley shows nothing, so the wave also catches light
       it should not: the crests of each ring pick up a thin cold glint. That
       is what makes a ripple readable in the middle of a dark puddle. */
    if (shader.fragmentShader.includes('#include <emissivemap_fragment>')) {
      shader.fragmentShader = 'varying float vRipLift;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' +
        'totalEmissiveRadiance += vec3(0.40, 0.55, 0.72) * clamp(abs(vRipLift) * 26.0, 0.0, 1.0) * 0.55;'
      );
    }
  };
  mat.customProgramCacheKey = () => 'puddleRipple';
  mat.needsUpdate = true;
  return u;
}

const PUDDLE_SPACING = 45;   // metres between splashable fields
const PUDDLE_FIRST = 6;      // the first field, just past the board
// where the alley opens out. 45 m apart, so the pattern survives the 90 m wrap.
const ECHO_ZONES = [-12, -57, -102];
const ECHO_SPREAD = 7.5;

function cloneTex(tex, rx, ry) {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

function streakTexture(color = '255,196,120') {
  const W = 64, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `rgba(${color},0)`);
  g.addColorStop(0.3, `rgba(${color},.55)`);
  g.addColorStop(0.5, `rgba(${color},.9)`);
  g.addColorStop(0.8, `rgba(${color},.3)`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const h = ctx.createLinearGradient(0, 0, W, 0);
  h.addColorStop(0, 'rgba(0,0,0,1)');
  h.addColorStop(0.42, 'rgba(0,0,0,0)');
  h.addColorStop(0.58, 'rgba(0,0,0,0)');
  h.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function puddleAlphaTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const field = fbmField(S, { seed: 303, cells: 2, octaves: 5, gain: 0.6 });
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x / S - 0.5) * 2, dy = (y / S - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      const edge = 1 - THREE.MathUtils.smoothstep(r, 0.55, 0.98);
      const n = field[y * S + x];
      const a = Math.max(0, edge * (0.55 + n * 0.8) - 0.18);
      const i = (y * S + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function rippleNormalTexture() {
  const S = 256;
  const field = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      let h = 0;
      for (let k = 0; k < 5; k++) {
        const fx = 3 + k * 4, fy = 2 + k * 3;
        h += Math.sin(u * Math.PI * 2 * fx + k) * Math.cos(v * Math.PI * 2 * fy - k * 2) * (1 / (k + 1));
      }
      field[y * S + x] = h * 0.5 + 0.5;
    }
  }
  // local import to avoid circular; rebuild via canvas inline
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const at = (x, y) => field[(((y % S) + S) % S) * S + (((x % S) + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 1.6;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 1.6;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function equirectEnvironment(renderer) {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#050710');
  sky.addColorStop(0.46, '#0b1020');
  sky.addColorStop(0.55, '#202a44');
  sky.addColorStop(0.62, '#0a0c14');
  sky.addColorStop(1, '#05050a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // hazy city glow + sodium lamps reflected into the wet street
  const blobs = [
    [140, 300, 190, 'rgba(255,178,96,.16)'],
    [520, 320, 130, 'rgba(150,190,255,.10)'],
    [760, 300, 220, 'rgba(255,120,140,.07)'],
    [940, 340, 160, 'rgba(255,206,140,.12)'],
  ];
  for (const [x, y, r, color] of blobs) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

/* ============================================================================
   WORLD
   ============================================================================ */
export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04050b);
    this.scene.fog = new THREE.FogExp2(0x141827, 0.052); // spec: heavy exponential fog

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.05, 220);
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(0, 1.9, 9.0);

    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false,
    });
    /* Never ask the driver "did this link?" after every program.
       `checkShaderErrors` makes three call getProgramParameter(LINK_STATUS)
       the moment a program is first used. On a real driver that is a hard
       pipeline stall — D3D/ANGLE finishes translating the shader before the
       call returns — and the bill lands on whichever frame first draws the
       new material, which is the moment Maigo-chan appears. Nothing is lost:
       a genuinely broken shader still draws nothing, and the compile counter
       below catches it. */
    renderer.debug.checkShaderErrors = false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;       // forced cinematic curve
    renderer.toneMappingExposure = 0.70;                      // crushed charcoal blacks
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    /* any material in the project that fails to compile is counted here. The
       blood pass watches this counter for its first few frames and puts the
       pristine uniform back if it ever ticks. */
    window.__shaderErrs = 0;
    renderer.debug = renderer.debug || {};
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      window.__shaderErrs++;
      if (window.console && console.warn) {
        console.warn('[shader] ' +
          (gl.getShaderInfoLog(vs) || '') + (gl.getShaderInfoLog(fs) || ''));
      }
    };
    this.renderer = renderer;

    // --- adaptive quality: software rasterisers get a lighter, still-ACES build
    const params = new URLSearchParams(location.search);
    const q = params.get('quality');
    let gpuName = '';
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    } catch (e) { /* ignore */ }
    this.gpuName = gpuName;
    this.software = /swiftshader|llvmpipe|software|basic render|mesa offscreen|subzero/i.test(gpuName);
    // a software rasteriser cannot afford the 'low' path either (env map + 480 rain)
    this.minQuality = q === 'min' || (q !== 'high' && q !== 'low' && this.software);
    this.lowQuality = this.minQuality || q === 'low' || (q !== 'high' && this.software);
    this.baseLowQuality = this.lowQuality;
    this.shadowEveryLamp = 2;
    if (this.lowQuality) {
      renderer.setPixelRatio(this.minQuality ? 0.5 : 0.72);
      renderer.shadowMap.enabled = false;
      this.rainCount = this.minQuality ? 0 : 1100;
    }
    if (this.minQuality) {
      this.scene.environment = null;
    }

    this.scene.environment = this.minQuality ? null : equirectEnvironment(renderer);
    this.scene.environmentIntensity = 0.55;

    /* ---------------- post chain ---------------- */
    /* 4x MSAA costs nothing on a desktop GPU and cleans up every handrail,
       window frame and rain streak in the alley. Touch-class hardware keeps
       the cheaper 2x path, and the software path stays off. */
    const coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
      type: THREE.HalfFloatType,
      samples: (this.lowQuality || this.software) ? 0 : (coarsePointer ? 2 : 4),
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new OutputPass());                  // ACES + sRGB
    this.horrorPass = new ShaderPass(HorrorShader);
    this.horrorPass.renderToScreen = true;
    this.composer.addPass(this.horrorPass);
    this.post = this.horrorPass.uniforms;

    /* ---------------- state ---------------- */
    this.t = 0;
    this.clockOffset = Math.random() * 100;
    this.flashlightOn = true;
    this.prewarming = false;      // the frame loop holds its last frame while true
    this.fogAmount = 0;
    this.rustTarget = 0;
    this.rustAmount = 0;
    /* The drops are pushed entirely on the GPU now, so the CPU cost of a
       heavier fall is zero and the density is a pure look decision. */
    if (this.rainCount === undefined) this.rainCount = 2600;
    this.dread = 0;
    this.interactables = [];
    this.vending = [];
    this._vendingCandies = [];
    this.raycaster = new THREE.Raycaster();
    this._tmpV = new THREE.Vector3();
    this.assetsLoaded = { wall: false, pole: false, vending: false };
    this._rustSignals = [];
    this._puddleMats = [];
    this._disposables = [];
  }

  /* ------------------------------------------------------------------ */
  async build(onProgress = () => {}) {
    onProgress(0.08, 'POURING CONCRETE');
    await new Promise((r) => setTimeout(r, 30));

    /* Photography first: the scanned sets are what make the walls read as a
       real alley instead of noise. They are ~2.4 MB of JPEG and load in
       parallel; a missing file simply leaves the procedural maps in place. */
    try { await loadSurfaces(this.minQuality ? 7000 : 12000); } catch (e) { /* procedural */ }
    onProgress(0.16, SURFACES.ready ? 'KILN-DRYING PLASTER' : 'POURING CONCRETE');

    this.createMaterials();
    onProgress(0.26, 'FLOODING THE STREET');
    await new Promise((r) => setTimeout(r, 20));

    this.createLights();
    if (this.lowQuality) this.thinLighting();
    this.buildGround();
    this.buildWalls();
    this.buildFacades();
    this.buildBoard();
    this.buildDifficultyTags();
    this.buildPole();
    this.buildVending(-15.5, 'blue');
    this.buildVending(-62, 'red');
    this.buildBlanket();
    this.buildStreetProps();
    this.buildDistantCity();
    this.buildAtmosphere();
    this.buildNeonDoor();
    this.buildMaigoLight();
    this.buildFlashlight();

    /* Everything above is scenery that never moves. Batching it by material
       in 24 m slices of the alley collapses ~430 draw calls into a fraction
       of that, while each slice still frustum-culls as one piece. Anything
       the game animates, toggles or lights is left exactly where it is. */
    this.batchStatic();

    onProgress(0.58, 'STREAMING GLTF ASSETS');
    await this.streamAssets();

    onProgress(0.94, 'DEVELOPING FILM GRAIN');
    await new Promise((r) => setTimeout(r, 20));
    onProgress(1, 'READY');
  }

  /* ==================================================================
     MATERIALS
     ================================================================== */
  createMaterials() {
    const concrete = concreteMaps(512, 7);
    this.wallTex = concrete;
    this.wallMat = new THREE.MeshStandardMaterial({
      map: cloneTex(concrete.map, 26, 2.2),
      normalMap: cloneTex(concrete.normalMap, 26, 2.2),
      roughnessMap: cloneTex(concrete.roughnessMap, 26, 2.2),
      color: 0xb6b8c4,
      roughness: 0.9,
      metalness: 0.03,
      normalScale: new THREE.Vector2(0.85, 0.85),
      envMapIntensity: 0.4,
    });
    this.wallMatDark = this.wallMat.clone();
    this.wallMatDark.color = new THREE.Color(0x7d7f8c);

    /* ---- photographic rebuild -------------------------------------------
       The walls are 224 m long and 5.6 m high, so the tiling is chosen per
       surface rather than per texture: 2.4 m of wall per tile reads as real
       mortar and aggregate at arm's length and still holds up at 30 m. */
    const S = SURFACES;
    if (S.ready) {
      const WT = [224 / 2.5, 5.6 / 2.5];        // 2.5 m: exactly 36 tiles per 90 m loop
      this.wallMat.map = retile(S.wall.map, WT[0], WT[1]);
      this.wallMat.normalMap = retile(S.wall.normalMap, WT[0], WT[1]);
      this.wallMat.roughnessMap = retile(S.wall.roughnessMap, WT[0], WT[1]);
      this.wallMat.color = new THREE.Color(0xa9a49a);   // the photo already has the colour
      this.wallMat.roughness = 0.94;
      this.wallMat.normalScale = new THREE.Vector2(1.15, 1.15);
      this.wallMat.envMapIntensity = 0.45;
      this.wallMat.needsUpdate = true;

      // the band along the foot of the wall: brick, 1.7 m per tile
      this.dadoMat = new THREE.MeshStandardMaterial({
        map: retile(S.dado.map, 224 / 1.8, 1.25 / 1.8),
        normalMap: retile(S.dado.normalMap, 224 / 1.8, 1.25 / 1.8),
        roughnessMap: retile(S.dado.roughnessMap, 224 / 1.8, 1.25 / 1.8),
        color: 0x8f8a80,
        roughness: 0.92,
        metalness: 0.02,
        normalScale: new THREE.Vector2(1.35, 1.35),
        envMapIntensity: 0.5,
      });

      // the dead-end wall
      this.wallMatDark.map = retile(S.end.map, 5.2 / 2.2, 5.6 / 2.2);
      this.wallMatDark.normalMap = retile(S.end.normalMap, 5.2 / 2.2, 5.6 / 2.2);
      this.wallMatDark.roughnessMap = retile(S.end.roughnessMap, 5.2 / 2.2, 5.6 / 2.2);
      this.wallMatDark.color = new THREE.Color(0x9d9a94);
      this.wallMatDark.normalScale = new THREE.Vector2(1.1, 1.1);
      this.wallMatDark.needsUpdate = true;

    }

    const rust = rustMaps(512, 71);
    this.rustTex = rust;
    this.rustMat = new THREE.MeshStandardMaterial({
      map: cloneTex(rust.map, 30, 2.5),
      normalMap: cloneTex(rust.normalMap, 30, 2.5),
      metalnessMap: cloneTex(rust.metalnessMap, 30, 2.5),
      color: 0xb08a72,
      roughness: 0.62,
      metalness: 0.55,
      normalScale: new THREE.Vector2(1.2, 1.2),
      envMapIntensity: 0.7,
      transparent: true,
      opacity: 0,
    });
    this.rustMatDark = this.rustMat.clone();
    this.rustMatDark.color = new THREE.Color(0x8e6a55);

    const asphalt = asphaltMaps(512, 21);
    this.asphaltTex = asphalt;
    this.groundMat = new THREE.MeshPhysicalMaterial({
      map: cloneTex(asphalt.map, 3, 110),
      normalMap: cloneTex(asphalt.normalMap, 5, 160),
      roughnessMap: cloneTex(asphalt.roughnessMap, 4, 120),
      color: 0xdfe4ee,
      roughness: 0.15,                 // spec: rain-slicked
      metalness: 0.0,
      clearcoat: 1.0,                  // spec: clearcoat wet asphalt
      clearcoatRoughness: 0.055,
      normalScale: new THREE.Vector2(0.55, 0.55),
      envMapIntensity: 0.9,
    });

    const fabric = fabricMaps(256, 5, [206, 202, 192]);
    this.fabricTex = fabric;
    this.clothMat = new THREE.MeshPhysicalMaterial({
      map: fabric.map,
      normalMap: fabric.normalMap,
      normalScale: new THREE.Vector2(0.35, 0.35),
      color: 0xd8d4cb,
      roughness: 0.82,
      sheen: 0.35,
      sheenColor: new THREE.Color(0xaab4c8),
      envMapIntensity: 0.4,
    });

    this.metalDark = new THREE.MeshStandardMaterial({ color: 0x2a2c31, metalness: 0.85, roughness: 0.42, envMapIntensity: 0.8 });
    this.metalRust = new THREE.MeshStandardMaterial({
      map: cloneTex(rust.map, 2, 2), normalMap: cloneTex(rust.normalMap, 2, 2),
      color: 0x8a6a52, metalness: 0.62, roughness: 0.55,
    });
    this.rubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 0.92, metalness: 0.05 });
    this.plasticBlack = new THREE.MeshPhysicalMaterial({
      color: 0x101014, roughness: 0.34, metalness: 0.02, clearcoat: 0.7, clearcoatRoughness: 0.25, sheen: 0.2,
    });
    this.glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x9fc4d8, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.14,
      clearcoat: 1, envMapIntensity: 1.4, depthWrite: false,
    });
    this.warmBulb = new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffcf8a, emissiveIntensity: 4.0, roughness: 0.4 });
    this.coolBulb = new THREE.MeshStandardMaterial({ color: 0xeaf7ff, emissive: 0xbfe6ff, emissiveIntensity: 5.5, roughness: 0.3 });
    this.pinkNeon = new THREE.MeshStandardMaterial({ color: 0xffeff6, emissive: 0xff2f6d, emissiveIntensity: 4.2, roughness: 0.4 });
    this.shutterMat = new THREE.MeshStandardMaterial({
      map: (() => { const t = shutterTexture(); t.repeat.set(3, 2); return t; })(),
      color: 0x8a8f9a, metalness: 0.55, roughness: 0.52, envMapIntensity: 0.7,
    });
    this.woodMat = new THREE.MeshStandardMaterial({ color: 0x3a2c20, roughness: 0.86, metalness: 0.02 });
    this.skinMat = new THREE.MeshPhysicalMaterial({
      color: 0xbfb4ac, roughness: 0.62, clearcoat: 0.08, clearcoatRoughness: 0.6,
      sheen: 0.25, sheenColor: new THREE.Color(0x9b8f90), envMapIntensity: 0.5,
    });

    this.streakTex = streakTexture('255,196,120');
    this.streakCool = streakTexture('150,215,255');
    this.streakPink = streakTexture('255,90,150');
    this.puddleAlpha = puddleAlphaTexture();
    this.rippleNormal = rippleNormalTexture();
    this.rippleNormal.repeat.set(1.5, 3);
    this.glowTex = glowSpriteTexture();
    this.fogTex = fogSheetTexture();

    /* ---- the two surfaces that had to be declared before they could be
       re-textured: the road and the shutter steel ---- */
    if (SURFACES.ready) {
      const S = SURFACES;
      // 2 m of road per tile, so a stone in the aggregate is a stone
      this.groundMat.map = retile(S.road.map, 7.6 / 2.0, 250 / 2.0);
      this.groundMat.normalMap = retile(S.road.normalMap, 7.6 / 2.0, 250 / 2.0);
      this.groundMat.roughnessMap = retile(S.road.roughnessMap, 7.6 / 2.0, 250 / 2.0);
      this.groundMat.normalScale = new THREE.Vector2(0.95, 0.95);
      this.groundMat.color = new THREE.Color(0xb9bcc4);
      this.groundMat.needsUpdate = true;

      /* ---- the ground ---------------------------------------------------
         A photo of clean asphalt tiled every 2 m under a pale tint reads as
         a tiled interior floor: the pattern repeats on a grid the eye locks
         onto, and there is nothing at street scale — patches, tar seams,
         cracks, gravel — to tell it apart from a kitchen. So the tile is
         rebuilt once at load: the photo grain is kept, and street-scale wear
         is painted over it. Tiled every 8 m, which is a scale the eye reads
         as "ground" rather than "pattern". */
      this.groundMat.map = this.buildAsphaltMap(S.road.map);
      this.groundMat.normalMap = retile(S.road.normalMap, 7.6 / 0.9, 250 / 0.9);
      this.groundMat.roughnessMap = retile(S.road.roughnessMap, 7.6 / 1.6, 250 / 1.6);
      this.groundMat.normalScale = new THREE.Vector2(1.25, 1.25);
      this.groundMat.color = new THREE.Color(0x9aa0a6);   // asphalt, not lino
      this.groundMat.needsUpdate = true;
      this.shutterMat.map = retile(S.metal.map, 5, 2.2);
      this.shutterMat.normalMap = retile(S.metal.normalMap, 5, 2.2);
      this.shutterMat.roughnessMap = retile(S.metal.roughnessMap, 5, 2.2);
      this.shutterMat.color = new THREE.Color(0x8d9199);
      this.shutterMat.needsUpdate = true;
    }
  }

  /* ==================================================================
     LIGHTING ARCHITECTURE
     ================================================================== */
  /* One 1024² sheet of worn asphalt: the photographic grain, plus repair
     patches, tar seams, a crack net and loose grit. Tiled at 8 m so nothing
     lines up with the cell walls. */
  buildAsphaltMap(src) {
    const N = 1024;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const g = c.getContext('2d');
    const rnd = mulberry32(7727);

    // the photo, twice across, for grain that survives the resample
    try {
      const img = src && (src.image || src.source?.data);
      if (img && img.width) {
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) g.drawImage(img, x * N / 2, y * N / 2, N / 2, N / 2);
      } else throw new Error('no image');
    } catch (e) {
      g.fillStyle = '#5c5f61'; g.fillRect(0, 0, N, N);
    }

    // overall darkness: real alley asphalt is nearly black when wet
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = 'rgba(132,135,140,1)';
    g.fillRect(0, 0, N, N);
    g.globalCompositeOperation = 'source-over';

    // repair patches — darker, slightly warmer rectangles of newer asphalt
    for (let i = 0; i < 14; i++) {
      const w = 90 + rnd() * 260, h = 70 + rnd() * 190;
      const x = rnd() * (N - w), y = rnd() * (N - h);
      g.save();
      g.beginPath();
      const r = 10 + rnd() * 26;
      g.moveTo(x + r, y);
      g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
      g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
      g.closePath();
      g.fillStyle = `rgba(${44 + rnd() * 16 | 0},${44 + rnd() * 16 | 0},${47 + rnd() * 16 | 0},${0.22 + rnd() * 0.3})`;
      g.fill();
      g.restore();
    }

    // tar seams: thick, slightly glossy black lines, the way a lane is mended
    for (let i = 0; i < 7; i++) {
      g.beginPath();
      let x = rnd() * N, y = rnd() * N;
      g.moveTo(x, y);
      const steps = 6 + (rnd() * 6 | 0);
      for (let k = 0; k < steps; k++) {
        x += (rnd() - 0.5) * 260; y += (rnd() - 0.5) * 260;
        g.lineTo(x, y);
      }
      g.strokeStyle = `rgba(22,22,25,${0.5 + rnd() * 0.35})`;
      g.lineWidth = 5 + rnd() * 9;
      g.lineCap = 'round';
      g.stroke();
      g.strokeStyle = 'rgba(120,124,130,0.10)';
      g.lineWidth = 1.5;
      g.stroke();
    }

    // a crack net — thin, branching, the strongest "this is a road" cue
    for (let i = 0; i < 26; i++) {
      let x = rnd() * N, y = rnd() * N;
      let a = rnd() * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y);
      const seg = 8 + (rnd() * 16 | 0);
      for (let k = 0; k < seg; k++) {
        a += (rnd() - 0.5) * 1.1;
        const L = 6 + rnd() * 22;
        x += Math.cos(a) * L; y += Math.sin(a) * L;
        g.lineTo(x, y);
      }
      g.strokeStyle = `rgba(18,18,20,${0.35 + rnd() * 0.4})`;
      g.lineWidth = 0.8 + rnd() * 1.8;
      g.stroke();
    }

    // loose grit and aggregate proud of the surface
    for (let i = 0; i < 3400; i++) {
      const x = rnd() * N, y = rnd() * N, r = 0.4 + rnd() * 1.4;
      const v = 52 + rnd() * 46 | 0;
      g.fillStyle = `rgba(${v},${v},${v + 4},${0.05 + rnd() * 0.16})`;
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
    // and a few darker stains where oil has dripped
    for (let i = 0; i < 9; i++) {
      const x = rnd() * N, y = rnd() * N, r = 20 + rnd() * 70;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(10,10,14,0.55)');
      grd.addColorStop(1, 'rgba(10,10,14,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.repeat.set(7.6 / 8, 250 / 8);
    tex.needsUpdate = true;
    return tex;
  }

  createLights() {
    this.ambient = new THREE.AmbientLight(0x39426e, 3.0);    // dark-indigo lift (never pitch black)
    this.scene.add(this.ambient);

    this.hemi = new THREE.HemisphereLight(0x4a5480, 0x0a0b12, 2.0);
    this.scene.add(this.hemi);

    const moon = new THREE.DirectionalLight(0xa7baea, 1.0);
    moon.position.set(-8, 16, -6);
    this.scene.add(moon);

    // sickly sodium street lamp on the utility pole
    this.lamp = new THREE.SpotLight(0xffb95e, 520, 30, 1.0, 0.78, 1.7);
    this.lamp.position.set(1.35, 5.05, -5.1);
    this.lamp.target.position.set(0.55, 0, -4.6);
    this.lamp.castShadow = true;
    /* The lamp only ever snaps between fixed fixtures, and the only thing
       that moves inside its cone is the girl — so this shadow map is driven
       by hand (see update()) instead of being re-rendered every frame. That
       pass alone was ~53k triangles a frame. */
    this.lamp.shadow.autoUpdate = false;
    this.lamp.shadow.needsUpdate = true;
    this.lamp.shadow.mapSize.set(1024, 1024);
    this.lamp.shadow.camera.near = 0.6;
    this.lamp.shadow.camera.far = 24;
    this.lamp.shadow.bias = -0.0008;
    this.lamp.shadow.normalBias = 0.035;
    this.lamp.shadow.radius = 3;
    this.scene.add(this.lamp, this.lamp.target);
    this.lampBaseIntensity = 520;

    this.lampGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffc477, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: 0.42,
    }));
    this.lampGlow.position.copy(this.lamp.position);
    this.lampGlow.scale.set(1.25, 1.25, 1);
    this.scene.add(this.lampGlow);

    // warm bulb over the missing-persons board
    this.boardLight = new THREE.SpotLight(0xffd7a0, 34, 9, 1.02, 0.92, 1.5);
    this.boardLight.position.set(0, 3.05, 11.32);
    this.boardLight.target.position.set(0, 1.55, 12.2);
    this.scene.add(this.boardLight, this.boardLight.target);

    // cold fluorescent wash behind the vending machines handled in buildVending()
    this.neonLight = new THREE.PointLight(0xff2f6d, 0, 10, 1.8);
    this.scene.add(this.neonLight);
  }

  thinLighting() {
    // software / low-end path: fewer analytic lights per fragment
    this._thin = true;
    if (this._sconceLights) {
      for (const s of this._sconceLights) { s.light.visible = false; s.light.intensity = 0; }
    }
    if (this.torchFill) { this.torchFill.visible = false; this.torchFill.intensity = 0; }
    if (this.minQuality) {
      if (this.sconce) this.sconce.visible = false;
    }
  }

  buildMaigoLight() {
    // a cold, sourceless moon-wash that finds her in the dark
    this.maigoLight = new THREE.PointLight(0xc9d8ff, 0, 8, 1.7);
    this.maigoLight.position.set(0, 2.4, 0);
    this.scene.add(this.maigoLight);
    this.maigoLightTarget = 0;
  }

  setMaigoLight(v) { this.maigoLightTarget = v; }

  buildFlashlight() {
    this.flashlight = new THREE.SpotLight(0xfff1d6, 720, 38, 0.40, 0.55, 1.75);
    this.flashlight.position.set(0.14, -0.1, 0.05);
    this.flashlight.castShadow = true;
    /* While the torch is off its shadow map is pure waste; while it is on it
       has to be exact, because it moves with the camera. */
    this.flashlight.shadow.autoUpdate = false;
    this.flashlight.shadow.needsUpdate = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = 34;
    this.flashlight.shadow.bias = -0.0006;
    this.flashlight.shadow.normalBias = 0.018;
    this.flashlight.shadow.radius = 2.5;
    const target = new THREE.Object3D();
    target.position.set(0.02, -1.15, -5.6);
    this.camera.add(this.flashlight, target);
    this.flashlight.target = target;
    this.scene.add(this.camera);
    this.flashlightIntensity = 720;
    this.batteryDim = 1;
    this.flashlightScale = 1; // cinematic dim only while the beam is aimed at her face

    // subtle bounce so the handheld reads as a real torch
    this.torchFill = new THREE.PointLight(0xffe2b8, 9, 6.0, 2);
    this.torchFill.position.set(0.1, -0.05, -0.3);
    this.camera.add(this.torchFill);
  }

  /* ==================================================================
     GROUND — wet asphalt with puddles and lamp streaks
     ================================================================== */
  buildGround() {
    const g = new THREE.PlaneGeometry(7.6, 250, 12, 160);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const camber = -Math.pow(Math.abs(x) / 3.8, 2) * 0.06;
      const wobble = Math.sin(y * 0.7) * 0.008 + Math.sin(y * 0.13 + x) * 0.014;
      pos.setZ(i, camber + wobble);
    }
    g.computeVertexNormals();
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -98);
    const ground = new THREE.Mesh(g, this.groundMat);
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;

    /* MANHOLES + GULLY — nothing sells a real back lane faster than the
       iron in its surface. Placed on the 90 m loop lattice so the repeat is
       invisible, and kept flat so they never catch the player. */
    {
      const manholeMat = new THREE.MeshStandardMaterial({
        /* cast iron in the rain: it darkens the torch pool instead of
           mirroring it white */
        color: 0x35383b, roughness: 0.74, metalness: 0.34, envMapIntensity: 0.5,
      });
      const disc = (r) => {
        const p = new THREE.PlaneGeometry(r * 2, r * 2, 14, 14);
        const pos = p.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i);
          const d = Math.hypot(x, y) / r;
          pos.setZ(i, d > 1 ? 0 : (0.006 + Math.sin(d * 9) * 0.0012));   // a shallow lid dish
        }
        p.computeVertexNormals();
        p.rotateX(-Math.PI / 2);
        return p;
      };
      const lidGeo = disc(0.34);
      const ringGeo = disc(0.43);
      for (const [x, z] of [[0.62, 2.4], [-0.7, -30.2], [0.55, -62.6], [-0.62, -92.4]]) {
        const ring = new THREE.Mesh(ringGeo, this.metalDark);
        ring.position.set(x, 0.004, z);
        ring.receiveShadow = true;
        this.scene.add(ring);
        const lid = new THREE.Mesh(lidGeo, manholeMat);
        lid.position.set(x, 0.010, z);
        lid.receiveShadow = true;
        this.scene.add(lid);
      }
      /* the gully: a long iron grate at the foot of the right-hand wall */
      const grate = new THREE.Group();
      const gW = 0.34, gL = 3.0;
      const frame = new THREE.Mesh(extrudedSlab(gW, 0.035, gL, { radius: 0.006, bevel: 0.004, steps: 1 }), this.metalDark);
      frame.rotation.x = -Math.PI / 2;
      frame.position.y = 0.006;
      grate.add(frame);
      const barGeo = extrudedSlab(gW * 0.86, 0.028, 0.022, { radius: 0.004, bevel: 0.002, steps: 1 });
      for (let i = 0; i < 34; i++) {
        const bar = new THREE.Mesh(barGeo, manholeMat);
        bar.rotation.x = -Math.PI / 2;
        bar.position.set(0, 0.012, -gL / 2 + 0.06 + i * (gL - 0.12) / 33);
        grate.add(bar);
      }
      grate.position.set(2.16, 0, -47.0);
      this.scene.add(grate);
      this.mergeGroupByMaterial(grate);          // one draw call for 34 bars
    }

    /* PUDDLE FIELDS — one wide field every PUDDLE_SPACING metres down the
       street. 45 m divides the 90 m loop band, so a field is always exactly
       where the walk expects it, lap after lap.

       Each field is a subdivided sheet with an onBeforeCompile vertex stage:
       a footfall drops a ring into the water and the ring expands outward
       entirely on the GPU. The CPU only ever writes one vec4 when a boot
       lands, so the ripple costs nothing per frame beyond a vec3 sum.

       The splash test is a flat Float32Array of (x, z, r²) triples and is
       only consulted on a footfall — roughly twice a second. */
    const fields = [];
    {
      const rnd = mulberry32(9);
      for (let z = PUDDLE_FIRST; z > -230; z -= PUDDLE_SPACING) fields.push([z, rnd()]);
    }
    this.puddleZones = [];
    this._puddleFlat = new Float32Array(fields.length * 3);
    {
      let fi = 0;
      for (const [z] of fields) {
        const x = -0.1, dz = 0.35, r = 1.85;
        this.puddleZones.push({ x, z: z + dz, r });
        this._puddleFlat[fi++] = x;
        this._puddleFlat[fi++] = z + dz;
        this._puddleFlat[fi++] = r * r;
      }
    }

    // the ripple sheets exist on the quality path only; the zones above do not
    this._splash = [];
    if (!this.minQuality) {
      // a plane lying in XZ *in geometry space*, so local +Y is world up and
      // the wave can be solved without touching a matrix
      const SEG = 26;
      const geo = new THREE.PlaneGeometry(1, 1, SEG, SEG);
      geo.rotateX(-Math.PI / 2);

      for (const [z, seed] of fields) {
        const sx = 3.7, sz = 2.9;
        const mat = new THREE.MeshPhysicalMaterial({
          map: this.puddleAlpha,
          transparent: true,
          opacity: 0.86,
          color: 0x0a0e18,
          roughness: 0.12,
          metalness: 0.0,
          clearcoat: 1.0,
          clearcoatRoughness: 0.09,
          normalMap: this.rippleNormal,
          normalScale: new THREE.Vector2(0.6, 0.6),
          envMapIntensity: 0.32,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.y = seed * 6.283;
        mesh.scale.set(sx, 1, sz);
        mesh.position.set(-0.1, 0.013, z + 0.35);
        mesh.renderOrder = 2;
        mesh.receiveShadow = false;
        this.scene.add(mesh);
        this._puddleMats.push(mat);

        const sink = makeRippleMaterial(mat, sx, sz);
        if (sink) {
          this._splash.push({ mesh, mat, sink, ring: 0, z: mesh.position.z });
        }
      }
    }

    /* Smaller sheets down the whole alley. These used to be flat decals that
       could not take a ripple; they are water now, so the rain rings and a
       footstep both register on them. The geometry is rotated (not the mesh)
       because the ripple stage solves the wave in object space, where +Y has
       to be up. */
    const puddleGeoFlat = new THREE.PlaneGeometry(1, 1);
    puddleGeoFlat.rotateX(-Math.PI / 2);
    const rnd2 = mulberry32(9);
    const spots = [
      [0.75, 1.4, 2.2, 1.35], [-1.1, -9, 2.0, 1.2], [1.0, -18, 2.4, 1.5],
      [-0.6, -27, 2.8, 1.7], [0.8, -38, 1.9, 1.1], [-1.2, -51, 2.3, 1.4],
      [0.5, -68, 2.6, 1.5], [-0.4, -84, 2.1, 1.3],
    ];
    for (const [x, z, sx, sz] of spots) {
      const mat = new THREE.MeshPhysicalMaterial({
        map: this.puddleAlpha,
        transparent: true,
        opacity: 0.72,
        color: 0x0d141d,          // water reflects the sky; it is not a shadow
        roughness: 0.13,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.10,
        normalMap: this.rippleNormal,
        normalScale: new THREE.Vector2(0.75, 0.75),
        envMapIntensity: 0.34,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const m = new THREE.Mesh(puddleGeoFlat, mat);
      m.rotation.y = rnd2() * Math.PI * 2;
      m.scale.set(sx, 1, sz);
      m.position.set(x, 0.012, z);
      m.renderOrder = 2;
      this.scene.add(m);
      this._puddleMats.push(mat);

      const sink2 = makeRippleMaterial(mat, sx, sz);
      if (sink2) {
        this._splash.push({ mesh: m, mat, sink: sink2, ring: 0, z });
      }
    }

    // reflection streaks below practical lamps
    this.addStreak(0.85, -5.1, 0.95, 11, this.streakTex, 0.34, 0xffb877);
    this.addStreak(1.55, -15.5, 0.8, 6.2, this.streakCool, 0.30, 0xbfe0ff);
    this.addStreak(1.5, -62.1, 0.75, 5.8, this.streakCool, 0.22, 0xbfe0ff);

    // drain grate near the wall
    const grate = new THREE.Mesh(extrudedSlab(0.5, 0.84, 0.03, { radius: 0.02, bevel: 0.004 }),
      new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.9, roughness: 0.4 }));
    grate.rotation.x = -Math.PI / 2;
    grate.position.set(-1.7, 0.018, -6.4);
    this.scene.add(grate);
    const barGeo = new THREE.PlaneGeometry(0.04, 0.74);
    const barMat = new THREE.MeshStandardMaterial({ color: 0x2b2e34, metalness: 0.9, roughness: 0.35 });
    for (let i = 0; i < 6; i++) {
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.rotation.x = -Math.PI / 2;
      bar.position.set(-1.9 + i * 0.08, 0.024, -6.4);
      this.scene.add(bar);
    }
  }

  addStreak(x, z, w, len, tex, opacity, tint = 0xffb877) {
    /* tinted to the source: a pure-white additive sheet under a sodium lamp
       reads as a piece of paper lying on the road, whatever the texture is. */
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthWrite: false, color: tint, toneMapped: true,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.024, z);
    m.renderOrder = 3;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    this.scene.add(m);
    return m;
  }

  /* ==================================================================
     FACADES — the walls stop being a corridor and become a street
     ------------------------------------------------------------------
     Every window, shutter, meter box and pipe on this alley is one
     InstancedMesh per component type, so 130-odd openings cost four draw
     calls instead of four hundred. The frames stand 4 cm proud of the
     displaced wall with a dark reveal behind them, which is what makes
     them read as openings cut into masonry rather than stickers.
     ================================================================== */
  buildFacades() {
    const LENGTH = 224, Z0 = 13, Z1 = Z0 - LENGTH;
    const rnd = mulberry32(4181);
    const SIDE_X = 2.545;                 // wall plane minus the displacement
    const OUT = 0.042;                    // frame stands this far proud

    /* ---------- one upper-floor window, built in wall-local space ----------
       X runs along the wall, Y is up, Z points out into the alley. */
    const W = 1.10, H = 1.30;
    /* ONE extrusion with a hole, not seven beveled bars: the reveal is a
       picture-frame profile 11 cm deep, plus a thin mullion bar and a sill.
       Seven bevelled slabs per window cost 1,316 triangles each; at 184
       openings that was 242k triangles — over half the whole scene. */
    const frameShape = roundedRectShape(W + 0.20, H + 0.15, 0.02);
    const hole = new THREE.Path();
    hole.moveTo(-W / 2, -H / 2);
    hole.lineTo(W / 2, -H / 2);
    hole.lineTo(W / 2, H / 2);
    hole.lineTo(-W / 2, H / 2);
    hole.closePath();
    frameShape.holes.push(hole);
    const frameGeo = new THREE.ExtrudeGeometry(frameShape, {
      depth: 0.11, bevelEnabled: false, curveSegments: 1, steps: 1,
    });
    frameGeo.translate(0, 0.02, 0.035);
    // mullion, transom and sill as flat slabs (no bevel, no rounding cost)
    const flat = (w, h, d, x, y, z) => {
      const sh = roundedRectShape(w, h, 0.008);
      const gg = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: false, curveSegments: 1, steps: 1 });
      gg.translate(x, y, z);
      return gg;
    };
    const detail = mergeGeometries([
      flat(0.05, H - 0.04, 0.075, 0, 0, 0.075),        // centre mullion
      flat(W, 0.042, 0.075, 0, H * 0.20, 0.075),       // transom
      flat(W + 0.24, 0.09, 0.19, 0, -H / 2 - 0.055, 0.10), // sill
    ], false);
    const frameAll = mergeGeometries([frameGeo, detail], false);

    const glassGeo = new THREE.PlaneGeometry(W - 0.09, H - 0.03);
    const backGeo = new THREE.PlaneGeometry(W + 0.02, H + 0.02);
    // a steel security grille for the ground floor: 4 bars + 2 rails
    const slab = (w, h, d, x, y, z) => {
      const sh = roundedRectShape(w, h, 0.006);
      const gg = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: false, curveSegments: 1, steps: 1 });
      gg.translate(x, y, z);
      return gg;
    };
    const grilleParts = [];
    for (let i = 0; i < 5; i++) grilleParts.push(slab(0.026, 0.94, 0.026, -0.36 + i * 0.18, 0, 0.145));
    grilleParts.push(slab(0.86, 0.03, 0.03, 0, 0.40, 0.145));
    grilleParts.push(slab(0.86, 0.03, 0.03, 0, -0.40, 0.145));
    const grilleGeo = mergeGeometries(grilleParts, false);

    /* ---------- materials ---------- */
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x5d625f, roughness: 0.72, metalness: 0.22, envMapIntensity: 0.6,
    });
    const grilleMat = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.5, metalness: 0.78, envMapIntensity: 0.9 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b1016, roughness: 0.06, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 2.1,
      transparent: true, opacity: 0.86, depthWrite: false,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.95, metalness: 0.0 });
    const litMat = new THREE.MeshStandardMaterial({
      color: 0x2a1d10, emissive: 0xffb060, emissiveIntensity: 0.85, roughness: 0.9,
    });

    /* ---------- layout ----------
       30 slots x 3.0 m = exactly one 90 m loop. The pattern is generated
       once and indexed by (z mod 90), so walking out of the far end of the
       street and back into the near end lands on the same windows, the same
       shutters and the same meters. That is what makes the loop seamless
       instead of a teleport that merely looks similar. */
    const LOOP = 90;
    const STEP = LOOP / 30;                 // 3.00 m
    const SLOTS = 30;
    const wins = [], lits = [], backs = [], shutters = [], meters = [], vents = [], transoms = [], topVents = [];
    const dummy = new THREE.Object3D();

    const pattern = [];
    {
      const rp = mulberry32(4181);
      for (let i = 0; i < SLOTS; i++) {
        pattern.push({ lit: rp() < 0.34, ground: rp(), meter: rp(), bump: rp() < 0.25, ac: rp() < 0.55 });
      }
    }
    /* blocked slots are expressed modulo the loop as well, or the clearance
       around the board and the machines would drift lap to lap */
    const keepClear = [7.2, 2.4, -22, -47, -15.5, -62, -5.2, 12.3, 0.0, 10.0, -4.6];
    const clearMod = keepClear.map((k) => ((k % LOOP) + LOOP) % LOOP);
    const clear = (z) => {
      const m = ((z % LOOP) + LOOP) % LOOP;
      return clearMod.every((k) => {
        const d = Math.abs(m - k);
        return Math.min(d, LOOP - d) > 1.30;
      });
    };

    const zTop = Z0 - 4.2;
    for (const side of [1, -1]) {
      for (let z = zTop; z > Z1 + 6; z -= STEP) {
        const slot = ((Math.round((zTop - z) / STEP) % SLOTS) + SLOTS) % SLOTS;
        const pat = pattern[slot];
        if (!clear(z)) continue;
        const rotY = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        const px = side * SIDE_X;
        const upperY = 4.02 + (pat.bump ? 0.06 : 0);
        wins.push({ x: px, y: upperY, z, rotY });
        backs.push({ x: px, y: upperY, z, rotY, lit: pat.lit });
        /* Every slot gets a ground-floor element: a bare stretch of wall is the
           one thing a real back lane never has. Shutter / barred window / meter
           bank / service hatch, in that order of frequency. */
        if (pat.ground < 0.36) {
          shutters.push({ x: px, y: 1.16, z, rotY, h: 2.30, w: 2.5 });
          if (pat.ac) transoms.push({ x: px, y: 2.62, z, rotY, lit: pat.meter < 0.5 });
        } else if (pat.ground < 0.72) {
          const gy = 1.62;
          wins.push({ x: px, y: gy, z, rotY, ground: true, sc: 0.82 });
          backs.push({ x: px, y: gy, z, rotY, lit: pat.meter < 0.22, ground: true, sc: 0.82 });
        } else if (pat.ground < 0.90) {
          meters.push({ x: px, y: 1.38 + pat.meter * 0.2, z: z + (pat.meter - 0.5) * 0.8, rotY });
        } else {
          vents.push({ x: px, y: 1.52 + pat.meter * 0.1, z: z + (pat.meter - 0.5) * 0.5, rotY });
        }
        if (pat.ac) lits.push({ x: px, y: upperY, z, rotY });
        if (pat.ground > 0.42) topVents.push({ x: px, y: 5.06, z: z + (pat.bump ? 0.2 : -0.2), rotY });
      }
    }

    /* ---------- instancing ---------- */
    const inst = (geo, mat, list, apply) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      list.forEach((it, i) => {
        dummy.position.set(it.x, it.y, it.z);
        dummy.rotation.set(0, it.rotY, 0);
        dummy.scale.set(1, 1, 1);
        if (apply) apply(dummy, it, i);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
      this.scene.add(m);
      return m;
    };

    // frames (scaled for the smaller ground-floor openings)
    inst(frameAll, frameMat, wins, (d, it) => { const s = it.sc || 1; d.scale.set(s, s, 1); if (it.sc) d.position.y = it.y; });
    // glass sits behind the frame
    const glassMesh = new THREE.InstancedMesh(glassGeo, glassMat, wins.length);
    const backDark = [], backLit = [];
    wins.forEach((it) => {
      const b = backs.find((x) => x.z === it.z && Math.abs(x.x - it.x) < 0.01 && Math.abs(x.y - it.y) < 0.5);
      (b && b.lit ? backLit : backDark).push(it);
    });
    let gi = 0;
    for (const list of [backDark, backLit]) {
      for (const it of list) {
        dummy.position.set(it.x - Math.sin(it.rotY) * 0.01 * 0, it.y, it.z);
        dummy.rotation.set(0, it.rotY, 0);
        dummy.scale.set(1, 1, 1);
        if (it.sc) dummy.scale.set(it.sc, it.sc, 1);
        dummy.translateZ(0.030);          // glass, proud of the masonry
        dummy.updateMatrix();
        glassMesh.setMatrixAt(gi++, dummy.matrix);
      }
    }
    while (gi < wins.length) { glassMesh.setMatrixAt(gi++, new THREE.Matrix4()); }
    glassMesh.instanceMatrix.needsUpdate = true;
    glassMesh.frustumCulled = false;
    this.scene.add(glassMesh);
    // the dark cavity behind the glass, and the lit rooms
    inst(backGeo, darkMat, backDark, (d, it) => { if (it.sc) d.scale.set(it.sc, it.sc, 1); d.translateZ(0.006); });
    inst(backGeo, litMat.clone(), backLit, (d, it) => { if (it.sc) d.scale.set(it.sc, it.sc, 1); d.translateZ(0.006); });
    // security grilles over the ground-floor openings only
    const groundWins = wins.filter((w) => w.ground);
    if (groundWins.length) inst(grilleGeo, grilleMat, groundWins, (d, it) => { d.scale.set(it.sc || 1, it.sc || 1, 1); });

    /* ---------- shop shutters ---------- */
    if (shutters.length) {
      const shGeoTemplate = extrudedSlab(1, 1, 0.05, { radius: 0.006, bevel: 0.004, steps: 1, curveSegments: 2 });
      const shMesh = new THREE.InstancedMesh(shGeoTemplate, this.shutterMat, shutters.length);
      shMesh.castShadow = true; shMesh.receiveShadow = true; shMesh.frustumCulled = false;
      shutters.forEach((it, i) => {
        dummy.position.set(it.x, it.y, it.z);
        dummy.rotation.set(0, it.rotY, 0);
        dummy.scale.set(it.w, it.h, 1);
        dummy.updateMatrix();
        shMesh.setMatrixAt(i, dummy.matrix);
      });
      shMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(shMesh);
      // a rusted sign band above each shutter
      const signMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.78, metalness: 0.3 });
      const signGeo = extrudeSignGeometry();
      const signMesh = new THREE.InstancedMesh(signGeo, signMat, shutters.length);
      signMesh.frustumCulled = false;
      shutters.forEach((it, i) => {
        dummy.position.set(it.x, it.y + it.h / 2 + 0.28, it.z);
        dummy.rotation.set(0, it.rotY, 0);
        dummy.scale.set(it.w * 0.9, 1, 1);
        dummy.updateMatrix();
        signMesh.setMatrixAt(i, dummy.matrix);
      });
      signMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(signMesh);
    }

    /* ---------- transom lights over the shutters (cheap panel, not a frame) */
    if (transoms.length) {
      const tParts = [new THREE.PlaneGeometry(0.62, 0.76)];
      for (const [w, h, y] of [[0.58, 0.05, 0], [0.05, 0.72, 0], [0.58, 0.05, 0.30], [0.58, 0.05, -0.30]]) {
        const bar = new THREE.PlaneGeometry(w, h);
        bar.translate(0, y, 0.010);
        tParts.push(bar);
      }
      const tGeo = mergeGeometries(tParts, false);
      tParts.forEach((g) => g.dispose());
      const tMat = new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.66, metalness: 0.32 });
      inst(tGeo, tMat, transoms);
      const tLit = transoms.filter((t) => t.lit);
      const tDark = transoms.filter((t) => !t.lit);
      const paneGeo = new THREE.PlaneGeometry(0.54, 0.68);
      if (tLit.length) inst(paneGeo, litMat.clone(), tLit, (d) => d.translateZ(-0.012));
      if (tDark.length) inst(paneGeo, darkMat, tDark, (d) => d.translateZ(-0.012));
    }

    /* ---------- eave vents: one small louvre per bay, high on the wall ---- */
    if (topVents.length) {
      const tvGeo = new THREE.PlaneGeometry(0.52, 0.30);
      const tvMat = new THREE.MeshStandardMaterial({ color: 0x35383c, roughness: 0.8, metalness: 0.3 });
      inst(tvGeo, tvMat, topVents);
      const slatParts = [];
      for (let i = 0; i < 4; i++) {
        const sl = new THREE.PlaneGeometry(0.46, 0.045);
        sl.rotateX(-0.5);
        sl.translate(0, -0.10 + i * 0.066, 0.012);
        slatParts.push(sl);
      }
      const slatGeo = mergeGeometries(slatParts, false);
      slatParts.forEach((g) => g.dispose());
      inst(slatGeo, this.metalDark || tvMat, topVents);
    }

    /* ---------- service hatches / louvred vents ---------- */
    if (vents.length) {
      const ventGeo = extrudedSlab(0.46, 0.34, 0.055, { radius: 0.014, bevel: 0.005, steps: 1 });
      const ventMat = new THREE.MeshStandardMaterial({ color: 0x585349, roughness: 0.82, metalness: 0.28 });
      inst(ventGeo, ventMat, vents);
    }

    /* ---------- meter boxes / junction boxes ---------- */
    if (meters.length) {
      const boxGeo = extrudedSlab(0.30, 0.42, 0.13, { radius: 0.018, bevel: 0.006 });
      const boxMat = new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.74, metalness: 0.35 });
      inst(boxGeo, boxMat, meters);
    }

    /* ---------- AC units, downpipes, sill brackets ---------- */
    for (let z = Z0 - 9; z > Z1 + 10; z -= 18) {
      if (!clear(z)) continue;
      const side = (Math.round(z) % 2 === 0) ? 1 : -1;
      this.addACUnit(side * (SIDE_X - 0.16), 3.30 + (Math.abs(z) % 3) * 0.05, z, 0.92);
    }
    /* downpipes: a vertical run from the eave to the gutter, with collars.
       All of them merge into one mesh — nineteen pipes plus collars were
       ninety draw calls standing against a wall. */
    const pipeParts = [];
    for (let z = Z0 - 6; z > Z1 + 8; z -= 18) {
      const side = (Math.round(z) % 3 === 0) ? 1 : -1;
      const px = side * (SIDE_X - 0.055);
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push(new THREE.Vector3(px + Math.sin(t * 3.1) * 0.012, 0.12 + t * 5.2, z + Math.cos(t * 2.2) * 0.008));
      }
      pipeParts.push(tubeGeometry(pts, 0.036, 26, 7));
      for (const yy of [1.1, 2.6, 4.1]) {
        const collar = new THREE.TorusGeometry(0.048, 0.011, 4, 10);
        collar.rotateX(Math.PI / 2);
        collar.translate(px, yy, z);
        pipeParts.push(collar);
      }
    }
    if (pipeParts.length) {
      const pipes = new THREE.Mesh(mergeGeometries(pipeParts, false), this.metalRust);
      pipes.castShadow = true;
      this.scene.add(pipes);
    }

    this.facadeCount = wins.length + shutters.length + meters.length;

    function extrudeSignGeometry() {
      const g = extrudedSlab(1, 0.30, 0.09, { radius: 0.01, bevel: 0.005, steps: 1, curveSegments: 3 });
      return g;
    }
  }

  /* ==================================================================
     WALLS — displaced concrete + hidden rust layer for The Rust Shift
     ================================================================== */
  buildWalls() {
    const length = 224, height = 5.6;
    const zStart = 13 - length;
    const wallGeo = (side) => {
      /* every x-frequency is a whole number of cycles per 90 m loop, so the
         wall it walks past the second time is literally the same wall — the
         wrap can no longer show a seam in the render or the silhouette */
      const K = (Math.PI * 2) / 90;
      const geo = displacedPlaneGeometry(length, height, 180, 22, (x, y) => {
        return Math.sin(x * K * 5) * 0.012 + Math.sin(x * K * 3 + y * 1.3) * 0.02 + Math.sin(y * 5.1) * 0.008;
      });
      return geo;
    };

    const geoR = wallGeo(1);
    const right = new THREE.Mesh(geoR, this.wallMat);
    right.rotation.y = -Math.PI / 2;
    right.position.set(2.56, height / 2, -99);
    right.receiveShadow = true;
    this.scene.add(right);
    this.wallRight = right;

    const geoL = wallGeo(-1);
    const left = new THREE.Mesh(geoL, this.wallMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(-2.56, height / 2, -99);
    left.receiveShadow = true;
    this.scene.add(left);
    this.wallLeft = left;

    /* ---- brick dado -----------------------------------------------------
       Real back-lane buildings are tiled or bricked for the first metre so
       carts and shoes cannot scour the render. It also breaks the corridor
       into masonry courses, which is most of what sells the scale. */
    if (SURFACES.ready && this.dadoMat) {
      for (const side of [-1, 1]) {
        const g2 = displacedPlaneGeometry(224, 1.25, 150, 5, (x, y) =>
          Math.sin(x * (Math.PI * 2 / 90) * 25) * 0.004 + Math.sin(y * 6.2 + x * (Math.PI * 2 / 90) * 6) * 0.003);
        const band = new THREE.Mesh(g2, this.dadoMat);
        band.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        band.position.set(side * 2.532, 0.625, -99);
        band.receiveShadow = true;
        this.scene.add(band);
        // a weathered concrete skirt where the brick meets the ground
        const skirtGeo = displacedPlaneGeometry(224, 0.16, 120, 2, (x) => Math.sin(x * (Math.PI * 2 / 90) * 46) * 0.003);
        const skirt = new THREE.Mesh(skirtGeo, this.wallMatDark);
        skirt.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        skirt.position.set(side * 2.524, 0.08, -99);
        skirt.receiveShadow = true;
        this.scene.add(skirt);
      }
    }

    // far dead-end wall behind the player (holds the missing-persons board)
    const endGeo = displacedPlaneGeometry(5.2, height, 26, 20, (x, y) =>
      Math.sin(x * 4.2) * 0.012 + Math.sin(y * 2.4) * 0.016);
    /* the board wall: concrete block, not cork. Its own material so the
       plinth skirt and the pole base keep the concrete they were built for. */
    if (!this.endWallMat) {
      this.endWallMat = this.wallMatDark.clone();
      if (SURFACES.ready) {
        const RE = [5.2 / 1.05, 5.6 / 1.05];
        this.endWallMat.map = retile(SURFACES.dado.map, RE[0], RE[1], { offsetX: 0.13, offsetY: 0.4 });
        this.endWallMat.normalMap = retile(SURFACES.dado.normalMap, RE[0], RE[1], { offsetX: 0.13, offsetY: 0.4 });
        this.endWallMat.roughnessMap = retile(SURFACES.dado.roughnessMap, RE[0], RE[1], { offsetX: 0.13, offsetY: 0.4 });
        this.endWallMat.color = new THREE.Color(0x9a9384);
        this.endWallMat.normalScale = new THREE.Vector2(1.2, 1.2);
        this.endWallMat.needsUpdate = true;
      }
    }
    const end = new THREE.Mesh(endGeo, this.endWallMat);
    end.rotation.y = Math.PI;
    end.position.set(0, height / 2, 12.3);
    end.receiveShadow = true;
    this.scene.add(end);
    this.endWall = end;

    // rusted overlays (The Rust Shift)
    for (const side of [-1, 1]) {
      const geo = displacedPlaneGeometry(length, height, 90, 14, (x, y) =>
        Math.sin(x * (Math.PI * 2 / 90) * 33) * 0.02 + Math.sin(x * (Math.PI * 2 / 90) * 11 + y * 2.1) * 0.03);
      const m = new THREE.Mesh(geo, side === 1 ? this.rustMat : this.rustMatDark);
      m.rotation.y = side === 1 ? -Math.PI / 2 : Math.PI / 2;
      m.position.set(side * 2.53, height / 2, -99);
      m.receiveShadow = true;
      m.visible = false;
      this.scene.add(m);
      this._rustSignals.push(m);
    }
    // rust end wall
    const rustEnd = new THREE.Mesh(displacedPlaneGeometry(5.2, height, 26, 16, (x, y) => Math.sin(x * 3) * 0.02), this.rustMatDark);
    rustEnd.rotation.y = Math.PI;
    rustEnd.position.set(0, height / 2, 12.27);
    rustEnd.visible = false;
    this.scene.add(rustEnd);
    this._rustSignals.push(rustEnd);

    // roof / eave line to keep the corridor from reading as an open sky box
    const eaveShape = new THREE.Shape();
    eaveShape.moveTo(-0.16, 0);
    eaveShape.lineTo(0.16, 0);
    eaveShape.lineTo(0.2, -0.12);
    eaveShape.lineTo(-0.2, -0.12);
    eaveShape.closePath();
    const eaveGeo = new THREE.ExtrudeGeometry(eaveShape, { depth: length, bevelEnabled: false });
    for (const side of [-1, 1]) {
      const eave = new THREE.Mesh(eaveGeo, new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.85 }));
      eave.position.set(side * 2.56, 5.62, zStart);
      this.scene.add(eave);
    }

    // curbs / plinth — extruded profile, never a box
    const curbShape = new THREE.Shape();
    curbShape.moveTo(0, 0);
    curbShape.lineTo(0.16, 0);
    curbShape.lineTo(0.16, 0.12);
    curbShape.lineTo(0.115, 0.19);
    curbShape.lineTo(0, 0.19);
    curbShape.closePath();
    const curbGeo = new THREE.ExtrudeGeometry(curbShape, { depth: length, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2 });
    const curbMat = new THREE.MeshStandardMaterial({
      map: cloneTex(this.wallTex.map, 30, 0.4),
      normalMap: cloneTex(this.wallTex.normalMap, 30, 0.4),
      color: 0x6a6c76, roughness: 0.72, metalness: 0.05,
    });
    const rightCurb = new THREE.Mesh(curbGeo, curbMat);
    rightCurb.position.set(2.4, 0, zStart);
    rightCurb.receiveShadow = true;
    this.scene.add(rightCurb);
    const leftShape = new THREE.Shape();
    leftShape.moveTo(0, 0); leftShape.lineTo(-0.16, 0); leftShape.lineTo(-0.16, 0.12);
    leftShape.lineTo(-0.115, 0.19); leftShape.lineTo(0, 0.19); leftShape.closePath();
    const leftCurb = new THREE.Mesh(new THREE.ExtrudeGeometry(leftShape, { depth: length, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2 }), curbMat);
    leftCurb.position.set(-2.4, 0, zStart);
    leftCurb.receiveShadow = true;
    this.scene.add(leftCurb);

    // wall-mounted garage shutter and service door on the left
    const garage = new THREE.Mesh(extrudedSlab(3.4, 2.7, 0.09, { radius: 0.03, bevel: 0.008 }), this.shutterMat);
    garage.rotation.y = Math.PI / 2;
    garage.position.set(-2.5, 1.4, 4.6);
    garage.receiveShadow = true;
    this.scene.add(garage);
    const gFrame = new THREE.Mesh(extrudedSlab(3.62, 2.92, 0.06, { radius: 0.03, bevel: 0.01 }), this.metalRust);
    gFrame.rotation.y = Math.PI / 2;
    gFrame.position.set(-2.53, 1.46, 4.6);
    this.scene.add(gFrame);

    const door = new THREE.Mesh(extrudedSlab(1.0, 2.2, 0.08, { radius: 0.02, bevel: 0.006 }), new THREE.MeshStandardMaterial({ color: 0x232830, metalness: 0.55, roughness: 0.58 }));
    door.rotation.y = Math.PI / 2;
    door.position.set(-2.5, 1.1, -0.6);
    this.scene.add(door);
    const handle = new THREE.Mesh(tubeGeometry([
      new THREE.Vector3(-2.4, 1.05, -0.85),
      new THREE.Vector3(-2.36, 1.02, -0.8),
      new THREE.Vector3(-2.4, 0.98, -0.78),
    ], 0.018, 10, 5), this.metalDark);
    this.scene.add(handle);

    /* wall lamps (practical sconces) — spacing divides the 90 m loop, and the
       far half of the alley is no longer a lightless hole: the wrap happens
       between two lamps instead of in the dark.
       Only the three nearest lamps are switched on at any moment, so the
       light budget is unchanged. */
    const SCONCE_Z = [8.0, -10.0, -28.0, -46.0, -64.0, -82.0, -100.0];
    const SCONCE_C = [0xffcf96, 0xffd7a8, 0xffc07a, 0xffca8a, 0xffd2a0, 0xffc890, 0xffcf9c];
    SCONCE_Z.forEach((z, i) => {
      this.addSconce(i % 2 ? -2.42 : 2.42, 3.0 + (i % 3) * 0.06, z, SCONCE_C[i]);
    });

    // downpipes, conduits, cables
    this.addPipeRun(2.44, 4.05, 12, -122, 0.055);
    this.addPipeRun(-2.44, 4.3, 12, -122, 0.045);
    for (const z of [9.2, -8.8, -26.8, -44.8, -62.8, -80.8, -98.8]) {
      const pts = [
        new THREE.Vector3(-2.44, 5.3, z),
        new THREE.Vector3(-2.40, 4.2, z + 0.06),
        new THREE.Vector3(-2.38, 2.2, z - 0.04),
        new THREE.Vector3(-2.30, 0.15, z + 0.02),
      ];
      const down = new THREE.Mesh(tubeGeometry(pts, 0.055, 28, 8), this.metalRust);
      down.castShadow = true;
      this.scene.add(down);
    }
    // overhead catenary wires crossing the alley
    for (const [z, sag] of [[1.8, 0.5], [-16.2, 0.7], [-34.2, 0.55], [-52.2, 0.62], [-70.2, 0.5], [-88.2, 0.66]]) {
      const wire = new THREE.Mesh(tubeGeometry([
        new THREE.Vector3(-2.6, 4.55, z),
        new THREE.Vector3(-0.8, 4.25 - sag * 0.4, z + 0.4),
        new THREE.Vector3(0.9, 4.1 - sag * 0.6, z - 0.2),
        new THREE.Vector3(2.6, 4.6, z + 0.3),
      ], 0.012, 30, 5), this.rubber);
      this.scene.add(wire);
    }

    // air-conditioning condensers + meter boxes
    for (const [side, y, z, s] of [[1, 2.55, -10.5, 1], [-1, 2.2, -26, 0.85], [1, 3.15, -44, 0.75], [-1, 3.3, -70, 0.9]]) {
      this.addACUnit(side * 2.46, y, z, s);
    }
    for (const [side, y, z] of [[-1, 2.0, -3.9], [1, 1.9, -36], [-1, 2.1, -59]]) {
      const meter = new THREE.Mesh(extrudedSlab(0.3, 0.4, 0.12, { radius: 0.02, bevel: 0.006 }), new THREE.MeshStandardMaterial({ color: 0x3f444d, metalness: 0.6, roughness: 0.5 }));
      meter.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      meter.position.set(side * 2.47, y, z);
      this.scene.add(meter);
    }

    // faded vertical tenant sign near the entrance
    const signTex = neonSignTexture('月光荘', 'APARTMENT', '#c7d6ff', '#6f86c9');
    signTex.anisotropy = 4;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 1.7), new THREE.MeshStandardMaterial({
      map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 0.55,
      color: 0x8a8a8a, roughness: 0.6, metalness: 0.2,
    }));
    sign.rotation.y = Math.PI / 2;
    sign.position.set(2.5, 2.9, -1.8);
    this.scene.add(sign);
  }

  /* Collapse a group's meshes into one mesh per material. Purely a draw-call
     measure: same triangles, same materials, a third of the calls. Sprites and
     lights are left untouched. Attribute sets are normalised first — mixing an
     indexed lathe with a non-indexed extrusion makes mergeGeometries bail. */
  /* ==================================================================
     STATIC BATCHING
     The alley is ~430 meshes and most of them share a dozen materials. Each
     mesh is its own draw call, plus another one per shadow pass, which is
     what actually bounds the frame on a mid-range GPU. This pass bakes the
     scenery into one mesh per (material × 24 m slice) so the count falls by
     an order of magnitude without touching a single pixel.

     It refuses anything that could change under it: objects the game holds a
     handle to (blanket, vending rows, neon door, posters, fog, rain, splash,
     Maigo, the camera), anything transparent or alpha-tested (draw order),
     skinned/instanced/morphed geometry, and any subtree containing a light.
     ================================================================== */
  batchStatic() {
    if (this._batched) return;
    this._batched = true;
    /* `?batch=off` is the escape hatch: if any machine ever shows a seam,
       the alley can be rendered exactly as it was built, one mesh at a time. */
    try {
      if (new URLSearchParams(location.search).get('batch') === 'off') return;
    } catch (e) { /* no location: fine */ }
    try {
      const scene = this.scene;
      const BAND = 24;

      /* 1 · everything the game has a reference to is off limits */
      const keep = new Set();
      const protect = (v) => {
        if (!v || typeof v !== 'object') return;
        if (v.isObject3D) { v.traverse((x) => keep.add(x)); return; }
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) protect(v[i]); return; }
        if (v.isMaterial || v.isBufferGeometry) return;
        /* A vending machine is a cabinet plus a handful of sweets that get
           taken one by one. The cabinet is scenery and can be batched; the
           sweets, the glow and the lamp inside it stay live. If a streamed
           machine ever replaces it, the whole group is exempt again. */
        if (v.group && v.group.userData && v.group.userData.vending) protect(v.group);
        else { protect(v.candies); protect(v.glowSprite); protect(v.sprites); }
        protect(v.mesh); protect(v.root);
        protect(v.light); protect(v.candies); protect(v.sprites);
      };
      for (const k in this) {
        if (k === 'scene' || k === 'camera' || k === '_batched') continue;
        protect(this[k]);
      }
      protect(this.camera);

      /* 2 · anything dynamic poisons its whole subtree */
      scene.updateMatrixWorld(true);
      const mark = [];
      scene.traverse((o) => {
        if (o.isLight || o.isCamera) { mark.push(o); return; }
        if (!o.isMesh && !o.isLine && !o.isPoints) return;
        if (o.isSkinnedMesh || o.isInstancedMesh) { mark.push(o); return; }
        if (o.morphTargetInfluences && o.morphTargetInfluences.length) { mark.push(o); return; }
        const m = o.material;
        if (!m || Array.isArray(m)) { mark.push(o); return; }
        if (m.transparent || (m.opacity !== undefined && m.opacity < 1) || (m.alphaTest || 0) > 0 || m.isShaderMaterial) { mark.push(o); return; }
      });
      /* Only the dynamic object itself is exempt — not its parents. Pulling a
         cabinet mesh out of a group that also holds a lamp is harmless, but
         pulling a mesh out of a group that MOVES would strand it. Moving
         groups are the ones the game holds a handle to, and those are already
         protected above. */
      for (let i = 0; i < mark.length; i++) {
        const o = mark[i];
        keep.add(o);
        if (o.isSkinnedMesh || o.isInstancedMesh) {
          let p = o.parent;
          while (p && p !== scene) { keep.add(p); p = p.parent; }
        }
      }

      /* 3 · bucket what is left by material and slice */
      const buckets = new Map();
      const centre = new THREE.Vector3();
      scene.traverse((o) => {
        if (!o.isMesh || keep.has(o)) return;
        const g = o.geometry;
        if (!g || !g.attributes || !g.attributes.position) return;
        if (!g.boundingSphere) g.computeBoundingSphere();
        if (!g.boundingSphere) return;
        centre.copy(g.boundingSphere.center).applyMatrix4(o.matrixWorld);
        const key = o.material.uuid + '|' + Math.round(centre.z / BAND);
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push(o);
      });

      /* 4 · merge, then swap in one mesh per bucket (built first, swapped
             after, so a failed merge cannot leave a hole in the alley) */
      let mergedCount = 0;
      let removed = 0;
      for (const list of buckets.values()) {
        if (list.length < 4) continue;
        const geos = [];
        let bad = false;
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          let g;
          try {
            g = o.geometry.clone().applyMatrix4(o.matrixWorld);
          } catch (e) { bad = true; break; }
          for (const k of Object.keys(g.attributes)) {
            if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
          }
          if (!g.attributes.normal) g.computeVertexNormals();
          if (!g.attributes.uv) {
            g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
          }
          geos.push(g);
        }
        if (bad) { geos.forEach((g) => g.dispose()); continue; }
        /* mergeGeometries insists every entry agree on indexing */
        if (geos.some((g) => !g.index)) {
          for (let i = 0; i < geos.length; i++) {
            if (geos[i].index) {
              const flat = geos[i].toNonIndexed();
              geos[i].dispose();
              geos[i] = flat;
            }
          }
        }
        let merged;
        try {
          merged = mergeGeometries(geos, false);
        } catch (e) { merged = null; }
        geos.forEach((g) => g.dispose());
        if (!merged) continue;
        const one = new THREE.Mesh(merged, list[0].material);
        one.castShadow = list.some((o) => o.castShadow);
        one.receiveShadow = list.some((o) => o.receiveShadow);
        one.matrixAutoUpdate = false;
        one.updateMatrix();
        one.name = 'batched';
        scene.add(one);
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          if (o.parent) o.parent.remove(o);
          o.geometry.dispose();
        }
        mergedCount++;
        removed += list.length;
      }
      this._batchStats = { batches: mergedCount, removed };
      if (removed) console.info(`[world] static batch: ${removed} meshes → ${mergedCount} draw groups`);
    } catch (err) {
      console.warn('[world] static batching skipped:', err && err.message);
    }
  }

  mergeGroupByMaterial(g) {
    const buckets = new Map();
    for (const o of g.children) {
      if (!o.isMesh || Array.isArray(o.material)) continue;
      if (!buckets.has(o.material)) buckets.set(o.material, []);
      buckets.get(o.material).push(o);
    }
    for (const [mat, meshes] of buckets) {
      if (meshes.length < 2) continue;
      let geos = meshes.map((m) => {
        m.updateMatrix();
        const gg = m.geometry.clone().applyMatrix4(m.matrix);
        for (const k of Object.keys(gg.attributes)) {
          if (k !== 'position' && k !== 'normal' && k !== 'uv') gg.deleteAttribute(k);
        }
        if (!gg.attributes.normal) gg.computeVertexNormals();
        if (!gg.attributes.uv) {
          gg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(gg.attributes.position.count * 2), 2));
        }
        return gg;
      });
      if (geos.some((x) => !x.index)) {
        geos = geos.map((x) => {
          if (x.index) { const n = x.toNonIndexed(); x.dispose(); return n; }
          return x;
        });
      }
      const merged = mergeGeometries(geos, false);
      geos.forEach((x) => x.dispose());
      if (!merged) continue;
      for (const m of meshes) g.remove(m);
      const one = new THREE.Mesh(merged, mat);
      one.castShadow = meshes.some((m) => m.castShadow);
      one.receiveShadow = meshes.some((m) => m.receiveShadow);
      g.add(one);
    }
    return g;
  }

  addSconce(x, y, z, color) {
    /* A wall lamp is a backplate, a swan-neck arm and a caged shade. The old
       version was a 28 cm slab with a glowing bead beside it — from the street
       it read as a lit box floating off the wall. Built along local +X and
       turned to face the alley, so both walls get the same fixture. */
    const dir = x > 0 ? -1 : 1;                   // world direction out of the wall
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = dir > 0 ? 0 : Math.PI;
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x1e2126, metalness: 0.8, roughness: 0.44, envMapIntensity: 0.8 });

    // backplate flush to the wall
    const plate = new THREE.Mesh(extrudedSlab(0.13, 0.19, 0.028, { radius: 0.026, bevel: 0.006 }), ironMat);
    plate.rotation.y = Math.PI / 2;
    plate.position.x = 0.016;
    g.add(plate);
    for (const dy of [-0.062, 0.062]) {            // two fixing bolts
      const bolt = new THREE.Mesh(new THREE.IcosahedronGeometry(0.011, 0), this.metalRust);
      bolt.position.set(0.032, dy, 0);
      g.add(bolt);
    }
    // swan-neck arm
    const armPts = [
      new THREE.Vector3(0.02, 0.06, 0),
      new THREE.Vector3(0.13, 0.15, 0),
      new THREE.Vector3(0.26, 0.155, 0),
      new THREE.Vector3(0.345, 0.09, 0),
    ];
    g.add(new THREE.Mesh(tubeGeometry(armPts, 0.017, 20, 6), ironMat));
    // caged shade — a lathe dome with visible bars around the bulb
    const shade = new THREE.Mesh(loftGeometry([
      { y: 0, rx: 0.115, rz: 0.115 },
      { y: 0.045, rx: 0.105, rz: 0.105 },
      { y: 0.105, rx: 0.062, rz: 0.062 },
      { y: 0.135, rx: 0.028, rz: 0.028 },
    ], 16, { capBottom: false, capTop: true }), ironMat);
    shade.position.set(0.345, 0.0, 0);
    g.add(shade);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.116, 0.008, 5, 18), ironMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0.345, 0.0, 0);
    g.add(ring);
    for (let i = 0; i < 4; i++) {                  // cage bars
      const a = (i / 4) * Math.PI * 2 + 0.4;
      g.add(new THREE.Mesh(tubeGeometry([
        new THREE.Vector3(0.345 + Math.cos(a) * 0.112, -0.004, Math.sin(a) * 0.112),
        new THREE.Vector3(0.345 + Math.cos(a) * 0.070, 0.085, Math.sin(a) * 0.070),
      ], 0.006, 6, 4), ironMat));
    }
    // bulb under the shade
    const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.042, 1), this.warmBulb);
    bulb.position.set(0.345, 0.006, 0);
    g.add(bulb);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color, transparent: true, opacity: 0.34,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.position.set(0.345, 0.0, 0);
    glow.scale.set(0.62, 0.62, 1);
    g.add(glow);
    /* 10 little iron parts per lamp x 7 lamps was ~70 draw calls for no visual
       gain: bake them into one geometry per fixture. */
    this.mergeGroupByMaterial(g);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(g);

    /* Seven fixtures, three lamps. Adding one real light per fixture cost
       seven analytic point lights per fragment; instead three lights walk to
       whichever fixtures are nearest, so the wall is lit end to end without
       paying for lights the fog would have eaten anyway. */
    this._sconceFixtures = this._sconceFixtures || [];
    this._sconceFixtures.push({ x: x + dir * 0.345, y, z, color });
    this._sconceLights = this._sconceLights || [];
    if (this._sconceLights.length < 3) {
      const pl = new THREE.PointLight(color, 26, 7.0, 1.8);
      pl.position.set(x + dir * 0.345, y, z);
      this.scene.add(pl);
      this._sconceLights.push({ light: pl, base: 26, seed: Math.random() * 10, z: z, on: true });
    }
  }

  addPipeRun(x, y, z0, z1, r) {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      pts.push(new THREE.Vector3(x + Math.sin(t * 9) * 0.015, y + Math.sin(t * 4) * 0.02, THREE.MathUtils.lerp(z0, z1, t)));
    }
    const pipe = new THREE.Mesh(tubeGeometry(pts, r, 180, 8), this.metalRust);
    pipe.castShadow = false;
    this.scene.add(pipe);
    const bracketGeo = new THREE.TorusGeometry(r + 0.022, 0.012, 5, 12, Math.PI * 1.4);
    const bracketMat = this.metalDark;
    for (let z = z0 - 2; z > z1; z -= 7) {
      const b = new THREE.Mesh(bracketGeo, bracketMat);
      b.rotation.y = Math.PI / 2;
      b.position.set(x + (x > 0 ? 0.02 : -0.02), y, z);
      this.scene.add(b);
    }
  }

  addACUnit(x, y, z, s) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(extrudedSlab(0.62 * s, 0.42 * s, 0.26, { radius: 0.035, bevel: 0.01 }),
      new THREE.MeshStandardMaterial({ color: 0x8b8d8a, roughness: 0.66, metalness: 0.35 }));
    g.add(body);
    const grilleTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#5d6062'; ctx.fillRect(0, 0, 128, 128);
      ctx.strokeStyle = 'rgba(10,10,12,.65)'; ctx.lineWidth = 3;
      for (let i = 8; i < 128; i += 9) { ctx.beginPath(); ctx.moveTo(8, i); ctx.lineTo(120, i); ctx.stroke(); }
      ctx.fillStyle = 'rgba(20,20,24,.5)'; ctx.beginPath(); ctx.arc(96, 96, 18, 0, 7); ctx.fill();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const grille = new THREE.Mesh(new THREE.PlaneGeometry(0.54 * s, 0.34 * s), new THREE.MeshStandardMaterial({ map: grilleTex, roughness: 0.6, metalness: 0.4 }));
    const dir = x > 0 ? -1 : 1;
    grille.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    grille.position.x = dir * 0.135;
    g.add(grille);
    const bracket = new THREE.Mesh(extrudedSlab(0.5 * s, 0.06, 0.3), this.metalDark);
    bracket.position.y = -0.26 * s;
    g.add(bracket);
    g.position.set(x, y, z);
    g.rotation.y = dir > 0 ? 0 : Math.PI;
    this.scene.add(g);
  }

  /* ==================================================================
     MISSING PERSONS BOARD
     ================================================================== */
  buildBoard() {
    const g = new THREE.Group();
    g.position.set(0, 1.55, 12.22);

    const frame = new THREE.Mesh(extrudedSlab(2.02, 1.44, 0.07, { radius: 0.02, bevel: 0.012 }),
      new THREE.MeshStandardMaterial({ color: 0x2c2f35, metalness: 0.72, roughness: 0.48, envMapIntensity: 0.7 }));
    g.add(frame);

    this.boardTex = createMissingBoardTexture();
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(1.88, 1.293),
      new THREE.MeshPhysicalMaterial({
        map: this.boardTex, emissiveMap: this.boardTex, emissive: 0xffffff, emissiveIntensity: 0.17,
        roughness: 0.42, metalness: 0.06, clearcoat: 0.55, clearcoatRoughness: 0.3,
      })
    );
    board.rotation.y = Math.PI;
    board.position.z = -0.075;
    g.add(board);
    this.boardMesh = board;

    // hover glow laid exactly over each poster — the selection feedback lives
    // in the world, on the board itself
    this.posterHover = {};
    const posterW = 0.705, posterH = 1.10;
    for (const [key, cx] of [['student', -0.470], ['adult', 0.470]]) {
      const q = new THREE.Mesh(
        new THREE.PlaneGeometry(posterW, posterH),
        new THREE.MeshBasicMaterial({
          color: 0xffe2ae, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      q.position.set(cx, 0.04, -0.070);
      q.rotation.y = Math.PI;
      g.add(q);
      this.posterHover[key] = q;
    }

    // a warm rim that ignites around the chosen poster
    this.posterRing = {};
    for (const [key, cx] of [['student', -0.470], ['adult', 0.470]]) {
      const ring = new THREE.Mesh(
        new THREE.PlaneGeometry(posterW + 0.05, posterH + 0.05),
        new THREE.MeshBasicMaterial({
          color: 0xffc978, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      ring.position.set(cx, 0.04, -0.078);
      ring.rotation.y = Math.PI;
      g.add(ring);
      this.posterRing[key] = ring;
    }
    this._hoverKey = null;

    /* ---- the wall around it ------------------------------------------
       A pinned notice this size does not float on a blank wall: it hangs
       under a pressed-steel canopy, beside a conduit and a meter box, on
       block work with paper taped up around it. */
    const wallG = new THREE.Group();
    wallG.position.set(0, 0, 0);

    // canopy over the board, its underside catching the lamp
    const canopy = new THREE.Mesh(extrudedSlab(2.35, 0.05, 0.52, { radius: 0.015, bevel: 0.008 }), this.metalRust);
    canopy.position.set(0, 2.34, 12.04);
    canopy.rotation.x = -0.07;
    wallG.add(canopy);
    for (const sx of [-1, 1]) {
      wallG.add(new THREE.Mesh(tubeGeometry([
        new THREE.Vector3(sx * 0.92, 0.0, 12.28), new THREE.Vector3(sx * 0.92, 0.0, 11.82),
        new THREE.Vector3(sx * 0.92, 0.34, 12.26),
      ], 0.013, 12, 5), this.metalRust));
    }

    // block-work plinth at the foot of the wall
    const plinth = new THREE.Mesh(extrudedSlab(5.1, 0.34, 0.16, { radius: 0.01, bevel: 0.006 }), this.wallMatDark);
    plinth.position.set(0, 0.17, 12.24);
    wallG.add(plinth);

    // meter box + conduit on the wall beside the board
    const meter = new THREE.Mesh(extrudedSlab(0.26, 0.36, 0.12, { radius: 0.014, bevel: 0.006 }),
      new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.74, metalness: 0.32 }));
    meter.position.set(1.62, 1.32, 12.25);
    wallG.add(meter);
    wallG.add(new THREE.Mesh(tubeGeometry([
      new THREE.Vector3(1.62, 1.50, 12.235), new THREE.Vector3(1.62, 2.7, 12.225), new THREE.Vector3(1.72, 3.3, 12.245),
    ], 0.017, 18, 6), this.metalRust));

    // breathing vent, high on the wall
    const vent = new THREE.Mesh(extrudedSlab(0.5, 0.34, 0.07, { radius: 0.012, bevel: 0.005 }), this.metalDark);
    vent.position.set(-1.72, 3.05, 12.26);
    wallG.add(vent);
    for (let i = 0; i < 5; i++) {
      const slat = new THREE.Mesh(extrudedSlab(0.44, 0.026, 0.02, { radius: 0.006, bevel: 0.003 }), this.metalRust);
      slat.position.set(-1.72, 2.94 + i * 0.055, 12.222);
      slat.rotation.x = -0.5;
      wallG.add(slat);
    }

    /* taped-up paper around the pinned notice: a wall like this never has
       exactly one sheet on it */
    const scrapCanvas = document.createElement('canvas');
    scrapCanvas.width = 128; scrapCanvas.height = 168;
    const sctx = scrapCanvas.getContext('2d');
    sctx.fillStyle = '#cfc7b2'; sctx.fillRect(0, 0, 128, 168);
    sctx.fillStyle = 'rgba(30,28,24,.62)';
    sctx.font = 'bold 15px monospace';
    sctx.fillText('注意', 12, 30);
    for (let y = 52; y < 150; y += 11) {
      sctx.fillStyle = 'rgba(40,38,32,.34)';
      sctx.fillRect(12, y, 70 + ((y * 7) % 30), 3);
    }
    sctx.strokeStyle = 'rgba(150,40,40,.55)'; sctx.lineWidth = 3;
    sctx.strokeRect(9, 9, 110, 150);
    const scrapTex = new THREE.CanvasTexture(scrapCanvas);
    scrapTex.colorSpace = THREE.SRGBColorSpace;
    const scrapMat = new THREE.MeshStandardMaterial({ map: scrapTex, roughness: 0.95, side: THREE.DoubleSide });
    const scraps = [[-1.30, 1.62, 0.34, 0.30, 0.40], [-1.05, 1.15, -0.18, 0.22, 0.29], [1.15, 2.05, 0.12, 0.26, 0.34]];
    for (const [x, y, rz, w, h] of scraps) {
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 3, 3), scrapMat);
      const pp = paper.geometry.attributes.position;
      for (let i = 0; i < pp.count; i++) pp.setZ(i, Math.sin(pp.getX(i) * 12) * 0.006);   // a slight curl
      paper.geometry.computeVertexNormals();
      paper.rotation.z = rz;
      paper.position.set(x, y, 12.262);
      wallG.add(paper);
    }

    // strips of tape holding the notice at its corners
    const tapeMat = new THREE.MeshPhysicalMaterial({
      color: 0xc9c3b2, roughness: 0.42, transparent: true, opacity: 0.26,
      clearcoat: 0.4, side: THREE.DoubleSide, depthWrite: false,
    });
    for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const tape = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 0.058), tapeMat);
      tape.rotation.z = sx * sy * 0.7;
      tape.position.set(sx * 0.90, 1.55 + sy * 0.62, 12.132);
      wallG.add(tape);
    }

    wallG.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(wallG);

    // corner bolts
    const boltGeo = new THREE.IcosahedronGeometry(0.022, 1);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const bolt = new THREE.Mesh(boltGeo, this.metalDark);
      bolt.position.set(sx * 0.93, sy * 0.66, -0.075);
      g.add(bolt);
    }

    // hooded lamp above board
    const hood = new THREE.Mesh(extrudedSlab(0.5, 0.09, 0.22, { radius: 0.03, bevel: 0.01 }), this.metalDark);
    hood.position.set(0, 1.55, 0.12);
    hood.rotation.x = 0.16;
    g.add(hood);
    const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.055, 1), this.warmBulb);
    bulb.position.set(0, 1.5, 0.1);
    g.add(bulb);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffcc8a, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.position.copy(bulb.position);
    glow.scale.set(0.9, 0.9, 1);
    g.add(glow);

    // conduit feeding the lamp
    const conduit = new THREE.Mesh(tubeGeometry([
      new THREE.Vector3(0.24, 1.6, 0.1), new THREE.Vector3(0.26, 1.9, 0.12), new THREE.Vector3(0.26, 2.4, 0.1),
    ], 0.018, 12, 5), this.metalRust);
    g.add(conduit);

    this.scene.add(g);
    this.boardGroup = g;
    this.boardWorldPos = new THREE.Vector3(0, 1.62, 12.15);
  }

  /* ==================================================================
     DIFFICULTY TAGS — four enamelled plates bolted to the end wall beside
     the missing-persons board. They are part of the alley, lit by their own
     small lamp, and they are chosen the same way the posters are: by
     looking at one.
     ================================================================== */
  buildDifficultyTags() {
    const g = new THREE.Group();
    g.position.set(0, 0, 12.24);

    this.diffTags = {};
    this.diffTagMeshes = [];
    this._diffSelected = 'professional';
    this._diffHover = null;

    const layout = [
      { key: 'amateur',      x: -1.22, y: 2.02 },
      { key: 'professional', x: -1.22, y: 1.54 },
      { key: 'nightmare',    x:  1.22, y: 2.02 },
      { key: 'hell',         x:  1.22, y: 1.54 },
    ];

    for (const spot of layout) {
      const holder = new THREE.Group();
      holder.position.set(spot.x, spot.y, 0);

      // the plate itself: a thin slab with a bevel, so it catches the lamp
      const back = new THREE.Mesh(
        extrudedSlab(0.47, 0.395, 0.030, { radius: 0.014, bevel: 0.009 }),
        new THREE.MeshStandardMaterial({
          color: 0x1b1e24, metalness: 0.82, roughness: 0.42, envMapIntensity: 0.8,
        })
      );
      back.rotation.y = Math.PI;
      holder.add(back);

      const tex = difficultyTagTexture(spot.key);
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(0.435, 0.365),
        new THREE.MeshStandardMaterial({
          map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.62,
          roughness: 0.44, metalness: 0.12, envMapIntensity: 0.5,
        })
      );
      face.rotation.y = Math.PI;
      face.position.z = -0.075;
      holder.add(face);

      // a hover wash, exactly like the posters get
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(0.47, 0.395),
        new THREE.MeshBasicMaterial({
          color: 0xffe2ae, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      glow.rotation.y = Math.PI;
      glow.position.z = -0.068;
      holder.add(glow);

      // selected: a rim that stays lit and a small lamp over the plate
      const rim = new THREE.Mesh(
        new THREE.PlaneGeometry(0.515, 0.445),
        new THREE.MeshBasicMaterial({
          color: 0xffb070, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      rim.rotation.y = Math.PI;
      rim.position.z = -0.062;
      holder.add(rim);

      const art = DIFFICULTY_ART.find((d) => d.key === spot.key);
      const tint = new THREE.Color(art ? art.ink : '#ffb070');
      const lamp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: tint.clone(), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      lamp.position.set(0, 0.285, -0.055);
      lamp.scale.set(0.44, 0.44, 1);
      holder.add(lamp);

      face.userData.level = spot.key;
      glow.userData.level = spot.key;
      back.userData.level = spot.key;
      this.diffTags[spot.key] = { face, glow, rim, lamp, back, tint, x: spot.x, y: spot.y };
      this.diffTagMeshes.push(face, back);
      g.add(holder);
    }

    this.scene.add(g);
    this.diffTagGroup = g;
    this.setDifficultyTag('professional', true);
  }

  /** hover wash on one plate (null clears) */
  setDifficultyHover(key) {
    if (key === this._diffHover) return;
    this._diffHover = key;
    for (const k in this.diffTags) {
      const t = this.diffTags[k];
      const target = k === key ? 0.16 : 0;
      t.glow.material.opacity = target;
      t.face.material.emissiveIntensity = k === this._diffSelected ? 1.05 : (k === key ? 0.92 : 0.62);
    }
  }

  /** the chosen plate keeps a warm rim and a lit lamp */
  setDifficultyTag(key, silent = false) {
    if (!this.diffTags[key]) return;
    this._diffSelected = key;
    for (const k in this.diffTags) {
      const t = this.diffTags[k];
      const on = k === key;
      t.rim.material.opacity = on ? 0.24 : 0;
      t.lamp.material.opacity = on ? 0.85 : 0;
      t.face.material.emissiveIntensity = on ? 1.05 : 0.62;
      if (on) { t.rim.material.color.copy(t.tint); t.lamp.material.color.copy(t.tint); }
    }
    if (!silent) this.setDifficultyHover(this._diffHover);
  }

  /** raycast the plates; returns 'amateur' | 'professional' | ... | null */
  difficultyAt(raycaster) {
    if (!this.diffTagMeshes || !this.diffTagMeshes.length) return null;
    const hit = raycaster.intersectObjects(this.diffTagMeshes, false)[0];
    return hit ? hit.object.userData.level : null;
  }

  /* ==================================================================
     UTILITY POLE + STREET LAMP
     ================================================================== */
  /** only the nearest sconces burn: same light budget, lit stretches all the way down the alley */
  alignSconces(pz) {
    /* Move the three real lamps onto the three nearest fixtures. The light
       count never changes, so the shaders never recompile, and only three
       point lights are ever in the fragment shader. */
    const F = this._sconceFixtures, L = this._sconceLights;
    if (!F || !L || !L.length) return;
    const order = F.map((f, i) => ({ i, d: Math.abs(f.z - pz) })).sort((a, b) => a.d - b.d);
    let changed = false;
    for (let k = 0; k < L.length; k++) {
      const idx = order[k] ? order[k].i : -1;
      if (L[k].fixture !== idx) { L[k].fixture = idx; changed = true; }
    }
    if (!changed) return;
    for (let k = 0; k < L.length; k++) {
      const f = F[L[k].fixture];
      if (!f) continue;
      L[k].light.position.set(f.x, f.y, f.z);
      L[k].z = f.z;
      L[k].light.color.setHex(f.color);
    }
  }

  /** keep the one sodium light on the fixture that is nearest the player */
  alignLamp(pz) {
    if (!this.lamp || !this.poleFixtures || !this.poleFixtures.length) return;
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.poleFixtures.length; i++) {
      const d = Math.abs(this.poleFixtures[i].position.z - pz);
      if (d < bd) { bd = d; best = i; }
    }
    if (best === this._lampIdx) return;
    this._lampIdx = best;
    if (this.lamp.shadow) this.lamp.shadow.needsUpdate = true;
    if (!this._lampHome) {
      this._lampHome = { x: this.lamp.position.x, y: this.lamp.position.y, z: this.lamp.position.z };
      this._lampTgt = { x: this.lamp.target.position.x, y: this.lamp.target.position.y, z: this.lamp.target.position.z };
    }
    const dz = this.poleFixtures[best].position.z - (this.poleGroup ? this.poleGroup.position.z : 0);
    this.lamp.position.set(this._lampHome.x, this._lampHome.y, this._lampHome.z + dz);
    this.lamp.target.position.set(this._lampTgt.x, this._lampTgt.y, this._lampTgt.z + dz);
    if (this.lampGlow) this.lampGlow.position.copy(this.lamp.position);
  }

  buildPole() {
    const g = new THREE.Group();
    g.position.set(2.22, 0, -5.2);

    const profile = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      profile.push(new THREE.Vector2(0.17 - t * 0.062 + Math.sin(t * 22) * 0.002, t * 7.6));
    }
    profile.unshift(new THREE.Vector2(0, 0));
    profile.push(new THREE.Vector2(0, 7.6));
    const poleGeo = new THREE.LatheGeometry(profile, 20);
    poleGeo.computeVertexNormals();
    const poleMat = new THREE.MeshStandardMaterial({
      map: cloneTex(this.wallTex.map, 1, 3),
      normalMap: cloneTex(this.wallTex.normalMap, 1, 3),
      color: 0x8e8f93, roughness: 0.84, metalness: 0.08,
    });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.castShadow = true;
    pole.receiveShadow = true;
    g.add(pole);

    // concrete base collar
    const base = new THREE.Mesh(loftGeometry([
      { y: 0, rx: 0.26, rz: 0.26 }, { y: 0.12, rx: 0.22, rz: 0.22 }, { y: 0.34, rx: 0.2, rz: 0.2 },
    ], 20), this.wallMatDark);
    base.castShadow = true;
    g.add(base);

    // transformer drum
    const drum = new THREE.Mesh(loftGeometry([
      { y: 0, rx: 0.21, rz: 0.21 }, { y: 0.06, rx: 0.27, rz: 0.27 }, { y: 0.64, rx: 0.27, rz: 0.27 },
      { y: 0.7, rx: 0.21, rz: 0.21 },
    ], 18), new THREE.MeshStandardMaterial({ color: 0x6d6a63, roughness: 0.72, metalness: 0.45 }));
    drum.position.y = 4.75;
    drum.castShadow = true;
    g.add(drum);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.275, 0.018, 6, 22), this.metalRust);
    band.rotation.x = Math.PI / 2;
    band.position.y = 4.95;
    g.add(band);

    // crossarm (extruded, not a box)
    const armShape = new THREE.Shape();
    armShape.moveTo(-0.04, 0); armShape.lineTo(0.04, 0); armShape.lineTo(0.055, -0.075); armShape.lineTo(-0.055, -0.075);
    armShape.closePath();
    const armGeo = new THREE.ExtrudeGeometry(armShape, { depth: 1.5, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2 });
    const arm = new THREE.Mesh(armGeo, this.metalRust);
    arm.rotation.y = Math.PI / 2;
    arm.position.set(0.6, 6.9, 0);
    arm.castShadow = true;
    g.add(arm);

    // insulators (lathe)
    const insGeo = loftGeometry([
      { y: 0, rx: 0.055, rz: 0.055 }, { y: 0.03, rx: 0.085, rz: 0.085 }, { y: 0.07, rx: 0.06, rz: 0.06 },
      { y: 0.1, rx: 0.085, rz: 0.085 }, { y: 0.14, rx: 0.05, rz: 0.05 },
    ], 12);
    const insMat = new THREE.MeshPhysicalMaterial({ color: 0xcfd2d6, roughness: 0.22, clearcoat: 0.8, metalness: 0.0 });
    for (let i = 0; i < 4; i++) {
      const ins = new THREE.Mesh(insGeo, insMat);
      ins.position.set(0.62 + (i % 2) * 0.12, 7.02, -0.5 + Math.floor(i / 2) * 1.05);
      g.add(ins);
    }

    /* ---- luminaire -----------------------------------------------------
       The old head was a 22 cm thimble with an emissive ball inside, which
       read as an orange marble hanging in the air. A real arm-mounted alley
       lamp is: a tapered arm off the pole, a shallow cast housing, a hinged
       lens frame, and a lens that glows instead of a bulb you can see. */
    const armPts = [
      new THREE.Vector3(0.02, 5.02, 0.02),
      new THREE.Vector3(-0.24, 5.13, 0.05),
      new THREE.Vector3(-0.52, 5.19, 0.08),
      new THREE.Vector3(-0.78, 5.18, 0.10),
      new THREE.Vector3(-0.90, 5.13, 0.10),
    ];
    const lampArm = new THREE.Mesh(tubeGeometry(armPts, 0.033, 30, 8), this.metalRust);
    lampArm.castShadow = true;
    g.add(lampArm);
    // arm collar where it meets the pole
    const collar = new THREE.Mesh(loftGeometry([
      { y: 0, rx: 0.052, rz: 0.052 }, { y: 0.05, rx: 0.062, rz: 0.062 }, { y: 0.09, rx: 0.05, rz: 0.05 },
    ], 14), this.metalRust);
    collar.rotation.z = -Math.PI / 2.15;
    collar.position.set(-0.1, 5.06, 0.03);
    g.add(collar);

    const headMat = new THREE.MeshStandardMaterial({ color: 0x4a4c50, metalness: 0.72, roughness: 0.46, envMapIntensity: 0.9 });
    // cast housing: a shallow tapered body, elongated along the arm
    const housing = new THREE.Mesh(loftGeometry([
      { y: 0, rx: 0.20, rz: 0.13 },
      { y: 0.05, rx: 0.245, rz: 0.155 },
      { y: 0.13, rx: 0.235, rz: 0.15 },
      { y: 0.20, rx: 0.16, rz: 0.11 },
      { y: 0.235, rx: 0.085, rz: 0.07 },
    ], 22, { capBottom: false, capTop: true }), headMat);
    housing.scale.x = 1.62;                    // cobra-head proportion
    housing.position.set(-0.87, 5.00, 0.10);
    housing.castShadow = true;
    g.add(housing);
    // hinged lens frame + rim
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.208, 0.017, 6, 30), headMat);
    rim.rotation.x = Math.PI / 2;
    rim.scale.set(1.62, 1.0, 1.0);
    rim.position.set(-0.87, 5.005, 0.10);
    g.add(rim);
    // the lens itself: warm, frosted, the actual light source you see
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0xffe6bd, emissive: 0xffb45e, emissiveIntensity: 1.9,
      roughness: 0.34, metalness: 0.0, transparent: true, opacity: 0.96,
    });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.185, 28), lensMat);
    lens.rotation.x = Math.PI / 2;
    lens.scale.x = 1.55;
    lens.position.set(-0.87, 5.012, 0.10);
    g.add(lens);
    // photocell can + hinge latch on top
    const cell = new THREE.Mesh(extrudedSlab(0.075, 0.05, 0.075, { radius: 0.02, bevel: 0.006 }), headMat);
    cell.position.set(-0.72, 5.245, 0.10);
    g.add(cell);
    const latch = new THREE.Mesh(extrudedSlab(0.05, 0.026, 0.05, { radius: 0.008, bevel: 0.004 }), this.metalDark);
    latch.position.set(-1.02, 5.20, 0.10);
    g.add(latch);
    // pole number plate
    const plateC = document.createElement('canvas');
    plateC.width = 64; plateC.height = 96;
    const pctx = plateC.getContext('2d');
    pctx.fillStyle = '#d8d4c6'; pctx.fillRect(0, 0, 64, 96);
    pctx.fillStyle = '#1a1a1c'; pctx.font = 'bold 24px monospace'; pctx.textAlign = 'center';
    pctx.fillText('月', 32, 34); pctx.fillText('2-1', 32, 64);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.2), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(plateC), roughness: 0.7 }));
    plate.rotation.y = -Math.PI / 2;
    plate.position.set(-0.14, 2.4, -0.16);
    g.add(plate);

    this.scene.add(g);
    this.poleGroup = g;

    /* The luminaire repeats once per loop. The SpotLight itself is a single
       light that snaps to whichever fixture is nearest the player: after a
       90 m wrap it lands on the fixture that is in the same place relative
       to the player, so the lighting of the street is identical before and
       after the transition — at the cost of one light, not three. */
    this.mergeGroupByMaterial(g);
    this.poleFixtures = [g];
    for (const dz of [-90, -180]) {
      const clone = g.clone(true);
      clone.position.z = g.position.z + dz;
      this.scene.add(clone);
      this.poleFixtures.push(clone);
    }

    /* the faux volumetric shaft that used to hang here was placed in WORLD
       space at x -0.87, three metres from the pole it was supposed to belong
       to, so it read as a lit cone with nothing above it. The SpotLight and
       the halo above carry the volume now — no orphan shaft. */

    // overhead wires from pole
    const wireMat = this.rubber;
    const runs = [
      [[2.2, 6.95, -4.3], [0.6, 5.4, -4.8], [-1.6, 4.7, -5.4], [-2.55, 4.4, -5.6]],
      [[2.2, 6.95, -5.9], [0.4, 5.5, -6.6], [-1.9, 4.9, -7.2], [-2.55, 4.6, -7.4]],
      [[2.2, 7.0, -5.2], [2.1, 6.7, -16], [2.4, 6.1, -30]],
    ];
    for (const r of runs) {
      const pts = r.map((p) => new THREE.Vector3(...p));
      const wire = new THREE.Mesh(tubeGeometry(pts, 0.013, 26, 5), wireMat);
      this.scene.add(wire);
    }
  }

  /* ==================================================================
     VENDING MACHINE — extruded cabinet, emissive glass, physical glow
     ================================================================== */
  /* ------------------------------------------------------------------
     BLANKET — the adult's containment item. A displaced cloth sheet laid
     on the ground, always on the wall opposite the vending machines.
     ------------------------------------------------------------------ */
  buildBlanket() {
    /* The containment blanket. It used to be one flat-shaded card that
       disappeared into the wet asphalt; this one is a 1.25 x 1.55 m quilt:
       a displaced sheet with real folds and a lift at one corner, a woven
       wool face with a checked weave printed into it, a bound hem running
       round the edge, and a heavy enough silhouette to cast its own shadow
       under the street lamp. */
    const g = new THREE.Group();

    const quiltTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#6d5b4a'; ctx.fillRect(0, 0, 256, 256);
      // woven base
      for (let i = 0; i < 256; i += 3) {
        ctx.fillStyle = i % 6 ? 'rgba(255,244,226,.05)' : 'rgba(0,0,0,.10)';
        ctx.fillRect(0, i, 256, 1.4);
        ctx.fillRect(i, 0, 1.4, 256);
      }
      // faded tartan check
      const bands = [26, 30, 78, 96, 150, 168, 214, 232];
      for (let b = 0; b < bands.length; b++) {
        ctx.fillStyle = b % 2 ? 'rgba(140,52,44,.30)' : 'rgba(40,52,68,.26)';
        ctx.fillRect(bands[b], 0, 7, 256);
        ctx.fillRect(0, bands[b], 256, 7);
      }
      // quilting stitches
      ctx.strokeStyle = 'rgba(232,224,206,.30)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i <= 256; i += 32) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
      }
      // wear
      const grd = ctx.createRadialGradient(128, 140, 10, 128, 128, 150);
      grd.addColorStop(0, 'rgba(20,16,12,.30)');
      grd.addColorStop(1, 'rgba(20,16,12,0)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, 256, 256);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    })();

    const quiltMat = new THREE.MeshPhysicalMaterial({
      map: quiltTex,
      normalMap: this.fabricTex ? this.fabricTex.normalMap : null,
      normalScale: new THREE.Vector2(0.55, 0.55),
      color: 0xbcae9a,          // the weave already carries the colour
      roughness: 0.94, metalness: 0.0,
      sheen: 0.55, sheenRoughness: 0.7, sheenColor: new THREE.Color(0x8f8272),
      envMapIntensity: 0.55,
      side: THREE.DoubleSide,
    });

    /* one sheet, folded: the height field does the work — a slack body, a
       fold ridge across the middle and one corner rolled back over itself */
    const W = 1.25, D = 1.55, SX = 34, SZ = 40;
    const geo = new THREE.PlaneGeometry(W, D, SX, SZ);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const u = x / W + 0.5, v = y / D + 0.5;
      let h = 0.020;
      h += Math.sin(u * Math.PI * 3.1) * 0.018 * Math.sin(v * Math.PI * 1.2);   // slack
      h += Math.sin(v * Math.PI * 2.4 + 0.6) * 0.010;
      // a raised fold running across the sheet
      const fold = Math.exp(-Math.pow((v - 0.62) * 7.0, 2));
      h += fold * 0.042 * Math.sin(u * Math.PI * 1.1 + 0.4);
      // corner turned back (upper-right)
      const cu = Math.max(0, u - 0.62), cv = Math.max(0, v - 0.60);
      const corner = Math.min(1, cu * 5.4) * Math.min(1, cv * 5.4);
      h += corner * 0.062;
      // edges settle to the ground so it does not look like a floating card
      const edge = Math.min(1, Math.min(u, 1 - u) * 9) * Math.min(1, Math.min(v, 1 - v) * 9);
      h = h * (0.42 + 0.58 * edge);
      pos.setZ(i, h);
    }
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2);
    const quilt = new THREE.Mesh(geo, quiltMat);
    quilt.castShadow = true;
    quilt.receiveShadow = true;
    g.add(quilt);

    /* bound hem: a rounded tube run round the perimeter so the silhouette
       has thickness instead of ending in a knife edge */
    const hemPts = [];
    {
      const hw = W / 2 + 0.004, hd = D / 2 + 0.004, r = 0.06;
      const corners = [[hw - r, hd - r, 0], [-(hw - r), hd - r, Math.PI / 2],
                       [-(hw - r), -(hd - r), Math.PI], [hw - r, -(hd - r), -Math.PI / 2]];
      // walk the rectangle, rounding each corner
      for (let c = 0; c < 4; c++) {
        const [cx, cz, a0] = corners[c];
        for (let i = 0; i <= 6; i++) {
          const a = a0 + (i / 6) * (Math.PI / 2);
          hemPts.push(new THREE.Vector3(cx + Math.cos(a) * r, 0.010 + (i % 2) * 0.003, cz + Math.sin(a) * r));
        }
      }
    }
    const hem = new THREE.Mesh(tubeGeometry(hemPts, 0.012, 96, 6, true), new THREE.MeshStandardMaterial({
      color: 0x3c3228, roughness: 0.96, metalness: 0.0,
    }));
    hem.castShadow = true;
    g.add(hem);

    /* two rolled corners: the sheet is not ironed flat onto the road */
    for (const [sx, sz] of [[-1, 1], [1, 1]]) {
      const roll = new THREE.Mesh(loftGeometry([
        { y: 0, rx: 0.075, rz: 0.042 }, { y: 0.035, rx: 0.080, rz: 0.046 }, { y: 0.070, rx: 0.072, rz: 0.040 },
      ], 12), quiltMat);
      roll.position.set(sx * (W / 2 - 0.09), 0.012, sz * (D / 2 - 0.10));
      roll.rotation.z = sx * 0.4;
      roll.castShadow = true;
      g.add(roll);
    }

    /* the machine's cold spill is what finds it: a soft bounce card under the
       cloth, invisible, so the quilt is never a black hole in the frame */
    const bounce = new THREE.PointLight(0xbfd8ff, 1.15, 3.1, 2.0);
    bounce.position.set(0.85, 0.95, -0.35);
    g.add(bounce);
    this.blanketBounce = bounce;

    g.position.set(-1.05, 0.0, -15.45);
    g.rotation.y = 0.42;
    g.visible = false;
    this.scene.add(g);

    this.blanket = { group: g, position: new THREE.Vector3(-1.05, 0.02, -15.45), z: -15.45 };
    this.interactables.push({
      kind: 'blanket', object: g,
      position: this.blanket.position, radius: 1.5, data: {},
    });
    return this.blanket;
  }

  showBlanket(z) {
    if (!this.blanket) return null;
    /* a missing argument used to set the whole blanket to NaN and make it
       invisible for the rest of the run */
    if (!Number.isFinite(z)) z = (this.blanket.z ?? -30);
    this.blanket.z = z;
    this.blanket.position.set(-1.05, 0.02, z + 0.05);
    this.blanket.group.position.set(-1.05, 0.0, z + 0.05);
    this.blanket.group.rotation.y = 0.42;
    this.blanket.group.visible = true;
    return this.blanket;
  }

  hideBlanket() {
    if (this.blanket) this.blanket.group.visible = false;
  }

  /* a student bought one: that slot in the display goes dark */
  takeVendingCandy(z) {
    const rows = this._vendingCandies;
    if (!rows) return;
    for (let i = 0; i < rows.length; i++) {
      if (Math.abs(rows[i].z - z) > 0.01) continue;
      const next = rows[i].candies.find((c) => c.visible);
      if (next) next.visible = false;
      return;
    }
  }

  buildVending(z, theme) {
    const g = new THREE.Group();
    g.userData.vending = !!MODEL_URLS.vendingMachine;   // see batchStatic()
    g.position.set(2.16, 0, z);
    g.rotation.y = -Math.PI / 2;

    const baseMat = theme === 'blue'
      ? new THREE.MeshStandardMaterial({ color: 0x24445e, metalness: 0.7, roughness: 0.34, envMapIntensity: 1.0 })
      : new THREE.MeshStandardMaterial({ color: 0x6b1f2a, metalness: 0.7, roughness: 0.34, envMapIntensity: 1.0 });

    const cabinet = new THREE.Mesh(extrudedSlab(1.0, 1.94, 0.78, { radius: 0.055, bevel: 0.016 }), baseMat);
    cabinet.position.y = 1.07;
    cabinet.castShadow = true;
    cabinet.receiveShadow = true;
    g.add(cabinet);

    const plinth = new THREE.Mesh(extrudedSlab(1.04, 0.12, 0.82, { radius: 0.02, bevel: 0.006 }), this.metalDark);
    plinth.position.y = 0.06;
    g.add(plinth);

    const front = vendingFrontTexture(theme);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.84, 1.34),
      new THREE.MeshStandardMaterial({
        /* 3.0 was past the ACES shoulder: every printed panel clipped to
           white and the machine read as a blank lightbox. 1.05 keeps the
           drink rows, prices and brand band legible while still being the
           brightest thing in the alley. */
        map: front, emissiveMap: front, emissive: 0xfff2e2, emissiveIntensity: 0.72,
        roughness: 0.24, metalness: 0.1, envMapIntensity: 1.1,
      })
    );
    panel.position.set(0, 1.16, 0.492);
    g.add(panel);

    /* The window is a real box, not a decal: the glass sits 6.4 cm proud of the
       backlit front, a bevel frame closes the gap, and the sweets stand on a
       rail inside it. Nothing about the cabinet itself moves. */
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 1.36), this.glassMat);
    glass.position.set(0, 1.16, 0.556);
    g.add(glass);

    const frameMat = theme === 'blue'
      ? new THREE.MeshStandardMaterial({ color: 0x2b4c66, metalness: 0.82, roughness: 0.26, envMapIntensity: 1.1 })
      : new THREE.MeshStandardMaterial({ color: 0x54202a, metalness: 0.82, roughness: 0.26, envMapIntensity: 1.1 });
    const barH = new THREE.Mesh(extrudedSlab(0.99, 0.055, 0.055, { radius: 0.014, bevel: 0.006 }), frameMat);
    const barH2 = barH.clone();
    barH.position.set(0, 1.858, 0.546);
    barH2.position.set(0, 0.462, 0.546);
    const barV = new THREE.Mesh(extrudedSlab(0.055, 1.45, 0.055, { radius: 0.014, bevel: 0.006 }), frameMat);
    const barV2 = barV.clone();
    barV.position.set(-0.452, 1.16, 0.546);
    barV2.position.set(0.452, 1.16, 0.546);
    g.add(barH, barH2, barV, barV2);

    // the shelf they stand on, and the sweets themselves
    const rail = new THREE.Mesh(extrudedSlab(0.76, 0.016, 0.05, { radius: 0.006, bevel: 0.003 }), this.metalDark);
    rail.position.set(0, 1.02, 0.512);
    g.add(rail);

    const candies = [];
    // two rows, the way a real machine merchandises: six sweets behind glass
    const rows = [
      { y: 1.10, xs: [-0.26, -0.09, 0.08, 0.25], s: 2.2 },
      { y: 1.34, xs: [-0.19, -0.01, 0.17], s: 1.9 },
    ];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let i = 0; i < row.xs.length; i++) {
        const candy = makeCandy(row.s, true);
        candy.position.set(row.xs[i], row.y, 0.505 + r * 0.012);
        candy.rotation.set(0.16, 0.6 + i * 1.27 + r, 0.12 - i * 0.06);
        candy.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        g.add(candy);
        candies.push(candy);
      }
    }
    this._vendingCandies.push({ z, candies });

    // brand header
    const headerMat = new THREE.MeshStandardMaterial({
      color: theme === 'blue' ? 0x0d3c62 : 0x5c0b16,
      emissive: theme === 'blue' ? 0x2f9fff : 0xff4055, emissiveIntensity: 0.8,
      roughness: 0.4, metalness: 0.3,
    });
    const header = new THREE.Mesh(extrudedSlab(0.95, 0.24, 0.06, { radius: 0.02, bevel: 0.008 }), headerMat);
    header.position.set(0, 1.98, 0.44);
    g.add(header);

    // selection buttons
    const btnGeo = extrudedSlab(0.075, 0.05, 0.02, { radius: 0.008, bevel: 0.003 });
    const btnMat = new THREE.MeshStandardMaterial({ color: 0x1b2b33, emissive: 0xffd166, emissiveIntensity: 0.65, roughness: 0.35 });
    for (let i = 0; i < 8; i++) {
      const b = new THREE.Mesh(btnGeo, btnMat);
      b.position.set(0.4, 1.72 - i * 0.105, 0.50);
      b.rotation.x = -Math.PI / 2;
      g.add(b);
    }

    // coin unit
    const coin = new THREE.Mesh(extrudedSlab(0.2, 0.31, 0.05, { radius: 0.02, bevel: 0.006 }), this.metalDark);
    coin.position.set(0.33, 0.66, 0.50);
    g.add(coin);
    const slot = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.1), new THREE.MeshBasicMaterial({ color: 0x050608 }));
    slot.position.set(0.33, 0.7, 0.528);
    g.add(slot);

    // glow + practical light
    /* The spilling light has to stand OUT in the alley. Left inside the
       cabinet it sat 24 cm from the backlit panel at 20 cd, and every incident
       pixel on the panel clipped: the machine read as a blank white sheet
       whatever the texture said. Now it is 0.9 m into the lane and gentler,
       which also puts a proper gradient across the road. */
    const light = new THREE.PointLight(theme === 'blue' ? 0xbfe6ff : 0xffb3bd, 11, 9.0, 1.7);
    light.position.set(0, 1.35, 1.42);
    if (this.minQuality) light.visible = false;
    g.add(light);
    const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: theme === 'blue' ? 0x9fdcff : 0xff8f9c,
      transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glowSprite.position.set(0, 1.25, 0.55);
    glowSprite.scale.set(1.7, 2.1, 1);
    g.add(glowSprite);

    this.scene.add(g);
    const frontWorld = new THREE.Vector3(-0.85, 1.0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0);
    this.vending.push({ group: g, light, z, theme, glowSprite });
    this.interactables.push({
      kind: 'vending', object: g, position: new THREE.Vector3(1.52, 0, z), radius: 1.7, data: { z, theme },
    });
  }

  /* ==================================================================
     STREET PROPS — trash bags, crates, plants, puddles of junk
     ================================================================== */
  buildStreetProps() {
    /* ------------------------------------------------------------------
       The alley's furniture. The old pass had six black blobs standing in
       for rubbish bags: untextured, unlit, reading as holes in the frame.
       What a Tokyo back lane actually has is a designated-bag pile, a
       galvanised can with a lid, flattened cardboard, and a bottle crate.
       ------------------------------------------------------------------ */
    const rnd = mulberry32(7723);

    /* ---- sack plastic: translucent liner, wrinkles, a knot ---- */
    const sackTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#c9c6b4';
      ctx.fillRect(0, 0, 256, 256);
      // crinkles
      for (let i = 0; i < 260; i++) {
        const x = rnd() * 256, y = rnd() * 256, len = 8 + rnd() * 34, a = rnd() * Math.PI;
        ctx.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,.5)' : 'rgba(90,88,78,.42)';
        ctx.lineWidth = 0.6 + rnd() * 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      // the printed band a designated bag carries
      ctx.fillStyle = 'rgba(190,180,140,.5)';
      ctx.fillRect(0, 96, 256, 26);
      ctx.fillStyle = 'rgba(60,60,54,.55)';
      ctx.font = 'bold 15px monospace';
      ctx.fillText('可燃ごみ  45L', 12, 116);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      return t;
    })();
    /* Black liner bags: dark, wet, high-sheen plastic with a corrugated
       normal map re-tiled tight so the surface reads as crumpled polythene
       rather than as an untextured rock. */
    const sackMat = new THREE.MeshPhysicalMaterial({
      map: sackTex,
      normalMap: SURFACES.ready ? retile(SURFACES.metal.normalMap, 5, 5) : null,
      normalScale: new THREE.Vector2(1.1, 1.1),
      color: 0x33343a, roughness: 0.38, metalness: 0.0,
      clearcoat: 0.85, clearcoatRoughness: 0.22,
      sheen: 0.6, sheenColor: new THREE.Color(0x8e9198),
      envMapIntensity: 1.1,
    });
    sackMat.map = sackMat.map.clone();
    sackMat.map.repeat.set(2.4, 2.4);
    sackMat.map.needsUpdate = true;
    const sackMatDirty = sackMat.clone();
    sackMatDirty.color = new THREE.Color(0x24252a);

    const bagSpots = [
      [1.82, -8.6, 0.34], [1.62, -9.15, 0.3], [1.9, -9.5, 0.26], [1.55, -9.9, 0.22],
      [-1.9, -30.5, 0.32], [-2.0, -31.1, 0.26], [2.0, -47.2, 0.3],
    ];
    for (let i = 0; i < bagSpots.length; i++) {
      const [x, z, r] = bagSpots[i];
      const geo = blobGeometry(r, 11, 8, { seed: 11 + i, amount: 0.34, squash: 0.78 });
      const bag = new THREE.Mesh(geo, i % 3 === 2 ? sackMatDirty : sackMat);
      bag.position.set(x, r * 0.72, z);
      bag.rotation.y = i * 1.7;
      bag.castShadow = true;
      bag.receiveShadow = true;
      this.scene.add(bag);
      // the tied neck: a pinched knot on top, which is what makes a bag a bag
      const knot = new THREE.Mesh(blobGeometry(r * 0.27, 8, 6, { seed: 40 + i, amount: 0.45 }), bag.material);
      knot.position.set(x + Math.sin(i) * 0.05, r * 1.28, z + Math.cos(i) * 0.05);
      knot.scale.set(1, 0.7, 1);
      knot.castShadow = true;
      this.scene.add(knot);
    }

    /* ---- galvanised rubbish bin ---- */
    const binBody = loftGeometry([
      { y: 0.00, rx: 0.235, rz: 0.235 },
      { y: 0.05, rx: 0.252, rz: 0.252 },
      { y: 0.52, rx: 0.268, rz: 0.268 },
      { y: 0.54, rx: 0.268, rz: 0.268 },
      { y: 0.56, rx: 0.262, rz: 0.262 },
    ], 26, { capBottom: true, capTop: false });
    const binRim = new THREE.TorusGeometry(0.262, 0.016, 6, 26);
    binRim.rotateX(Math.PI / 2);
    binRim.translate(0, 0.56, 0);
    const binBand = new THREE.TorusGeometry(0.262, 0.008, 5, 26);
    binBand.rotateX(Math.PI / 2);
    binBand.translate(0, 0.20, 0);
    const binGeo = mergeGeometries([binBody, binRim, binBand], false);
    const binMat = new THREE.MeshStandardMaterial({
      map: retile(SURFACES.ready ? SURFACES.metal.map : this.asphaltTex.map, 3, 1.4),
      normalMap: SURFACES.ready ? retile(SURFACES.metal.normalMap, 3, 1.4) : null,
      color: 0xb3b9bd, roughness: 0.42, metalness: 0.66, envMapIntensity: 1.2,
    });
    const lidGeo = loafLid();
    function loafLid() {
      const lid = loftGeometry([
        { y: 0.00, rx: 0.272, rz: 0.272 },
        { y: 0.035, rx: 0.278, rz: 0.278 },
        { y: 0.075, rx: 0.250, rz: 0.250 },
        { y: 0.095, rx: 0.150, rz: 0.150 },
      ], 24, { capBottom: false, capTop: true });
      const knob = new THREE.TorusGeometry(0.055, 0.011, 5, 12, Math.PI);
      knob.rotateY(Math.PI / 2);
      knob.translate(0, 0.115, 0);
      return mergeGeometries([lid, knob], false);
    }
    const binSpots = [[2.02, -10.9, 0.3], [-2.06, -30.8, -0.5], [2.0, -47.0, 0.9]];
    for (let i = 0; i < binSpots.length; i++) {
      const [x, z, ry] = binSpots[i];
      const g2 = new THREE.Group();
      g2.position.set(x, 0, z);
      g2.rotation.y = ry;
      const body = new THREE.Mesh(binGeo, binMat);
      body.castShadow = true; body.receiveShadow = true;
      g2.add(body);
      const lid = new THREE.Mesh(lidGeo, binMat);
      lid.position.set(0, 0.565, 0);
      lid.rotation.set(0.06, 0, 0.03);
      lid.castShadow = true;
      g2.add(lid);
      // a bag liner peeking over the rim
      const liner = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.18), sackMat);
      liner.position.set(0, 0.60, 0);
      liner.rotation.y = 0.6;
      g2.add(liner);
      this.scene.add(g2);
    }

    /* ---- flattened cardboard against the wall ---- */
    const cardTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#9a7c52'; ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 700; i++) {
        ctx.fillStyle = `rgba(${60 + rnd() * 40},${45 + rnd() * 30},${25 + rnd() * 20},.20)`;
        ctx.fillRect(rnd() * 128, rnd() * 128, 2, 1);
      }
      ctx.strokeStyle = 'rgba(60,44,28,.5)'; ctx.lineWidth = 2;
      ctx.strokeRect(10, 10, 108, 108);
      ctx.fillStyle = 'rgba(50,40,30,.55)';
      ctx.font = 'bold 12px monospace';
      ctx.fillText('ORANGE', 16, 40);
      ctx.fillText('宅配便', 16, 58);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const cardMat = new THREE.MeshStandardMaterial({ map: cardTex, color: 0xb59a72, roughness: 0.95, metalness: 0.0 });
    for (const [x, z, ry, w] of [[1.72, -10.4, 0.4, 0.7], [-1.85, -31.6, 1.2, 0.62], [1.8, -46.2, -0.3, 0.66]]) {
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 1.2, 4, 4), cardMat);
      const pos = sheet.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 9) * 0.012);
      sheet.geometry.computeVertexNormals();
      sheet.rotation.x = -Math.PI / 2 + 0.12;
      sheet.rotation.z = ry;
      sheet.position.set(x, 0.05, z);
      sheet.castShadow = true;
      this.scene.add(sheet);
    }

    // wooden crates near the second machine
    for (let i = 0; i < 3; i++) {
      const crate = new THREE.Mesh(extrudedSlab(0.5, 0.34, 0.4, { radius: 0.02, bevel: 0.01 }), this.woodMat);
      crate.position.set(1.9 + (i % 2) * 0.12, 0.17 + Math.floor(i / 2) * 0.34, -58.6 - i * 0.1);
      crate.rotation.y = i * 0.13;
      crate.castShadow = true;
      this.scene.add(crate);
    }

    // planter + dead shrub
    const pot = new THREE.Mesh(loftGeometry([
      { y: 0, rx: 0.16, rz: 0.16 }, { y: 0.3, rx: 0.21, rz: 0.21 }, { y: 0.36, rx: 0.22, rz: 0.22 },
    ], 14), new THREE.MeshStandardMaterial({ color: 0x5b4a3c, roughness: 0.9 }));
    pot.position.set(-2.16, 0, -14.2);
    pot.castShadow = true;
    this.scene.add(pot);
    for (let i = 0; i < 7; i++) {
      const twig = new THREE.Mesh(tubeGeometry([
        new THREE.Vector3(-2.16, 0.36, -14.2),
        new THREE.Vector3(-2.16 + Math.sin(i) * 0.16, 0.7 + i * 0.06, -14.2 + Math.cos(i) * 0.12),
        new THREE.Vector3(-2.16 + Math.sin(i) * 0.26, 1.0 + i * 0.07, -14.2 + Math.cos(i * 1.7) * 0.2),
      ], 0.008, 10, 4), new THREE.MeshStandardMaterial({ color: 0x29241d, roughness: 0.95 }));
      this.scene.add(twig);
    }

    // paper scraps / litter on wet asphalt
    /* Litter used to be untextured pale-grey planes: under the sodium lamp
       they clipped to pure white and read as blank cards dropped on the road.
       These carry printed newsprint and a torn edge, so they stay dark. */
    const paperTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 128, 128);
      // torn silhouette
      ctx.beginPath();
      ctx.moveTo(8, 12);
      for (let i = 0; i <= 8; i++) ctx.lineTo(8 + i * 14, 12 + (i % 2) * 7 + (i * 3) % 5);
      for (let i = 0; i <= 8; i++) ctx.lineTo(120 - (i % 2) * 6, 12 + i * 13);
      for (let i = 8; i >= 0; i--) ctx.lineTo(8 + i * 14, 118 - (i % 2) * 6);
      ctx.closePath();
      ctx.fillStyle = '#b8b3a4';
      ctx.fill();
      ctx.save(); ctx.clip();
      // newsprint columns
      ctx.fillStyle = 'rgba(35,32,28,.55)';
      for (let col = 0; col < 3; col++) {
        for (let y = 22; y < 116; y += 6) {
          const w = 20 + ((col * 7 + y) % 14);
          ctx.fillRect(12 + col * 38, y, w, 2);
        }
      }
      ctx.fillStyle = 'rgba(120,20,20,.5)';   // red print band
      ctx.fillRect(12, 16, 96, 4);
      ctx.restore();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    })();
    const paperMat = new THREE.MeshStandardMaterial({
      map: paperTex, color: 0x9a968c, roughness: 0.96, metalness: 0.0,
      side: THREE.DoubleSide, transparent: true, alphaTest: 0.35,
    });
    const rndLit = mulberry32(19);
    for (let i = 0; i < 18; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.1 + rndLit() * 0.13, 0.08 + rndLit() * 0.11), paperMat);
      p.rotation.x = -Math.PI / 2 + (rndLit() - 0.5) * 0.09;
      p.rotation.z = rndLit() * Math.PI;
      p.position.set((rndLit() - 0.5) * 4.2, 0.024 + rndLit() * 0.004, 10 - rndLit() * 80);
      this.scene.add(p);
    }

    // two distant street cones of light to imply the city beyond the fog
    this.addDistantGlow(0.5, -108, 0xffb070, 14, 7);
    this.addDistantGlow(-1.2, -118, 0xb0c4ff, 18, 6);
  }

  addLampCone(x, y, z) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 256;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, 'rgba(255,196,120,.5)');
    grad.addColorStop(0.35, 'rgba(255,190,110,.20)');
    grad.addColorStop(1, 'rgba(255,180,100,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = loftGeometry([
      { y: -2.9, rx: 1.12, rz: 1.12 },
      { y: -1.9, rx: 0.78, rz: 0.78 },
      { y: -0.95, rx: 0.40, rz: 0.40 },
      { y: 0, rx: 0.10, rz: 0.10 },
    ], 24, { capBottom: false, capTop: false });
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0xffc07a, transparent: true, opacity: 0.085,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide, fog: true,
    });
    const cone = new THREE.Mesh(geo, mat);
    cone.position.set(x, y, z);
    cone.renderOrder = 3;
    this.scene.add(cone);
    this.lampCone = cone;
  }

  addDistantGlow(x, z, color, w, h) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    const col = new THREE.Color(color);
    g.addColorStop(0, `rgba(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0},.8)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    m.position.set(x, h * 0.35, z);
    this.scene.add(m);
  }

  /* ==================================================================
     DISTANT CITY — silhouettes with lit windows behind the far wall
     ================================================================== */
  buildDistantCity() {
    const rnd = mulberry32(6);
    for (let i = 0; i < 7; i++) {
      const w = 6 + rnd() * 9;
      const h = 16 + rnd() * 20;
      const tex = windowTexture(30 + i, 8, 16);
      tex.repeat.set(1, h / 12);
      const mat = new THREE.MeshStandardMaterial({
        map: tex, color: 0x151821, roughness: 0.92, metalness: 0.02,
        emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.36,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      plane.position.set((i - 3) * 7.5, h / 2, -128 - i * 3.3);
      this.scene.add(plane);
    }
    // skyline behind the dead end too, so looking back isn't empty
    for (let i = 0; i < 3; i++) {
      const tex = windowTexture(80 + i, 6, 12);
      const mat = new THREE.MeshStandardMaterial({
        map: tex, color: 0x10131b, roughness: 0.95,
        emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.22,
      });
      const p = new THREE.Mesh(new THREE.PlaneGeometry(14, 20), mat);
      p.position.set((i - 1) * 11, 10, 27 + i * 4);
      p.rotation.y = Math.PI;
      this.scene.add(p);
    }
  }

  /* ==================================================================
     ATMOSPHERE — rain, dust, ground fog sheets
     ================================================================== */
  buildAtmosphere() {
    // rain streaks
    const count = this.rainCount;
    const rnd = mulberry32(42);
    if (count > 0) {
    /* The fall used to be integrated on the CPU: 8 400 float writes and a
       full 34 kB buffer upload every single frame. It is a shader now — one
       uniform per frame, no upload — which is how the count can go up to
       2 600 drops without costing a millisecond. */
    const H = 9.0;
    const positions = new Float32Array(count * 2 * 3);
    const ends = new Float32Array(count * 2);
    const vars = new Float32Array(count * 2 * 2);
    for (let i = 0; i < count; i++) {
      const x = (rnd() - 0.5) * 14;
      const y0 = rnd() * H;
      const z = (rnd() - 0.5) * 30;
      const len = 0.22 + rnd() * 0.34;
      const spd = 5 + rnd() * 6;
      for (let v = 0; v < 2; v++) {
        const k = i * 2 + v;
        positions[k * 3] = x; positions[k * 3 + 1] = y0; positions[k * 3 + 2] = z;
        ends[k] = v;
        vars[k * 2] = spd; vars[k * 2 + 1] = len;
      }
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    rainGeo.setAttribute('aVar', new THREE.BufferAttribute(vars, 2));
    rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, H * 0.5, 0), 26);
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHeight: { value: H },
        uColor: { value: new THREE.Color(0x93a9cc) },
        uOpacity: { value: 0.16 },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uHeight;
        attribute float aEnd;
        attribute vec2 aVar;
        varying float vA;
        void main() {
          vec3 p = position;
          float y = mod(p.y - uTime * aVar.x, uHeight);
          y -= aEnd * aVar.y;
          if (y < 0.0) y += uHeight;
          float k = 1.0 - y / uHeight;
          p.x += k * 0.30 + sin(uTime * 0.8 + position.z * 2.1) * 0.05;
          p.y = y;
          p.z += k * 0.10;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(0.0, 1.4, y) * (1.0 - smoothstep(uHeight * 0.62, uHeight, y))
             * (1.0 - smoothstep(3.0, 16.0, d));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vA;
        void main() {
          float a = uOpacity * vA;
          if (a < 0.002) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.rain = new THREE.LineSegments(rainGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
    }

    // dust motes that drift through the flashlight cone
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = new Float32Array(240 * 3);
    for (let i = 0; i < 240; i++) {
      dustPos[i * 3] = (rnd() - 0.5) * 6;
      dustPos[i * 3 + 1] = rnd() * 4;
      dustPos[i * 3 + 2] = (rnd() - 0.5) * 16;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    this.dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      color: 0xcfd8e8, size: 0.012, transparent: true, opacity: 0.5,
      sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.dust);

    // neutral haze sheets — quiet volumetric depth through the whole alley
    const hazeMat = new THREE.MeshBasicMaterial({
      map: this.fogTex, color: 0x93a4c8, transparent: true, opacity: 0.11,
      depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide,
    });
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 3), hazeMat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rnd() * Math.PI * 2;
      m.position.set((rnd() - 0.5) * 2, 0.22 + rnd() * 0.35, 2 - rnd() * 70);
      m.renderOrder = 2;
      this.scene.add(m);
      if (!this.minQuality) {
        this.hazeSheets = this.hazeSheets || [];
        this.hazeSheets.push(m);
      } else {
        m.visible = false;
      }
    }

    // pink ground fog sheets (hidden until the manifestation)
    this.fogSheets = [];
    for (let i = 0; i < 9; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.fogTex, color: 0xffa9c4, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.2), mat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rnd() * Math.PI * 2;
      m.position.set((rnd() - 0.5) * 3, 0.12 + rnd() * 0.4, -rnd() * 30);
      m.renderOrder = 4;
      this.scene.add(m);
      this.fogSheets.push({
        mesh: m, mat, baseY: m.position.y, seed: rnd() * 10,
        drift: 0.12 + rnd() * 0.2, spin: (rnd() - 0.5) * 0.06,
      });
    }
  }

  /* ==================================================================
     NEON CONVENIENCE-STORE DOOR (appears in the adult final phase)
     ================================================================== */
  buildNeonDoor() {
    const g = new THREE.Group();
    g.position.set(-2.48, 0, -40);
    g.rotation.y = Math.PI / 2;
    g.visible = false;

    const frame = new THREE.Mesh(extrudedSlab(1.5, 2.5, 0.16, { radius: 0.03, bevel: 0.01 }), this.metalDark);
    frame.position.y = 1.25;
    g.add(frame);

    const glassC = document.createElement('canvas');
    glassC.width = 256; glassC.height = 512;
    const gctx = glassC.getContext('2d');
    const lg = gctx.createLinearGradient(0, 0, 0, 512);
    lg.addColorStop(0, '#d8fbff');
    lg.addColorStop(0.4, '#8fe6f5');
    lg.addColorStop(1, '#e8ffff');
    gctx.fillStyle = lg;
    gctx.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 3; i++) {
      gctx.fillStyle = 'rgba(255,255,255,.5)';
      gctx.fillRect(18, 60 + i * 150, 220, 72);
      gctx.fillStyle = 'rgba(30,80,90,.55)';
      for (let k = 0; k < 7; k++) gctx.fillRect(24 + k * 30, 72 + i * 150, 18, 48);
    }
    gctx.fillStyle = 'rgba(255,255,255,.85)';
    gctx.font = '600 30px monospace';
    gctx.fillText('OPEN', 88, 480);
    const glassTex = new THREE.CanvasTexture(glassC);
    glassTex.colorSpace = THREE.SRGBColorSpace;
    const doorGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.9), new THREE.MeshStandardMaterial({
      map: glassTex, emissiveMap: glassTex, emissive: 0xffffff, emissiveIntensity: 1.4,
      roughness: 0.2, metalness: 0.0, transparent: true, opacity: 0.92,
    }));
    doorGlass.position.set(0.18, 1.2, 0.09);
    g.add(doorGlass);

    const signTex = neonSignTexture('コンビニ', '24H', '#ff2f6d', '#8ff4ff');
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 1.9), new THREE.MeshStandardMaterial({
      map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 1.7,
      transparent: true, roughness: 0.4,
    }));
    sign.position.set(-0.55, 1.8, 0.25);
    g.add(sign);

    const sign2 = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.32), new THREE.MeshStandardMaterial({
      map: neonSignTexture('出口', 'EXIT', '#8ff4ff', '#ff2f6d'), emissive: 0xffffff, emissiveIntensity: 1.2,
      transparent: true,
    }));
    sign2.position.set(0.15, 2.55, 0.2);
    g.add(sign2);

    const light = new THREE.PointLight(0xff4f86, 60, 13, 1.7);
    light.position.set(0.4, 1.8, 1.2);
    g.add(light);

    const spill = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 4.4), new THREE.MeshBasicMaterial({
      map: this.streakPink, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    spill.rotation.x = -Math.PI / 2;
    spill.position.set(0.5, 0.02, 1.4);
    g.add(spill);

    this.scene.add(g);
    this.neonDoor = { group: g, light, spill, z: -40, active: false };
  }

  setDoorAhead(playerZ) {
    if (!this.neonDoor) return;
    const z = Math.max(-104, Math.min(-12, playerZ - 21));
    this.neonDoor.group.position.z = z;
    this.neonDoor.z = z;
    this.neonDoor.group.visible = true;
    this.neonDoor.active = true;
    this.neonLight.position.set(-2.1, 2.0, z);
    this.neonLight.intensity = 55;
    this.neonLight.color.setHex(0xff2f6d);
    this.addStreak(-1.6, z, 0.9, 5, this.streakPink, 0.26, 0xff6f9e);
    this.interactables.push({
      kind: 'door', object: this.neonDoor.group,
      position: new THREE.Vector3(-2.0, 0, z), radius: 1.8, data: {},
    });
  }

  /* ==================================================================
     GLTF STREAMING + MATERIAL OVERRIDE ENGINE
     ================================================================== */
  async streamAssets() {
    const loader = new GLTFLoader();
    const load = (url) => new Promise((resolve) => loader.load(url, resolve, undefined, (err) => {
      console.warn('[GLTF] stream failed:', url, err);
      resolve(null);
    }));

    // Wall module: cloned around the alley if supplied.
    if (MODEL_URLS.concreteWall) {
      const gltf = await load(MODEL_URLS.concreteWall);
      if (gltf) {
        const proto = gltf.scene;
        proto.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = o.receiveShadow = true;
          o.material = this.overrideMaterial(o.material, 'concrete');
        });
        for (let z = 6; z > -110; z -= 8) {
          const clone = proto.clone(true);
          clone.position.set(-2.4, 0, z);
          clone.rotation.y = Math.PI / 2;
          this.scene.add(clone);
        }
        this.assetsLoaded.wall = true;
      }
    }

    // Utility pole
    if (MODEL_URLS.utilityPole) {
      const gltf = await load(MODEL_URLS.utilityPole);
      if (gltf) {
        const pole = gltf.scene;
        pole.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = o.receiveShadow = true;
          o.material = this.overrideMaterial(o.material, 'metal');
        });
        pole.position.set(2.22, 0, -5.2);
        pole.scale.setScalar(1);
        this.scene.add(pole);
        this.poleGroup.visible = false;
        this.assetsLoaded.pole = true;
      }
    }

    // Vending machine
    if (MODEL_URLS.vendingMachine) {
      const gltf = await load(MODEL_URLS.vendingMachine);
      if (gltf) {
        for (const [i, z] of [-15.5, -62].entries()) {
          const vm = gltf.scene.clone(true);
          vm.traverse((o) => {
            if (!o.isMesh) return;
            o.castShadow = o.receiveShadow = true;
            o.material = this.overrideMaterial(o.material, 'vending');
          });
          vm.position.set(2.2, 0, z);
          vm.rotation.y = -Math.PI / 2;
          this.scene.add(vm);
          if (this.vending[i]) this.vending[i].group.visible = false;
        }
        this.assetsLoaded.vending = true;
      }
    }
  }

  /** Force consistent PBR profiles onto every streamed mesh. */
  overrideMaterial(src, kind) {
    const base = src ? src.clone() : new THREE.MeshStandardMaterial();
    if ('map' in src) { /* keep scanned albedo */ }
    base.envMapIntensity = 0.7;
    if (kind === 'concrete') {
      base.metalness = 0.04; base.roughness = 0.88;
      base.normalScale = new THREE.Vector2(1.1, 1.1);
      base.color = new THREE.Color(0x9a9ba6);
    } else if (kind === 'metal') {
      base.metalness = Math.max(0.65, base.metalness ?? 0);
      base.roughness = THREE.MathUtils.clamp(base.roughness ?? 0.5, 0.25, 0.7);
    } else if (kind === 'vending') {
      base.metalness = 0.55; base.roughness = 0.35;
      base.color = new THREE.Color(0xd9dde4);
    }
    base.needsUpdate = true;
    return base;
  }

  /* ==================================================================
     RUNTIME CONTROLS
     ================================================================== */
  /* ------------------------------------------------------------------
     Is (x, z) standing in water? Flat array, squared distances, no
     allocations, no raycasts. Called on footfall only — a couple of times
     a second — so it is invisible in the frame budget.
     ------------------------------------------------------------------ */
  inPuddle(x, z) {
    const f = this._puddleFlat;
    if (!f) return false;
    for (let i = 0; i < f.length; i += 3) {
      const dx = x - f[i];
      const dz = z - f[i + 1];
      if (dx * dx + dz * dz <= f[i + 2]) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------
     ECHO-LOCATION — the alley opens into cross-streets at fixed points.
     echoAt(z) returns 0 in a tight corridor, 1 in the mouth of an
     intersection; audio.js turns that number into delay/decay.
     ------------------------------------------------------------------ */
  echoAt(z) {
    let best = 0;
    for (let i = 0; i < ECHO_ZONES.length; i++) {
      const d = Math.abs(z - ECHO_ZONES[i]);
      if (d >= ECHO_SPREAD) continue;
      const k = 1 - d / ECHO_SPREAD;
      const s = k * k * (3 - 2 * k);          // smoothstep
      if (s > best) best = s;
    }
    return best;
  }

  /* ------------------------------------------------------------------
     Drop a ring into the water at a world position. Called from the *same*
     statement that fires the splash sound, so picture and audio cannot drift.
     Returns true if a sheet was close enough to take it.
     ------------------------------------------------------------------ */
  splashRipple(x, z, strength = 1) {
    const list = this._splash;
    if (!list || !list.length) return false;
    let hit = false;
    for (let i = 0; i < list.length; i++) {
      const sp = list[i];
      const dx = x - sp.mesh.position.x;
      const dz = z - sp.mesh.position.z;
      if (dx * dx + dz * dz > 20.25) continue;        // only sheets within 4.5 m
      const th = sp.mesh.rotation.y;
      const c = Math.cos(th), sn = Math.sin(th);
      // world → this sheet's unrotated metric frame (see RIPPLE_CALC)
      const lx = dx * c - dz * sn;
      const lz = dx * sn + dz * c;
      const slot = sp.sink.uRip.value[sp.ring];
      slot.set(lx, lz, this.t, strength);
      sp.ring = (sp.ring + 1) % 3;
      hit = true;
    }
    return hit;
  }

  /* ------------------------------------------------------------------
     RAIN — Amateur is a dry alley: no fall, no rings on the water. Every
     other floor is wet. `uRain` gates the procedural ring field in the
     puddle shader, so switching it costs one uniform write per sheet.
     ------------------------------------------------------------------ */
  setRain(on) {
    this.rainOn = !!on;
    if (this.rain) this.rain.visible = !!on;
    const list = this._splash;
    if (list) for (let i = 0; i < list.length; i++) list[i].sink.uRain.value = on ? 1 : 0;
  }

  /* a rhythmic flashlight stutter, used as the amateur freeze warning */
  flashFlicker(seconds = 0.2) {
    this._flickerT = Math.max(this._flickerT || 0, seconds);
  }

  setFlashlight(on) {
    if (this.flashlightOn === on) return;
    this.flashlightOn = on;
    // NEVER toggle .visible on a light: three.js rebuilds the light list, which
    // changes the program defines and recompiles every material in the alley.
    // Dimming to zero keeps the program text identical.
    if (!on) this.flashlight.intensity = 0;
    this.torchFill.intensity = on ? 9 : 0;
  }

  toggleFlashlight() {
    this.setFlashlight(!this.flashlightOn);
    return this.flashlightOn;
  }

  setPinkFog(on) {
    this.fogTarget = on ? 1 : 0;
    if (on) {
      this.scene.fog.color.setHex(0x2b1220);
      this.scene.fog.density = 0.075;
      this.neonLight.color.setHex(0xff2f6d);
    } else if (this.rustAmount < 0.5) {
      this.scene.fog.color.setHex(0x0a0a16);
      this.scene.fog.density = 0.06;
    }
  }

  setRustShift(on) {
    this.rustTarget = on ? 1 : 0;
    if (on) {
      this._rustSignals.forEach((m) => (m.visible = true));
      this.scene.fog.color.setHex(0x1a0f0c);
      this.scene.fog.density = 0.072;
      this.ambient.color.setHex(0x3a2a24);
      this.lamp.color.setHex(0xffa04a);
      this.hemi.color.setHex(0x4a3a34);
      this.boardLight.color.setHex(0xffbf7a);
    }
  }

  setDread(v) {
    this.dread = THREE.MathUtils.clamp(v, 0, 1);
  }

  flashRed(v) {
    this._redFlash = Math.max(this._redFlash || 0, v);
  }

  update(dt, elapsed, game = {}) {
    this.t += dt;
    const t = elapsed + this.clockOffset;

    /* --- shadow cadence -------------------------------------------------
       The street lamp is fixed: only Maigo moves through its cone, so 30 Hz
       is invisible and costs half the triangles (8 Hz when she is not on
       stage at all). The torch is the opposite — it rides the camera — so it
       updates every frame, and nearly none when it is switched off. */
    this._shadowTick = (this._shadowTick || 0) + 1;
    if (this.lamp) {
      const alive = !!(this.maigo && this.maigo.root && this.maigo.root.visible);
      /* Face to face in the dialogue the camera is 1.3 m from her and the
         street-lamp shadow is off the bottom of the frame; re-rendering the
         whole alley into that map every other frame is pure cost at the one
         moment the player is watching her turn. */
      const talking = game && game.state === 'DIALOGUE';
      const every = talking ? 8 : (alive ? (this.shadowEveryLamp || 2) : 8);
      if (this._shadowTick % every === 0) this.lamp.shadow.needsUpdate = true;
    }
    if (this.flashlight) {
      if (this.flashlightOn) {
        /* Face to face the camera is on rails — a slow dolly and no free look.
           Re-rendering the whole alley into the torch's shadow map every
           single frame there is the most expensive thing on screen, and a
           one-frame-old shadow behind a 0.1 m/s dolly is invisible. */
        const talking = game && game.state === 'DIALOGUE';
        if (!talking || this._shadowTick % 2 === 0) this.flashlight.shadow.needsUpdate = true;
      } else if (this._shadowTick % 12 === 0) this.flashlight.shadow.needsUpdate = true;
    }

    // 12 float writes; the waves themselves are solved on the GPU
    if (this._splash) {
      for (let i = 0; i < this._splash.length; i++) this._splash[i].sink.uRipT.value = this.t;
    }

    // --- lamp flicker: sickly, irregular, with occasional dropouts ---
    const flick = 0.82 + Math.sin(t * 21.3) * 0.055 + Math.sin(t * 3.1) * 0.08;
    // --- vending hum light ---
    for (let i = 0; i < this.vending.length; i++) {
      const v = this.vending[i];
      const f = 0.92 + Math.sin(t * 2.2 + i * 2.1) * 0.05 + (Math.sin(t * 13.7 + i) > 0.97 ? 0.18 : 0);
      v.light.intensity = 32 * f;
      if (v.glowSprite) v.glowSprite.material.opacity = 0.45 * f;
    }

    // --- manifestation key light ---
    if (this.maigoLight) {
      this.maigoLight.intensity += (this.maigoLightTarget - this.maigoLight.intensity) * Math.min(1, dt * 3.2);
      if (this.maigo) {
        const p = this.maigo.root.position;
        this.maigoLight.position.set(p.x, 2.35, p.z + 1.35);
      }
    }

    // --- poster hover: a slow breathing glow on the board -----------------
    if (this.posterHover) {
      for (const key of ['student', 'adult']) {
        const q = this.posterHover[key];
        const r = this.posterRing[key];
        const on = key === this._hoverKey;
        const breath = 0.10 + Math.sin(t * 3.4) * 0.035;
        q.material.opacity += ((on ? breath : 0) - q.material.opacity) * Math.min(1, dt * 9);
        r.material.opacity += ((on ? 0.16 : 0) - r.material.opacity) * Math.min(1, dt * 9);
      }
    }

    // --- failing sodium lamp: a slow sag plus sudden stutters -------------
    if (this.lamp) {
      const sag = 0.94 + Math.sin(t * 0.9) * 0.03;
      let stutter = 1;
      // two pre-scheduled dropout windows per ~11 s, deterministic but uneasy
      const cyc = (t * 0.09) % 1;
      if (cyc > 0.62 && cyc < 0.70) stutter = 0.15 + Math.abs(Math.sin(t * 47)) * 0.55;
      else if (cyc > 0.70 && cyc < 0.74) stutter = 0.4;
      const dread = this.dread || 0;
      this.lamp.intensity = this.lampBaseIntensity * sag * stutter * (1 - dread * 0.18);
      if (this.lampGlow) this.lampGlow.material.opacity = 0.5 * sag * stutter;
      if (this.lampCone) this.lampCone.material.opacity = 0.085 * sag * stutter * (1 + dread * 0.5);
    }

    // --- wall sconces: independent hum-flicker, stronger as dread rises ---
    if (this._sconceLights) {
      for (let i = 0; i < this._sconceLights.length; i++) {
        const sc = this._sconceLights[i];
        const f = 0.9
          + Math.sin(t * (5.1 + i * 0.7) + i * 2.3) * 0.05
          + (Math.sin(t * (17 + i)) > 0.965 ? -0.45 : 0);
        sc.light.intensity = (sc.base || 26) * f * (1 - (this.dread || 0) * 0.25) * (sc.gate ?? 1);
      }
    }

    // --- torch micro-flicker, plus the warning stutter before she freezes ---
    if (this.flashlightOn) {
      let fi = this.flashlightIntensity * this.flashlightScale * (this.batteryDim ?? 1) * (0.97 + Math.sin(t * 12.1) * 0.014);
      if (this._flickerT > 0) {
        this._flickerT -= dt;
        // four hard dips in 0.2 s — reads as a failing filament, not a strobe
        const sq = Math.sin(t * 96) > -0.15 ? 1 : 0.10;
        fi *= sq;
      }
      this.flashlight.intensity = fi;
    } else {
      this._flickerT = 0;
    }

    // --- neon door pulse ---
    if (this.neonDoor?.active) {
      this.neonDoor.light.intensity = 60 + Math.sin(t * 4.2) * 9;
      this.neonDoor.spill.material.opacity = 0.4 + Math.sin(t * 2.1) * 0.12;
    }

    // --- rain follows the player; the fall itself is solved in the shader ---
    if (this.rain && game.player) {
      this.rain.position.set(game.player.position.x, 0, game.player.position.z);
      this.rainMat.uniforms.uTime.value = this.t;
    }
    if (this.dust) {
      this.dust.rotation.y += dt * 0.012;
      this.dust.position.y = Math.sin(t * 0.25) * 0.06;
    }

    if (this.hazeSheets) {
      for (let i = 0; i < this.hazeSheets.length; i++) {
        const m = this.hazeSheets[i];
        m.position.x += Math.sin(t * 0.07 + i) * 0.03 * dt;
        m.position.z += Math.cos(t * 0.05 + i) * 0.08 * dt;
        m.rotation.z += 0.001 * dt;
        if (game.player) {
          if (m.position.z > game.player.position.z + 6) m.position.z -= 60;
          if (m.position.z < game.player.position.z - 70) m.position.z += 60;
        }
      }
    }

    // --- pink fog rolling across the asphalt ---
    this.fogAmount += ((this.fogTarget || 0) - this.fogAmount) * Math.min(1, dt * 1.6);
    for (const s of this.fogSheets) {
      const m = s.mesh;
      m.material.opacity = this.fogAmount * (0.2 + 0.2 * Math.sin(t * 0.6 + s.seed));
      m.position.x += Math.sin(t * 0.21 + s.seed) * s.drift * dt;
      m.position.z += Math.cos(t * 0.17 + s.seed) * s.drift * dt * 1.6;
      m.position.y = s.baseY + Math.sin(t * 0.4 + s.seed) * 0.05;
      m.rotation.z += s.spin * dt;
      if (game.player) {
        const dz = m.position.z - game.player.position.z;
        if (dz > 6) m.position.z -= 26;
        if (dz < -30) m.position.z += 26;
      }
    }

    // --- Rust Shift crossfade ---
    this.rustAmount += (this.rustTarget - this.rustAmount) * Math.min(1, dt * 1.1);
    for (const m of this._rustSignals) {
      if (m.material) {
        m.material.opacity = this.rustAmount;
        m.material.transparent = this.rustAmount < 0.995;
      }
    }
    if (this.rustAmount > 0.02 && !this.groundMat.rustApplied) {
      this.groundMat.normalScale.set(0.85, 0.85);
    }

    // --- puddle shimmer ---
    if (this.rippleNormal) {
      this.rippleNormal.offset.y = (t * 0.006) % 1;
      this.rippleNormal.offset.x = Math.sin(t * 0.04) * 0.02;
    }

    // --- post-processing grade ---
    const u = this.post;
    u.uTime.value = t;
    const dread = this.dread || 0;
    u.uGrain.value = 0.06 + dread * 0.04;
    u.uAberration.value = 0.0019 + dread * 0.0022;
    u.uVignette.value = 0.88 + dread * 0.08;
    u.uDesat.value = 0.1 + dread * 0.12;
    u.uPulse.value = dread * 0.22;
    this._redFlash = Math.max(0, (this._redFlash || 0) - dt * 2.2);
    u.uRed.value = this._redFlash;

    // keep a tiny ambient drift on grain so it never looks frozen
    u.uResolution.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
  }

  render() {
    this.composer.render();
  }

  /* Last-resort grounding for a machine that is clearly not keeping up.
     What it used to do — switch practical lights off, hide the rain, hide the
     puddles, throw the environment map away — changed the *program defines*
     of every material in the alley. The whole scene relinked, which is a
     two-second freeze bought to save a few milliseconds a frame, and the
     graphics never came back. Now the only lever is resolution and the shadow
     cadence: both are reversible, and neither touches a light, the rain or
     the puddles, so nothing relinks and nothing the player can see is lost. */
  degradeToMin() {
    if (this._softDegraded) return;
    this._softDegraded = true;
    this.lowQuality = true;
    this.shadowEveryLamp = 4;
    if (!this.minQuality) this.setRenderScale(0.62);
    document.body.classList.add('perf-low');
  }

  restoreQuality() {
    if (!this._softDegraded) return;
    this._softDegraded = false;
    this.lowQuality = this.baseLowQuality || false;
    this.shadowEveryLamp = 2;
    if (!this.minQuality) this.setRenderScale(Math.min(this._renderScale + 0.18, 1.0));
    document.body.classList.remove('perf-low');
  }

  setRenderScale(scale) {
    if (this.minQuality) return;
    this._renderScale = THREE.MathUtils.clamp(scale, 0.62, 1.35);
    this.renderer.setPixelRatio(this._renderScale);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.post.uResolution.value.set(
      this.renderer.domElement.width, this.renderer.domElement.height
    );
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    /* A resize must not undo the quality the governor has settled on. */
    this.renderer.setPixelRatio(this.minQuality ? 0.5
      : this.lowQuality ? 0.72
        : (this._renderScale || Math.min(window.devicePixelRatio || 1, 1.6)));
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.post.uResolution.value.set(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
  }

  /* ==================================================================
     queries used by mechanics
     ================================================================== */
  nearestInteractable(pos, dir, maxDist = 2.6) {
    let best = null, bestScore = Infinity;
    for (const it of this.interactables) {
      if (it.object && it.object.visible === false) continue;   // e.g. a blanket not spawned yet
      const d = pos.distanceTo(it.position);
      if (d > Math.max(maxDist, it.radius + 0.6)) continue;
      const to = it.position.clone().add(new THREE.Vector3(0, 0.9, 0)).sub(pos);
      const len = to.length();
      const dot = len > 0 ? to.multiplyScalar(1 / len).dot(dir) : 1;
      if (dot < 0.35) continue;
      const score = d * (2 - dot);
      if (score < bestScore) { bestScore = score; best = it; }
    }
    return best;
  }

  setPosterHover(key) { this._hoverKey = key; }

  boardLookTarget() {
    return this.boardWorldPos.clone();
  }
}
