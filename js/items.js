/* ============================================================================
   items.js — the two things Maigo answers to

   A candy and a folded blanket, built once and shared by the two places they
   appear: the vending machines down the alley, and the corner of the screen
   once you are carrying them. Same geometry, same materials, same lighting
   response — the thing in your hand is the thing you picked up.

   Nothing here is a box, a cylinder or a sphere. The sweet is a lathe turned
   around its own axis with a pinched cellophane twist at each end, and the
   cloth is a displaced plane with a woven normal map.
   ========================================================================== */

import * as THREE from 'three';
import { latheGeo } from './prims.js?v=b89';
import { mulberry32, fabricMaps } from './textures.js?v=b89';

/* --------------------------------------------------------------------------
   CANDY
   -------------------------------------------------------------------------- */
let _candyBody = null, _candyWrap = null, _candyMat = null, _wrapMat = null, _stripeTex = null;
let _dispMat = null, _dispWrap = null;

function candyStripeTexture() {
  if (_stripeTex) return _stripeTex;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#e8dcc8';
  g.fillRect(0, 0, S, S);
  // a peppermint spiral: diagonal bands that read as a swirl on the lathe
  g.lineWidth = S * 0.115;
  g.strokeStyle = '#b3121f';
  for (let i = -S; i < S * 2; i += S * 0.23) {
    g.beginPath();
    g.moveTo(i, 0);
    g.quadraticCurveTo(i + S * 0.22, S * 0.5, i, S);
    g.stroke();
  }
  g.globalAlpha = 0.22;
  g.strokeStyle = '#fff6e8';
  g.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    g.beginPath();
    g.moveTo(0, i * S / 12);
    g.lineTo(S, i * S / 12 + 18);
    g.stroke();
  }
  g.globalAlpha = 1;
  _stripeTex = new THREE.CanvasTexture(cv);
  _stripeTex.colorSpace = THREE.SRGBColorSpace;
  _stripeTex.wrapS = THREE.RepeatWrapping;
  _stripeTex.wrapT = THREE.ClampToEdgeWrapping;
  _stripeTex.repeat.set(2, 1);
  _stripeTex.anisotropy = 4;
  return _stripeTex;
}

