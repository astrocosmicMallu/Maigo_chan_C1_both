/* ============================================================================
   prims.js — hand-built geometry
   ----------------------------------------------------------------------------
   The scene rule is "no THREE.BoxGeometry / SphereGeometry / CylinderGeometry":
   everything visible is either sculpted from a distance field or generated as
   raw buffers here. These are small parametric builders for the parts of Maigo
   that an SDF cannot express cheaply — eyes, lips, the bag handle.
   ========================================================================== */

import * as THREE from 'three';

/** UV sphere with correct normals and a single seam. */
export function sphereGeo(r, wSeg = 24, hSeg = 18) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let iy = 0; iy <= hSeg; iy++) {
    const v = iy / hSeg;
    const phi = v * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let ix = 0; ix <= wSeg; ix++) {
      const u = ix / wSeg;
      const theta = u * Math.PI * 2;
      const nx = sp * Math.cos(theta), ny = cp, nz = sp * Math.sin(theta);
      pos.push(nx * r, ny * r, nz * r);
      nrm.push(nx, ny, nz);
      uv.push(u, 1 - v);
    }
  }
  const row = wSeg + 1;
  for (let iy = 0; iy < hSeg; iy++) {
    for (let ix = 0; ix < wSeg; ix++) {
      const a = iy * row + ix, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, c, b, d, c);   // +Y → -Y rows flip the winding
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Flat disc in the XY plane, facing +Z. */
export function discGeo(r, seg = 26) {
  const pos = [0, 0, 0], nrm = [0, 0, 1], uv = [0.5, 0.5], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    pos.push(x, y, 0);
    nrm.push(0, 0, 1);
    uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
  }
  for (let i = 1; i <= seg; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Capsule along Y: a cylinder with hemispherical caps, built as a lathe. */
export function capsuleGeo(r, len, radial = 12, capSeg = 6) {
  const half = len / 2;
  const profile = [];
  // bottom cap: from the south pole up to the equator
  for (let i = 0; i <= capSeg; i++) {
    const a = -Math.PI / 2 + (i / capSeg) * (Math.PI / 2);
    profile.push([Math.cos(a) * r, -half + Math.sin(a) * r]);
  }
  // top cap: equator up to the north pole
  for (let i = 1; i <= capSeg; i++) {
    const a = (i / capSeg) * (Math.PI / 2);
    profile.push([Math.cos(a) * r, half + Math.sin(a) * r]);
  }
  return latheGeo(profile, radial);
}

/** Surface of revolution about Y from [radius, y] pairs. */
export function latheGeo(profile, seg = 24) {
  const pos = [], nrm = [], uv = [], idx = [];
  const rows = profile.length;
  for (let i = 0; i < rows; i++) {
    const [r, y] = profile[i];
    const [r2, y2] = profile[Math.min(rows - 1, i + 1)];
    const [r0, y0] = profile[Math.max(0, i - 1)];
    // profile tangent → surface normal
    const tx = r2 - r0, ty = y2 - y0;
    const nl = Math.hypot(tx, ty) || 1;
    const nr = ty / nl, ny = -tx / nl;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(r * ca, y, r * sa);
      nrm.push(nr * ca, ny, nr * sa);
      uv.push(j / seg, i / (rows - 1));
    }
  }
  const row = seg + 1;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Torus (optionally a partial arc) lying in the XY plane. */
export function torusGeo(R, r, radialSeg = 8, tubeSeg = 20, arc = Math.PI * 2) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= tubeSeg; i++) {
    const u = i / tubeSeg;
    const a = u * arc;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j <= radialSeg; j++) {
      const v = j / radialSeg;
      const b = v * Math.PI * 2;
      const cb = Math.cos(b), sb = Math.sin(b);
      const nx = ca * cb, ny = sa * cb, nz = sb;
      pos.push((R + r * cb) * ca, (R + r * cb) * sa, r * sb);
      nrm.push(nx, ny, nz);
      uv.push(u, v);
    }
  }
  const row = radialSeg + 1;
  for (let i = 0; i < tubeSeg; i++) {
    for (let j = 0; j < radialSeg; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Lumpy blob: a sphere whose radius is displaced by cheap 3D value noise. */
export function blobGeo(r, detail = 3, amount = 0.06, seed = 7) {
  const g = sphereGeo(r, 28, 20);
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const hash = (x, y, z) => {
    let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed) * 43758.5453;
    return h - Math.floor(h);
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (hash(Math.round(x * 40), Math.round(y * 40), Math.round(z * 40)) - 0.5) * amount * 2;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  void n; void detail;
  return g;
}

export default { sphereGeo, discGeo, capsuleGeo, latheGeo, torusGeo, blobGeo };
