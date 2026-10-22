/* ============================================================================
   geo.js — bespoke geometry foundry
   No BoxGeometry / CylinderGeometry / SphereGeometry anywhere.
   Walls, cabinets, poles, cloth and the character are lofted, extruded,
   lathed or hand-indexed from raw vertex buffers.
   ========================================================================== */
import * as THREE from 'three';

/* ------------------------- rounded rectangle shape ------------------------ */
export function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Rounded, beveled slab (vending cabinets, notice boards, AC units). */
export function extrudedSlab(w, h, depth, { radius = 0.05, bevel = 0.012, curveSegments = 6, steps = 1 } = {}) {
  const shape = roundedRectShape(w, h, radius);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments,
    steps,
  });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}

/* --------------------------------- loft ---------------------------------- */
/**
 * Loft a stack of elliptical rings into a closed-or-open surface.
 * rings: [{ y, rx, rz, x?, z?, v? , rot? }] — ordered bottom → top.
 */
export function loftGeometry(rings, radialSegments = 32, { capBottom = true, capTop = true, uOffset = 0 } = {}) {
  const positions = [], uvs = [], indices = [];
  const R = radialSegments;
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri];
    const rx = ring.rx ?? ring.r, rz = ring.rz ?? ring.r;
    for (let i = 0; i <= R; i++) {
      const a = (i / R) * Math.PI * 2 + (ring.rot || 0);
      let px = Math.cos(a) * rx;
      let pz = Math.sin(a) * rz;
      if (ring.shape) {
        const mod = ring.shape(i / R, a, ri / Math.max(1, rings.length - 1));
        px *= mod.x ?? 1; pz *= mod.z ?? 1;
      }
      positions.push(px + (ring.x || 0), ring.y, pz + (ring.z || 0));
      uvs.push(i / R + uOffset, ring.v ?? ri / Math.max(1, rings.length - 1));
    }
  }
  for (let ri = 0; ri < rings.length - 1; ri++) {
    for (let i = 0; i < R; i++) {
      const a = ri * (R + 1) + i;
      const b = a + 1;
      const c = a + (R + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const base = positions.length / 3;
  if (capBottom && rings.length) {
    const cIdx = base;
    positions.push(rings[0].x || 0, rings[0].y, rings[0].z || 0);
    uvs.push(0.5, 0);
    for (let i = 0; i < R; i++) {
      indices.push(cIdx, i, i + 1);
    }
  }
  if (capTop && rings.length) {
    const last = rings.length - 1;
    const start = last * (R + 1);
    const cIdx = positions.length / 3;
    positions.push(rings[last].x || 0, rings[last].y, rings[last].z || 0);
    uvs.push(0.5, 1);
    for (let i = 0; i < R; i++) {
      indices.push(cIdx, start + i + 1, start + i);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* --------------------------------- tube ---------------------------------- */
export function tubeGeometry(points, radius = 0.02, tubularSegments = 48, radialSegments = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.35);
  const frames = curve.computeFrenetFrames(tubularSegments, closed);
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const p = curve.getPointAt ? curve.getPoint(t) : curve.getPoint(t);
    const N = frames.normals[Math.min(i, tubularSegments)];
    const B = frames.binormals[Math.min(i, tubularSegments)];
    for (let j = 0; j <= radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2;
      const sin = Math.sin(v), cos = -Math.cos(v);
      positions.push(
        p.x + radius * (cos * N.x + sin * B.x),
        p.y + radius * (cos * N.y + sin * B.y),
        p.z + radius * (cos * N.z + sin * B.z)
      );
      uvs.push(j / radialSegments, t);
    }
  }
  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * (radialSegments + 1) + j;
      const b = a + 1;
      const c = a + radialSegments + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* --------------------------------- blob ---------------------------------- */
/** Hand-indexed organic ellipsoid with fBm-ish displacement (bags, fruit, gore). */
export function blobGeometry(radius = 0.2, widthSeg = 28, heightSeg = 20, {
  seed = 1, amount = 0.14, squash = 1, taper = 1, ripple = 2.0,
} = {}) {
  const positions = [], uvs = [], indices = [];
  const rnd = (n) => {
    const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let iy = 0; iy <= heightSeg; iy++) {
    const v = iy / heightSeg;
    const phi = v * Math.PI;                 // 0 top → PI bottom
    const y = Math.cos(phi) * radius;
    const ringR = Math.sin(phi) * radius;
    for (let ix = 0; ix <= widthSeg; ix++) {
      const u = ix / widthSeg;
      const theta = u * Math.PI * 2;
      let n = 0, amp = 1, freq = 2;
      for (let o = 0; o < 3; o++) {
        n += Math.sin(theta * freq + iy * 1.7 + seed) * Math.cos(phi * freq * 1.1 + u * 6 + seed * 2) * amp;
        amp *= 0.5; freq *= 2.0;
      }
      const disp = 1 + n * amount;
      const taperV = 1 - (v) * (1 - taper);
      const px = Math.cos(theta) * ringR * disp * taperV;
      const pz = Math.sin(theta) * ringR * disp;
      positions.push(px, y * squash, pz);
      uvs.push(u, v);
    }
  }
  for (let iy = 0; iy < heightSeg; iy++) {
    for (let ix = 0; ix < widthSeg; ix++) {
      const a = iy * (widthSeg + 1) + ix;
      const b = a + 1;
      const c = a + widthSeg + 1;
      const d = c + 1;
      // rings go top→bottom, so flip winding
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------ hair ribbon ------------------------------- */
/**
 * Tapered ribbon following a polyline. Used for hair locks, cloth strips.
 * points: Vector3[]; side: Vector3 reference used to orient width.
 */
export function ribbonGeometry(points, { widths = null, side = new THREE.Vector3(0, 0, 1), taper = 0.35, thickness = 0.004 } = {}) {
  const positions = [], uvs = [], indices = [];
  const n = points.length;
  const tangents = [];
  for (let i = 0; i < n; i++) {
    const p = points[Math.max(0, i - 1)];
    const q = points[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(q, p).normalize());
  }
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const w = (widths ? widths[i] : 1) * (1 - t * (1 - taper));
    const p = points[i];
    const tangent = tangents[i];
    const sideV = new THREE.Vector3().crossVectors(tangent, side).normalize();
    if (sideV.lengthSq() < 1e-4) sideV.set(1, 0, 0);
    const half = w * 0.5;
    for (const s of [-1, 1]) {
      positions.push(
        p.x + sideV.x * half * s,
        p.y + sideV.y * half * s,
        p.z + sideV.z * half * s
      );
      uvs.push(s > 0 ? 1 : 0, t);
    }
    // back layer (gives hair physical thickness)
    for (const s of [-1, 1]) {
      positions.push(
        p.x + sideV.x * half * s - side.x * thickness,
        p.y + sideV.y * half * s - side.y * thickness,
        p.z + sideV.z * half * s - side.z * thickness
      );
      uvs.push(s > 0 ? 1 : 0, t);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4;
    // front face
    indices.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
    // back face (flipped)
    indices.push(a + 2, a + 6, a + 3, a + 3, a + 6, a + 7);
    // side edges
    indices.push(a, a + 4, a + 2, a + 2, a + 4, a + 6);
    indices.push(a + 1, a + 3, a + 5, a + 3, a + 7, a + 5);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* --------------------------- displaced plane ----------------------------- */
/** Procedural wall / ground panel with vertex displacement. */
export function displacedPlaneGeometry(width, height, segX, segY, displaceFn, uvRepeat = [1, 1]) {
  const geo = new THREE.PlaneGeometry(width, height, segX, segY);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = displaceFn(v.x, v.y, uv.getX(i), uv.getY(i));
    v.z += d;
    pos.setXYZ(i, v.x, v.y, v.z);
    uv.setXY(i, uv.getX(i) * uvRepeat[0], uv.getY(i) * uvRepeat[1]);
  }
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------ small props ------------------------------ */
export function wireBundleGeometry(length, count = 3, sag = 0.25) {
  const geos = [];
  for (let c = 0; c < count; c++) {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      pts.push(new THREE.Vector3(
        (c - (count - 1) / 2) * 0.035,
        -Math.sin(t * Math.PI) * sag * (0.8 + c * 0.1),
        -t * length
      ));
    }
    geos.push(tubeGeometry(pts, 0.009, 16, 4));
  }
  return geos;
}

export function latheProfile(points, segments = 24) {
  const geo = new THREE.LatheGeometry(points, segments);
  geo.computeVertexNormals();
  return geo;
}
