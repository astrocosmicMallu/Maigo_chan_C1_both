/* ============================================================================
   rig.js — what is in your hands

   The blanket rides in the bottom-left of the frame and the candies in the
   bottom-right. They are not stuck in front of the world camera: they live in
   their own tiny scene that is drawn over the finished frame with the depth
   buffer cleared, so they can never clip through a wall, sink into the road,
   or be eaten by the ink-wash grade. That is what "screen-bound" means here.

   Both are anchored to the *corner of the viewport*, not to a world position,
   so a phone in portrait and a monitor in landscape both get them tucked out
   of the sightline. They sit low: the top edge of either stack never rises
   above the lower fifth of the frame, and nothing crosses the centre.
   ========================================================================== */

import * as THREE from 'three';
import { makeCloth, makeCandy } from './items.js?v=b89';

export class ViewportRig {
  constructor(renderer, envMap = null) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    if (envMap) this.scene.environment = envMap;

    // a 53.13° lens puts exactly 1.0 world unit of height on the plane at z=-1,
    // which makes every layout number below a fraction of the screen height
    this.camera = new THREE.PerspectiveCamera(53.13010235415598, 1, 0.1, 4);
    this.camera.position.set(0, 0, 0);

    // three lights, no shadows: enough for sheen on cloth and a hot glint on
    // cellophane, cheap enough to be free at 60 fps
    const hemi = new THREE.HemisphereLight(0x9fb2cc, 0x241d18, 1.15);
    const key = new THREE.DirectionalLight(0xfff0d6, 2.35);
    key.position.set(-0.6, 0.9, 1.0);
    const rim = new THREE.DirectionalLight(0x7fa6cc, 0.85);
    rim.position.set(0.8, 0.2, -0.6);
    this.scene.add(hemi, key, rim);

    this.clothGroup = new THREE.Group();
    this.candyGroup = new THREE.Group();
    this.scene.add(this.clothGroup, this.candyGroup);

    this.clothPieces = 0;
    this.candyPieces = 0;
    this._clothCache = [];
    this._candyCache = [];
    this._t = 0;
    this.scale = 1;
    this.resize();          // aspect comes from the real window, not the ctor
  }

  /* ------------------------------------------------------------ layout -- */
  _layout() {
    const aspect = this.camera.aspect || 1;
    const halfW = 0.5 * aspect, halfH = 0.5;
    // keep the props the same *screen* proportion on every device
    const s = THREE.MathUtils.clamp(Math.min(1, halfW / 0.62), 0.42, 1);
    this.scale = s;

    /* A phone puts the joystick and the INTERACT ring in exactly these two
       corners, so on a tall screen the props ride a little higher — above the
       thumbs, still inside the bottom third. */
    const lift = aspect < 0.78 ? 0.145 : 0;

    // bottom-left: the blanket, hanging off the frame edge
    this.clothBase = { x: -halfW + 0.155 * s, y: -halfH + 0.075 * s + lift };
    this.clothGroup.position.set(this.clothBase.x, this.clothBase.y, -1);

    // bottom-right: the row of sweets
    this.candyBase = { x: halfW - 0.10 * s, y: -halfH + 0.10 * s + lift };
    this.candyGroup.position.set(this.candyBase.x, this.candyBase.y, -1);
  }

  resize() {
    const w = window.innerWidth || 1280, h = window.innerHeight || 720;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._layout();
    this._applyCounts();
  }

  /* ------------------------------------------------------------- cloth -- */
  setCloth(n) {
    n = THREE.MathUtils.clamp(n | 0, 0, 3);
    if (n === this.clothPieces) return;
    this.clothPieces = n;
    this._applyCounts();
  }

  /* ------------------------------------------------------------- candy -- */
  setCandy(n) {
    n = THREE.MathUtils.clamp(n | 0, 0, 3);
    if (n === this.candyPieces) return;
    this.candyPieces = n;
    this._applyCounts();
  }

  _applyCounts() {
    const s = this.scale;

    /* ---- cloth: each blanket is one more piece folded on top of the pile -- */
    while (this._clothCache.length < this.clothPieces) {
      const i = this._clothCache.length;
      const piece = makeCloth(0.30, 0.225, i + 1, {
        folds: 4.2 + i * 0.8, droop: 0.05, cup: 0.055, hemTone: i % 2 ? 0x8f7f6d : 0xa08f7b,
      });
      piece.rotation.z = -0.26 + i * 0.10;
      piece.rotation.y = 0.20 - i * 0.34;
      piece.rotation.x = -0.30 - i * 0.04;
      piece.position.set(i * 0.012 * s, -i * 0.019 * s, i * 0.004);
      piece.scale.setScalar(s * (1 - i * 0.05));
      this.clothGroup.add(piece);
      this._clothCache.push(piece);
    }
    this._clothCache.forEach((p, i) => {
      p.visible = i < this.clothPieces;
      p.rotation.z = -0.26 + i * 0.10;
      p.rotation.y = 0.20 - i * 0.34;
      p.position.set(i * 0.012 * s, -i * 0.019 * s, i * 0.004);
      p.scale.setScalar(s * (1 - i * 0.05));
    });

    /* ---- candy: laid out side by side, each at a slightly different angle -- */
    while (this._candyCache.length < this.candyPieces) {
      const i = this._candyCache.length;
      const c = makeCandy(s * 1.55);
      c.rotation.set(0.34, -0.5 + i * 0.42, -0.22 + i * 0.16);
      c.scale.setScalar(s * 1.55);
      this.candyGroup.add(c);
      this._candyCache.push(c);
    }
    this._candyCache.forEach((c, i) => {
      c.visible = i < this.candyPieces;
      c.rotation.set(0.34, -0.5 + i * 0.42, -0.22 + i * 0.16);
      c.scale.setScalar(s * 1.55);
    });
    // the row is centred on the anchor, so one sweet sits in the corner and
    // three spread inward — never toward the middle of the frame
    const spacing = 0.072 * s;
    const n = Math.max(1, this.candyPieces);
    this.candyGroup.position.x = this.candyBase.x + (n - 1) * spacing * 0.5;
    this._candyCache.forEach((c, i) => {
      c.position.set(-i * spacing, Math.sin(i * 2.1) * 0.006 * s, i * 0.01);
    });
  }

  /* ------------------------------------------------------------- frame -- */
  update(dt, playerSpeed = 0) {
    this._t += dt;
    const t = this._t;
    const s = this.scale;
    // carried, not welded: a slow sway, plus a kick counter to the stride
    const sway = Math.sin(t * 1.25) * 0.006 + Math.sin(t * 0.53) * 0.003;
    const kick = THREE.MathUtils.clamp(playerSpeed / 3.2, 0, 1);
    const bob = Math.sin(t * 7.4) * 0.012 * kick + Math.sin(t * 3.1) * 0.004;

    this.clothGroup.position.set(
      this.clothBase.x + sway * s - kick * 0.004 * s,
      this.clothBase.y + bob * s,
      -1
    );
    this.clothGroup.rotation.z = sway * 0.32 + Math.cos(t * 0.61) * 0.02;

    this.candyGroup.position.y = this.candyBase.y + bob * 1.25 * s + Math.sin(t * 0.9) * 0.003;
    this.candyGroup.rotation.z = -sway * 0.22;
    this.candyGroup.rotation.x = Math.sin(t * 0.7) * 0.05;
  }

  /** draw over the finished frame; the world's depth buffer is dropped first */
  render() {
    if (!this.clothPieces && !this.candyPieces) return;
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.camera);
    r.autoClear = prevAutoClear;
  }
}

export default ViewportRig;
