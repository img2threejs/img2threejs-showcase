/**
 * Measure the character out of its own embedded data.
 *
 * Nothing here is authored by eye. Every colour is read from the vertex colours that shipped in
 * `surfaceData.high.ts`, and every socket position is read from the vertices that the rig's own
 * skin weights bind to a named bone, then expressed in that bone's local space through the bone's
 * inverse bind matrix — so a socket rides the real rig instead of sitting at a magic coordinate.
 *
 * Output: evidence/palette.json, evidence/sockets.json.
 */
import * as THREE from 'three';
import { writeFileSync, mkdirSync } from 'node:fs';
import { decodeModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';

// ---------------------------------------------------------------- colour helpers

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}
function hex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
/** HSL on sRGB 0..1, the space the classification rules below are written in. */
function hsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

// ---------------------------------------------------------------- decode

const decoded = decodeModel(SURFACE_MODEL, SURFACE_STREAM);
const part = decoded[0];
const n = part.meta.vertexCount;

const skinIndex = (() => {
  const bytes = Buffer.from(RIG.skinIndex, 'base64');
  const out = new Uint16Array(bytes.length / 2);
  Buffer.from(out.buffer).set(bytes);
  return out;
})();
const skinWeight = (() => {
  const bytes = Buffer.from(RIG.skinWeight, 'base64');
  const out = new Float32Array(bytes.length / 4);
  Buffer.from(out.buffer).set(bytes);
  return out;
})();

if (RIG.vertexCount !== n) {
  throw new Error(`rig binds ${RIG.vertexCount} vertices, surface has ${n} — these are not the same mesh`);
}

const boneNames = RIG.bones.map((b) => b.name);
const boneIndexOf = new Map(boneNames.map((name, i) => [name, i]));

// Gate R0 / G5: an index past the end of the skeleton reads a garbage matrix and throws one vertex
// to infinity. Check it here rather than discovering it as a spike in the render.
let maxSkinIndex = 0;
for (let i = 0; i < skinIndex.length; i += 1) maxSkinIndex = Math.max(maxSkinIndex, skinIndex[i]);

// G4: weights must already sum to 1.
let maxWeightError = 0;
for (let v = 0; v < n; v += 1) {
  const sum = skinWeight[v * 4] + skinWeight[v * 4 + 1] + skinWeight[v * 4 + 2] + skinWeight[v * 4 + 3];
  maxWeightError = Math.max(maxWeightError, Math.abs(1 - sum));
}

/** The joint carrying the largest share of a vertex — what "this vertex belongs to the head" means. */
const dominantBone = new Uint16Array(n);
for (let v = 0; v < n; v += 1) {
  let best = 0;
  let bestW = -1;
  for (let k = 0; k < 4; k += 1) {
    const w = skinWeight[v * 4 + k];
    if (w > bestW) { bestW = w; best = skinIndex[v * 4 + k]; }
  }
  dominantBone[v] = best;
}

// ---------------------------------------------------------------- bind-pose bone frames

const bindWorld: THREE.Matrix4[] = RIG.bones.map((b) => new THREE.Matrix4().fromArray(b.inverseBind).invert());
const inverseBind: THREE.Matrix4[] = RIG.bones.map((b) => new THREE.Matrix4().fromArray(b.inverseBind));
const bonePos = bindWorld.map((m) => new THREE.Vector3().setFromMatrixPosition(m));

/**
 * Which axis separates left from right is measured, not assumed: the model turned out to carry its
 * lateral axis on Z (arm span 2.57 against a 1.01 body depth), so hard-coding X would have put
 * every paired socket on the wrong pair of axes.
 */
const lHand = bonePos[boneIndexOf.get('L_Hand')!];
const rHand = bonePos[boneIndexOf.get('R_Hand')!];
const spread = new THREE.Vector3().subVectors(lHand, rHand);
const lateralAxis = (['x', 'y', 'z'] as const).reduce((a, b) => (Math.abs(spread[a]) >= Math.abs(spread[b]) ? a : b));
const leftSign = Math.sign(spread[lateralAxis]);
const depthAxis = (['x', 'y', 'z'] as const).filter((a) => a !== lateralAxis && a !== 'y')[0];

