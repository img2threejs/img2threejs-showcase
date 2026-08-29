import type { EncodedRig } from './meshCodec';

/**
 * Lift the gown off the legs: separate the robe from the body and rebind it to the joints it
 * actually hangs from.
 *
 * THE DEFECT. Tripo's auto-rigger bound this figure by nearest-joint proximity in its A-pose. Van
 * Hi wears a floor-length robe whose skirt and two trailing sleeve panels occupy the SAME SPACE as
 * her legs, so "nearest joint" answered with a leg for almost every square centimetre of fabric.
 * Measured on the source rig, over the 89,978-vertex gown surface:
 *
 *     L_CalfTwist02  67%      R_Foot  10%
 *     L_CalfTwist01  21%      other    2%
 *
 * The whole robe is skinned to two calves and a foot. Adjacent vertices got different answers, so
 * the fabric was also torn between limbs: of the 115,258 vertices further than 0.06 from any bone,
 * 24,632 (21.4%) are weighted to a DIFFERENT LIMB than the one they sit nearest — skirt panels on
 * an arm, sleeve silk on a thigh. Sweeping all 22 clips at five times each and measuring every
 * sampled edge against its bind length, the worst edge stretched 516x and 2,159 edges passed 5x on
 * `preset:biped:angry_01` alone. On screen that is the dress being dragged inside-out by the shins
 * while spikes shoot off the silhouette.
 *
 * THE REPAIR, IN SIX MEASURED STEPS.
 *
 * 1. FIND THE FABRIC, BY HUE AND BY REACH. The robe is the only strongly purple surface on the
 *    figure — its blue channel leads its green by 20-80 in sRGB, while skin sits at 1 and the black
 *    hair at 0 — but hue alone leaves the gown's WHITE panels behind, and the train pooling on the
 *    floor reads rgb(153,149,152). So a surface is also fabric when it is simply out of the body's
 *    reach: further than `FABRIC_REACH` from every bone, which no part of a body is. Coincident
 *    vertices vote as one point, `FABRIC_VOTE_PASSES` of majority vote over the surface close the
 *    pinholes, and non-fabric islands under `ISLAND_ABSORB_VERTICES` — grey braid and metal
 *    fittings sewn into the gown — are absorbed by topology rather than by loosening a threshold.
 *
 * 2. KEEP ONLY WHAT HANGS. Connected components of the fabric set on the surface graph. A component
 *    joins the garment only if it is both large and tall (`MIN_DRAPE_VERTICES`,
 *    `MIN_DRAPE_HEIGHT`), which is what separates a floor-length robe from the shoulder caps, the
 *    tiara and the shoe trim — small, rigid, and correctly following their own limb.
 *
 * 3. MEASURE HOW FAR EACH POINT IS FROM WHERE THE CLOTH IS HELD. Because the shell is welded, the
 *    garment's attachment is exactly its boundary on the surface graph: the waistband, the cuffs,
 *    the neckline. A breadth-first walk inward from that boundary gives every fabric vertex a
 *    geodesic DEPTH, which is also the `drape` attribute `clothDrape` animates against.
 *
 * 4. REBUILD THE BINDING AS RIGID PANELS. The seam takes the lifted binding of the body it hangs
 *    from — every joint replaced by its nearest `CARRIER_BONES` ancestor, which is the substitution
 *    that ends the leg drag — and that binding is carried inward along the walk. It is then reduced
 *    to ONE carrier per vertex. Rigidity is the point: a panel bound to a single joint cannot change
 *    length internally at all, whatever the body does inside it. Only where two panels meet does the
 *    binding have to travel, and `DIFFUSION_PASSES` Jacobi passes confined to `TRANSITION_BAND`
 *    steps of that boundary turn the step into a gradient.
 *
 *    TWO EARLIER VERSIONS BLENDED EVERYWHERE AND BOTH WERE WORSE. Letting each vertex inherit the
 *    seam it descends from is discontinuous — two neighbours deep in the skirt can descend from
 *    points a body apart — and took the worst stretch from 517x to 696x. Replacing that with a
 *    smooth inverse-distance field over the carriers fixed the discontinuity and cost more anyway,
 *    mean elongation 2.46 mm -> 7.87 mm, because a gradient IS a stretch: spreading the sleeve's
 *    travel over the whole skirt only means every edge pays a little of it.
 *
 * 5. SOFTEN THE BODY'S UNPAINTED JOINT BOUNDARIES. The gown is done; this is the body's own
 *    defect, and it is visible. The rigger painted no falloff — 39.9% of vertices carry ONE
 *    influence at weight 1.0 — so where two such regions meet across a joint the surface has a hard
 *    seam that tears rather than bends, and a lit sliver is thrown out past the silhouette behind
 *    the right knee. Only edges whose two ends disagree by more than `BODY_HARD_EDGE` are touched,
 *    which is near-disjoint and cannot be an intended blend. It runs over the body's own copy of
 *    the weights, so nothing it does can reach the garment.
 *
 * 6. CUT THE SHELL IN TWO. Each mesh keeps the vertices its triangles use, duplicated at the rim,
 *    and binds ITS WHOLE LIST ITS OWN WAY — the garment lifted, the body from the source. Triangles
 *    that weld two limbs together are dropped rather than bound, because no binding can deform them.
 *    Nothing is sewn back across the cut (`SEAM_BAND` is 0) and that is deliberate: where the gown
 *    is genuinely held, the lift barely changes the binding and the two rims stay together to within
 *    0.9 mm at the collar; where it is a free edge — the thigh slit, the hem on the floor — they
 *    part, which is what a slit and a hem do.
 *
 * WHAT IT MOVED. The gate skins every edge of the TWO MESHES AS THEY SHIP at five times through
 * all 22 clips and compares each with its bind length; "source" re-runs the same meshes with the
 * source rig's own weights, so the comparison isolates the repair and not the cut. Absolute
 * elongation in millimetres on the 1.9 m figure — not a ratio, because the median edge here is
 * about 3 mm and a ratio on a 3 mm edge says more about the mesh's density than about anything a
 * viewer can see.
 *
 *     mesh              edges     worst mm    mean mm     >5mm     >2cm
 *     body   source    128013      321.0       0.424      0.88%    0.13%
 *     body   shipped   128013      258.2       0.440      1.07%    0.16%
 *     garment source   332532     1750.1       2.277      2.13%    0.79%
 *     garment shipped  332532       45.8       0.045      0.20%    0.00%
 *
 * The garment's worst tear is 38x smaller, its mean 51x, its share of edges over 2 cm goes to zero,
 * and its weight on any leg joint from 78.8% to none. The body's worst is a fifth smaller for a
 * hundredth of a millimetre on the mean, which is the softening in step 5 paying for itself.
 *
 * WHAT IS STILL WRONG. 258 mm, and it is the HAIR. Waist-length hair is the other long hanging
 * surface on this figure and it has the same disease as the gown — the auto-rigger put 36% of it on
 * a collarbone, 22% on the head and 4% on a THIGH — but it is not clothing, so it is not in the
 * costume mesh and it is not rebound. Two strands at the small of the back read `Spine01` and
 * `L_ThighTwist01` and part by 26 cm on `preset:run`.
 *
 * REBINDING IT WAS TRIED AND COST MORE THAN IT RETURNED. Run through the same drape machinery it
 * improved the body's worst from 321 mm to 301 mm, made the body's mean worse, and cost the garment
 * three and a half times its quality — 45.8 mm worst to 202.1 mm, 0.045 mm mean to 0.157 mm —
 * because waist-length hair LIES AGAINST the gown, so the two share a surface neighbourhood and
 * their panel blends run into each other. Two earlier general repairs failed the same way: a
 * neighbour-majority limb filter reached 6 vertices, and capping the binding disagreement across
 * every edge halved the worst case, 790 -> 365 mm, while driving the body's mean from 0.536 mm to
 * 2.769 mm. All three are the lesson this file is built on: SPREADING a discontinuity is not
 * removing it. Hair wants its own drape and its own carrier, which is a separate piece of work.
 *
 * WHAT CHANGES AND WHAT DOES NOT. Skin weights only. Positions, normals, vertex colours and the
 * triangle list are the decoded source, byte for byte. The garment is then issued as its own
 * SkinnedMesh sharing the one skeleton, so it can carry a fabric material and its own secondary
 * motion — and so that "the costume is a separate mesh" is true of the scene graph, not just of the
 * weights. Both meshes keep the boundary vertices, identically bound at depth 0, so the seam cannot
 * open.
 */

