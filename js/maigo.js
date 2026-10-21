/* ============================================================================
   maigo.js — Maigo-chan
   ----------------------------------------------------------------------------
   The body and head are baked from a signed-distance sculpt (js/anatomy.js) with
   surface nets, so she is one continuous organic mesh rather than assembled
   primitives. On top of that sculpt sit the things an SDF cannot express well:
     · layered hair cards with per-strand normals (fringe, side locks, curtain)
     · anime eyes (sclera shell, iris disc, specular catch, soft lid crease)
     · brows, lash line, lip tint, cheek warmth
     · the plastic bag of meat from the reference photograph
     · a procedural sailor uniform with a pleated skirt
   She is rigged as a simple hierarchy (hips → torso → head / arms, hips → legs)
   and animated procedurally; no keyframes, no external model files.
   ========================================================================== */

import * as THREE from 'three';
import { bakeCharacter, REGION } from './anatomy.js?v=b13';
import { glowSpriteTexture, mulberry32 } from './textures.js?v=b13';
import { sphereGeo, discGeo, capsuleGeo, torusGeo, blobGeo } from './prims.js?v=b13';

/* --------------------------------------------------------- hair helper --- */
/**
 * One tapered hair card. `pts` is a spine in local space, `w` the half width
 * at the root; the card is two quads wide at the tip so strands overlap into a
 * mass instead of reading as separate ribbons.
 */
