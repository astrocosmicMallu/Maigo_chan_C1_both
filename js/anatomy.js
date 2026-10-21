/* ============================================================================
   anatomy.js — the sculpt for Maigo-chan
   ----------------------------------------------------------------------------
   Units are metres, Y up, she faces +Z. Height ≈ 1.40 m (a lost child), seven
   head-heights, narrow shoulders, soft limbs. Everything is one continuous
   field so limbs melt into the torso the way a body actually does.

   Region ids become material groups:
     0 skin   1 blouse   2 skirt   3 sock   4 shoe   5 collar
   ========================================================================== */

import { Field, P, surfaceNets } from './sdf.js?v=b13';

export const REGION = { SKIN: 0, BLOUSE: 1, SKIRT: 2, SOCK: 3, SHOE: 4, COLLAR: 5 };

const v = (x, y, z) => ({ x, y, z });

/* ------------------------------------------------------------------ head */
export function buildHeadField() {
  const f = new Field();
  const K = 0.012;

  // cranium + mid-face + jaw: three masses blended into a child's soft skull
  f.add(P.ellipsoid(v(0, 1.312, 0.004), v(0.079, 0.095, 0.086)), REGION.SKIN, 0.02);
  f.add(P.ellipsoid(v(0, 1.272, 0.018), v(0.071, 0.072, 0.072)), REGION.SKIN, 0.018);
  f.add(P.ellipsoid(v(0, 1.233, 0.030), v(0.049, 0.044, 0.053)), REGION.SKIN, 0.016);

  // cheekbones + brow ridge: what actually makes a face read as a face
  for (const s of [-1, 1]) {
    f.add(P.sphere(v(0.047 * s, 1.279, 0.046), 0.024), REGION.SKIN, 0.016);
    f.add(P.sphere(v(0.040 * s, 1.310, 0.058), 0.020), REGION.SKIN, 0.016);
    f.add(P.ellipsoid(v(0.078 * s, 1.283, 0.004), v(0.008, 0.023, 0.015)), REGION.SKIN, 0.010); // ear
  }
  f.add(P.roundCone(v(-0.042, 1.302, 0.066), v(0.042, 1.302, 0.066), 0.0135, 0.0135), REGION.SKIN, 0.014);

  // nose: bridge, tip, and two small alae
  f.add(P.roundCone(v(0, 1.305, 0.068), v(0, 1.278, 0.083), 0.0115, 0.0135), REGION.SKIN, 0.012);
  f.add(P.sphere(v(0, 1.2765, 0.0855), 0.0125), REGION.SKIN, 0.010);
  for (const s of [-1, 1]) f.add(P.sphere(v(0.0135 * s, 1.2725, 0.0795), 0.0072), REGION.SKIN, 0.008);
  // septum is a soft underside, never a hanging spur
  f.add(P.ellipsoid(v(0, 1.2655, 0.0775), v(0.013, 0.006, 0.009)), REGION.SKIN, 0.008);

  // lips (a mouth is mostly a crease between two soft pads)
  f.add(P.ellipsoid(v(0, 1.2475, 0.0825), v(0.0195, 0.0065, 0.0105)), REGION.SKIN, 0.006);
  f.add(P.ellipsoid(v(0, 1.2395, 0.0805), v(0.0165, 0.0075, 0.0100)), REGION.SKIN, 0.006);
  f.add(P.sphere(v(0, 1.222, 0.070), 0.0135), REGION.SKIN, 0.012); // chin

  // neck
  f.add(P.roundCone(v(0, 1.170, 0.012), v(0, 1.234, 0.006), 0.0345, 0.0300), REGION.SKIN, 0.02);

  // ---- carving: eye sockets, mouth line, nostrils, hair-line parting ----
  for (const s of [-1, 1]) {
    // deep socket so a real eyeball can sit inside it
    f.cut(P.ellipsoid(v(0.0325 * s, 1.2900, 0.0700), v(0.0235, 0.0180, 0.0230)), 0.0055);
    f.cut(P.sphere(v(0.0125 * s, 1.2645, 0.0865), 0.0035), 0.002); // nostril
  }
  // mouth line — the crease between the lips
  f.cut(P.box(v(0, 1.2435, 0.0885), v(0.0165, 0.0016, 0.0045)), 0.0022);

  return f;
}