/** sRGB blue-minus-green at which the robe separates from skin, hair and silver. */
const FABRIC_MARGIN = 18;

/**
 * Distance from the nearest bone at which a surface is drapery whatever its colour.
 *
 * The colour test alone leaves the gown's WHITE panels behind — the train pooling on the floor
 * reads rgb(153,149,152), a blue-green margin of 4. Measured by distance band, the non-purple
 * surface that sits further than 0.15 from every bone is 5,376 vertices at an average radius of
 * 0.18-0.29 and a height of 0.00-0.45: the train, and nothing else, because no part of a body is
 * 15% of its own height away from its whole skeleton. The hair, the other long dark surface, comes
 * no further out than 0.15 and hangs at radius 0.09, so it is not caught. Anything this rule does
 * catch that is not drapery — the tiara's spurs — is dropped by the component filter below.
 */
const FABRIC_REACH = 0.15;

/**
 * Passes of majority vote over the surface graph after the per-vertex fabric test.
 *
 * A single vertex sitting in a highlight or a fold shadow can miss the colour threshold while every
 * vertex around it clears it: the body's worst surviving tear was two such vertices, reading b-g of
 * 10 and 12 in a neighbourhood averaging 36. Left out of the garment they keep the auto-rigger's
 * binding — one on each calf — while the gown around them moves as one piece. A vertex is fabric if
 * its neighbours say so; the same vote also erases the speckle that the raw test leaves behind.
 */
const FABRIC_VOTE_PASSES = 3;

/**
 * Below this a NON-fabric island is trim inside the gown rather than a piece of the body.
 *
 * The gown carries grey braid, pale ribbon and metal fittings that are fabric to a rig and neutral
 * to a colour test — the two vertices behind the left hip that survived every other rule read b-g
 * of 10 and 12. Topology answers where hue cannot. Components of the non-fabric surface:
 *
 *     25,156   y 0.54..1.00   head, hair, bodice
 *     15,032   y 0.00..0.66   skin and legs
 *        572   and 53 more, none above 572, all inside the gown's own reach
 *
 * The body is exactly the two large components; the gap between 15,032 and 572 is twenty-six fold,
 * so nothing about the threshold is delicate. Everything else is enclosed by fabric and moves with
 * it, and left on the body it was the most visible defect in the model: a fan of silver splinters
 * thrown out of the left hip on every clip, because a splinter's two ends were bound to opposite
 * calves.
 */
const ISLAND_ABSORB_VERTICES = 2000;

/** Below this a fabric component is trim or a shoulder cap, not drapery. */
const MIN_DRAPE_VERTICES = 2000;

/** A drape hangs; it spans a real fraction of the figure. Armour caps span 0.06 and are excluded. */
const MIN_DRAPE_HEIGHT = 0.2;

/**
 * Joints a garment is allowed to hang from.
 *
 * Every leg joint, every twist joint and every arm joint below the collarbone is absent, and that
 * absence IS the repair. Sweeping the candidate sets over all 22 clips and measuring mean edge
 * elongation across the garment (the source rig reads 2.459 mm):
 *
 *     trunk + arm + hand   0.934 m worst   1.508 mm mean
 *     trunk + upper arm    0.790 m worst   0.966 mm mean
 *     trunk + clavicle     0.240 m worst   0.260 mm mean      <- chosen
 *     hip alone            0        worst   0      mm mean
 *
 * The arm sets lose because the right sleeve panel hangs against the skirt at mid-thigh: two
 * vertices 9.7 mm apart, one on the sleeve and one on the skirt, are dragged 1.74 m apart the
 * moment the arm swings. They are separate cloths in the reference and touching surfaces in the
 * generated mesh, and no skinned binding can let them both track their own limb without the
 * triangles between them paying for it. Hanging the whole robe from the trunk costs the sleeve its
 * direct link to the wrist — which `clothDrape` gives back as secondary motion, where it belongs.
 *
 * Hanging everything from the hip alone is the degenerate optimum: perfectly rigid, and visibly
 * dead, since the gown then ignores the spine entirely.
 */