function hairCard(pts, w, { normal = [0, 0, 1], twist = 0, taper = 0.18 } = {}) {
  const seg = pts.length - 1;
  const pos = [], uv = [], nrm = [], idx = [];
  const N = new THREE.Vector3(...normal).normalize();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const c = pts[i];
    const halfW = w * (1 - t * (1 - taper));
    // side vector = normal × tangent
    const tan = i < seg
      ? new THREE.Vector3().subVectors(pts[i + 1], pts[i]).normalize()
      : new THREE.Vector3().subVectors(pts[i], pts[i - 1]).normalize();
    const side = new THREE.Vector3().crossVectors(N, tan).normalize().multiplyScalar(halfW);
    if (twist) side.applyAxisAngle(tan, twist * t);
    const a = c.clone().add(side);
    const b = c.clone().sub(side);
    // slight outward cup so cards catch rim light
    const cup = N.clone().multiplyScalar(halfW * 0.22 * Math.sin(Math.PI * t));
    a.add(cup); b.add(cup);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const nx = N.x, ny = N.y, nz = N.z;
    nrm.push(nx, ny, nz, nx, ny, nz);
    uv.push(0, t, 1, t);
    if (i < seg) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/* ================================================================ class */
export class SculptMaigo {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'maigo';
    this.root.visible = false;
    scene.add(this.root);

    this.mode = 'hidden';
    this._turning = false;
    this._t = 0;
    this._walkPhase = 0;
    this._walkSpeed = 0;
    this._bake = null;

    this._buildMaterials();
    this._buildRig();
    this._buildHair();
    this._buildFace();
    this._buildBag();
    this.buildBackZone();

    this.root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
    });
    this.backZone.castShadow = false;
    this.backZone.receiveShadow = false;
  }

  /* ------------------------------------------------------------ materials */
  _buildMaterials() {
    const skinTex = this._skinTexture();
    skinTex.repeat.set(1, 1);

    this.mats = {
      skin: new THREE.MeshPhysicalMaterial({
        color: 0xc9b6ae,
        roughness: 0.72, metalness: 0.0,
        clearcoat: 0.05, clearcoatRoughness: 0.7,
        sheen: 0.22, sheenColor: new THREE.Color(0xffd8d2),
        envMapIntensity: 0.5,
        map: skinTex,
      }),
      blouse: new THREE.MeshPhysicalMaterial({
        color: 0xd9dde2, roughness: 0.82, metalness: 0.0,
        sheen: 0.55, sheenColor: new THREE.Color(0x9fb0c8),
        clearcoat: 0.03, envMapIntensity: 0.35,
      }),
      collar: new THREE.MeshPhysicalMaterial({
        color: 0x162136, roughness: 0.72, metalness: 0.0,
        sheen: 0.45, sheenColor: new THREE.Color(0x56709c),
        envMapIntensity: 0.4,
      }),
      skirt: new THREE.MeshPhysicalMaterial({
        color: 0x172132, roughness: 0.78, metalness: 0.02,
        sheen: 0.7, sheenColor: new THREE.Color(0x4d608a),
        clearcoat: 0.05, envMapIntensity: 0.42,
      }),
      sock: new THREE.MeshStandardMaterial({ color: 0x1b1e28, roughness: 0.9, metalness: 0.0 }),
      shoe: new THREE.MeshPhysicalMaterial({
        color: 0x0b0b0f, roughness: 0.3, metalness: 0.03,
        clearcoat: 0.85, clearcoatRoughness: 0.24, envMapIntensity: 0.9,
      }),
      hair: new THREE.MeshPhysicalMaterial({
        color: 0x0a0a10, roughness: 0.80, metalness: 0.0,
        clearcoat: 0.0, clearcoatRoughness: 0.9,
        sheen: 0.14, sheenColor: new THREE.Color(0x1c1e26),
        envMapIntensity: 0.35,
        side: THREE.DoubleSide,
      }),
      hairSheen: new THREE.MeshBasicMaterial({
        color: 0x5f6d93, transparent: true, opacity: 0.13,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
      sclera: new THREE.MeshPhysicalMaterial({
        color: 0xe6ecf2, roughness: 0.2, metalness: 0.0,
        clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 1.2,
      }),
      iris: new THREE.MeshPhysicalMaterial({
        color: 0x20303f, roughness: 0.14, metalness: 0.12,
        emissive: 0x6fc4ea, emissiveIntensity: 0.40,
        clearcoat: 1.0, clearcoatRoughness: 0.04,
      }),
      pupil: new THREE.MeshBasicMaterial({ color: 0x02030a }),
      catch: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
      lash: new THREE.MeshBasicMaterial({ color: 0x0a0a0e, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      brow: new THREE.MeshBasicMaterial({ color: 0x14121a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      lip: new THREE.MeshPhysicalMaterial({
        color: 0x6f4046, roughness: 0.86, metalness: 0.0,
        clearcoat: 0.0, clearcoatRoughness: 1.0, envMapIntensity: 0.25,
      }),
      blush: new THREE.MeshBasicMaterial({
        color: 0xb45a63, transparent: true, opacity: 0.075,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
      blood: new THREE.MeshPhysicalMaterial({
        color: 0x3d0409, roughness: 0.22, metalness: 0.05,
        clearcoat: 0.95, clearcoatRoughness: 0.12,
        emissive: 0x160103, emissiveIntensity: 0.22,
      }),
      gore: new THREE.MeshPhysicalMaterial({
        color: 0x4a060c, roughness: 0.2, metalness: 0.04,
        clearcoat: 0.9, clearcoatRoughness: 0.15,
      }),
      bag: new THREE.MeshPhysicalMaterial({
        color: 0xdbe4ec, roughness: 0.14, metalness: 0.0,
        transparent: true, opacity: 0.34, transmission: 0.0,
        clearcoat: 1, clearcoatRoughness: 0.06,
        side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.3,
      }),
    };
  }

  /** faint pore/skin variation so the face is not a plastic solid */
  _skinTexture() {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, S, S);
    const rnd = mulberry32(77);
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * S, y = rnd() * S;
      const v = 236 + Math.floor(rnd() * 19);
      g.fillStyle = `rgba(${v},${v - 6},${v - 10},0.5)`;
      g.fillRect(x, y, 1, 1);
    }
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(196,150,150,${0.05 + rnd() * 0.06})`;
      g.beginPath();
      g.arc(rnd() * S, rnd() * S, 2 + rnd() * 4, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* ------------------------------------------------------------------ rig */
  _buildRig() {
    // bake once; the head uses a finer lattice because faces need the detail
    const { head, body } = bakeCharacter(0.0084);
    this._bake = { head, body };

    const mk = (bake, matFor) => {
      const group = new THREE.Group();
      for (const [region, index] of Object.entries(bake.indices)) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(bake.positions, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(bake.normals, 3));
        g.setIndex(new THREE.BufferAttribute(index, 1));
        const mat = matFor(Number(region));
        if (!mat) continue;
        const mesh = new THREE.Mesh(g, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        group.add(mesh);
      }
      return group;
    };

    const bodyMat = (r) => ({
      [REGION.SKIN]: this.mats.skin,
      [REGION.BLOUSE]: this.mats.blouse,
      [REGION.SKIRT]: this.mats.skirt,
      [REGION.SOCK]: this.mats.sock,
      [REGION.SHOE]: this.mats.shoe,
      [REGION.COLLAR]: this.mats.collar,
    }[r]);

    // hips → torso → head, plus an upper-body root so the whole figure can bob
    this.hips = new THREE.Group();
    this.hips.position.y = 0;
    this.root.add(this.hips);

    this.bodyMesh = mk(body, bodyMat);
    this.hips.add(this.bodyMesh);

    this.head = new THREE.Group();
    this.head.position.set(0, 0, 0);
    this.hips.add(this.head);
    this.head.add(mk(head, () => this.mats.skin));

    // shoulder pivot used for sway; head pivot for look-at
    this.headPivot = new THREE.Group();
    this.headPivot.position.set(0, 1.238, 0.012);
    this.hips.add(this.headPivot);

    // hair + face ride on a pivot at the skull base so they can lead the head
    this.skull = new THREE.Group();
    this.skull.position.set(0, -1.238, -0.012);
    this.headPivot.add(this.skull);
  }

  /* ------------------------------------------------------------- hair ---- */
  /**
   * Hair shell: a parametric dome around the skull with a wedge cut out for
   * the face. Fuller at the back, tight over the crown — this is the silhouette
   * that reads as a bob even at distance, before any strands are drawn.
   */
  _hairShell() {
    const R0 = 0.099, CY = 1.300;
    const NT = 30, NP = 64;          // polar × azimuth
    const THETA_MAX = Math.PI * 0.66;
    const OPEN_THETA = Math.PI * 0.26;   // opening starts below the crown
    const OPEN_HALF = 0.62;              // half-width of the face wedge (rad)

    const pos = [], nrm = [], uv = [], idx = [];
    const gridId = [];
    for (let i = 0; i <= NT; i++) {
      gridId[i] = [];
      const theta = (i / NT) * THETA_MAX;
      for (let j = 0; j <= NP; j++) {
        const phi = (j / NP) * Math.PI * 2;
        // fullness: +12 % at the back (-Z), tighter at the front
        const back = 1 + 0.13 * (0.5 - 0.5 * Math.cos(phi));   // 0 at front, 1 at back
        // thin the shell toward its rim so the edge reads as hair, not a plate
        const rimT = Math.min(1, (THETA_MAX - theta) / (Math.PI * 0.16));
        const r = R0 * (0.99 + 0.12 * back) * (0.985 + 0.015 * rimT);
        const st = Math.sin(theta);
        const x = st * Math.sin(phi) * r;
        const z = st * Math.cos(phi) * r + 0.004;
        const y = Math.cos(theta) * r * 1.13;
        // face opening: skip vertices inside the front wedge below the crown
        const inWedge = Math.abs(Math.atan2(x, z)) < OPEN_HALF;
        const open = inWedge && theta > OPEN_THETA;
        gridId[i][j] = open ? -1 : pos.length / 3;
        if (open) continue;
        pos.push(x, y, z);
        const n = new THREE.Vector3(x, y * 0.9, z).normalize();
        nrm.push(n.x, n.y, n.z);
        uv.push(j / NP, i / NT);
      }
    }
    for (let i = 0; i < NT; i++) {
      for (let j = 0; j < NP; j++) {
        const a = gridId[i][j], b = gridId[i][j + 1];
        const c = gridId[i + 1][j + 1], d = gridId[i + 1][j];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        idx.push(a, c, b, a, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.translate(0, CY, 0);
    return g;
  }

  _buildHair() {
    const rnd = mulberry32(1907);
    const geos = [];

    // --- the shell -------------------------------------------------------
    geos.push(this._hairShell());

    // --- fringe: short cards sitting ON the brow, never over the eyes -----
    for (let i = 0; i < 26; i++) {
      const u = i / 25;
      const x = (u - 0.5) * 0.170;
      const zf = Math.sqrt(Math.max(0.0004, 0.093 * 0.093 - x * x)) + 0.006;
      // curtain bang: shorter in the middle, longer toward the temples
      const len = 0.052 + Math.pow(Math.abs(u - 0.5) * 2, 1.6) * 0.052 + rnd() * 0.006;
      const pts = [];
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        pts.push(new THREE.Vector3(
          x * (1 + t * 0.05) + (rnd() - 0.5) * 0.003 * t,
          1.398 - Math.cos((u - 0.5) * Math.PI) * 0.012 - t * len,
          zf * (1 - t * 0.05),
        ));
      }
      geos.push(hairCard(pts, 0.0125 + rnd() * 0.004, { normal: [x * 3, 0.2, 1] }));
    }

    // --- side locks in front of the ears, tapering past the jaw ----------
    for (const s of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const pts = [];
        for (let i = 0; i <= 5; i++) {
          const t = i / 5;
          pts.push(new THREE.Vector3(
            s * (0.088 + t * 0.006 + k * 0.002),
            1.348 - t * (0.175 + k * 0.030),
            0.058 + t * 0.002 - k * 0.008,
          ));
        }
        geos.push(hairCard(pts, 0.015 + k * 0.004, { normal: [s, 0.05, 0.25] }));
      }
    }

    // --- the long curtain: hangs from the BACK of the skull --------------
    const CURTAIN = 40;
    for (let i = 0; i < CURTAIN; i++) {
      const u = i / (CURTAIN - 1);
      // arc centred on -Z (her back): -π/2 ± 0.58π
      const ang = Math.PI + (u - 0.5) * Math.PI * 1.12;   // centred on -Z (her back)
      const rr = 0.094 + rnd() * 0.007;
      const px = Math.sin(ang) * rr;
      const pz = Math.cos(ang) * rr;
      const len = 0.28 + rnd() * 0.09;
      const pts = [];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        pts.push(new THREE.Vector3(
          px * (1 + t * 0.16) + (rnd() - 0.5) * 0.012 * t,
          1.330 - t * len,
          pz * (1 + t * 0.18),
        ));
      }
      geos.push(hairCard(pts, 0.019 + rnd() * 0.007, { normal: [px, 0.1, pz] }));
    }

    // --- one wet lock across the cheek, as in the reference photograph ---
    const lock = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      lock.push(new THREE.Vector3(
        -0.036 + t * 0.020,
        1.352 - t * 0.105,
        0.078 + t * 0.006,
      ));
    }
    geos.push(hairCard(lock, 0.0042, { normal: [0, 0, 1], taper: 0.06 }));

    this.hairGroup = new THREE.Group();
    for (const g of geos) {
      const m = new THREE.Mesh(g, this.mats.hair);
      m.castShadow = true;
      m.receiveShadow = false;
      m.frustumCulled = false;
      this.hairGroup.add(m);
    }
    this.skull.add(this.hairGroup);

    // rim light so hair keeps a cold edge against the dark
    this.hairRim = new THREE.PointLight(0xb9c6e0, 0.30, 2.2, 2);
    this.hairRim.position.set(0, 1.34, -0.30);
    this.skull.add(this.hairRim);

    // a whisper of bounce in front of the face — keeps her legible in the dark
    this.faceFill = new THREE.PointLight(0xffd9c8, 0.55, 1.1, 2);
    this.faceFill.position.set(0, 1.30, 0.46);
    this.skull.add(this.faceFill);
  }

  /* ------------------------------------------------------------- face ---- */
  _buildFace() {
    const face = new THREE.Group();
    const EYE_Y = 1.2900, EYE_Z = 0.0735, DX = 0.0325;

    for (const s of [-1, 1]) {
      // sclera: a shallow cap of a sphere, set into the socket
      const sclera = new THREE.Mesh(sphereGeo(0.0149, 24, 18), this.mats.sclera);
      sclera.position.set(DX * s, EYE_Y - 0.0012, EYE_Z - 0.0035);
      sclera.scale.set(1.16, 0.92, 0.82);
      face.add(sclera);

      // iris
      const iris = new THREE.Mesh(discGeo(0.0082, 26), this.mats.iris);
      iris.position.set(DX * s, EYE_Y - 0.0016, EYE_Z + 0.0092);
      iris.scale.set(1, 0.96, 1);
      face.add(iris);

      // pupil
      const pupil = new THREE.Mesh(discGeo(0.0039, 20), this.mats.pupil);
      pupil.position.set(DX * s, EYE_Y - 0.0018, EYE_Z + 0.0097);
      face.add(pupil);

      // specular catch-lights: the single biggest "reads as anime" cue
      const c1 = new THREE.Mesh(discGeo(0.0029, 14), this.mats.catch);
      c1.position.set(DX * s - 0.0030, EYE_Y + 0.0030, EYE_Z + 0.0100);
      face.add(c1);
      const c2 = new THREE.Mesh(discGeo(0.0013, 12), this.mats.catch);
      c2.position.set(DX * s + 0.0036, EYE_Y - 0.0038, EYE_Z + 0.0100);
      face.add(c2);

      // upper lash line, angled up at the outer corner
      const lashPts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        lashPts.push(new THREE.Vector3(
          DX * s + (t - 0.5) * 0.040 * s,
          EYE_Y + 0.0118 + Math.sin(t * Math.PI) * 0.0032 + t * 0.0016,
          EYE_Z + 0.0122,
        ));
      }
      face.add(new THREE.Mesh(hairCard(lashPts, 0.0026, { normal: [0, 0, 1], taper: 0.35 }), this.mats.lash));

      // brow
      const browPts = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        browPts.push(new THREE.Vector3(
          DX * s + (t - 0.5) * 0.052 * s,
          EYE_Y + 0.0265 + Math.sin(t * Math.PI) * 0.0030,
          EYE_Z + 0.0092,
        ));
      }
      face.add(new THREE.Mesh(hairCard(browPts, 0.0021, { normal: [0, 0, 1], taper: 0.3 }), this.mats.brow));

      // cheek warmth
      const blush = new THREE.Mesh(discGeo(0.020, 18), this.mats.blush);
      blush.position.set(DX * s * 1.5, EYE_Y - 0.030, EYE_Z + 0.0075);
      blush.rotation.y = s * 0.42;
      face.add(blush);
    }

    // lips: two soft pads tinted from the reference photograph
    const upper = new THREE.Mesh(sphereGeo(0.0080, 18, 10), this.mats.lip);
    upper.position.set(0, 1.2462, 0.0842);
    upper.scale.set(1.85, 0.42, 0.26);
    face.add(upper);
    const lower = new THREE.Mesh(sphereGeo(0.0086, 18, 10), this.mats.lip);
    lower.position.set(0, 1.2408, 0.0838);
    lower.scale.set(1.55, 0.50, 0.28);
    face.add(lower);

    // blood at the mouth corner and a thin drip down the chin
    const smear = new THREE.Mesh(discGeo(0.0062, 14), this.mats.blood);
    smear.position.set(0.0135, 1.2412, 0.0862);
    smear.scale.set(1, 1.5, 1);
    face.add(smear);
    const drip = new THREE.Mesh(capsuleGeo(0.0011, 0.020, 8, 4), this.mats.blood);
    drip.position.set(0.0155, 1.2285, 0.0855);
    face.add(drip);

    this.faceGroup = face;
    this.skull.add(face);
  }

  /* -------------------------------------------------------------- bag ---- */
  _buildBag() {
    const g = new THREE.Group();
    g.position.set(-0.152, 0.618, 0.040);

    // crumpled plastic: an icosahedron pushed around by noise
    const bagGeo = blobGeo(0.098, 3, 0.09, 11);
    const p = bagGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const n = 1 + Math.sin(x * 42 + y * 17) * 0.055 + Math.cos(z * 51 - y * 23) * 0.05
        + Math.sin(y * 9 + z * 31) * 0.04;
      p.setXYZ(i, x * n, y * n * 1.35, z * n);
    }
    bagGeo.computeVertexNormals();
    const bag = new THREE.Mesh(bagGeo, this.mats.bag);
    bag.scale.set(0.82, 1, 0.66);
    bag.position.y = -0.115;
    bag.renderOrder = 2;
    g.add(bag);

    // the meat inside
    for (let i = 0; i < 5; i++) {
      const r = 0.030 + (i % 3) * 0.009;
      const m = new THREE.Mesh(blobGeo(r, 2, 0.18, 3 + i * 7), this.mats.gore);
      const a = i * 2.1;
      m.position.set(Math.cos(a) * 0.030, -0.115 + Math.sin(a) * 0.042, Math.sin(a) * 0.022);
      m.scale.set(1, 1.25, 0.85);
      g.add(m);
    }

    // knotted handles
    const handle = new THREE.Mesh(torusGeo(0.030, 0.0035, 8, 20, Math.PI * 1.35), this.mats.bag);
    handle.position.set(0, -0.020, 0.004);
    handle.rotation.x = Math.PI / 2;
    g.add(handle);

    this.bagRoot = g;
    this.skull.add(g);
  }

  /* --------------------------------------------------------- back hitbox -- */
  buildBackZone() {
    const geo = new THREE.PlaneGeometry(0.44, 0.62);
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
    const zone = new THREE.Mesh(geo, mat);
    // she faces +Z, so -Z is her back
    zone.position.set(0, 0.98, -0.115);
    zone.rotation.y = Math.PI;
    zone.renderOrder = -1;
    this.backZone = zone;
    this.root.add(zone);
    this.backZone.updateMatrixWorld(true);
  }

  /* ------------------------------------------------------------ state ---- */
  show(pos, faceTarget = null) {
    this.root.visible = true;
    this.root.position.copy(pos);
    this.root.position.y = 0;
    if (faceTarget) this.root.rotation.y = this.yawToward(faceTarget);
    this.setMode('idle');
    this.root.updateMatrixWorld(true);
    this.backZone.updateMatrixWorld(true);
  }

  hide() {
    this.root.visible = false;
    this.mode = 'hidden';
  }

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

  setTurning(on) { this._turning = on; }

  turnAround(duration = 1.15) {
    return this.turnTo(this.root.rotation.y + Math.PI, duration);
  }

  turnTo(yaw, duration = 0.9) {
    this._turning = true;
    this.mode = 'turn';
    const from = this.root.rotation.y;
    let delta = ((yaw - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return new Promise((resolve) => {
      this._turn = { from, delta, t: 0, dur: duration, resolve };
    });
  }

  headWorldPosition() {
    return new THREE.Vector3(0, 1.30, 0).applyMatrix4(this.skull.matrixWorld);
  }

  chestWorldPosition() {
    return new THREE.Vector3(0, 1.05, 0.02).applyMatrix4(this.skull.matrixWorld);
  }

  backZoneInfo() {
    this.root.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    this.backZone.getWorldPosition(pos);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion);
    return { mesh: this.backZone, position: pos, forward };
  }

  /* ------------------------------------------------------------ animate -- */
  update(dt, t) {
    this._t += dt;
    if (!this.root.visible) return;

    if (this._turn) {
      const s = this._turn;
      s.t += dt;
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

    const speedTarget = this.mode === 'walk' ? 1.0
      : this.mode === 'chase' ? 1.85
        : this.mode === 'attack' ? 0 : 0;
    this._walkSpeed += (speedTarget - this._walkSpeed) * Math.min(1, dt * 6);
    this._walkPhase += dt * this._walkSpeed * 6.2;

    const ph = this._walkPhase;
    const sw = Math.sin(ph);
    const bob = Math.abs(Math.cos(ph)) * 0.016 * this._walkSpeed;

    // whole-body motion
    this.hips.position.y = bob;
    this.hips.rotation.z = Math.sin(ph * 0.5) * 0.022 * this._walkSpeed;

    // head: counter-sway, idle micro-drift, and the too-still uncanny beat
    const idle = Math.sin(t * 0.7) * 0.012 + Math.sin(t * 0.23) * 0.008;
    this.headPivot.rotation.z = -Math.sin(ph * 0.5) * 0.03 * this._walkSpeed + idle * 0.5;
    this.headPivot.rotation.x = Math.sin(ph) * 0.02 * this._walkSpeed;
    this.headPivot.rotation.y = Math.sin(t * 0.29) * 0.06 * (1 - this._walkSpeed);
    this.skull.rotation.z = Math.sin(t * 0.41) * 0.02;

    // hair inertia
    if (this.hairGroup) {
      this.hairGroup.rotation.x = -this._walkSpeed * 0.10 + Math.sin(t * 0.9) * 0.012;
      this.hairGroup.rotation.z = Math.sin(t * 0.6) * 0.014 - this.hips.rotation.z * 0.5;
    }

    // bag swings from the left hand
    if (this.bagRoot) {
      this.bagRoot.rotation.z = Math.sin(ph * 0.9) * 0.14 * this._walkSpeed + Math.sin(t * 0.6) * 0.02;
      this.bagRoot.rotation.x = Math.sin(ph * 0.7 + 1) * 0.09 * this._walkSpeed;
    }

    // chase: lean forward, head drops, arms trail
    if (this.mode === 'chase') {
      this.headPivot.rotation.x += 0.12;
      this.hips.position.y += Math.sin(ph * 2) * 0.012;
    }

    // freeze: completely still, but breathing
    if (this.mode === 'freeze') {
      const br = Math.sin(t * 1.5) * 0.004;
      this.hips.position.y = br;
      this.headPivot.rotation.set(0.04, 0, 0.03);
    }
  }

  attackPose() {
    this.setMode('attack');
    this.headPivot.rotation.set(-0.22, 0, 0.16);
    this.skull.rotation.set(0.12, 0, -0.10);
    this.hips.position.y = 0.02;
    if (this.hairGroup) this.hairGroup.rotation.x = 0.28;
  }
}




/* ============================================================================
   FACADE
   ----------------------------------------------------------------------------
   `Maigo` owns two implementations: the VRM humanoid (preferred) and the
   sculpted fallback. Every accessor forwards to whichever one is active, so
   `maigo.root.position` in the rest of the game always means the right object.
   ========================================================================== */
export class Maigo {
  constructor(scene) {
    this.scene = scene;
    this._sculpt = null;        // built only if the VRM is unavailable
    this.vrmModel = null;
    this.isVRM = false;
    this.active = null;

    // a stand-in so anything that peeks at .root before the avatar exists
    // gets a real Object3D instead of null
    this._placeholder = new THREE.Group();
    this._placeholder.name = 'maigo-pending';
    this._placeholder.visible = false;
    scene.add(this._placeholder);
  }

  /** the sculpted fallback is expensive (SDF bake) — never build it eagerly */
  get sculpt() {
    if (!this._sculpt) {
      this._sculpt = new SculptMaigo(this.scene);
      if (!this.active) this.active = this._sculpt;
    }
    return this._sculpt;
  }

  useFallback() {
    if (this.isVRM) return this._sculpt;
    this._fallbackActive = true;
    // build-then-place: the sculpt bakes on first use, so anything that was
    // staged on the placeholder (or that a late VRM left behind) is copied on
    const sculpt = this.sculpt;
    this.active = sculpt;
    sculpt.root.visible = this._placeholder.visible;
    sculpt.root.position.copy(this._placeholder.position);
    return sculpt;
  }

  /* ---- forwarded transform / state ---- */
  get root() { return this.active ? this.active.root : this._placeholder; }
  get mode() { return this.active ? this.active.mode : 'hidden'; }
  set mode(v) { if (this.active) this.active.mode = v; }
  get backZone() { return this.active ? this.active.backZone : null; }
  get skull() { return (this.active && this.active.skull) || this.root; }
  get mats() { return (this.active && this.active.mats) || {}; }
  get ready() { return !!this.active; }

  show(...a) { return this.active ? this.active.show(...a) : undefined; }
  hide(...a) { return this.active ? this.active.hide(...a) : undefined; }
  face(...a) { return this.active ? this.active.face(...a) : undefined; }
  yawToward(...a) { return this.active ? this.active.yawToward(...a) : 0; }
  setMode(...a) { return this.active ? this.active.setMode(...a) : undefined; }
  setTurning(...a) { return this.active ? this.active.setTurning(...a) : undefined; }
  turnAround(...a) { return this.active ? this.active.turnAround(...a) : Promise.resolve(); }
  turnTo(...a) { return this.active ? this.active.turnTo(...a) : Promise.resolve(); }
  attackPose(...a) { return this.active ? this.active.attackPose(...a) : undefined; }
  update(...a) { return this.active ? this.active.update(...a) : undefined; }
  speak(seconds) { if (this.active && this.active.speak) this.active.speak(seconds); }

  headWorldPosition() {
    if (this.active) return this.active.headWorldPosition();
    return new THREE.Vector3(0, 1.30, 0).applyMatrix4(this.root.matrixWorld);
  }

  chestWorldPosition() {
    if (this.active) return this.active.chestWorldPosition();
    return new THREE.Vector3(0, 1.05, 0).applyMatrix4(this.root.matrixWorld);
  }

  backZoneInfo() {
    if (!this.active) return { mesh: null, position: this.root.position.clone(), forward: new THREE.Vector3(0, 0, 1) };
    return this.active.backZoneInfo();
  }

  /** swap in the VRM. Returns false and keeps the sculpt if anything fails. */
  load(url, force = false) {
    // idempotent per URL: a fetch started on the title screen is reused by the
    // intro, but a different file (the full VRM after a failed lite one) — or
    // an explicit retry — gets a fresh attempt instead of inheriting a failure
    if (!force && this._loadPromise && this._loadUrl === url) return this._loadPromise;
    this._loadUrl = url;
    this._loadPromise = this._load(url);
    return this._loadPromise;
  }

  async _load(url, { takeOver = false } = {}) {
    if (!url) { this.useFallback(); return false; }
    try {
      const { VRMMaigo } = await import('./maigo_vrm.js?v=b13');
      const vrm = new VRMMaigo(this.scene);
      const ok = await vrm.load(url);
      // do NOT stage the stand-in here: main.js retries the real download and
      // decides when to give up. A failure is reported, not papered over.
      if (!ok) { vrm.root.visible = false; return false; }

      this._placeholder.visible = false;
      // If the stand-in is already standing in the alley and the player can
      // see her, swapping models now would pop in plain view. Keep the stand-in
      // for the rest of this scene; it is a real sculpt, not a placeholder box.
      const sculpt = this._sculpt;
      if (sculpt && sculpt.root.visible && !takeOver) {
        vrm.root.visible = false;
        this.vrmModel = vrm;      // ready if she is ever staged again
        return true;
      }
      this.vrmModel = vrm;
      this.isVRM = true;
      if (sculpt) {
        sculpt.root.visible = false;
        vrm.root.position.copy(sculpt.root.position);
        vrm.root.rotation.y = sculpt.root.rotation.y;
        if (sculpt.mode && vrm.setMode) vrm.setMode(sculpt.mode);
        vrm.root.visible = true;
      } else {
        vrm.root.position.copy(this._placeholder.position);
        vrm.root.visible = this._placeholder.visible;
      }
      this.active = vrm;
      return true;
    } catch (err) {
      console.warn('[Maigo] VRM load error:', err);
      window.__avatarError = (err && err.message) || String(err);
      return false;
    }
  }
}

export default Maigo;
