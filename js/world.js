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

import {
  concreteMaps, asphaltMaps, rustMaps, fabricMaps, shutterTexture,
  createMissingBoardTexture, vendingFrontTexture, neonSignTexture, windowTexture,
  glowSpriteTexture, fogSheetTexture, mulberry32, fbmField,
} from './textures.js?v=b13';
import {
  extrudedSlab, loftGeometry, tubeGeometry, blobGeometry, displacedPlaneGeometry,
  roundedRectShape,
} from './geo.js?v=b13';

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

    float hash21(vec2 p){
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
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
      float fine = hash21(px + frame * 13.7);
      float coarse = hash21(floor(px / 2.0) * 1.31 + frame * 7.13);
      float blotch = hash21(floor(px / 7.0) + frame * 3.3);
      float grain = (fine - 0.5) * 0.55 + (coarse - 0.5) * 0.8 + (blotch - 0.5) * 0.42;
      float shadowClump = smoothstep(0.55, 0.015, lum);
      float gAmt = uGrain * mix(0.32, 1.25, shadowClump);
      col += grain * gAmt * vec3(0.95, 0.98, 1.06);
      /* slight grain-driven distortion inside deep shadow */
      col.r += (hash21(px * 1.7 + frame) - 0.5) * shadowClump * 0.014;

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;       // forced cinematic curve
    renderer.toneMappingExposure = 0.70;                      // crushed charcoal blacks
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
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
    if (this.lowQuality) {
      renderer.setPixelRatio(this.minQuality ? 0.5 : 0.72);
      renderer.shadowMap.enabled = false;
      this.rainCount = this.minQuality ? 0 : 480;
    }
    if (this.minQuality) {
      this.scene.environment = null;
    }

    this.scene.environment = this.minQuality ? null : equirectEnvironment(renderer);
    this.scene.environmentIntensity = 0.55;

    /* ---------------- post chain ---------------- */
    const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
      type: THREE.HalfFloatType,
      samples: this.lowQuality ? 0 : 2,
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
    this.fogAmount = 0;
    this.rustTarget = 0;
    this.rustAmount = 0;
    this.rainCount = 1400;
    this.dread = 0;
    this.interactables = [];
    this.vending = [];
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

    this.createMaterials();
    onProgress(0.26, 'FLOODING THE STREET');
    await new Promise((r) => setTimeout(r, 20));

    this.createLights();
    if (this.lowQuality) this.thinLighting();
    this.buildGround();
    this.buildWalls();
    this.buildBoard();
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
    this.warmBulb = new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffcf8a, emissiveIntensity: 7, roughness: 0.4 });
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
  }

  /* ==================================================================
     LIGHTING ARCHITECTURE
     ================================================================== */
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
      depthWrite: false, opacity: 0.85,
    }));
    this.lampGlow.position.copy(this.lamp.position);
    this.lampGlow.scale.set(0.85, 0.85, 1);
    this.scene.add(this.lampGlow);

    // warm bulb over the missing-persons board
    this.boardLight = new THREE.SpotLight(0xffd7a0, 19, 8, 0.85, 0.95, 1.6);
    this.boardLight.position.set(0, 3.05, 11.32);
    this.boardLight.target.position.set(0, 1.55, 12.2);
    this.scene.add(this.boardLight, this.boardLight.target);

    // cold fluorescent wash behind the vending machines handled in buildVending()
    this.neonLight = new THREE.PointLight(0xff2f6d, 0, 10, 1.8);
    this.scene.add(this.neonLight);
  }

  thinLighting() {
    // software / low-end path: fewer analytic lights per fragment
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
    const g = new THREE.PlaneGeometry(7.6, 250, 30, 320);
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

    // puddle sheets — physical clearcoat skin that catches the flashlight
    if (this.minQuality) return;
    const puddleGeo = new THREE.PlaneGeometry(1, 1);
    const rnd = mulberry32(9);
    const spots = [
      [0.4, -2.5, 2.6, 1.6], [-1.1, -9, 2.0, 1.2], [1.0, -18, 2.4, 1.5],
      [-0.6, -27, 2.8, 1.7], [0.8, -38, 1.9, 1.1], [-1.2, -51, 2.3, 1.4],
      [0.5, -68, 2.6, 1.5], [-0.4, -84, 2.1, 1.3],
    ];
    for (const [x, z, sx, sz] of spots) {
      const mat = new THREE.MeshPhysicalMaterial({
        map: this.puddleAlpha,
        transparent: true,
        opacity: 0.72,
        color: 0x0b0f1a,
        roughness: 0.03,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        normalMap: this.rippleNormal,
        normalScale: new THREE.Vector2(0.18, 0.18),
        envMapIntensity: 1.2,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const m = new THREE.Mesh(puddleGeo, mat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = rnd() * Math.PI * 2;
      m.scale.set(sx, sz, 1);
      m.position.set(x, 0.012, z);
      m.renderOrder = 2;
      this.scene.add(m);
      this._puddleMats.push(mat);
    }

    // reflection streaks below practical lamps
    this.addStreak(0.55, -4.9, 1.5, 14, this.streakTex, 0.62);
    this.addStreak(1.45, -15.4, 1.2, 7.5, this.streakCool, 0.5);
    this.addStreak(1.4, -62.1, 1.0, 6.5, this.streakCool, 0.35);

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

  addStreak(x, z, w, len, tex, opacity) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthWrite: false, color: 0xffffff,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.016, z);
    m.renderOrder = 3;
    this.scene.add(m);
    return m;
  }

  /* ==================================================================
     WALLS — displaced concrete + hidden rust layer for The Rust Shift
     ================================================================== */
  buildWalls() {
    const length = 224, height = 5.6;
    const zStart = 13 - length;
    const wallGeo = (side) => {
      const geo = displacedPlaneGeometry(length, height, 180, 22, (x, y) => {
        return Math.sin(x * 0.9) * 0.012 + Math.sin(x * 0.27 + y * 1.3) * 0.02 + Math.sin(y * 5.1) * 0.008;
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

    // far dead-end wall behind the player (holds the missing-persons board)
    const endGeo = displacedPlaneGeometry(5.2, height, 26, 20, (x, y) =>
      Math.sin(x * 4.2) * 0.012 + Math.sin(y * 2.4) * 0.016);
    const end = new THREE.Mesh(endGeo, this.wallMatDark);
    end.rotation.y = Math.PI;
    end.position.set(0, height / 2, 12.3);
    end.receiveShadow = true;
    this.scene.add(end);
    this.endWall = end;

    // rusted overlays (The Rust Shift)
    for (const side of [-1, 1]) {
      const geo = displacedPlaneGeometry(length, height, 90, 14, (x, y) =>
        Math.sin(x * 2.3) * 0.02 + Math.sin(x * 0.8 + y * 2.1) * 0.03);
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

    // wall lamps (practical sconces)
    this.addSconce(-2.42, 3.05, 7.2, 0xffcf96);
    this.addSconce(-2.42, 2.85, 2.4, 0xffd7a8);
    this.addSconce(2.42, 3.1, -22, 0xffc07a);
    this.addSconce(-2.42, 3.15, -47, 0xffca8a);

    // downpipes, conduits, cables
    this.addPipeRun(2.44, 4.05, 12, -122, 0.055);
    this.addPipeRun(-2.44, 4.3, 12, -122, 0.045);
    for (const z of [9.2, -13.5, -33, -58, -88]) {
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
    for (const [z, sag] of [[1.8, 0.5], [-17, 0.7], [-40, 0.55], [-72, 0.62]]) {
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

  addSconce(x, y, z, color) {
    const housing = new THREE.Mesh(extrudedSlab(0.28, 0.16, 0.16, { radius: 0.03, bevel: 0.01 }), this.metalDark);
    housing.position.set(x + (x > 0 ? -0.08 : 0.08), y, z);
    housing.rotation.z = x > 0 ? 0.2 : -0.2;
    this.scene.add(housing);
    const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.065, 1), this.warmBulb);
    bulb.position.set(x + (x > 0 ? -0.14 : 0.14), y - 0.03, z);
    this.scene.add(bulb);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.position.copy(bulb.position);
    glow.scale.set(0.8, 0.8, 1);
    this.scene.add(glow);
    const pl = new THREE.PointLight(color, 26, 7.0, 1.8);
    pl.position.copy(bulb.position);
    this.scene.add(pl);
    this._sconceLights = this._sconceLights || [];
    this._sconceLights.push({ light: pl, base: 26, seed: Math.random() * 10 });
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
        map: this.boardTex, emissiveMap: this.boardTex, emissive: 0xffffff, emissiveIntensity: 0.15,
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
     UTILITY POLE + STREET LAMP
     ================================================================== */
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

    // curved lamp arm + shade
    const armPts = [
      new THREE.Vector3(0.03, 5.15, 0),
      new THREE.Vector3(-0.25, 5.35, 0.0),
      new THREE.Vector3(-0.62, 5.36, -0.02),
      new THREE.Vector3(-0.87, 5.18, 0),
    ];
    const lampArm = new THREE.Mesh(tubeGeometry(armPts, 0.035, 22, 7), this.metalRust);
    lampArm.castShadow = true;
    g.add(lampArm);
    const shade = new THREE.Mesh(loftGeometry([
      { y: 0, rx: 0.09, rz: 0.09 }, { y: 0.05, rx: 0.2, rz: 0.2 }, { y: 0.14, rx: 0.22, rz: 0.22 }, { y: 0.19, rx: 0.19, rz: 0.19 },
    ], 18, { capBottom: false, capTop: true }), this.metalRust);
    shade.position.set(-0.87, 5.06, 0);
    g.add(shade);
    const bulb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 1), this.warmBulb);
    bulb.position.set(-0.87, 5.02, 0);
    g.add(bulb);

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

    // fake volumetric shaft under the sodium lamp
    if (!this.minQuality) this.addLampCone(-0.87, 4.98, 0);

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
    const geo = new THREE.PlaneGeometry(0.92, 1.15, 14, 16);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const fold = Math.sin(x * 7.3) * 0.020 + Math.sin(y * 5.1 + 1.1) * 0.024 +
                   Math.cos((x + y) * 9.4) * 0.010;
      // taper the edges so it reads as crumpled cloth rather than a card
      const edge = Math.min(1, (0.46 - Math.abs(x)) * 6, (0.575 - Math.abs(y)) * 6);
      pos.setZ(i, fold * Math.max(0.15, edge) + 0.012);
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x6b5546, roughness: 0.95, metalness: 0.0,
    });
    const cloth = new THREE.Mesh(geo, mat);
    cloth.rotation.x = -Math.PI / 2;
    cloth.castShadow = true;
    cloth.receiveShadow = true;

    const g = new THREE.Group();
    g.add(cloth);
    g.visible = false;
    this.scene.add(g);

    this.blanket = { group: g, position: new THREE.Vector3(-1.30, 0.02, -26), z: -26 };
    this.interactables.push({
      kind: 'blanket', object: g,
      position: this.blanket.position, radius: 1.5, data: {},
    });
    return this.blanket;
  }

  showBlanket(z) {
    if (!this.blanket) return null;
    this.blanket.z = z;
    this.blanket.position.set(-1.30, 0.02, z);
    this.blanket.group.position.set(-1.30, 0.02, z);
    this.blanket.group.rotation.y = 0.35;
    this.blanket.group.visible = true;
    return this.blanket;
  }

  hideBlanket() {
    if (this.blanket) this.blanket.group.visible = false;
  }

  buildVending(z, theme) {
    const g = new THREE.Group();
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
        map: front, emissiveMap: front, emissive: 0xffffff, emissiveIntensity: 3.0,
        roughness: 0.28, metalness: 0.1,
      })
    );
    panel.position.set(0, 1.16, 0.398);
    g.add(panel);

    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 1.36), this.glassMat);
    glass.position.set(0, 1.16, 0.408);
    g.add(glass);

    // brand header
    const headerMat = new THREE.MeshStandardMaterial({
      color: theme === 'blue' ? 0x0d3c62 : 0x5c0b16,
      emissive: theme === 'blue' ? 0x2f9fff : 0xff4055, emissiveIntensity: 0.8,
      roughness: 0.4, metalness: 0.3,
    });
    const header = new THREE.Mesh(extrudedSlab(0.95, 0.24, 0.06, { radius: 0.02, bevel: 0.008 }), headerMat);
    header.position.set(0, 1.98, 0.33);
    g.add(header);

    // selection buttons
    const btnGeo = extrudedSlab(0.075, 0.05, 0.02, { radius: 0.008, bevel: 0.003 });
    const btnMat = new THREE.MeshStandardMaterial({ color: 0x1b2b33, emissive: 0xffd166, emissiveIntensity: 0.65, roughness: 0.35 });
    for (let i = 0; i < 8; i++) {
      const b = new THREE.Mesh(btnGeo, btnMat);
      b.position.set(0.4, 1.72 - i * 0.105, 0.405);
      b.rotation.x = -Math.PI / 2;
      g.add(b);
    }

    // coin unit
    const coin = new THREE.Mesh(extrudedSlab(0.2, 0.31, 0.05, { radius: 0.02, bevel: 0.006 }), this.metalDark);
    coin.position.set(0.33, 0.66, 0.41);
    g.add(coin);
    const slot = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.1), new THREE.MeshBasicMaterial({ color: 0x050608 }));
    slot.position.set(0.33, 0.7, 0.436);
    g.add(slot);

    // glow + practical light
    const light = new THREE.PointLight(theme === 'blue' ? 0xbfe6ff : 0xffb3bd, 32, 9.5, 1.8);
    light.position.set(0, 1.25, 0.7);
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
    const bagSpots = [
      [1.82, -8.6, 0.34], [1.62, -9.15, 0.3], [1.9, -9.5, 0.26],
      [-1.9, -30.5, 0.32], [-2.0, -31.1, 0.26], [2.0, -47.2, 0.3],
    ];
    for (let i = 0; i < bagSpots.length; i++) {
      const [x, z, r] = bagSpots[i];
      const geo = blobGeometry(r, 24, 16, { seed: 11 + i, amount: 0.2, squash: 0.86 });
      const bag = new THREE.Mesh(geo, this.plasticBlack);
      bag.position.set(x, r * 0.82, z);
      bag.rotation.y = i * 1.7;
      bag.castShadow = true;
      bag.receiveShadow = true;
      this.scene.add(bag);
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
    const paperMat = new THREE.MeshStandardMaterial({ color: 0x8d8878, roughness: 0.92, side: THREE.DoubleSide });
    const rnd = mulberry32(19);
    for (let i = 0; i < 18; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.1 + rnd() * 0.16, 0.08 + rnd() * 0.14), paperMat);
      p.rotation.x = -Math.PI / 2 + (rnd() - 0.5) * 0.12;
      p.rotation.z = rnd() * Math.PI;
      p.position.set((rnd() - 0.5) * 4.2, 0.022 + rnd() * 0.004, 10 - rnd() * 80);
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
    const positions = new Float32Array(count * 6);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = (rnd() - 0.5) * 14;
      const y = rnd() * 9;
      const z = (rnd() - 0.5) * 30;
      const len = 0.18 + rnd() * 0.3;
      positions[i * 6] = x; positions[i * 6 + 1] = y; positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x - 0.02; positions[i * 6 + 4] = y - len; positions[i * 6 + 5] = z + 0.015;
      speeds[i] = 5 + rnd() * 6;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
      color: 0x93a9cc, transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.rain.frustumCulled = false;
    this.rainSpeeds = speeds;
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
    this.addStreak(-1.6, z, 1.4, 6, this.streakPink, 0.4);
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

    // --- lamp flicker: sickly, irregular, with occasional dropouts ---
    const flick = 0.82 + Math.sin(t * 21.3) * 0.055 + Math.sin(t * 3.1) * 0.08;
    if (this._sconceLights) {
      for (const s of this._sconceLights) {
        const f = 0.9 + Math.sin(t * 8.3 + s.seed) * 0.06 + (Math.sin(t * 0.7 + s.seed) > 0.96 ? -0.6 : 0);
        s.light.intensity = s.base * Math.max(0, f);
      }
    }

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
        sc.light.intensity = (sc.base || 26) * f * (1 - (this.dread || 0) * 0.25);
      }
    }

    // --- torch micro-flicker ---
    if (this.flashlightOn) {
      if (this.flashlightOn) {
        this.flashlight.intensity = this.flashlightIntensity * this.flashlightScale * (0.97 + Math.sin(t * 12.1) * 0.014);
      }
    }

    // --- neon door pulse ---
    if (this.neonDoor?.active) {
      this.neonDoor.light.intensity = 60 + Math.sin(t * 4.2) * 9;
      this.neonDoor.spill.material.opacity = 0.4 + Math.sin(t * 2.1) * 0.12;
    }

    // --- rain follows the player, streaks fall in local space ---
    if (this.rain && game.player) {
      this.rain.position.set(game.player.position.x, 0, game.player.position.z);
      const pos = this.rain.geometry.attributes.position;
      const arr = pos.array;
      for (let i = 0; i < this.rainCount; i++) {
        const speed = this.rainSpeeds[i] * dt;
        arr[i * 6 + 1] -= speed;
        arr[i * 6 + 4] -= speed;
        if (arr[i * 6 + 1] < 0) {
          const top = 8.5 + Math.random() * 2;
          arr[i * 6 + 1] = top;
          const len = 0.2 + Math.random() * 0.28;
          arr[i * 6 + 4] = top - len;
        }
      }
      pos.needsUpdate = true;
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

  /* last-resort degradation for a machine that is clearly not keeping up */
  degradeToMin() {
    if (this.minQuality) return;
    this.minQuality = true;
    this.lowQuality = true;
    this.scene.environment = null;
    if (this.rain) { this.rain.visible = false; }
    if (this.puddles) { for (const p of this.puddles) p.visible = false; }
    if (this.lampCone) this.lampCone.visible = false;
    if (this.sconce) this.sconce.visible = false;
    this.thinLighting();
    this.renderer.setPixelRatio(0.5);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.post.uResolution.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
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
    this.renderer.setPixelRatio(this.minQuality ? 0.5 : this.lowQuality ? 0.72 : Math.min(window.devicePixelRatio || 1, 1.6));
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