// Which way is the face? The eyes are the highest-contrast thing on the head, so take the darkest
// head vertices and read the sign of their offset from the head joint along the depth axis.
const headIndex = boneIndexOf.get('Head')!;

// ---------------------------------------------------------------- per-vertex sRGB

const srgb = new Float32Array(n * 3);
for (let i = 0; i < n * 3; i += 1) srgb[i] = linearToSrgb(part.colour[i]);

const pos = part.position;
const vertexHsl = new Float32Array(n * 3);
for (let v = 0; v < n; v += 1) {
  const { h, s, l } = hsl(srgb[v * 3], srgb[v * 3 + 1], srgb[v * 3 + 2]);
  vertexHsl[v * 3] = h; vertexHsl[v * 3 + 1] = s; vertexHsl[v * 3 + 2] = l;
}

// ---------------------------------------------------------------- palette by histogram

const BINS = 24;
const histogram = new Map<number, { count: number; r: number; g: number; b: number }>();
for (let v = 0; v < n; v += 1) {
  const r = srgb[v * 3], g = srgb[v * 3 + 1], b = srgb[v * 3 + 2];
  const key = (Math.min(BINS - 1, (r * BINS) | 0) * BINS + Math.min(BINS - 1, (g * BINS) | 0)) * BINS + Math.min(BINS - 1, (b * BINS) | 0);
  const cell = histogram.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
  cell.count += 1; cell.r += r; cell.g += g; cell.b += b;
  histogram.set(key, cell);
}
const bins = [...histogram.values()]
  .map((c) => ({ share: c.count / n, r: c.r / c.count, g: c.g / c.count, b: c.b / c.count }))
  .sort((a, b) => b.share - a.share);

/** Merge histogram bins that are perceptually the same colour, so the palette is families not bins. */
const clusters: { share: number; r: number; g: number; b: number }[] = [];
for (const bin of bins) {
  const near = clusters.find((c) => Math.hypot(c.r - bin.r, c.g - bin.g, c.b - bin.b) < 0.10);
  if (near) {
    const total = near.share + bin.share;
    near.r = (near.r * near.share + bin.r * bin.share) / total;
    near.g = (near.g * near.share + bin.g * bin.share) / total;
    near.b = (near.b * near.share + bin.b * bin.share) / total;
    near.share = total;
  } else clusters.push({ ...bin });
}
clusters.sort((a, b) => b.share - a.share);

// ---------------------------------------------------------------- named regions