const CARRIER_BONES = [
  'Root', 'Hip', 'Waist', 'Spine01', 'Spine02', 'L_Clavicle', 'R_Clavicle',
];

/** Influences kept per garment vertex. Four is what a SkinnedMesh reads. */
const INFLUENCES = 4;

/**
 * Graph steps over which two neighbouring carrier panels blend into each other.
 *
 * The garment is bound as RIGID PANELS — one carrier each — because a panel bound to a single joint
 * cannot stretch internally at all, and holding its shape while the body moves inside it is what a
 * garment is for. Only where two panels meet does the binding have to travel, and this is how wide
 * that crossing may be. Over all 22 clips, worst / mean edge elongation across the garment:
 *
 *     band  0    497 mm   0.326 mm        band  8    240 mm   0.260 mm
 *     band  2    210 mm   0.290 mm        band 16    272 mm   0.254 mm
 *     band  4    203 mm   0.272 mm        band 24    289 mm   0.254 mm
 *
 * Four is the minimum of the worst case. Wider trims the mean by a further hundredth of a
 * millimetre and gives back more than a centimetre of worst case, which is the visible one.
 */
const TRANSITION_BAND = 4;

/** Jacobi passes used to turn the panel labels into that gradient. Two per step of band width. */
const DIFFUSION_PASSES = TRANSITION_BAND * 2;

/**
 * Width of the band, in graph steps, over which the garment's binding returns to the body's own.
 *
 * ZERO, after measuring it. The instinct is that the two meshes share their rim, so the garment
 * must carry the body's binding there or the costume slides off the skin. But the source's binding
 * AT the rim is exactly the noise this file exists to remove — the hem reads `R_ToeBase 74%` beside
 * `R_CalfTwist02` — and importing it drags that noise back into the fabric. Measured over all 22
 * clips, mean edge elongation across the garment:
 *
 *     band 0    0.045 mm        band 2   10.463 mm
 *     band 1   10.626 mm        band 6    7.997 mm
 *
 * And the rim does not, in fact, come apart where it matters. Comparing the two bindings at the
 * same rim vertex, by region: 0.9 mm at the collar and shoulder, 10.4 mm over the torso, 43.8 mm at
 * the hip and cuffs, 185 mm at the thigh slit, 260 mm at the hem. The lift barely changes a binding
 * that was already sensible, so where the gown is genuinely HELD it stays held; where it is a FREE
 * EDGE the two part, which is what a slit and a hem do. Only a welded shell made those edges look
 * like seams.
 *
 * Kept as a constant rather than deleted: it is the knob this trade lives on, and a differently
 * built garment — one attached all the way round — would want it back.
 */
const SEAM_BAND = 0;

/**
 * L1 distance between two neighbours' dense weight vectors above which the boundary between them is
 * treated as unpainted rather than intended. 0 is identical; 2 is disjoint, one vertex answering to
 * one joint at full weight and its neighbour to another with nothing in common.
 *
 * The auto-rigger paints no falloff at all: 39.9% of this figure's vertices carry a single influence
 * at weight 1.0, so where two such regions meet the surface has a hard seam and the joint between
 * them tears instead of bending. It is visible — behind the right knee, two vertices 18.5 mm apart
 * on `R_CalfTwist01` and `R_ThighTwist02` are pulled 32 cm apart and throw a lit sliver out past the
 * silhouette.
 *
 * 1.6 is high on purpose. An earlier version capped at 0.5, which is not a hard seam but an ordinary
 * gradient, and smoothing all of those spread the deformation everywhere: the worst case halved,
 * 790 -> 365 mm, while the body's mean went from 0.536 mm to 2.769 mm. Only near-disjoint pairs are
 * unpainted boundaries; everything below is a rigger's blend, or this file's own.
 */
const BODY_HARD_EDGE = 1.6;

/** Passes of the softener. Each halves the excess on any edge still over the threshold. */
const BODY_SOFTEN_PASSES = 3;

/** Position quantisation is ~0.03 mm, so 0.01 mm rounding welds only genuinely coincident vertices. */
const WELD_KEY = 1e5;

/** One of the two meshes the shell is cut into, compacted to only the vertices it uses. */
export interface MeshPartition {
  /** Source vertex id for each of this mesh's vertices, for pulling position/normal/colour across. */
  sourceVertex: Uint32Array;
  /** Triangle list in this mesh's own vertex numbering. */
  index: Uint32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /** 0 where the cloth is held by the body, 1 at the furthest reach of the drape. Zero on the body. */
  drape: Float32Array;
}

export interface GarmentSplit {
  /** Per-vertex flag over the source vertex list: 1 where the vertex belongs to the garment mesh. */
  isGarment: Uint8Array;
  /** 0 at the attachment seam, 1 at the furthest reach of that drape. Zero outside the garment. */
  drape: Float32Array;
  /** Rebound skin influences, source layout (4 per vertex). Body vertices keep the source's. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  body: MeshPartition;
  garment: MeshPartition;
  report: GarmentReport;
}

export interface GarmentReport {
  fabricVertices: number;
  /** Non-fabric islands small enough to be trim inside the gown, absorbed into it. */
  absorbedIslands: number;
  fabricComponents: number;
  drapeComponents: number;
  garmentVertices: number;
  seamVertices: number;
  maxDrapeDepth: number;
  reboundVertices: number;
  /** Fabric vertices whose dominant joint changed limb — the cross-limb tears that are now gone. */
  limbCorrections: number;
  /** Share of the garment's weight that sat on calf/foot joints before and after. */
  legShareBefore: number;
  legShareAfter: number;
  /** Distinct rigid panels the drapery was partitioned into. */
  panels: number;
  /** Triangles dropped because they welded two limbs together in the source mesh. */
  weldedTrianglesDropped: number;
  /** Body edges still over the hard-boundary threshold when the last softening pass ran. */
  softenedEdges: number;
  bodyVertices: number;
  bodyTriangles: number;
  garmentTriangles: number;
  milliseconds: number;
}

function isLegBone(name: string): boolean {
  return /(Thigh|Calf|Foot|Toe)/.test(name);
}

/** Which limb a joint belongs to. Two limbs are OPPOSED when neither is the trunk and they differ. */
function limbOf(name: string): string {
  const leg = isLegBone(name);
  if (name.startsWith('L_')) return leg ? 'L-leg' : 'L-arm';
  if (name.startsWith('R_')) return leg ? 'R-leg' : 'R-arm';
  return 'trunk';
}

