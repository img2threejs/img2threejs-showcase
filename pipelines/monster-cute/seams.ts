/**
 * Do coincident vertices share a binding?
 *
 * A crack in a SINGLE skinned shell cannot come from parts drifting apart — there is only one part.
 * It comes from vertices that sit on top of each other in bind pose but are bound to different
 * joints: the exporter splits a vertex wherever the normal or the UV is discontinuous, and each
 * copy is then weighted independently. In bind pose they coincide exactly, so nothing is visible.
 * The moment their joints diverge, the copies separate and the surface opens along that seam.
 *
 * This measures it directly: group vertices by quantised position, then compare bindings inside
 * each group.
 */
import * as THREE from 'three';
import { decodeModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';

const part = decodeModel(SURFACE_MODEL, SURFACE_STREAM)[0];
const n = part.meta.vertexCount;
const pos = part.position;

const skinIndex = (() => {
  const b = Buffer.from(RIG.skinIndex, 'base64');
  const out = new Uint16Array(b.length / 2); Buffer.from(out.buffer).set(b); return out;
})();
const skinWeight = (() => {
  const b = Buffer.from(RIG.skinWeight, 'base64');
  const out = new Float32Array(b.length / 4); Buffer.from(out.buffer).set(b); return out;
})();

const H = SURFACE_MODEL.height;
const names = RIG.bones.map((b) => b.name);

// Positions were quantised to 16 bits on the way in, so exactly-coincident vertices are bit-identical.
// Key on the raw floats.
const groups = new Map<string, number[]>();
for (let v = 0; v < n; v += 1) {
  const key = `${pos[v * 3]},${pos[v * 3 + 1]},${pos[v * 3 + 2]}`;
  const g = groups.get(key);
  if (g) g.push(v); else groups.set(key, [v]);
}

/** Dense weight vector over all joints, so two bindings can be compared slot-order-independently. */
function dense(v: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let k = 0; k < 4; k += 1) {
    const w = skinWeight[v * 4 + k];
    if (w > 0) m.set(skinIndex[v * 4 + k], (m.get(skinIndex[v * 4 + k]) ?? 0) + w);
  }
  return m;
}
function bindingDelta(a: number, b: number): number {
  const A = dense(a); const B = dense(b);
  let d = 0;
  for (const j of new Set([...A.keys(), ...B.keys()])) d += Math.abs((A.get(j) ?? 0) - (B.get(j) ?? 0));
  return d / 2;   // total variation distance, 0 = identical, 1 = disjoint
}

let duplicated = 0;
let split = 0;
let worst = 0;
const perBone = new Map<string, { groups: number; worst: number }>();
const offenders: { v: number; delta: number; y: number; bones: string[] }[] = [];

for (const g of groups.values()) {
  if (g.length < 2) continue;
  duplicated += 1;
  let localWorst = 0;
  for (let i = 1; i < g.length; i += 1) localWorst = Math.max(localWorst, bindingDelta(g[0], g[i]));
  if (localWorst > 1e-6) {
    split += 1;
    worst = Math.max(worst, localWorst);
    const dominant = names[skinIndex[g[0] * 4]];
    const e = perBone.get(dominant) ?? { groups: 0, worst: 0 };
    e.groups += 1; e.worst = Math.max(e.worst, localWorst);
    perBone.set(dominant, e);
    offenders.push({
      v: g[0], delta: localWorst, y: pos[g[0] * 3 + 1],
      bones: [...new Set(g.flatMap((x) => [0, 1, 2, 3].filter((k) => skinWeight[x * 4 + k] > 0).map((k) => names[skinIndex[x * 4 + k]])))],
    });
  }
}

console.log(`vertices ................. ${n}`);
console.log(`distinct positions ....... ${groups.size}`);
console.log(`positions with >1 vertex . ${duplicated}`);
console.log(`  ...of which the copies DISAGREE on their binding: ${split}`);
console.log(`worst binding disagreement (total variation, 0..1): ${worst.toFixed(4)}`);

if (split) {
  console.log('\nsplit seams by dominant joint (top 12):');
  for (const [bone, e] of [...perBone.entries()].sort((a, b) => b[1].groups - a[1].groups).slice(0, 12)) {
    console.log(`  ${bone.padEnd(20)} ${String(e.groups).padStart(5)} seams   worst ${e.worst.toFixed(3)}`);
  }
  const band = (y: number) => Math.min(9, Math.floor((y / 0.7378) * 10));
  const bands = new Array(10).fill(0);
  for (const o of offenders) bands[band(o.y)] += 1;
  console.log('\nby height band (0 = feet, 9 = horns):');
  bands.forEach((c, i) => console.log(`  band ${i} (${(i * 10)}-${(i + 1) * 10}% of height): ${c}`));
}
