/* ============================================================================
   sdf.js — signed-distance sculpting + surface-nets meshing
   ----------------------------------------------------------------------------
   Pure math, no DOM and no Three.js, so the character can be baked and
   inspected offline (tools/preview.mjs) as well as at runtime.

   The character is described as a field of smooth-blended primitives and then
   polygonised at ~5 mm resolution. That is what makes her read as one organic
   body instead of a stack of boxes: every limb flows into the next through a
   smooth-minimum, and normals come from the analytic gradient of the field.
   ========================================================================== */

/* ---------------------------------------------------------------- vectors */
const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });

/* ------------------------------------------------------------- primitives */
export const P = {
  sphere: (c, r, o = {}) => ({ kind: 'sphere', c, r, ...o }),
  ellipsoid: (c, r, o = {}) => ({ kind: 'ellipsoid', c, r, ...o }),   // r = {x,y,z}
  capsule: (a, b, r, o = {}) => ({ kind: 'capsule', a, b, r, ...o }),
  roundCone: (a, b, r1, r2, o = {}) => ({ kind: 'roundCone', a, b, r1, r2, ...o }),
  revolved: (profile, o = {}) => ({ kind: 'revolved', profile, ...o }), // [[rho,y],…]
  box: (c, h, o = {}) => ({ kind: 'box', c, h, ...o }),                 // half extents
};

/* --------------------------------------------------------------- helpers */
function len3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }

function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = (px - cx) / rx, y = (py - cy) / ry, z = (pz - cz) / rz;
  const k0 = len3(x, y, z);
  if (k0 === 0) return -Math.min(rx, ry, rz);
  const x1 = x / rx, y1 = y / ry, z1 = z / rz;
  const k1 = len3(x1, y1, z1);
  return (k0 * (k0 - 1)) / k1;
}

