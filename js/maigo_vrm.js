/* ============================================================================
   maigo_vrm.js — Maigo-chan as a real humanoid
   ----------------------------------------------------------------------------
   The blocky fallback is gone from the critical path: she is now a proper VRM
   avatar (CC0-equivalent licence, see assets/VRM-LICENSE.txt) driven through
   @pixiv/three-vrm. Because it is a real rig, everything is animated on bones:
   arms down at her sides, a walk cycle, breathing, hair spring bones, blinking,
   and mouth movement while she speaks.

   The VRM ships in a plain T-shirt and shorts, so the sailor uniform is built
   on top of the rig: a navy pleated skirt and collar parented to the hip and
   chest bones, and the shorts are re-tinted navy so nothing shows through.

   Materials come from the file as MToon (flat anime shading). They are rebuilt
   as MeshStandardMaterial so the alley's flashlight actually lights her — a
   flat-shaded character in a dark corridor looks like a sticker.
   ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from 'three-vrm';
import { mulberry32 } from './textures.js?v=b89';
import { latheGeo } from './prims.js?v=b89';

const TARGET_HEIGHT = 1.44;       // a small fourteen-year-old

/* ============================================================================
   BLOOD AND CLAWS — runtime only, never in the model file

   The skirt is a lathe, so its UVs are trivial: u runs around the body with
   u = 0.25 dead ahead (+Z, the direction she faces) and u = 0.75 down her back.
   That means the stains can be *painted* into a canvas in UV space and mapped
   onto a second skin of the same geometry four millimetres off the cloth — no
   vertex surgery, no texture in the VRM touched, and the navy material that
   was already there is never asked to change colour.

   If anything in here throws — canvas unavailable, geometry missing, shader
   refusing to compile — the whole overlay is torn down and she is left in the
   clean default uniform, exactly as before.
   ========================================================================== */
function _blot(g, x, y, r, rnd, col, alpha) {
  const n = 9 + ((rnd() * 5) | 0);
  const px = [], py = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.55 + rnd() * 0.7);
    px.push(x + Math.cos(a) * rr);
    py.push(y + Math.sin(a) * rr * 1.08);
  }
  g.beginPath();
  g.moveTo((px[n - 1] + px[0]) / 2, (py[n - 1] + py[0]) / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    g.quadraticCurveTo(px[i], py[i], (px[i] + px[j]) / 2, (py[i] + py[j]) / 2);
  }
  g.closePath();
  g.globalAlpha = alpha;
  g.fillStyle = col;
  g.fill();
  g.globalAlpha = 1;
}