/* ------------------------------------------------------------------ body */
export function buildBodyField() {
  const f = new Field();

  /* A child's frame: 1.40 m, seven heads, hip joint at 0.70, knee at 0.40.
     Masses are ordered torso → sleeves → arms → skirt → legs so the smooth
     blends read as one body. */

  // torso: shoulder shelf, ribcage, waist, pelvis
  f.add(P.capsule(v(-0.104, 1.122, 0.002), v(0.104, 1.122, 0.002), 0.043), REGION.BLOUSE, 0.032);
  f.add(P.ellipsoid(v(0, 1.048, 0.004), v(0.096, 0.098, 0.062)), REGION.BLOUSE, 0.022);
  f.add(P.ellipsoid(v(0, 0.922, 0.004), v(0.072, 0.086, 0.050)), REGION.BLOUSE, 0.024);
  f.add(P.ellipsoid(v(0, 0.812, 0.004), v(0.084, 0.078, 0.056)), REGION.BLOUSE, 0.024);

  // puffy short sleeves
  for (const s of [-1, 1]) {
    f.add(P.ellipsoid(v(0.108 * s, 1.088, 0.002), v(0.056, 0.066, 0.058)), REGION.BLOUSE, 0.022);
  }

  // sailor collar: square flap behind, V strips in front
  f.add(P.ellipsoid(v(0, 1.126, -0.050), v(0.090, 0.058, 0.017)), REGION.COLLAR, 0.012);
  for (const s of [-1, 1]) {
    f.add(P.roundCone(v(0.058 * s, 1.138, 0.042), v(0.008 * s, 1.050, 0.062), 0.0115, 0.0095), REGION.COLLAR, 0.010);
  }

  // arms: shoulder → elbow → wrist, held a little away from the body
  for (const s of [-1, 1]) {
    f.add(P.roundCone(v(0.116 * s, 1.098, 0.002), v(0.138 * s, 0.888, 0.010), 0.0335, 0.0262), REGION.SKIN, 0.020);
    f.add(P.roundCone(v(0.138 * s, 0.888, 0.010), v(0.146 * s, 0.672, 0.030), 0.0262, 0.0188), REGION.SKIN, 0.016);
    // hand: palm, then a thumb — fingers stay a soft mitten at this scale
    f.add(P.ellipsoid(v(0.148 * s, 0.628, 0.036), v(0.0225, 0.0385, 0.0165)), REGION.SKIN, 0.013);
    f.add(P.roundCone(v(0.130 * s, 0.638, 0.038), v(0.121 * s, 0.606, 0.052), 0.0092, 0.0068), REGION.SKIN, 0.008);
  }

  /* Pleated skirt as a CLOSED solid shell (outer wall → hem → inner wall).
     An open profile would give a zero-thickness surface and tear apart. */
  f.add(P.revolved([
    [0.086, 0.828],      // waistband, outer
    [0.104, 0.774],
    [0.132, 0.672],
    [0.156, 0.552],
    [0.163, 0.508],      // hem, outer edge
    [0.147, 0.506],      // hem, inner edge
    [0.140, 0.556],
    [0.116, 0.676],
    [0.092, 0.780],
    [0.080, 0.828],      // close the ring
  ]), REGION.SKIRT, 0.020);

  // legs: thigh → knee → calf (skin), then knee sock, then loafer
  for (const s of [-1, 1]) {
    f.add(P.roundCone(v(0.046 * s, 0.760, 0.002), v(0.049 * s, 0.400, 0.006), 0.0565, 0.0372), REGION.SKIN, 0.020);
    f.add(P.roundCone(v(0.049 * s, 0.400, 0.006), v(0.046 * s, 0.238, 0.010), 0.0372, 0.0292), REGION.SKIN, 0.016);
    f.add(P.roundCone(v(0.046 * s, 0.238, 0.010), v(0.043 * s, 0.070, -0.004), 0.0292, 0.0208), REGION.SOCK, 0.012);
    // loafer: sole block plus a rounded toe, flattened at the bottom
    f.add(P.box(v(0.043 * s, 0.042, 0.026), v(0.0265, 0.028, 0.058), { radius: 0.015 }), REGION.SHOE, 0.010);
    f.add(P.ellipsoid(v(0.043 * s, 0.036, 0.068), v(0.0235, 0.0235, 0.026)), REGION.SHOE, 0.010);
  }

  return f;
}

/* --------------------------------------------------------------- baking */
export function bakeCharacter(step = 0.0075) {
  const head = surfaceNets(buildHeadField(), {
    min: [-0.11, 1.155, -0.105], max: [0.11, 1.425, 0.135],
  }, 0.0032);

  const body = surfaceNets(buildBodyField(), {
    min: [-0.215, -0.005, -0.205], max: [0.215, 1.175, 0.205],
  }, step);

  return { head, body };
}

export default bakeCharacter;