/** Distance from every vertex to the nearest bone segment of the skeleton's rest pose. */
function skeletonReach(position: Float32Array, count: number, rig: EncodedRig): Float32Array {
  const world: Float64Array[] = [];
  for (const bone of rig.bones) {
    const local = composeTRS(bone.position, bone.quaternion, bone.scale);
    world.push(bone.parent < 0 ? local : multiply(world[bone.parent], local));
  }
  const segments: number[][] = [];
  for (let b = 1; b < rig.bones.length; b += 1) {
    const parent = rig.bones[b].parent;
    if (parent < 0) continue;
    const p = world[parent], c = world[b];
    if (Math.hypot(p[12] - c[12], p[13] - c[13], p[14] - c[14]) < 1e-4) continue;
    segments.push([p[12], p[13], p[14], c[12], c[13], c[14]]);
  }
  // A stub at every leaf, so a hand, a toe or the crown of the head is covered by something and
  // not measured against the segment behind it.
  const hasChild = new Set(rig.bones.map((bone) => bone.parent));
  for (let b = 0; b < rig.bones.length; b += 1) {
    if (hasChild.has(b)) continue;
    const m = world[b];
    segments.push([m[12], m[13], m[14], m[12], m[13] + 0.02, m[14]]);
  }
  const out = new Float32Array(count);
  for (let v = 0; v < count; v += 1) {
    const px = position[v * 3], py = position[v * 3 + 1], pz = position[v * 3 + 2];
    let best = Infinity;
    for (const [ax, ay, az, bx, by, bz] of segments) {
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t), pz - (az + dz * t));
      if (d < best) best = d;
    }
    out[v] = best;
  }
  return out;
}

function composeTRS(p: readonly number[], q: readonly number[], s: readonly number[]): Float64Array {
  const out = new Float64Array(16);
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - (yy + zz)) * s[0]; out[1] = (xy + wz) * s[0]; out[2] = (xz - wy) * s[0];
  out[4] = (xy - wz) * s[1]; out[5] = (1 - (xx + zz)) * s[1]; out[6] = (yz + wx) * s[1];
  out[8] = (xz + wy) * s[2]; out[9] = (yz - wx) * s[2]; out[10] = (1 - (xx + yy)) * s[2];
  out[12] = p[0]; out[13] = p[1]; out[14] = p[2]; out[15] = 1;
  return out;
}

function multiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c += 1) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/**
 * Map every bone to the nearest carrier at or above it in the hierarchy, so a binding expressed in
 * twist and limb joints can be re-expressed in joints a garment may legitimately hang from.
 * L_CalfTwist02 walks L_CalfTwist01 -> L_Calf -> L_Thigh -> Pelvis -> Hip; R_Foot reaches Hip the
 * same way; L_ForearmTwist02 stops at L_Forearm; Head stops at Spine02. A bone that reaches the
 * root without meeting a carrier maps to itself, which makes the lift a no-op for it.
 */
function carrierAncestors(rig: EncodedRig): Int32Array {
  const carrier = new Set(CARRIER_BONES);
  const out = new Int32Array(rig.bones.length);
  for (let b = 0; b < rig.bones.length; b += 1) {
    let at = b;
    let guard = 0;
    while (!carrier.has(rig.bones[at].name) && rig.bones[at].parent >= 0 && guard < 64) {
      at = rig.bones[at].parent;
      guard += 1;
    }
    out[b] = carrier.has(rig.bones[at].name) ? at : b;
  }
  return out;
}

/** Reduce a dense weight vector to the strongest `INFLUENCES`, normalised, written in place. */
function writeTopInfluences(dense: Float64Array, target: number, index: Uint16Array, weight: Float32Array): void {
  const joints = new Int32Array(INFLUENCES).fill(-1);
  const values = new Float64Array(INFLUENCES);
  for (let j = 0; j < dense.length; j += 1) {
    const w = dense[j];
    if (w <= 0) continue;
    let slot = -1;
    for (let k = 0; k < INFLUENCES; k += 1) if (joints[k] < 0 || w > values[k]) { slot = k; break; }
    if (slot < 0) continue;
    for (let k = INFLUENCES - 1; k > slot; k -= 1) { joints[k] = joints[k - 1]; values[k] = values[k - 1]; }
    joints[slot] = j; values[slot] = w;
  }
  let sum = 0;
  for (let k = 0; k < INFLUENCES; k += 1) if (joints[k] >= 0) sum += values[k];
  for (let k = 0; k < INFLUENCES; k += 1) {
    index[target * INFLUENCES + k] = joints[k] >= 0 ? joints[k] : 0;
    weight[target * INFLUENCES + k] = joints[k] >= 0 && sum > 0 ? values[k] / sum : 0;
  }
}

/** Collapse coincident vertices to one representative, so the surface graph follows the surface. */
function weldPositions(position: Float32Array, count: number): Int32Array {
  const weld = new Int32Array(count);
  const map = new Map<string, number>();
  for (let v = 0; v < count; v += 1) {
    const key = `${Math.round(position[v * 3] * WELD_KEY)},${Math.round(position[v * 3 + 1] * WELD_KEY)},${Math.round(position[v * 3 + 2] * WELD_KEY)}`;
    const hit = map.get(key);
    if (hit === undefined) { map.set(key, v); weld[v] = v; } else weld[v] = hit;
  }
  return weld;
}

/** Adjacency between welded representatives, built from the triangle list. */
function buildAdjacency(index: Uint32Array, weld: Int32Array): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    const ra = weld[a], rb = weld[b];
    if (ra === rb) return;
    let list = adj.get(ra);
    if (!list) { list = []; adj.set(ra, list); }
    if (!list.includes(rb)) list.push(rb);
  };
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f], b = index[f + 1], c = index[f + 2];
    link(a, b); link(b, a); link(b, c); link(c, b); link(c, a); link(a, c);
  }
  return adj;
}