function sdRoundCone(px, py, pz, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y;
  const xy = pay * l2 - bay * y;
  const xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

/** signed distance from (px,py) to a closed 2D polygon (negative inside) */
function sdPolygon(pts, px, py) {
  const n = pts.length;
  let dx = px - pts[0][0], dy = py - pts[0][1];
  let d = dx * dx + dy * dy;
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const vix = pts[i][0], viy = pts[i][1];
    const vjx = pts[j][0], vjy = pts[j][1];
    const ex = vjx - vix, ey = vjy - viy;
    const wx = px - vix, wy = py - viy;
    const ee = ex * ex + ey * ey || 1e-12;
    let t = (wx * ex + wy * ey) / ee;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const bx = wx - ex * t, by = wy - ey * t;
    const dd = bx * bx + by * by;
    if (dd < d) d = dd;
    const c1 = py >= viy, c2 = py < vjy, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

/** closed profile [[rho,y],…] revolved around Y — signed, so it is a solid */
function sdRevolved(px, py, pz, profile) {
  const rho = Math.sqrt(px * px + pz * pz);
  return sdPolygon(profile, rho, py);
}

/* ------------------------------------------------------------ smooth ops */
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}
function smax(a, b, k) {
  if (k <= 0) return Math.max(a, b);
  const h = Math.max(0, Math.min(1, 0.5 - (0.5 * (b - a)) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

function distanceTo(prim, px, py, pz) {
  switch (prim.kind) {
    case 'sphere':
      return len3(px - prim.c.x, py - prim.c.y, pz - prim.c.z) - prim.r;
    case 'ellipsoid':
      return sdEllipsoid(px, py, pz, prim.c.x, prim.c.y, prim.c.z, prim.r.x, prim.r.y, prim.r.z);
    case 'capsule':
      return sdRoundCone(px, py, pz, prim.a.x, prim.a.y, prim.a.z, prim.b.x, prim.b.y, prim.b.z, prim.r, prim.r);
    case 'roundCone':
      return sdRoundCone(px, py, pz, prim.a.x, prim.a.y, prim.a.z, prim.b.x, prim.b.y, prim.b.z, prim.r1, prim.r2);
    case 'revolved': {
      let d = sdRevolved(px, py, pz, prim.profile);
      // pleats only perturb the field close to the surface, otherwise they
      // corrupt distances far away and spawn phantom sheets
      if (prim.pleats && Math.abs(d) < 0.05) {
        const rho = Math.sqrt(px * px + pz * pz);
        const th = Math.atan2(pz, px);
        const amp = prim.pleatAmp ?? 0.006;
        const fall = Math.min(1, Math.max(0, (prim.pleatTop - py) / 0.14));
        const fade = 1 - Math.min(1, Math.abs(d) / 0.05);
        d += amp * Math.cos(prim.pleats * th) * fall * fade * (rho > 0.02 ? 1 : 0);
      }
      return d;
    }
    case 'box': {
      const qx = Math.abs(px - prim.c.x) - prim.h.x;
      const qy = Math.abs(py - prim.c.y) - prim.h.y;
      const qz = Math.abs(pz - prim.c.z) - prim.h.z;
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
      return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - (prim.radius || 0);
    }
    default:
      return Infinity;
  }
}

/* ============================================================= the field */
export class Field {
  constructor() {
    this.prims = [];      // additive sculpting
    this.cuts = [];       // subtractive carving (eyes, mouth, arm gaps)
  }

  add(prim, region = 0, k = 0.02) {
    this.prims.push({ prim, region, k });
    return this;
  }

  cut(prim, k = 0.006) {
    this.cuts.push({ prim, k });
    return this;
  }

  /** returns [distance, region] */
  eval(px, py, pz) {
    let d = Infinity;
    let region = 0;
    let nearest = Infinity;
    for (let i = 0; i < this.prims.length; i++) {
      const e = this.prims[i];
      const di = distanceTo(e.prim, px, py, pz);
      // seed with the first primitive — smin(Infinity, x) is NaN
      d = i === 0 ? di : smin(d, di, e.k);
      if (di < nearest) { nearest = di; region = e.region; }
    }
    for (let i = 0; i < this.cuts.length; i++) {
      const c = this.cuts[i];
      const dc = distanceTo(c.prim, px, py, pz);
      d = smax(d, -dc, c.k);
    }
    return [d, region];
  }

  /** analytic normal from central differences of the field */
  normal(px, py, pz, eps = 0.0016) {
    const dx = this.eval(px + eps, py, pz)[0] - this.eval(px - eps, py, pz)[0];
    const dy = this.eval(px, py + eps, pz)[0] - this.eval(px, py - eps, pz)[0];
    const dz = this.eval(px, py, pz + eps)[0] - this.eval(px, py, pz - eps)[0];
    const l = len3(dx, dy, dz) || 1;
    return [dx / l, dy / l, dz / l];
  }
}

/* ======================================================== surface nets */
/**
 * Polygonise the zero level-set of `field` inside `bounds` at `step` metres.
 * Returns { positions:Float32Array, normals:Float32Array, regions:Uint8Array,
 *           indices: { [region]: Uint32Array } } — quads are emitted as two
 *           triangles, grouped per material region.
 */
export function surfaceNets(field, bounds, step) {
  const { min, max } = bounds;
  const nx = Math.ceil((max[0] - min[0]) / step) + 1;
  const ny = Math.ceil((max[1] - min[1]) / step) + 1;
  const nz = Math.ceil((max[2] - min[2]) / step) + 1;

  const N = nx * ny * nz;
  const dist = new Float32Array(N);
  const reg = new Uint8Array(N);
  const idx = (i, j, k) => i + nx * (j + ny * k);

  // ---- sample the field on the lattice (once per vertex, not per cell) ----
  for (let k = 0; k < nz; k++) {
    const pz = min[2] + k * step;
    for (let j = 0; j < ny; j++) {
      const py = min[1] + j * step;
      for (let i = 0; i < nx; i++) {
        const [d, r] = field.eval(min[0] + i * step, py, pz);
        const o = idx(i, j, k);
        dist[o] = d;
        reg[o] = r;
      }
    }
  }

  // ---- one vertex per cell that straddles the surface ----
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cidx = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const pos = [];
  const regs = [];

  const CORNERS = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v = CORNERS.map(([di, dj, dk]) => dist[idx(i + di, j + dj, k + dk)]);
        let mask = 0;
        for (let c = 0; c < 8; c++) if (v[c] < 0) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          if ((v[a] < 0) === (v[b] < 0)) continue;
          const da = v[a], db = v[b];
          const t = da / (da - db);
          const ca = CORNERS[a], cb = CORNERS[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        if (!n) continue;
        cellVert[cidx(i, j, k)] = pos.length / 3;
        pos.push(
          min[0] + (i + sx / n) * step,
          min[1] + (j + sy / n) * step,
          min[2] + (k + sz / n) * step,
        );
        // region = the primitive that owns the nearest corner
        let bestC = 0, bestD = Infinity;
        for (let c = 0; c < 8; c++) {
          if (v[c] >= 0) continue;
          if (v[c] < bestD) { bestD = v[c]; bestC = c; }
        }
        const [di, dj, dk] = CORNERS[bestC];
        regs.push(reg[idx(i + di, j + dj, k + dk)]);
      }
    }
  }

  // ---- quads across every sign-changing lattice edge ----
  const buckets = new Map();
  const push = (region, a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    let arr = buckets.get(region);
    if (!arr) { arr = []; buckets.set(region, arr); }
    if (flip) { arr.push(a, c, b, a, d, c); }
    else { arr.push(a, b, c, a, c, d); }
  };

  const regionOfCell = (i, j, k) => regs[cellVert[cidx(i, j, k)]] ?? 0;
  const quadRegion = (cells) => {
    const rs = cells.map(([i, j, k]) => regionOfCell(i, j, k));
    // majority vote keeps material seams clean
    const tally = {};
    for (const r of rs) tally[r] = (tally[r] || 0) + 1;
    let best = rs[0], bestN = -1;
    for (const r in tally) if (tally[r] > bestN) { bestN = tally[r]; best = +r; }
    return best;
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const o = idx(i, j, k);
        const s0 = dist[o] < 0;

        // edge along +x → quad spans (j-1,j) × (k-1,k)
        if (i < nx - 1 && j > 0 && k > 0 && (dist[idx(i + 1, j, k)] < 0) !== s0) {
          const cells = [[i, j - 1, k - 1], [i, j, k - 1], [i, j, k], [i, j - 1, k]];
          const vs = cells.map(([a, b, c]) => cellVert[cidx(a, b, c)]);
          push(quadRegion(cells), vs[0], vs[1], vs[2], vs[3], s0);
        }
        // edge along +y → quad spans (i-1,i) × (k-1,k)
        if (j < ny - 1 && i > 0 && k > 0 && (dist[idx(i, j + 1, k)] < 0) !== s0) {
          const cells = [[i - 1, j, k - 1], [i - 1, j, k], [i, j, k], [i, j, k - 1]];
          const vs = cells.map(([a, b, c]) => cellVert[cidx(a, b, c)]);
          push(quadRegion(cells), vs[0], vs[1], vs[2], vs[3], !s0);
        }
        // edge along +z → quad spans (i-1,i) × (j-1,j)
        if (k < nz - 1 && i > 0 && j > 0 && (dist[idx(i, j, k + 1)] < 0) !== s0) {
          const cells = [[i - 1, j - 1, k], [i, j - 1, k], [i, j, k], [i - 1, j, k]];
          const vs = cells.map(([a, b, c]) => cellVert[cidx(a, b, c)]);
          push(quadRegion(cells), vs[0], vs[1], vs[2], vs[3], s0);
        }
      }
    }
  }

  // ---- normals from the field gradient ----
  const positions = new Float32Array(pos);
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const n = field.normal(positions[i], positions[i + 1], positions[i + 2]);
    normals[i] = n[0]; normals[i + 1] = n[1]; normals[i + 2] = n[2];
  }

  /* ---- enforce consistent winding against the field gradient ----
     Per-axis quad ordering is easy to get subtly wrong; instead every triangle
     is checked against the SDF gradient (which always points outward) and
     flipped when it disagrees. Guarantees a watertight, correctly oriented
     surface regardless of the traversal order above. */
  const indices = {};
  for (const [region, arr] of buckets) {
    const u = Uint32Array.from(arr);
    for (let t = 0; t < u.length; t += 3) {
      const a = u[t] * 3, b = u[t + 1] * 3, c = u[t + 2] * 3;
      const ux = positions[b] - positions[a];
      const uy = positions[b + 1] - positions[a + 1];
      const uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a];
      const vy = positions[c + 1] - positions[a + 1];
      const vz = positions[c + 2] - positions[a + 2];
      const gx = uy * vz - uz * vy;
      const gy = uz * vx - ux * vz;
      const gz = ux * vy - uy * vx;
      const nx = normals[a] + normals[b] + normals[c];
      const ny = normals[a + 1] + normals[b + 1] + normals[c + 1];
      const nz = normals[a + 2] + normals[b + 2] + normals[c + 2];
      if (gx * nx + gy * ny + gz * nz < 0) {
        const tmp = u[t + 1];
        u[t + 1] = u[t + 2];
        u[t + 2] = tmp;
      }
    }
    indices[region] = u;
  }

  return {
    positions, normals,
    regions: new Uint8Array(regs),
    indices,
    stats: { vertices: positions.length / 3, triangles: Object.values(indices).reduce((a, b) => a + b.length / 3, 0) },
  };
}
