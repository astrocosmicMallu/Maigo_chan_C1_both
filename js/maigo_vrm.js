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
import { mulberry32 } from './textures.js?v=b13';
import { latheGeo } from './prims.js?v=b13';

const TARGET_HEIGHT = 1.44;       // a small fourteen-year-old

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

    this._buildBackZone();
  }

  /* ------------------------------------------------------------- loading -- */
  async load(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
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

  setTurning(on) { this._turning = on; }

  turnAround(duration = 1.15) { return this.turnTo(this.root.rotation.y + Math.PI, duration); }

  turnTo(yaw, duration = 0.9) {
    this._turning = true;
    this.mode = 'turn';
    const from = this.root.rotation.y;
    const delta = ((yaw - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return new Promise((resolve) => { this._turn = { from, delta, t: 0, dur: duration, resolve }; });
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
    if (!this.vrm) return;
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

    const target = this.mode === 'walk' ? 1.0
      : this.mode === 'chase' ? 1.9
        : this.mode === 'attack' ? 0 : 0;
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
    if (b.neck) b.neck.rotation.x = -this._walkSpeed * 0.04;

    // head: the too-still uncanny beat
    if (b.head) {
      const idleSway = Math.sin(t * 0.31) * 0.10 * (1 - this._walkSpeed);
      b.head.rotation.y = idleSway - Math.sin(ph) * 0.04 * this._walkSpeed;
      b.head.rotation.x = 0.03 + Math.sin(t * 0.7) * 0.015;
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
    }

    this.vrm.update(dt);
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