export function separateGarment(
  position: Float32Array,
  colourSrgb: Uint8Array,
  index: Uint32Array,
  rig: EncodedRig,
): GarmentSplit {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const count = rig.vertexCount;
  const sourceIndex = new Uint16Array(decodeUint16Base64(rig.skinIndex));
  const sourceWeight = new Float32Array(decodeFloat32Base64(rig.skinWeight));
  const skinIndex = sourceIndex.slice();
  const skinWeight = sourceWeight.slice();

  const weld = weldPositions(position, count);
  const adj = buildAdjacency(index, weld);

  // --- 1. fabric test: purple, or simply out of the body's reach ---
  const reach = skeletonReach(position, count, rig);
  const fabricVotes = new Map<number, { yes: number; total: number }>();
  for (let v = 0; v < count; v += 1) {
    const root = weld[v];
    let tally = fabricVotes.get(root);
    if (!tally) { tally = { yes: 0, total: 0 }; fabricVotes.set(root, tally); }
    tally.total += 1;
    const purple = colourSrgb[v * 3 + 2] - colourSrgb[v * 3 + 1] >= FABRIC_MARGIN;
    if (purple || reach[v] >= FABRIC_REACH) tally.yes += 1;
  }
  let isFabric = new Uint8Array(count);
  for (let v = 0; v < count; v += 1) {
    const tally = fabricVotes.get(weld[v])!;
    if (tally.yes * 2 >= tally.total) isFabric[v] = 1;
  }
  // Majority vote over the surface, applied whole so the result cannot depend on vertex order.
  for (let pass = 0; pass < FABRIC_VOTE_PASSES; pass += 1) {
    const next = isFabric.slice();
    for (let v = 0; v < count; v += 1) {
      const near = adj.get(weld[v]);
      if (!near || near.length < 3) continue;
      let yes = 0;
      for (const w of near) yes += isFabric[w];
      if (yes * 2 > near.length) next[v] = 1;
      else if (yes * 2 < near.length) next[v] = 0;
    }
    isFabric = next;
  }
  // Absorb the small non-fabric islands: trim sewn into the gown, which the colour test reads as
  // body because it is grey, and which then animates against the cloth around it.
  let absorbedIslands = 0;
  {
    const visited = new Set<number>();
    for (let v = 0; v < count; v += 1) {
      const root = weld[v];
      if (isFabric[root] || visited.has(root)) continue;
      visited.add(root);
      const members: number[] = [root];
      const stack = [root];
      while (stack.length) {
        const u = stack.pop()!;
        for (const w of adj.get(u) ?? []) {
          if (isFabric[w] || visited.has(w)) continue;
          visited.add(w); members.push(w); stack.push(w);
        }
      }
      if (members.length >= ISLAND_ABSORB_VERTICES) continue;
      absorbedIslands += 1;
      const island = new Set(members);
      for (let q = 0; q < count; q += 1) if (island.has(weld[q])) isFabric[q] = 1;
    }
  }
  let fabricVertices = 0;
  for (let v = 0; v < count; v += 1) fabricVertices += isFabric[v];

  // --- 2. keep only the components that hang ---
  const isGarment = new Uint8Array(count);
  const componentOf = new Int32Array(count).fill(-1);
  let fabricComponents = 0;
  let drapeComponents = 0;
  const drapeRoots: number[][] = [];
  {
    const membership = isFabric;
    const visited = new Set<number>();
    for (let v = 0; v < count; v += 1) {
      const root = weld[v];
      if (!membership[root] || visited.has(root)) continue;
      visited.add(root);
      const members: number[] = [root];
      const stack = [root];
      let minY = position[root * 3 + 1], maxY = minY;
      while (stack.length) {
        const u = stack.pop()!;
        const y = position[u * 3 + 1];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (const w of adj.get(u) ?? []) {
          if (!membership[w] || visited.has(w)) continue;
          visited.add(w); members.push(w); stack.push(w);
        }
      }
      fabricComponents += 1;
      if (members.length < MIN_DRAPE_VERTICES || maxY - minY < MIN_DRAPE_HEIGHT) continue;
      const id = drapeComponents;
      drapeComponents += 1;
      drapeRoots.push(members);
      for (const m of members) componentOf[m] = id;
    }
  }
  // Project the welded verdict back onto every source vertex that shares the position.
  let garmentVertices = 0;
  for (let v = 0; v < count; v += 1) {
    const component = componentOf[weld[v]];
    if (component < 0) continue;
    componentOf[v] = component;
    isGarment[v] = 1;
    garmentVertices += 1;
  }

  // --- 3. geodesic depth from the seam, per drape ---
  const drape = new Float32Array(count);
  const seamSteps = new Int32Array(count).fill(-1);
  let seamVertices = 0;
  let maxDrapeDepth = 0;
  for (const members of drapeRoots) {
    const inDrape = new Set(members);
    const depth = new Map<number, number>();
    const queue: number[] = [];
    for (const m of members) {
      let boundary = false;
      for (const w of adj.get(m) ?? []) if (!inDrape.has(w)) { boundary = true; break; }
      if (!boundary) continue;
      depth.set(m, 0); queue.push(m);
      seamVertices += 1;
    }
    // A drape with no boundary would be a closed bubble with nothing to hang it from.
    if (!queue.length) continue;
    let head = 0;
    let deepest = 0;
    while (head < queue.length) {
      const u = queue[head]; head += 1;
      const d = depth.get(u)!;
      if (d > deepest) deepest = d;
      for (const w of adj.get(u) ?? []) {
        if (!inDrape.has(w) || depth.has(w)) continue;
        depth.set(w, d + 1); queue.push(w);
      }
    }
    if (deepest > maxDrapeDepth) maxDrapeDepth = deepest;
    for (let v = 0; v < count; v += 1) {
      if (!isGarment[v]) continue;
      const d = depth.get(weld[v]);
      if (d === undefined) continue;
      seamSteps[v] = d;
      drape[v] = deepest > 0 ? d / deepest : 0;
    }
  }

  // --- 4. lift the seam, label rigid panels, blend only where panels meet ---
  const boneCount = rig.bones.length;
  const carrier = carrierAncestors(rig);

  const drapeList: number[] = [];
  for (let v = 0; v < count; v += 1) if (isGarment[v] && seamSteps[v] >= 0) drapeList.push(v);
  const slot = new Int32Array(count).fill(-1);
  drapeList.forEach((v, i) => { slot[v] = i; });

  // Lanes are the distinct carriers this skeleton lifts to — thirteen here, not forty-one.
  const carrierIds: number[] = [];
  const carrierSlot = new Int32Array(boneCount).fill(-1);
  for (let b = 0; b < boneCount; b += 1) {
    const target = carrier[b];
    if (carrierSlot[target] >= 0) continue;
    carrierSlot[target] = carrierIds.length;
    carrierIds.push(target);
  }
  const lanes = carrierIds.length;

  /** Lifted binding of one source vertex, accumulated into a lane vector. */
  const liftInto = (source: number, out: Float32Array, base: number, scale = 1): void => {
    for (let k = 0; k < INFLUENCES; k += 1) {
      const w = sourceWeight[source * INFLUENCES + k];
      if (w > 0) out[base + carrierSlot[carrier[sourceIndex[source * INFLUENCES + k]]]] += w * scale;
    }
  };

  // Seed the seam from the body next door, then carry it inward along the breadth-first order that
  // step 3 established, so every fabric vertex holds the lifted binding of the body it hangs from.
  let field = new Float32Array(drapeList.length * lanes);
  const order = drapeList.slice().sort((x, y) => seamSteps[x] - seamSteps[y]);
  for (const v of order) {
    const i = slot[v];
    const base = i * lanes;
    if (seamSteps[v] === 0) {
      let found = false;
      for (const w of adj.get(weld[v]) ?? []) if (!isGarment[w]) { liftInto(w, field, base); found = true; }
      if (!found) liftInto(v, field, base);
    } else {
      let donors = 0;
      for (const w of adj.get(weld[v]) ?? []) {
        const s = slot[w];
        if (s < 0 || seamSteps[w] >= seamSteps[v]) continue;
        for (let j = 0; j < lanes; j += 1) field[base + j] += field[s * lanes + j];
        donors += 1;
      }
      if (donors === 0) liftInto(v, field, base);
    }
    let sum = 0;
    for (let j = 0; j < lanes; j += 1) sum += field[base + j];
    if (sum > 0) for (let j = 0; j < lanes; j += 1) field[base + j] /= sum;
  }

  // Reduce that to ONE carrier per vertex. This is the step that keeps the garment still: inside a
  // panel every vertex answers to the same joint, so the panel is rigid and its edges cannot change
  // length at all, however the body moves. Blending everywhere — which an earlier version did — is
  // what drove mean elongation across the garment from 2.46 mm to 7.87 mm: a gradient IS a stretch,
  // and spreading it over the whole skirt only means every edge pays a little of it.
  const panel = new Int32Array(drapeList.length);
  for (let i = 0; i < drapeList.length; i += 1) {
    const base = i * lanes;
    let best = 0, bestW = -1;
    for (let j = 0; j < lanes; j += 1) if (field[base + j] > bestW) { bestW = field[base + j]; best = j; }
    panel[i] = best;
  }

  // Within one drape only. The hair lies against the gown, so their surfaces are neighbours in the
  // graph even though they are separate things; letting the panel blend cross between them mixed a
  // head of hair into the skirt's binding and took the gown's own mean elongation from 0.037 mm to
  // 0.154 mm. Two drapes that merely touch do not share a hem.
  const neighbours: Int32Array[] = drapeList.map((v) => {
    const list: number[] = [];
    const mine = componentOf[v];
    for (const w of adj.get(weld[v]) ?? []) if (slot[w] >= 0 && componentOf[w] === mine) list.push(slot[w]);
    return Int32Array.from(list);
  });

  // Distance, in graph steps, to the nearest vertex on a different panel.
  const bandDistance = new Int32Array(drapeList.length).fill(-1);
  {
    const queue: number[] = [];
    for (let i = 0; i < drapeList.length; i += 1) {
      for (const n of neighbours[i]) if (panel[n] !== panel[i]) { bandDistance[i] = 0; queue.push(i); break; }
    }
    let head = 0;
    while (head < queue.length) {
      const u = queue[head]; head += 1;
      if (bandDistance[u] >= TRANSITION_BAND) continue;
      for (const n of neighbours[u]) {
        if (bandDistance[n] >= 0) continue;
        bandDistance[n] = bandDistance[u] + 1; queue.push(n);
      }
    }
  }

  // One-hot the panels, then diffuse ONLY inside the band. Everything else is pinned, so the rigid
  // interior stays rigid and the crossing becomes a gradient a band's width across.
  field.fill(0);
  for (let i = 0; i < drapeList.length; i += 1) field[i * lanes + panel[i]] = 1;
  {
    let scratch = new Float32Array(field.length);
    for (let pass = 0; pass < DIFFUSION_PASSES; pass += 1) {
      for (let i = 0; i < drapeList.length; i += 1) {
        const base = i * lanes;
        const near = neighbours[i];
        // Seam vertices are NOT pinned. They were in an earlier version, and where a panel
        // boundary happened to land on the seam — the right sleeve hangs against the skirt at
        // mid-thigh, and the thigh slit runs between them — the crossing never blended: two
        // vertices 9.7 mm apart stayed on R_Forearm and Hip and travelled 1.74 m apart.
        const mobile = bandDistance[i] >= 0 && bandDistance[i] < TRANSITION_BAND && near.length > 0;
        if (!mobile) {
          for (let j = 0; j < lanes; j += 1) scratch[base + j] = field[base + j];
          continue;
        }
        const inv = 0.5 / near.length;
        for (let j = 0; j < lanes; j += 1) {
          let acc = 0;
          for (let n = 0; n < near.length; n += 1) acc += field[near[n] * lanes + j];
          scratch[base + j] = 0.5 * field[base + j] + acc * inv;
        }
      }
      const previous = field;
      field = scratch;
      scratch = previous;
    }
  }

  const dense = new Float64Array(boneCount);
  let reboundVertices = 0;
  let limbCorrections = 0;
  let legBefore = 0, legAfter = 0, garmentWeight = 0;
  const dominantJoint = (joints: Uint16Array, weights: Float32Array, v: number): number => {
    let best = -1, bestW = -1;
    for (let k = 0; k < INFLUENCES; k += 1) {
      if (weights[v * INFLUENCES + k] > bestW) { bestW = weights[v * INFLUENCES + k]; best = joints[v * INFLUENCES + k]; }
    }
    return best;
  };

  for (let i = 0; i < drapeList.length; i += 1) {
    const v = drapeList[i];
    dense.fill(0);
    const base = i * lanes;
    // Sew to the body across the seam band. `toPanel` is 0 on the shared seam vertices, where the
    // garment must carry the body's own binding or the costume slides off the skin, and 1 once the
    // band is cleared and the rigid panel takes over.
    const toPanel = SEAM_BAND > 0 ? Math.min(1, seamSteps[v] / SEAM_BAND) : 1;
    for (let j = 0; j < lanes; j += 1) if (field[base + j] > 0) dense[carrierIds[j]] += field[base + j] * toPanel;
    if (toPanel < 1) {
      for (let k = 0; k < INFLUENCES; k += 1) {
        const w = sourceWeight[v * INFLUENCES + k];
        if (w > 0) dense[sourceIndex[v * INFLUENCES + k]] += w * (1 - toPanel);
      }
    }
    const before = dominantJoint(sourceIndex, sourceWeight, v);
    writeTopInfluences(dense, v, skinIndex, skinWeight);
    if (dominantJoint(skinIndex, skinWeight, v) !== before) limbCorrections += 1;
    reboundVertices += 1;
    for (let k = 0; k < INFLUENCES; k += 1) {
      const wb = sourceWeight[v * INFLUENCES + k];
      if (wb > 0 && isLegBone(rig.bones[sourceIndex[v * INFLUENCES + k]].name)) legBefore += wb;
      const wa = skinWeight[v * INFLUENCES + k];
      if (wa > 0 && isLegBone(rig.bones[skinIndex[v * INFLUENCES + k]].name)) legAfter += wa;
      garmentWeight += wa;
    }
  }

  // --- 5. soften the body's unpainted joint boundaries ---
  // Written into their OWN copy, not into `skinIndex`. That array carries the garment's rebinding
  // and is what `liftInto` reads the seam from; the body mesh binds from these instead, so the two
  // repairs stay separable and the gate can still re-run either mesh against the untouched source.
  const bodyIndex = sourceIndex.slice();
  const bodyWeight = sourceWeight.slice();
  // The garment is finished; this is the body's own defect. Only edges over `BODY_HARD_EDGE` are
  // touched, and only between two vertices that are both body — a rim edge into the garment is left
  // alone, because the two sides belong to different meshes and are meant to be able to part.
  let softenedEdges = 0;
  {
    const before = new Float64Array(boneCount);
    const after = new Float64Array(boneCount);
    const denseOf = (v: number, out: Float64Array): void => {
      out.fill(0);
      for (let k = 0; k < INFLUENCES; k += 1) out[bodyIndex[v * INFLUENCES + k]] += bodyWeight[v * INFLUENCES + k];
    };
    const edgeA: number[] = [];
    const edgeB: number[] = [];
    // EVERY edge, garment vertices included. Their copies in the body mesh carry the body's binding
    // and their edges to body vertices are real edges of that mesh: the worst tear left after the
    // first version of this step skipped them was exactly one of those, a lavender skirt vertex on
    // `R_CalfTwist01` next to a body vertex on `R_ThighTwist02`, 30 cm apart on `dance_03`. Nothing
    // written here can reach the garment mesh, which binds from `liftedIndex`.
    for (const [u, near] of adj) {
      for (const w of near) if (u < w) { edgeA.push(u); edgeB.push(w); }
    }
    for (let pass = 0; pass < BODY_SOFTEN_PASSES; pass += 1) {
      // Collected first and written after, so the result cannot depend on the order of the edges.
      const patch = new Map<number, Float64Array>();
      let touched = 0;
      for (let e = 0; e < edgeA.length; e += 1) {
        const u = edgeA[e], w = edgeB[e];
        denseOf(u, before); denseOf(w, after);
        let l1 = 0;
        for (let j = 0; j < boneCount; j += 1) l1 += Math.abs(before[j] - after[j]);
        if (l1 <= BODY_HARD_EDGE) continue;
        touched += 1;
        // Each end moves the fraction of the way to the other that brings the pair to the threshold.
        const pull = 0.5 * (1 - BODY_HARD_EDGE / l1);
        for (const [self, own, theirs] of [[u, before, after], [w, after, before]] as const) {
          let target = patch.get(self);
          if (!target) { target = Float64Array.from(own); patch.set(self, target); }
          for (let j = 0; j < boneCount; j += 1) {
            const moved = own[j] + (theirs[j] - own[j]) * pull;
            // Toward the neighbour, never past it: several neighbours over the threshold must not
            // compound into an overshoot that then oscillates between passes.
            if (moved > target[j]) target[j] = moved;
          }
        }
      }
      if (!touched) break;
      softenedEdges = touched;
      for (const [v, target] of patch) writeTopInfluences(target, v, bodyIndex, bodyWeight);
      // Split copies of one position must stay identical, or the softening opens its own seam.
      for (let v = 0; v < count; v += 1) {
        const root = weld[v];
        if (root === v || !patch.has(root)) continue;
        for (let k = 0; k < INFLUENCES; k += 1) {
          bodyIndex[v * INFLUENCES + k] = bodyIndex[root * INFLUENCES + k];
          bodyWeight[v * INFLUENCES + k] = bodyWeight[root * INFLUENCES + k];
        }
      }
    }
  }

  // --- 6. cut the shell into two meshes ---
  // A triangle follows its majority. The vertices a triangle brings across from the other side —
  // the rim — are DUPLICATED rather than shared, and EACH MESH BINDS ITS WHOLE VERTEX LIST ITS OWN
  // WAY: the garment's copies all carry the lifted binding, the body's copies all carry the
  // source's. Mixing the two is not a small error. An earlier version gave the body mesh the
  // repaired array — which holds the lifted binding at every garment vertex — so a body triangle
  // that reached one vertex into the hem had two corners on `R_ToeBase` and one on `Hip`, and the
  // shoe trim threw a 73 cm splinter across the floor on `heart_pose`. Within one mesh, one rule.
  const liftedIndex = new Uint16Array(count * INFLUENCES);
  const liftedWeight = new Float32Array(count * INFLUENCES);
  {
    const lifted = new Float32Array(lanes);
    for (let v = 0; v < count; v += 1) {
      if (isGarment[v]) {
        for (let k = 0; k < INFLUENCES; k += 1) {
          liftedIndex[v * INFLUENCES + k] = skinIndex[v * INFLUENCES + k];
          liftedWeight[v * INFLUENCES + k] = skinWeight[v * INFLUENCES + k];
        }
        continue;
      }
      lifted.fill(0);
      liftInto(v, lifted, 0);
      dense.fill(0);
      for (let j = 0; j < lanes; j += 1) if (lifted[j] > 0) dense[carrierIds[j]] += lifted[j];
      writeTopInfluences(dense, v, liftedIndex, liftedWeight);
    }
  }

  /**
   * Triangles that bridge two limbs, which no binding can deform coherently.
   *
   * The generator fuses surfaces that come close: at the inner thigh, where the legs almost touch
   * under the skirt, and behind the torso where the arms pass the back. A triangle there has one
   * corner on the left calf and the next on the right, so the moment the legs split it is stretched
   * across the gap — 68 cm on `preset:biped:angry_03` — and that is the fan of splinters that comes
   * out of the hip. There is no correct binding for it, because it is not a real surface: it is two
   * surfaces welded by a mesh generator that could not tell them apart.
   *
   * Measured on the finished meshes: 419 of the body's 80,540 triangles, 0.52%, at y 0.09-0.78 and
   * an average radius of 0.087 — the midline, between the legs and between the arms, under the
   * floor-length gown and behind the back. The garment has none: rebinding it to the trunk removed
   * every one. Dropping them opens a hole in a place nothing sees, and closes the last tear.
   */
  const isOpposedWeld = (
    a: number, b: number, c: number,
    pickIndex: () => Uint16Array, pickWeight: () => Float32Array,
  ): boolean => {
    const dominant = (v: number): string => {
      const joints = pickIndex(), weights = pickWeight();
      let best = 0, bestW = -1;
      for (let k = 0; k < INFLUENCES; k += 1) {
        if (weights[v * INFLUENCES + k] > bestW) { bestW = weights[v * INFLUENCES + k]; best = joints[v * INFLUENCES + k]; }
      }
      return limbOf(rig.bones[best].name);
    };
    const limbs = [dominant(a), dominant(b), dominant(c)];
    for (let i = 0; i < 3; i += 1) {
      for (let j = i + 1; j < 3; j += 1) {
        if (limbs[i] === 'trunk' || limbs[j] === 'trunk') continue;
        if (limbs[i] !== limbs[j]) return true;
      }
    }
    return false;
  };

  let weldedTrianglesDropped = 0;

  const partition = (wantGarment: boolean): MeshPartition => {
    const remap = new Int32Array(count).fill(-1);
    const sourceVertex: number[] = [];
    const triangles: number[] = [];
    const local = (v: number): number => {
      if (remap[v] < 0) { remap[v] = sourceVertex.length; sourceVertex.push(v); }
      return remap[v];
    };
    // The garment mesh binds every one of its vertices the lifted way. The body mesh binds the
    // SOURCE way, with one exception: the hair, which is drapery that was rebound and STAYS in this
    // mesh. A garment vertex reaching into a body triangle is NOT the exception — it belongs to the
    // other mesh, and giving its copy here the repaired binding is what left the shoe trim with two
    // corners on `R_ToeBase` and one on `Hip`, throwing a 73 cm splinter across the floor.
    const pickIndex = (): Uint16Array => (wantGarment ? liftedIndex : bodyIndex);
    const pickWeight = (): Float32Array => (wantGarment ? liftedWeight : bodyWeight);
    const weldIndex = (): Uint16Array => (wantGarment ? liftedIndex : sourceIndex);
    const weldWeight = (): Float32Array => (wantGarment ? liftedWeight : sourceWeight);
    for (let f = 0; f < index.length; f += 3) {
      const votes = isGarment[index[f]] + isGarment[index[f + 1]] + isGarment[index[f + 2]];
      if ((votes >= 2) !== wantGarment) continue;
      // Tested against the SOURCE binding, not the softened one. Softening blends a disjoint pair
      // into a merely lopsided one, and a weld that has been blended is still a weld: judging it
      // afterwards let every one of them through and left the worst body tear at 300 mm.
      if (isOpposedWeld(index[f], index[f + 1], index[f + 2], weldIndex, weldWeight)) {
        weldedTrianglesDropped += 1;
        continue;
      }
      triangles.push(local(index[f]), local(index[f + 1]), local(index[f + 2]));
    }
    const n = sourceVertex.length;
    const outIndex = new Uint16Array(n * INFLUENCES);
    const outWeight = new Float32Array(n * INFLUENCES);
    const outDrape = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const v = sourceVertex[i];
      const joints = pickIndex(), weights = pickWeight();
      for (let k = 0; k < INFLUENCES; k += 1) {
        outIndex[i * INFLUENCES + k] = joints[v * INFLUENCES + k];
        outWeight[i * INFLUENCES + k] = weights[v * INFLUENCES + k];
      }
      // A body vertex pulled into the garment reads as fully held: it is where the cloth attaches.
      outDrape[i] = wantGarment && isGarment[v] ? drape[v] : 0;
    }
    return { sourceVertex: Uint32Array.from(sourceVertex), index: Uint32Array.from(triangles), skinIndex: outIndex, skinWeight: outWeight, drape: outDrape };
  };
  const body = partition(false);
  const garment = partition(true);

  const finished = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    isGarment, drape, skinIndex, skinWeight, body, garment,
    report: {
      fabricVertices, absorbedIslands, fabricComponents, drapeComponents, garmentVertices, seamVertices,
      maxDrapeDepth, reboundVertices, limbCorrections,
      panels: new Set(Array.from(panel)).size,
      weldedTrianglesDropped, softenedEdges,
      legShareBefore: garmentWeight > 0 ? legBefore / garmentWeight : 0,
      legShareAfter: garmentWeight > 0 ? legAfter / garmentWeight : 0,
      bodyVertices: body.sourceVertex.length,
      bodyTriangles: body.index.length / 3,
      garmentTriangles: garment.index.length / 3,
      milliseconds: finished - started,
    },
  };
}

function decodeBase64(text: string): Uint8Array {
  if (typeof atob === 'function') {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }
  const buffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (!buffer) throw new Error('no base64 decoder available');
  return buffer.from(text, 'base64');
}

function decodeUint16Base64(text: string): Uint16Array {
  const bytes = decodeBase64(text);
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

function decodeFloat32Base64(text: string): Float32Array {
  const bytes = decodeBase64(text);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