/** geometry + materials, built lazily so a texture failure cannot break boot */
function candyAssets() {
  if (_candyBody) return;
  // the sweet itself: a lens lying on its side, twisted wrapper at each end
  const body = latheGeo([
    [0.000, -0.0165], [0.014, -0.0155], [0.023, -0.0105],
    [0.0265, 0.0], [0.023, 0.0105], [0.014, 0.0155], [0.000, 0.0165],
  ], 26);
  body.rotateZ(Math.PI / 2);              // axis along X, like a wrapped sweet

  const wrap = latheGeo([
    [0.000, 0.000], [0.0255, 0.0015], [0.019, 0.011], [0.0075, 0.024],
    [0.0055, 0.032], [0.0032, 0.040], [0.0000, 0.0455],
  ], 20);
  wrap.rotateZ(-Math.PI / 2);             // points along -X
  const wrap2 = wrap.clone();
  wrap2.rotateY(Math.PI);                 // and its mirror along +X

  const merged = new THREE.BufferGeometry();
  // hand-merge (three's BufferGeometryUtils is not vendored)
  const geos = [wrap, wrap2].map((g) => g.toNonIndexed());
  const total = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  let o = 0, ou = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    uv.set(g.attributes.uv.array, ou * 2);
    o += g.attributes.position.count;
    ou += g.attributes.uv.count;
    g.dispose();
  }
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  wrap.dispose();

  _candyBody = body;
  _candyWrap = merged;
  _candyMat = new THREE.MeshPhysicalMaterial({
    map: candyStripeTexture(),
    color: 0xffffff,
    roughness: 0.12,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.35,
    sheen: 0.2,
    sheenColor: new THREE.Color(0xff9db0),
  });
  /* The window behind a sweet is a backlit panel under a 32-intensity bulb: any
     normal albedo clips to white there. This variant keeps its colour by barely
     reflecting light at all and carrying the red itself. */
  _dispMat = new THREE.MeshPhysicalMaterial({
    color: 0x150203,
    emissive: new THREE.Color(0xa0121d),
    emissiveIntensity: 0.9,
    roughness: 0.16,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    envMapIntensity: 0.6,
  });
  _dispWrap = new THREE.MeshPhysicalMaterial({
    color: 0x18060a,
    emissive: new THREE.Color(0xd0344f),
    emissiveIntensity: 0.42,
    roughness: 0.2,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  _wrapMat = new THREE.MeshPhysicalMaterial({
    color: 0xff7fa2,
    roughness: 0.16,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    transparent: true,
    opacity: 0.46,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.2,
    sheen: 0.6,
    sheenColor: new THREE.Color(0xffd0dc),
  });
}

/**
 * A single wrapped candy, about 3 cm across.
 * @param {number} scale overall size multiplier
 */
export function makeCandy(scale = 1, display = false) {
  candyAssets();
  const g = new THREE.Group();
  const body = new THREE.Mesh(_candyBody, display ? _dispMat : _candyMat);
  const wrap = new THREE.Mesh(_candyWrap, display ? _dispWrap : _wrapMat);
  wrap.renderOrder = 1;
  g.add(body, wrap);
  g.scale.setScalar(scale);
  g.userData.kind = 'candy';
  return g;
}

/** cheap instancing-ish clone that shares geometry and materials */
export function cloneCandy(src, scale = 1) {
  const g = src.clone(true);
  g.scale.setScalar(scale);
  return g;
}

/* --------------------------------------------------------------------------
   BLANKET — a folded calico square, woven map, displaced so it is never flat
   -------------------------------------------------------------------------- */
let _clothGroup = null;

function clothMaterialMaps() {
  if (_clothGroup) return _clothGroup;
  const maps = fabricMaps(256, 13, [122, 104, 86]);     // faded brown calico
  _clothGroup = maps;
  return maps;
}

/**
 * A draped cloth mesh.
 * @param {number} w width in metres
 * @param {number} h height in metres
 * @param {number} seed fold pattern
 * @param {object} opts { folds, droop, tone }
 */
export function makeCloth(w = 0.4, h = 0.32, seed = 1, opts = {}) {
  const segX = 22, segY = 18;
  const geo = new THREE.PlaneGeometry(w, h, segX, segY);
  const pos = geo.attributes.position;
  const rnd = mulberry32(seed * 37 + 5);
  const folds = opts.folds ?? 3.4;
  const droop = opts.droop ?? 0.035;
  const ph = rnd() * 6.283;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const u = x / w + 0.5, v = y / h + 0.5;
    // long soft folds across the weave
    let z = Math.sin(u * folds * Math.PI * 2 + ph) * 0.011;
    z += Math.sin(v * 2.1 * Math.PI + ph * 0.6) * 0.008;
    // the free edge sags and curls back
    const edge = Math.pow(Math.abs(u - 0.5) * 2, 2.4);
    z -= edge * droop;
    // the sheet is cupped, not a card: both sides lean toward the eye
    z += Math.pow((u - 0.5) * 2, 2) * (opts.cup ?? 0.03);
    z += Math.pow((v - 0.5) * 2, 2) * (opts.cup ?? 0.03) * 0.55;
    z += (rnd() - 0.5) * 0.0016;
    pos.setZ(i, z);
    // a corner lifts, as cloth does when it is carried
    pos.setY(i, y - edge * droop * 0.55);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const maps = clothMaterialMaps();
  const mat = new THREE.MeshPhysicalMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    color: opts.tone ?? 0xd8cdbd,
    roughness: 0.94,
    metalness: 0.0,
    sheen: 0.5,
    sheenColor: new THREE.Color(0x8d7f6c),
    sheenRoughness: 0.7,
    envMapIntensity: 0.35,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.kind = 'cloth';

  return mesh;
}