function bloodTexture() {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  if (!g) throw new Error('no 2d context for the blood map');
  g.clearRect(0, 0, S, S);
  const rnd = mulberry32(31);

  /* The torch is a 720-intensity spot 2 m from her hip, so a white uniform
     clips to pure light. Blood that survives that has to be *darker* than the
     light can push: these read crimson where the cloth burns out to white. */
  const CORE = '#2b0106';
  const CRIMSON = '#480308';
  const WET = '#6b0410';

  /* ---------------- FRONT (u = 0.75): impact splatter ---------------- */
  const fx = S * 0.75, fy = S * 0.66;
  // the soaked-through core, then the ragged crown around it
  _blot(g, fx, fy + 10, 104, rnd, '#2c0104', 0.75);
  _blot(g, fx, fy, 82, rnd, CORE, 1.0);
  _blot(g, fx - 34, fy - 20, 44, rnd, CRIMSON, 0.95);
  _blot(g, fx + 30, fy + 16, 36, rnd, CRIMSON, 0.9);
  // cast-off satellites: flung out along one diagonal, thinning as they go
  for (let i = 0; i < 30; i++) {
    const a = -0.6 + rnd() * 1.55;
    const d = 76 + rnd() * 205;
    const r = 3.4 + rnd() * 14 * (1 - d / 340);
    _blot(g, fx + Math.sin(a) * d * 0.92, fy + Math.cos(a) * d * 0.66, Math.max(2.8, r), rnd,
      rnd() < 0.38 ? WET : CORE, 0.6 + rnd() * 0.4);
  }
  // drips running for the hem, heavier in the middle
  for (let i = 0; i < 14; i++) {
    const x = fx + (rnd() - 0.5) * 158;
    const y0 = fy + 20 + rnd() * 42;
    const len = 64 + rnd() * 130;
    const w = 3.5 + rnd() * 8;
    const grd = g.createLinearGradient(0, y0, 0, y0 + len);
    grd.addColorStop(0, 'rgba(43,1,6,0.98)');
    grd.addColorStop(0.72, 'rgba(43,1,6,0.82)');
    grd.addColorStop(1, 'rgba(43,1,6,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(x - w / 2, y0);
    g.quadraticCurveTo(x - w * 0.2, y0 + len * 0.62, x, y0 + len);
    g.quadraticCurveTo(x + w * 0.2, y0 + len * 0.62, x + w / 2, y0);
    g.closePath();
    g.fill();
    if (rnd() < 0.5) _blot(g, x, y0 + len * 0.95, w * 0.9, rnd, CORE, 0.95);
  }

  /* ---------------- BACK (u = 0.25): three claw rakes ---------------- */
  /* Kept low on the skirt: her hair hangs to the hip, and a rake hidden under
     it would be a rake nobody ever sees. */
  const marks = [
    { x: 168, w: 27, y0: 0.505, len: 348, tilt: 122, bend: -12 },
    { x: 262, w: 35, y0: 0.478, len: 392, tilt: 132, bend: 8 },
    { x: 356, w: 23, y0: 0.512, len: 330, tilt: 118, bend: 15 },
  ];
  for (let m = 0; m < marks.length; m++) {
    const mk = marks[m];
    const y0 = S * mk.y0, y1 = y0 + mk.len;
    const x0 = mk.x, x1 = x0 + mk.tilt;
    // a torn, tapering ribbon: thickest a third of the way down
    const steps = 22;
    const edge = (t) => {
      const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.94 + 0.03)));
      return mk.w * (0.28 + 0.9 * taper) * 0.5;
    };
    const path = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = x0 + (x1 - x0) * t + Math.sin(t * Math.PI) * mk.bend;
      const cy = y0 + (y1 - y0) * t;
      path.push([cx, cy, edge(t)]);
    }
    // the torn halo first, then the cut over the top of it
    const drawRibbon = (grow, fill, alpha) => {
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const [cx, cy, e] = path[i];
        const px = cx - (e + grow);
        if (i === 0) g.moveTo(px, cy); else g.lineTo(px, cy);
      }
      for (let i = steps; i >= 0; i--) {
        const [cx, cy, e] = path[i];
        g.lineTo(cx + (e + grow), cy);
      }
      g.closePath();
      g.globalAlpha = alpha;
      g.fillStyle = fill;
      g.fill();
      g.globalAlpha = 1;
    };
    drawRibbon(7, '#2a0104', 0.5);
    drawRibbon(0, CORE, 0.97);
    // the wet line down the middle
    g.strokeStyle = 'rgba(122,5,16,0.55)';
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= steps; i++) {
      const [cx, cy] = path[i];
      if (i === 0) g.moveTo(cx, cy + 4); else g.lineTo(cx, cy + 4);
    }
    g.stroke();
    // torn fibres: little slanting spines off both sides
    for (let i = 0; i < 30; i++) {
      const t = 0.08 + rnd() * 0.86;
      const k = Math.round(t * steps);
      const [cx, cy, e] = path[k];
      const side = rnd() < 0.5 ? -1 : 1;
      const l = 5 + rnd() * 15;
      g.strokeStyle = rnd() < 0.5 ? 'rgba(61,2,7,0.62)' : 'rgba(42,1,4,0.55)';
      g.lineWidth = 1 + rnd() * 2.4;
      g.beginPath();
      g.moveTo(cx + side * e, cy);
      g.lineTo(cx + side * (e + l), cy + l * 0.5);
      g.stroke();
    }
    // beads pooling under the bottom of each rake, then drips off them
    const [bx, by, be] = path[steps];
    for (let i = 0; i < 6; i++) {
      _blot(g, bx + (rnd() - 0.4) * 26, by + rnd() * 30, 2.8 + rnd() * 6, rnd, CORE, 0.9);
    }
    for (let i = 0; i < 3; i++) {
      const x = bx + (rnd() - 0.45) * 30;
      const len = 34 + rnd() * 90;
      const grd = g.createLinearGradient(0, by, 0, by + len);
      grd.addColorStop(0, 'rgba(61,2,7,0.92)');
      grd.addColorStop(1, 'rgba(43,1,6,0)');
      g.fillStyle = grd;
      g.fillRect(x, by, 2 + rnd() * 3.6, len);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.offset.x = 0.5;               // puts painted u=0.75 on her front
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const IDENTITY_Q = new THREE.Quaternion();

export class VRMMaigo {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'maigo-vrm';
    this.root.visible = false;
    scene.add(this.root);

    this.mode = 'hidden';
    this._t = 0;
    this._walkSpeed = 0;
    this._walkPhase = 0;
    this._turn = null;
    this._turning = false;
    this._blinkAt = 2.0;
    this._mouth = 0;
    this._speakUntil = 0;

    this.vrm = null;
    this.bones = {};
    this.ready = false;

    /* head-repair state (see _repairHead): always present, even if load() bails */
    this._restHeadQ = new THREE.Quaternion();
    this._restHeadPos = new THREE.Vector3();
    this._restHeadScale = new THREE.Vector3(1, 1, 1);
    this._sanitizeBones = [];
    this._restNormHeadQ = new THREE.Quaternion();

    this._buildBackZone();
  }

  /* ------------------------------------------------------------- loading -- */
  async load(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, (ev) => {
        if (ev && ev.total) window.__avatarProgress = ev.loaded / ev.total;
      }, reject);
    });

    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('not a VRM file');

    // VRM 0.x faces −Z; normalise everything to face +Z like the rest of the game
    if (VRMUtils.rotateVRM0) VRMUtils.rotateVRM0(vrm);
    if (VRMUtils.removeUnnecessaryVertices) VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);

    this.vrm = vrm;
    this._retexture(gltf.scene);

    const h = vrm.humanoid;
    for (const name of [
      'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
      'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
      'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
      'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
      'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
    ]) {
      this.bones[name] = h.getNormalizedBoneNode(name) || null;
    }

    this.root.add(vrm.scene);

    // scale her to the height the game is built around
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const raw = box.max.y - box.min.y;
    if (raw > 0.2) {
      const k = TARGET_HEIGHT / raw;
      vrm.scene.scale.setScalar(k);
      vrm.scene.position.y = -box.min.y * k;
    }

    /* This VRM ships aim helpers that the humanoid pass divides by and turns
       into NaN, and the NaN reaches the real head bone — a head bone with a
       NaN quaternion takes its whole subtree (face, hair) out of the render.
       Snapshot the authored rest pose now and keep a repair list. */
    this._restHeadQ = new THREE.Quaternion();
    this._sanitizeBones = [];
    this._restNormHeadQ = new THREE.Quaternion();
    {
      const rawHead = h.getRawBoneNode('head');
      this._restHeadPos = new THREE.Vector3();
      this._restHeadScale = new THREE.Vector3(1, 1, 1);
      if (rawHead && Number.isFinite(rawHead.quaternion.w)) {
        this._restHeadQ.copy(rawHead.quaternion);
        this._restHeadPos.copy(rawHead.position);
        this._restHeadScale.copy(rawHead.scale);
      } else {
        this._restHeadQ.identity();
      }
      /* Snapshot the rest pose of EVERY bone. The old list held only the bones
         that were already NaN at load time plus the J_Aim_ helpers; a bone that
         turns NaN later — from the pose solve, an expression, or a division on
         a driver-specific path — was never repaired, and one NaN bone takes its
         whole subtree out of the draw. A NaN on the hips or the spine is not a
         twisted neck, it is a girl who is simply not there. */
      vrm.scene.traverse((o) => {
        if (!o.isBone) return;
        o.userData._restQ = Number.isFinite(o.quaternion.w) ? o.quaternion.clone() : new THREE.Quaternion();
        o.userData._restP = Number.isFinite(o.position.x) ? o.position.clone() : new THREE.Vector3();
        o.userData._restS = Number.isFinite(o.scale.x) ? o.scale.clone() : new THREE.Vector3(1, 1, 1);
        this._sanitizeBones.push(o);
      });
    }

    this._poseRest();
    this.vrm.update(0);

    // the sailor uniform, built onto the real bones
    this._buildUniform();
    this._buildBag();

    this.root.updateMatrixWorld(true);
    this.ready = true;
    return true;
  }

  /* ----------------------------------------------------------- materials -- */
  _retexture(scene) {
    const made = [];
    const keep = (src, dst) => {
      if (src.map) dst.map = src.map;
      if (src.normalMap) dst.normalMap = src.normalMap;
      if (src.alphaMap) dst.alphaMap = src.alphaMap;
      if (src.emissiveMap) { dst.emissiveMap = src.emissiveMap; dst.emissive = new THREE.Color(0xffffff); }
    };

    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      if (o.isSkinnedMesh) o.frustumCulled = false;

      const list = Array.isArray(o.material) ? o.material : [o.material];
      const rebuilt = list.map((src) => {
        const name = (src && src.name) || '';
        const isSkin = /SKIN/i.test(name);
        const isHair = /HAIR/i.test(name);
        const isEye = /EYE/i.test(name);
        const isFace = /FACE/i.test(name);
        const isCloth = /CLOTH/i.test(name);

        const m = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.85,
          metalness: 0.0,
          transparent: false,
          side: src.side ?? THREE.FrontSide,
          envMapIntensity: 0.5,
        });
        keep(src, m);

        if (isSkin) {
          m.color = new THREE.Color(0xd6c3bc);       // the pale, washed-out skin of the reference
          m.roughness = 0.82;
          m.metalness = 0.0;
        } else if (isHair) {
          m.color = new THREE.Color(0x14161f);       // near-black, blue-cold
          m.roughness = 0.55;
          m.metalness = 0.05;
          m.side = THREE.DoubleSide;
        } else if (isEye) {
          m.color = new THREE.Color(0xc8d4dc);
          m.roughness = 0.35;
          m.metalness = 0.05;
          if (/IRIS/i.test(name)) {
            m.emissive = new THREE.Color(0x2a6b8a);
            m.emissiveIntensity = 0.5;
          }
          if (/HIGHLIGHT/i.test(name)) {
            m.transparent = true;
            m.depthWrite = false;
            m.emissive = new THREE.Color(0xffffff);
            m.emissiveIntensity = 0.8;
          }
        } else if (isFace) {
          if (src.transparent || /EYELINE|BROW|MOUTH/i.test(name)) {
            m.transparent = true;
            m.alphaTest = 0.08;
            m.depthWrite = false;
            m.color = new THREE.Color(0x2a2226);
            m.roughness = 1.0;
          } else {
            m.color = new THREE.Color(0xd6c3bc);
            m.roughness = 0.85;
          }
        } else if (isCloth) {
          if (/Bottoms/i.test(name)) m.color = new THREE.Color(0x1a2233);   // shorts read as part of the skirt
          else if (/Shoes/i.test(name)) { m.color = new THREE.Color(0x0b0b0f); m.roughness = 0.5; }
          else if (/Tops/i.test(name)) m.color = new THREE.Color(0xcfd4dc);
          m.roughness = 0.92;
        }
        made.push(src);
        return m;
      });

      o.material = Array.isArray(o.material) ? rebuilt : rebuilt[0];
    });

    for (const m of made) { try { m.dispose(); } catch (e) { /* noop */ } }
  }

  /* ---------------------------------------------------------------- pose -- */
  _poseRest() {
    const b = this.bones;
    // arms down from the T-pose. Positive Z lifts them — verified against the
    // actual bind pose: −1.28 puts the hands at 0.86 m, +1.28 at 1.69 m.
    if (b.leftUpperArm) b.leftUpperArm.rotation.z = -1.28;
    if (b.rightUpperArm) b.rightUpperArm.rotation.z = 1.28;
    if (b.leftLowerArm) { b.leftLowerArm.rotation.z = -0.10; b.leftLowerArm.rotation.x = -0.08; }
    if (b.rightLowerArm) { b.rightLowerArm.rotation.z = 0.10; b.rightLowerArm.rotation.x = -0.08; }
    // a touch of inward shoulder roll so the silhouette is not a scarecrow
    if (b.leftShoulder) b.leftShoulder.rotation.z = 0.06;
    if (b.rightShoulder) b.rightShoulder.rotation.z = -0.06;
    if (b.head) b.head.rotation.x = 0.03;
    if (b.spine) b.spine.rotation.x = 0.02;
  }

  /* --------------------------------------------------------------- uniform -- */
  _buildUniform() {
    const hip = this.bones.hips;
    const chest = this.bones.chest || this.bones.spine;
    if (!hip) return;

    const navy = new THREE.MeshPhysicalMaterial({
      color: 0x1a2233, roughness: 0.82, metalness: 0.02,
      side: THREE.DoubleSide, sheen: 0.55, sheenColor: new THREE.Color(0x2b3a55),
      envMapIntensity: 0.5,
    });
    const cream = new THREE.MeshStandardMaterial({
      color: 0xcfd4dc, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
    });

    // --- pleated skirt, parented to the hips bone so it moves with her ------
    // profile in metres relative to the hip bone origin
    const profile = [
      [0.088, 0.045], [0.104, 0.010], [0.150, -0.115],
      [0.181, -0.245], [0.186, -0.262], [0.170, -0.262],
      [0.140, -0.130], [0.096, 0.010], [0.086, 0.045],
    ];
    const skirtGeo = latheGeo(profile, 64);
    // pleats: radial ripple, applied after meshing so the surface stays clean
    const pos = skirtGeo.attributes.position;
    const rnd = mulberry32(7);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r < 0.001) continue;
      const a = Math.atan2(z, x);
      const drop = THREE.MathUtils.clamp((0.045 - y) / 0.30, 0, 1);
      const pleat = Math.sin(a * 22) * 0.006 * drop + (rnd() - 0.5) * 0.0015 * drop;
      const k = 1 + pleat / r;
      pos.setXYZ(i, x * k, y, z * k);
    }
    skirtGeo.computeVertexNormals();

    const skirt = new THREE.Mesh(skirtGeo, navy);
    skirt.castShadow = true;
    skirt.receiveShadow = true;
    skirt.frustumCulled = false;
    hip.add(skirt);
    this.skirt = skirt;

    // the stain sits on top of this skirt and on nothing else
    this._buildBlood(skirt);

    // --- sailor collar: a flat V on the chest -------------------------------
    if (chest) {
      const collarGeo = new THREE.BufferGeometry();
      const pts = [
        [-0.115, 0.085, 0.055], [0.115, 0.085, 0.055],
        [0.062, -0.010, 0.088], [0.0, -0.090, 0.092], [-0.062, -0.010, 0.088],
      ];
      const idx = [0, 1, 2, 0, 2, 3, 0, 3, 4];
      const arr = [];
      for (const p of pts) arr.push(...p);
      collarGeo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      collarGeo.setIndex(idx);
      collarGeo.computeVertexNormals();
      const collar = new THREE.Mesh(collarGeo, navy);
      collar.frustumCulled = false;
      collar.castShadow = true;
      chest.add(collar);
      this.collar = collar;

      // a thin cream stripe across the collar, as on a real seifuku
      const stripeGeo = new THREE.BufferGeometry();
      const s = pts.map(([x, y, z]) => [x * 0.86, y * 0.86 + 0.004, z + 0.004]);
      const sarr = [];
      for (const p of s) sarr.push(...p);
      stripeGeo.setAttribute('position', new THREE.Float32BufferAttribute(sarr, 3));
      stripeGeo.setIndex(idx);
      stripeGeo.computeVertexNormals();
      const stripe = new THREE.Mesh(stripeGeo, cream);
      stripe.frustumCulled = false;
      chest.add(stripe);
    }
  }

  /* ------------------------------------------------------------ blood -- */
  /* A second skin of the exact same skirt shell, pushed 4 mm along its
     normals, carrying a canvas painted in UV space. The navy material is
     never touched, so removing this mesh gives back the pristine uniform. */
  _buildBlood(skirt) {
    try {
      if (!skirt || !skirt.geometry || !skirt.geometry.attributes.normal) {
        throw new Error('skirt geometry is not where the blood pass expects it');
      }
      const src = skirt.geometry;
      const geo = src.clone();
      const pos = geo.attributes.position, nrm = geo.attributes.normal;
      const LIFT = 0.005;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
        // this lathe winds with its normals pointing into the cloth, so the
        // radial component decides which way is actually "away from her"
        const away = (nx * px + nz * pz) < 0 ? -1 : 1;
        pos.setXYZ(i, px + nx * LIFT * away, py + ny * LIFT * away, pz + nz * LIFT * away);
      }
      pos.needsUpdate = true;
      geo.computeBoundingSphere();

      const tex = bloodTexture();
      const mat = new THREE.MeshPhysicalMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        roughness: 0.55,
        metalness: 0.0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.45,
        envMapIntensity: 0.22,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const blood = new THREE.Mesh(geo, mat);
      blood.name = 'maigo-blood';
      blood.frustumCulled = false;
      blood.castShadow = false;
      blood.receiveShadow = false;
      blood.renderOrder = 1;
      blood.matrixAutoUpdate = false;
      blood.matrix.copy(skirt.matrix);
      skirt.parent.add(blood);

      this.blood = blood;
      // watch the next few frames: if the program fails to compile we put the
      // clean uniform back rather than leave a broken material in her rig
      this._bloodGuard = { errs: (window.__shaderErrs || 0), frames: 0 };
    } catch (err) {
      this._removeBlood();
      this.blood = null;
      if (window.console) console.warn('[maigo] blood pass skipped:', err && err.message);
    }
  }

  _removeBlood() {
    const b = this.blood;
    this.blood = null;
    this._bloodGuard = null;
    if (!b) return;
    if (b.parent) b.parent.remove(b);
    if (b.geometry) b.geometry.dispose();
    if (b.material) {
      if (b.material.map) b.material.map.dispose();
      b.material.dispose();
    }
  }

  /* one line per frame in update(); costs nothing once the guard expires */
  _tickBlood() {
    const g = this._bloodGuard;
    if (!g) return;
    g.frames++;
    if ((window.__shaderErrs || 0) > g.errs) {
      this._removeBlood();                    // shader refused: clean uniform
      return;
    }
    if (g.frames > 24) this._bloodGuard = null;
  }

  _buildBag() {
    const hand = this.bones.rightHand;
    if (!hand) return;
    const g = new THREE.Group();

    const bagMat = new THREE.MeshPhysicalMaterial({
      color: 0xdbe4ec, roughness: 0.18, metalness: 0.0,
      transparent: true, opacity: 0.34, transmission: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.12, envMapIntensity: 1.0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const meatMat = new THREE.MeshStandardMaterial({ color: 0x571016, roughness: 0.42, metalness: 0.05 });

    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 14), bagMat);
    shell.scale.set(1.0, 1.18, 0.85);
    shell.castShadow = false;
    g.add(shell);

    for (let i = 0; i < 4; i++) {
      const r = 0.030 + (i % 3) * 0.008;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), meatMat);
      const a = i * 2.1;
      m.position.set(Math.cos(a) * 0.024, -0.02 + Math.sin(a) * 0.034, Math.sin(a) * 0.018);
      m.scale.set(1, 1.3, 0.9);
      g.add(m);
    }

    g.position.set(0, -0.055, 0.012);
    hand.add(g);
    this.bagRoot = g;
  }

  /* -------------------------------------------------------------- backray -- */
  _buildBackZone() {
    const geo = new THREE.PlaneGeometry(0.44, 0.62);
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
    this.backZone = new THREE.Mesh(geo, mat);
    this.backZone.position.set(0, 0.98, -0.12);
    this.backZone.rotation.y = Math.PI;
    this.backZone.castShadow = false;
    this.backZone.receiveShadow = false;
    this.root.add(this.backZone);
  }

  /* ----------------------------------------------------------------- api -- */
  show(pos, faceTarget = null) {
    this.root.visible = true;
    this.root.position.copy(pos);
    this.root.position.y = 0;
    if (faceTarget) this.root.rotation.y = this.yawToward(faceTarget);
    this.setMode('idle');
    this.root.updateMatrixWorld(true);
  }

  hide() { this.root.visible = false; this.mode = 'hidden'; }

  face(target) { this.root.rotation.y = this.yawToward(target); }

  yawToward(target) {
    const dx = target.x - this.root.position.x;
    const dz = target.z - this.root.position.z;
    return Math.atan2(dx, dz);
  }

  setMode(mode) {
    if (this._turning && mode !== 'turn') return;
    this.mode = mode;
  }

  /** 1.0 = the cadence the rig was authored for; 0.7..1.55 from the floor */
  setPace(v) {
    this.pace = THREE.MathUtils.clamp(v || 1, 0.5, 1.6);
  }

  /* ---------------------------------------------------------------- look --
     A lost child never takes her eyes off the person she is following, even
     while she is walking away from them. `setLookAt` hands her a world
     position every frame; the neck and head solve the angle locally, so it
     works whatever her body is doing (and whatever the body yaw is doing).
     ---------------------------------------------------------------------- */
  setLookAt(v) {
    if (!v) { this._hasLook = false; return; }
    this._lookW = this._lookW || new THREE.Vector3();
    this._lookW.copy(v);
    this._hasLook = true;
    this._lookMax = arguments[1] !== undefined ? arguments[1] : 1.15;
  }

  /** the nightmare twitch: 45° snap back over her shoulder, then release */
  jerkLook() {
    this._jerk = { t: 0, dur: 0.9 };
  }

  /* ------------------------------------------------------- the long turn --
     Nightmare and Hell only. She is walking away from you, and then the head
     keeps going: a slow 180° turn on a neck that should not do that, holding
     long enough for you to see her face, smiling. The yaw is split by the
     existing pose code (34 % neck / 66 % head), so the twist is distributed
     rather than snapping the head off the spine. */
  lookBackHead(duration = 1.25, hold = 2.6) {
    this._turnBack = { t: 0, turn: duration, hold, phase: 'turn' };
    this._smileUntil = this._t + duration + hold + 0.6;
  }

  cancelLookBack() {
    this._turnBack = null;
    this._smileUntil = 0;
  }

  _updateLook(dt) {
    let yaw = 0;
    let pitch = 0;
    if (this._hasLook && this._lookW) {
      this.root.updateWorldMatrix(true, false);
      const inv = this._lookInv || (this._lookInv = new THREE.Matrix4());
      const p = this._lookLocal || (this._lookLocal = new THREE.Vector3());
      inv.copy(this.root.matrixWorld).invert();
      p.copy(this._lookW).applyMatrix4(inv);
      const flat = Math.hypot(p.x, p.z);
      yaw = Math.atan2(p.x, p.z);                       // 0 = dead ahead
      const max = this._lookMax || 1.15;
      if (!this._turnBack) { if (yaw > max) yaw = max; else if (yaw < -max) yaw = -max; }
      pitch = -Math.atan2(p.y - 1.42, Math.max(0.5, flat)) * 0.65;
      if (pitch > 0.32) pitch = 0.32; else if (pitch < -0.42) pitch = -0.42;
    }

    /* a full 180° head turn that outranks the follow-look clamp */
    let maxClamp = this._lookMax || 1.15;
    if (this._turnBack) {
      const tb = this._turnBack;
      tb.t += dt;
      if (tb.phase === 'turn') {
        if (tb.t >= tb.turn) { tb.t = 0; tb.phase = 'hold'; }
        // ease out on the way, so it arrives rather than arrives-and-stops
        const k = Math.min(1, tb.t / tb.turn);
        const ease = 1 - Math.pow(1 - k, 2.2);
        yaw = (Math.abs(yaw) > 0.05 ? Math.sign(yaw) : 1) * Math.PI * ease;
        maxClamp = Math.PI;
      } else if (tb.phase === 'hold') {
        yaw = (Math.abs(yaw) > 0.05 ? Math.sign(yaw) : 1) * Math.PI;
        maxClamp = Math.PI;
        if (tb.t >= tb.hold) { tb.t = 0; tb.phase = 'release'; }
      } else {
        const k = Math.min(1, tb.t / 0.85);
        yaw *= (1 - k);
        maxClamp = Math.PI;
        if (k >= 1) this._turnBack = null;
      }
    }
    this._lookMaxEff = maxClamp;

    if (this._jerk) {
      const j = this._jerk;
      j.t += dt;
      if (j.t >= j.dur) {
        this._jerk = null;
      } else {
        const k = j.t / j.dur;
        const attack = Math.min(1, j.t / 0.055);        // 55 ms — a snap, not a turn
        const release = k > 0.74 ? Math.max(0, 1 - (k - 0.74) / 0.26) : 1;
        const mag = 0.785 * attack * release;           // 45°
        const dir = Math.abs(yaw) > 0.08 ? Math.sign(yaw) : 1;
        yaw = dir * Math.max(mag, Math.abs(yaw));
      }
    }

    /* a single NaN here poisons the head bone for the rest of the session */
    if (!Number.isFinite(yaw)) yaw = 0;
    if (!Number.isFinite(pitch)) pitch = 0;
    if (!Number.isFinite(this._lookYaw)) this._lookYaw = 0;
    if (!Number.isFinite(this._lookPitch)) this._lookPitch = 0;
    const rate = this._jerk ? 26 : (this._turnBack ? 3.4 : 5.0);
    this._lookYaw = THREE.MathUtils.damp(this._lookYaw || 0, yaw, rate, dt);
    this._lookPitch = THREE.MathUtils.damp(this._lookPitch || 0, pitch, 4.5, dt);
    return this._lookYaw;
  }

  setTurning(on) { this._turning = on; }

  turnAround(duration = 1.15) { return this.turnTo(this.root.rotation.y + Math.PI, duration); }

  /* Finish a turn immediately. Used when the beat is capped and the walk has
     to start on time: she snaps to the target yaw instead of arriving late. */
  cancelTurn() {
    const s = this._turn;
    if (!s) return;
    this.root.rotation.y = s.from + s.delta;
    this._turn = null;
    this._turning = false;
    this.mode = 'idle';
    if (s.resolve) s.resolve();
  }

  turnTo(yaw, duration = 0.9) {
    this._turning = true;
    this.mode = 'turn';
    const from = this.root.rotation.y;
    const delta = ((yaw - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    /* Wall-clock, not frame delta: a dropped frame used to stretch a 1.25 s
       turn into however long the machine took to draw it, and the player sat
       in a letterboxed dialogue that could not advance. */
    return new Promise((resolve) => {
      this._turn = { from, delta, t: 0, dur: duration, resolve, t0: performance.now() };
    });
  }

  headWorldPosition() {
    const b = this.bones.head;
    const v = new THREE.Vector3();
    if (b) { b.updateWorldMatrix(true, false); b.getWorldPosition(v); v.y += 0.10; }
    else v.set(0, 1.32, 0).applyMatrix4(this.root.matrixWorld);
    return v;
  }

  chestWorldPosition() {
    const b = this.bones.chest || this.bones.spine;
    const v = new THREE.Vector3();
    if (b) { b.updateWorldMatrix(true, false); b.getWorldPosition(v); }
    else v.set(0, 1.05, 0).applyMatrix4(this.root.matrixWorld);
    return v;
  }

  backZoneInfo() {
    this.root.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    this.backZone.getWorldPosition(pos);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion);
    return { mesh: this.backZone, position: pos, forward };
  }

  /** drive the mouth while a line is playing */
  speak(seconds) { this._speakUntil = this._t + seconds; }

  /* ------------------------------------------------------------- animate -- */
  update(dt, t) {
    this._t += dt;
    this._tickBlood();
    if (!this.vrm) return;
    if (!this.root.visible) return;

    if (this._turn) {
      const s = this._turn;
      s.t = Math.max(s.t + dt, (performance.now() - (s.t0 || performance.now())) / 1000);
      const k = Math.min(1, s.t / s.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.root.rotation.y = s.from + s.delta * e;
      if (k >= 1) {
        this._turning = false;
        const done = s.resolve;
        this._turn = null;
        this.mode = 'idle';
        done && done();
      }
    }

    // the stride is scaled by her actual ground speed, so a slow floor reads
    // as a slow walk instead of a fast walk sliding over the pavement
    const base = this.mode === 'walk' ? 1.0
      : this.mode === 'chase' ? 1.9
        : this.mode === 'attack' ? 0 : 0;
    const target = base * (this.pace || 1);
    this._walkSpeed += (target - this._walkSpeed) * Math.min(1, dt * 5);
    this._walkPhase += dt * (2.2 + this._walkSpeed * 3.4);
    const ph = this._walkPhase;
    const sw = Math.sin(ph);
    const b = this.bones;

    // --- legs ---------------------------------------------------------------
    const stride = 0.62 * this._walkSpeed;
    if (b.leftUpperLeg) b.leftUpperLeg.rotation.x = sw * stride;
    if (b.rightUpperLeg) b.rightUpperLeg.rotation.x = -sw * stride;
    if (b.leftLowerLeg) b.leftLowerLeg.rotation.x = Math.max(0, -sw) * stride * 1.5;
    if (b.rightLowerLeg) b.rightLowerLeg.rotation.x = Math.max(0, sw) * stride * 1.5;
    if (b.leftFoot) b.leftFoot.rotation.x = -Math.max(0, -sw) * stride * 0.7;
    if (b.rightFoot) b.rightFoot.rotation.x = -Math.max(0, sw) * stride * 0.7;

    // --- arms, opposite the legs -------------------------------------------
    const armSwing = 0.42 * this._walkSpeed;
    if (b.leftUpperArm) {
      b.leftUpperArm.rotation.z = -1.28 + Math.abs(sw) * 0.05 * this._walkSpeed;
      b.leftUpperArm.rotation.x = -sw * armSwing;
    }
    if (b.rightUpperArm) {
      // the bag hand barely swings
      b.rightUpperArm.rotation.z = 1.28 - Math.abs(sw) * 0.05 * this._walkSpeed;
      b.rightUpperArm.rotation.x = sw * armSwing * 0.45;
    }
    if (b.leftLowerArm) b.leftLowerArm.rotation.x = -0.12 - Math.max(0, -sw) * 0.25 * this._walkSpeed;
    if (b.rightLowerArm) b.rightLowerArm.rotation.x = -0.18 - Math.max(0, sw) * 0.1 * this._walkSpeed;

    // --- body ---------------------------------------------------------------
    const breath = Math.sin(t * 1.35) * 0.006;
    if (b.hips) {
      b.hips.position.y = (this.bones.hips.userData.baseY ?? (this.bones.hips.userData.baseY = b.hips.position.y))
        + Math.abs(Math.sin(ph)) * 0.014 * this._walkSpeed + breath * 0.4;
      b.hips.rotation.z = Math.sin(ph) * 0.03 * this._walkSpeed;
    }
    if (b.spine) {
      b.spine.rotation.y = -Math.sin(ph) * 0.06 * this._walkSpeed;
      b.spine.rotation.x = 0.02 + this._walkSpeed * 0.05;
    }
    // --- where she is looking (solved before the head is posed) ----------
    const lookYaw = this._updateLook(dt);
    const lookPitch = this._lookPitch || 0;

    if (b.neck) {
      b.neck.rotation.x = -this._walkSpeed * 0.04 + lookPitch * 0.30;
      b.neck.rotation.y = lookYaw * 0.34;
    }

    // head: the too-still uncanny beat, plus most of the look
    if (b.head) {
      const idleSway = Math.sin(t * 0.31) * 0.10 * (1 - this._walkSpeed);
      b.head.rotation.y = idleSway - Math.sin(ph) * 0.04 * this._walkSpeed + lookYaw * 0.66;
      b.head.rotation.x = 0.03 + Math.sin(t * 0.7) * 0.015 + lookPitch * 0.70;
      b.head.rotation.z = Math.sin(t * 0.42) * 0.03;
      if (this.mode === 'chase') b.head.rotation.x += 0.10;
    }

    // --- face -------------------------------------------------------------
    const ex = this.vrm.expressionManager;
    if (ex) {
      // blink every few seconds
      this._blinkAt -= dt;
      let blink = 0;
      if (this._blinkAt < 0.13) blink = Math.sin((0.13 - this._blinkAt) / 0.13 * Math.PI);
      if (this._blinkAt < 0) this._blinkAt = 2.6 + Math.random() * 3.4;
      try { ex.setValue('blink', blink); } catch (e) { /* expression optional */ }

      // mouth while speaking
      const speaking = this._t < this._speakUntil;
      const target2 = speaking ? 0.5 + Math.sin(this._t * 17) * 0.35 + Math.sin(this._t * 6.3) * 0.15 : 0;
      this._mouth += (target2 - this._mouth) * Math.min(1, dt * 18);
      try { ex.setValue('aa', THREE.MathUtils.clamp(this._mouth, 0, 1)); } catch (e) { /* optional */ }

      /* the smile: it only ever appears while her head is turned all the way
         round, which is exactly long enough for it to be seen and not long
         enough to be comfortable */
      const smiling = this._t < (this._smileUntil || 0);
      this._smile = THREE.MathUtils.damp(this._smile || 0, smiling ? 1 : 0, smiling ? 3.2 : 4.5, dt);
      try { ex.setValue('happy', this._smile * 0.92); } catch (e) { /* optional */ }
    }

    this.vrm.update(dt);
    this._guardSkeleton();
    this._repairHead(dt);
  }

  /* A finite check over her whole skeleton, every frame. It costs a couple of
     hundred comparisons and it is the difference between a girl who is drawn
     and a girl who silently is not: a single NaN in a bone — anywhere — makes
     its entire subtree emit nothing, and nothing else in the alley looks
     wrong, so it reads to a player as "she never appeared". */
  _guardSkeleton() {
    const list = this._sanitizeBones;
    if (!list || !list.length) return;
    let bad = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!Number.isFinite(b.quaternion.w) || !Number.isFinite(b.quaternion.x)
        || !Number.isFinite(b.position.x) || !Number.isFinite(b.scale.x)) {
        b.quaternion.copy(b.userData._restQ || IDENTITY_Q);
        if (b.userData._restP) b.position.copy(b.userData._restP);
        if (b.userData._restS) b.scale.copy(b.userData._restS);
        bad++;
      }
    }
    this._nanBones = bad;
    if (bad) {
      if (this.vrm) this.vrm.update(0);
      if (!this._nanWarned) {
        this._nanWarned = true;
        console.warn('[Maigo] skeleton had ' + bad + ' non-finite bone(s); reset to rest pose');
      }
    }
  }

  /** put every bone back to the pose she was authored in (used by the rescue) */
  restoreRestPose() {
    const list = this._sanitizeBones || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.userData._restQ) b.quaternion.copy(b.userData._restQ);
      if (b.userData._restP) b.position.copy(b.userData._restP);
      if (b.userData._restS) b.scale.copy(b.userData._restS);
    }
    if (this.vrm) this.vrm.update(0);
    this.root.updateMatrixWorld(true);
  }

  /* The humanoid pass cannot be trusted with this model's head (see load()).
     Rebuild the head from its rest pose each frame and layer the solved look
     on top, so the 180° turn and the ordinary eye-line both survive. */
  _repairHead() {
    if (!this.vrm) return;
    try {
      this._repairHeadInner();
    } catch (err) {
      if (!this._repairWarned) {
        this._repairWarned = true;
        console.warn('[maigo] head repair skipped:', err && err.message);
      }
    }
  }

  _repairHeadInner() {
    if (!this.vrm || !this.vrm.humanoid || !this.vrm.humanoid.getRawBoneNode) return;
    /* Never re-pose the head here. Earlier this method rebuilt the head from
       its rest quaternion every frame and layered our look on in local space —
       but this rig's head bone sits at ~90° to the body, so a local-space yaw
       tilted the whole head sideways. The rig's own pose already solves the
       look correctly through the normalized rig, so the only job left is to
       repair a bone the humanoid pass has poisoned with NaN. */
    const raw = this.vrm.humanoid.getRawBoneNode('head');
    if (raw && (!Number.isFinite(raw.quaternion.w) || !Number.isFinite(raw.position.x))) {
      raw.quaternion.copy(this._restHeadQ || IDENTITY_Q);
      if (this._restHeadPos) raw.position.copy(this._restHeadPos);
      if (this._restHeadScale) raw.scale.copy(this._restHeadScale);
    }
    const nb = this.bones && this.bones.head;
    if (nb && !Number.isFinite(nb.quaternion.w)) nb.quaternion.copy(this._restNormHeadQ || IDENTITY_Q);
    if (this._sanitizeBones) {
      for (let i = 0; i < this._sanitizeBones.length; i++) {
        const b = this._sanitizeBones[i];
        if (!Number.isFinite(b.quaternion.w)) b.quaternion.copy(b.userData._restQ || IDENTITY_Q);
        if (!Number.isFinite(b.position.x) && b.userData._restP) b.position.copy(b.userData._restP);
        if (!Number.isFinite(b.scale.x) && b.userData._restS) b.scale.copy(b.userData._restS);
      }
    }
  }

  attackPose() {
    this.setMode('attack');
    if (this.bones.head) {
      this.bones.head.rotation.x = -0.28;
      this.bones.head.rotation.z = 0.18;
    }
    if (this.bones.chest) this.bones.chest.rotation.x = 0.18;
    this.vrm && this.vrm.update(0);
  }
}

export default VRMMaigo;