interface Region {
  id: string;
  rule: string;
  bones: string[];
  count: number;
  share: number;
  hex: string;
  hsl: { h: number; s: number; l: number };
  centroid: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

const boneOfVertex = (v: number) => boneNames[dominantBone[v]];
const descendsFrom = (name: string, ancestor: string): boolean => {
  let i = boneIndexOf.get(name);
  while (i !== undefined && i >= 0) {
    if (boneNames[i] === ancestor) return true;
    const p: number = RIG.bones[i].parent;
    if (p < 0) return false;
    i = p;
  }
  return false;
};
const HEAD_SET = new Set(boneNames.filter((b) => descendsFrom(b, 'Head')));
// Arms and neck descend from Spine01 too, so a plain "descends from the spine" set puts the hands
// in the torso and drags the belly centroid out to the fingertips.
const TORSO_SET = new Set(boneNames.filter((b) =>
  (descendsFrom(b, 'Waist') || descendsFrom(b, 'Spine01'))
  && !HEAD_SET.has(b)
  && !descendsFrom(b, 'L_Clavicle') && !descendsFrom(b, 'R_Clavicle')
  && !descendsFrom(b, 'NeckTwist01')));
const armSet = (side: 'L' | 'R') => new Set(boneNames.filter((b) => descendsFrom(b, `${side}_Forearm`)));

function summarise(id: string, rule: string, members: number[]): Region | null {
  if (members.length === 0) return null;
  let r = 0, g = 0, b = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const c: [number, number, number] = [0, 0, 0];
  const boneTally = new Map<string, number>();
  for (const v of members) {
    r += srgb[v * 3]; g += srgb[v * 3 + 1]; b += srgb[v * 3 + 2];
    for (let a = 0; a < 3; a += 1) {
      const p = pos[v * 3 + a];
      c[a] += p;
      if (p < min[a]) min[a] = p;
      if (p > max[a]) max[a] = p;
    }
    const bone = boneOfVertex(v);
    boneTally.set(bone, (boneTally.get(bone) ?? 0) + 1);
  }
  const k = members.length;
  const mr = r / k, mg = g / k, mb = b / k;
  return {
    id, rule,
    bones: [...boneTally.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 4).map(([name, cnt]) => `${name} (${cnt})`),
    count: k,
    share: k / n,
    hex: hex(mr, mg, mb),
    hsl: hsl(mr, mg, mb),
    centroid: [c[0] / k, c[1] / k, c[2] / k],
    bounds: { min, max },
  };
}

const lateralOf = (v: number) => pos[v * 3 + { x: 0, y: 1, z: 2 }[lateralAxis]];
/**
 * Split a symmetric pair at the cluster's OWN midline rather than at zero. The figure is not
 * centred on the lateral axis to within a pupil's width, so splitting at zero put a few iris
 * vertices on the wrong side and dragged the eye sockets apart asymmetrically.
 */
const splitSides = (members: number[]): { L: number[]; R: number[] } => {
  const mid = members.reduce((s, v) => s + lateralOf(v), 0) / (members.length || 1);
  const L: number[] = []; const R: number[] = [];
  for (const v of members) ((lateralOf(v) - mid) * leftSign > 0 ? L : R).push(v);
  return { L, R };
};
const depthOf = (v: number) => pos[v * 3 + { x: 0, y: 1, z: 2 }[depthAxis]];
const yOf = (v: number) => pos[v * 3 + 1];

const all = Array.from({ length: n }, (_, v) => v);
const S = (v: number) => vertexHsl[v * 3 + 1];
const L = (v: number) => vertexHsl[v * 3 + 2];
const H = (v: number) => vertexHsl[v * 3];

const headY = bonePos[headIndex].y;
const depthIdx = { x: 0, y: 1, z: 2 }[depthAxis];
const headDepth = bonePos[headIndex].getComponent(depthIdx);
const torsoDepth = bonePos[boneIndexOf.get('Spine01')!].getComponent(depthIdx);
/** The eyes are the darkest thing on the head; which side of the head joint they sit is the face. */
const darkHead = all.filter((v) => L(v) < 0.22 && HEAD_SET.has(boneOfVertex(v)));
const frontSign = Math.sign(darkHead.reduce((s, v) => s + depthOf(v), 0) / (darkHead.length || 1) - headDepth) || 1;

// The rules are written against the measured distribution, and each one is reported with its
// population so a rule that caught nothing (or caught everything) is visible rather than silent.
const rules: { id: string; rule: string; test: (v: number) => boolean }[] = [
  { id: 'fur', rule: 'hue 180-230, saturation >= 0.20, lightness 0.30-0.70', test: (v) => H(v) >= 180 && H(v) <= 235 && S(v) >= 0.2 && L(v) >= 0.3 && L(v) <= 0.7 },
  { id: 'belly', rule: 'hue 180-235, lightness > 0.58, bound to a torso joint, on the face side of the depth axis', test: (v) => H(v) >= 180 && H(v) <= 235 && L(v) > 0.58 && S(v) >= 0.08 && TORSO_SET.has(boneOfVertex(v)) && Math.sign(depthOf(v) - torsoDepth) === frontSign },
  { id: 'horn', rule: 'saturation < 0.22, lightness 0.30-0.72, above the head joint', test: (v) => S(v) < 0.22 && L(v) >= 0.3 && L(v) <= 0.72 && yOf(v) > headY },
  { id: 'sclera', rule: 'lightness > 0.80, saturation < 0.18, on a head joint', test: (v) => L(v) > 0.8 && S(v) < 0.18 && HEAD_SET.has(boneOfVertex(v)) },
  { id: 'iris', rule: 'lightness < 0.22, on a head joint', test: (v) => L(v) < 0.22 && HEAD_SET.has(boneOfVertex(v)) },
  { id: 'wristband', rule: 'lightness < 0.30, bound to a forearm/hand joint', test: (v) => L(v) < 0.3 && (armSet('L').has(boneOfVertex(v)) || armSet('R').has(boneOfVertex(v))) },
];

const regions: Region[] = [];
for (const r of rules) {
  const members = all.filter(r.test);
  const region = summarise(r.id, r.rule, members);
  if (region) regions.push(region);
}

// ---------------------------------------------------------------- sockets

interface Socket {
  id: string;
  kind: 'effect' | 'grip' | 'attachment';
  bone: string;
  /** Position in that bone's local space; a child Object3D placed here rides the animated bone. */
  offset: [number, number, number];
  /** Same point in bind-pose mesh space, kept so the derivation can be re-checked. */
  bindPoint: [number, number, number];
  derivation: string;
  sampleCount: number;
}

const sockets: Socket[] = [];

function addSocket(id: string, kind: Socket['kind'], boneName: string, point: THREE.Vector3, derivation: string, sampleCount: number): void {
  const bi = boneIndexOf.get(boneName);
  if (bi === undefined) throw new Error(`socket ${id} names bone "${boneName}", which this rig does not have`);
  const local = point.clone().applyMatrix4(inverseBind[bi]);
  sockets.push({
    id, kind, bone: boneName,
    offset: [local.x, local.y, local.z],
    bindPoint: [point.x, point.y, point.z],
    derivation, sampleCount,
  });
}

const centroidOf = (members: number[]): THREE.Vector3 => {
  const c = new THREE.Vector3();
  for (const v of members) c.add(new THREE.Vector3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
  return c.divideScalar(members.length || 1);
};

/** Vertices whose dominant joint is this bone — the part of the skin that joint actually drives. */
const verticesOfBone = (name: string): number[] => {
  const bi = boneIndexOf.get(name)!;
  return all.filter((v) => dominantBone[v] === bi);
};

// Palms: the centroid of the skin the hand joint drives, not the joint origin, so an effect sits in
// the hand rather than at the wrist pivot.
for (const side of ['L', 'R'] as const) {
  const members = verticesOfBone(`${side}_Hand`);
  addSocket(`effect:palm.${side.toLowerCase()}`, 'effect', `${side}_Hand`, centroidOf(members),
    `centroid of the ${members.length} vertices whose dominant joint is ${side}_Hand`, members.length);
  addSocket(`grip:hand.${side.toLowerCase()}`, 'grip', `${side}_Hand`, centroidOf(members),
    `same point as effect:palm.${side.toLowerCase()}; a held prop parents here`, members.length);
}

// Horns: split the grey cap by the measured lateral axis and take the extreme tip on each side.
const hornRegion = rules.find((r) => r.id === 'horn')!;
const hornMembers = all.filter(hornRegion.test);
const hornSides = splitSides(hornMembers);
for (const side of ['L', 'R'] as const) {
  const members = hornSides[side];
  if (members.length === 0) continue;
  const tip = members.reduce((a, b) => (yOf(a) > yOf(b) ? a : b));
  addSocket(`effect:horn.${side.toLowerCase()}`, 'effect', 'Head',
    new THREE.Vector3(pos[tip * 3], pos[tip * 3 + 1], pos[tip * 3 + 2]),
    `highest vertex of the ${members.length} grey cap vertices on the ${side === 'L' ? 'left' : 'right'} of the measured lateral axis (${lateralAxis})`,
    members.length);
}

/**
 * Eyes and fangs are the same near-white material, so one colour rule returns both. They separate
 * cleanly in height: the measured distribution is bimodal with an empty band between the fangs and
 * the eyes, so split on the widest gap rather than on a mean — a mean sits inside the eye lobe and
 * drags a third of the eye vertices into the "fangs".
 */
const scleraMembers = all.filter(rules.find((r) => r.id === 'sclera')!.test).sort((a, b) => yOf(a) - yOf(b));
let splitY = headY;
let widestGap = 0;
for (let i = 1; i < scleraMembers.length; i += 1) {
  const gap = yOf(scleraMembers[i]) - yOf(scleraMembers[i - 1]);
  if (gap > widestGap) { widestGap = gap; splitY = (yOf(scleraMembers[i]) + yOf(scleraMembers[i - 1])) / 2; }
}
const fangMembers = scleraMembers.filter((v) => yOf(v) < splitY);
const eyeMembers = scleraMembers.filter((v) => yOf(v) >= splitY);

const regionHexFallback = '#4487a4';
const eyeSides = splitSides(eyeMembers);
for (const side of ['L', 'R'] as const) {
  const members = eyeSides[side];
  if (members.length === 0) continue;
  addSocket(`effect:eye.${side.toLowerCase()}`, 'effect', 'Head', centroidOf(members),
    `centroid of the ${members.length} eye-white vertices on the ${side === 'L' ? 'left' : 'right'} of the cluster midline; the eye/fang split is the widest gap in the near-white height distribution, at y=${splitY.toFixed(4)} (gap ${widestGap.toFixed(4)})`,
    members.length);
}
if (fangMembers.length) {
  // Midpoint between the two fang lobes, not the centroid of both: the lobes came back with
  // unequal vertex counts, and a centroid of an unequal pair sits inside the bigger fang rather
  // than in the middle of the mouth.
  const fangSides = splitSides(fangMembers);
  const mouth = fangSides.L.length && fangSides.R.length
    ? centroidOf(fangSides.L).add(centroidOf(fangSides.R)).multiplyScalar(0.5)
    : centroidOf(fangMembers);
  addSocket('effect:mouth', 'effect', 'Head', mouth,
    `midpoint of the two fang lobes (${fangSides.L.length} + ${fangSides.R.length} near-white head vertices below y=${splitY.toFixed(4)})`,
    fangMembers.length);
}

// Wristbands: the dark band bound to each forearm — a real attachment point for a bracer effect.
const bandMembers = all.filter(rules.find((r) => r.id === 'wristband')!.test);
for (const side of ['L', 'R'] as const) {
  const set = armSet(side);
  const members = bandMembers.filter((v) => set.has(boneOfVertex(v)));
  if (members.length === 0) continue;
  const tally = new Map<string, number>();
  for (const v of members) tally.set(boneOfVertex(v), (tally.get(boneOfVertex(v)) ?? 0) + 1);
  const bone = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  addSocket(`attachment:wrist.${side.toLowerCase()}`, 'attachment', bone, centroidOf(members),
    `centroid of the ${members.length} dark vertices on the ${side} forearm chain; carried by ${bone}, the joint that drives most of them`, members.length);
}

// Core and feet, from the joints themselves.
addSocket('effect:core', 'effect', 'Spine02', centroidOf(verticesOfBone('Spine02')),
  'centroid of the skin driven by Spine02 — the chest', verticesOfBone('Spine02').length);
addSocket('effect:belly', 'effect', 'Spine01', centroidOf(all.filter(rules.find((r) => r.id === 'belly')!.test)),
  'centroid of the pale front patch', all.filter(rules.find((r) => r.id === 'belly')!.test).length);
for (const side of ['L', 'R'] as const) {
  const members = verticesOfBone(`${side}_ToeBase`).length ? verticesOfBone(`${side}_ToeBase`) : verticesOfBone(`${side}_Foot`);
  const bone = verticesOfBone(`${side}_ToeBase`).length ? `${side}_ToeBase` : `${side}_Foot`;
  // Sole, not centroid: a dust puff belongs on the ground, so take the lowest vertices of the foot.
  const sorted = [...members].sort((a, b) => yOf(a) - yOf(b));
  const sole = sorted.slice(0, Math.max(1, (sorted.length * 0.1) | 0));
  addSocket(`effect:foot.${side.toLowerCase()}`, 'effect', bone, centroidOf(sole),
    `centroid of the lowest 10% (${sole.length}) of the ${members.length} vertices driven by ${bone} — the sole`, sole.length);
}


// ---------------------------------------------------------------- eye regions, for the blink

/**
 * This rig has no eyelids.
 *
 * 41 bones, none of them facial: `Head` is the only joint above the neck, and the export carries no
 * morph targets. So a blink cannot be posed — there is nothing to pose. What the model does have is
 * per-vertex colour and a measurable eye, so the blink is drawn instead: the eye's own vertices are
 * swept to the colour of the fur immediately around them, top to bottom, and swept back.
 *
 * Each eye is collected as a disc around its measured socket rather than as "the white pixels", so
 * the lid also covers the rim of fur the eye sits in and closes over a clean circle. The lid
 * parameter is the vertex's height within that disc, normalised, and it is STATIC — being fixed to
 * the vertex, it rides the head through every clip with no per-frame work.
 */
interface EyeRegion {
  id: 'l' | 'r';
  bone: string;
  centre: [number, number, number];
  radius: number;
  vertices: number[];
  /** 0 at the bottom of the eye, 1 at the top. The lid closes from 1 down. */
  lid: number[];
}

const eyeRegions: EyeRegion[] = [];
const eyeSurroundSamples: number[] = [];
for (const side of ['L', 'R'] as const) {
  const members = eyeSides[side];
  if (!members.length) continue;
  const centre = centroidOf(members);
  let radius = 0;
  for (const v of members) {
    radius = Math.max(radius, centre.distanceTo(new THREE.Vector3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])));
  }
  // A little wider than the white, so the lid closes over the fur rim rather than stopping at it.
  const reach = radius * 1.35;
  const inside: number[] = [];
  for (const v of all) {
    if (!HEAD_SET.has(boneOfVertex(v))) continue;
    const d = centre.distanceTo(new THREE.Vector3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
    if (d <= reach) inside.push(v);
    else if (d <= reach * 1.6) eyeSurroundSamples.push(v);
  }
  const ys = inside.map(yOf);
  const lo = Math.min(...ys); const hi = Math.max(...ys);
  eyeRegions.push({
    id: side.toLowerCase() as 'l' | 'r',
    bone: 'Head',
    centre: [centre.x, centre.y, centre.z],
    radius: reach,
    vertices: inside,
    lid: inside.map((v) => (hi - lo < 1e-9 ? 0 : (yOf(v) - lo) / (hi - lo))),
  });
}

/** The colour the lid is drawn in: the fur that actually rings the eyes, averaged. */
const lidColour = (() => {
  if (!eyeSurroundSamples.length) return regionHexFallback;
  let r = 0; let g = 0; let b = 0;
  let used = 0;
  for (const v of eyeSurroundSamples) {
    // Skip anything still eye-coloured, so the lid is fur and not a smeared white.
    if (L(v) > 0.7) continue;
    r += srgb[v * 3]; g += srgb[v * 3 + 1]; b += srgb[v * 3 + 2]; used += 1;
  }
  return used ? hex(r / used, g / used, b / used) : regionHexFallback;
})();

// ---------------------------------------------------------------- write

mkdirSync(new URL('../../src/demos/monster-cute/evidence/', import.meta.url), { recursive: true });

const palette = {
  measuredFrom: 'src/surfaceData.high.ts vertex colours, converted linear -> sRGB',
  authored: false,
  vertexCount: n,
  dominantClusters: clusters.slice(0, 8).map((c) => ({ hex: hex(c.r, c.g, c.b), share: Number(c.share.toFixed(4)), hsl: hsl(c.r, c.g, c.b) })),
  regions,
};
const mouthSocket = sockets.find((s) => s.id === 'effect:mouth');
const headForwardLocal = mouthSocket
  ? (() => { const v = new THREE.Vector3(mouthSocket.offset[0], 0, mouthSocket.offset[2]).normalize(); return [v.x, v.y, v.z] as [number, number, number]; })()
  : null;

const socketDoc = {
  measuredFrom: 'src/rigData.ts bind matrices + skin weights, and src/surfaceData.high.ts vertex colours',
  authored: 'the socket SET is authored; every socket POSITION is measured, and every socket names a bone this rig really has',
  frame: {
    lateralAxis,
    leftSign,
    depthAxis,
    frontSign,
    headForwardLocal,
    note: 'measured from the L_Hand/R_Hand bind positions and the eye cluster, not assumed from the coordinateFrame note in the spec',
  },
  gates: { maxSkinIndex, boneCount: RIG.bones.length, maxWeightError },
  sockets,
};

writeFileSync(new URL('../../src/demos/monster-cute/evidence/palette.json', import.meta.url), JSON.stringify(palette, null, 2));
// Written compact, and the lid parameter rounded to three places: it drives a colour blend, so
// more precision than that is 200 KB of digits nothing can see.
writeFileSync(new URL('../../src/demos/monster-cute/evidence/eyes.json', import.meta.url), JSON.stringify({
  measuredFrom: 'eye-white clusters in src/surfaceData.high.ts, grown to a disc around each measured eye socket',
  note: 'this rig has no eyelid joints and no morph targets; the blink is drawn in vertex colour',
  lidColour,
  eyes: eyeRegions.map((e) => ({ ...e, lid: e.lid.map((v) => Number(v.toFixed(3))) })),
}));
writeFileSync(new URL('../../src/demos/monster-cute/evidence/sockets.json', import.meta.url), JSON.stringify(socketDoc, null, 2));

// ---------------------------------------------------------------- report

console.log(`vertices ${n}  bones ${RIG.bones.length}  clips ${RIG.clips.length}`);
console.log(`G5 maxSkinIndex ${maxSkinIndex} <= ${RIG.bones.length - 1}: ${maxSkinIndex <= RIG.bones.length - 1 ? 'PASS' : 'FAIL'}`);
console.log(`G4 maxWeightError ${maxWeightError.toExponential(2)} <= 2e-7: ${maxWeightError <= 2e-7 ? 'PASS' : 'FAIL'}`);
console.log(`frame: lateral=${lateralAxis} (left is ${leftSign > 0 ? '+' : '-'}${lateralAxis}), depth=${depthAxis}`);
console.log('\npalette clusters:');
for (const c of palette.dominantClusters) console.log(`  ${c.hex}  ${(c.share * 100).toFixed(1).padStart(5)}%  h${c.hsl.h.toFixed(0)} s${c.hsl.s.toFixed(2)} l${c.hsl.l.toFixed(2)}`);
console.log('\nregions:');
for (const r of regions) console.log(`  ${r.id.padEnd(10)} ${r.hex}  ${String(r.count).padStart(6)} verts (${(r.share * 100).toFixed(2)}%)  bones: ${r.bones.join(', ')}`);
console.log('\neyes (for the blink):');
for (const e of eyeRegions) console.log(`  ${e.id}  ${String(e.vertices.length).padStart(5)} vertices  radius ${e.radius.toFixed(4)}  lid colour ${lidColour}`);
console.log('\nsockets:');
for (const s of sockets) console.log(`  ${s.id.padEnd(22)} -> ${s.bone.padEnd(18)} local [${s.offset.map((x) => x.toFixed(4)).join(', ')}]  (${s.sampleCount} samples)`);
