/**
 * How sharp is the skin-weight field, and where?
 *
 * A crease that appears only under animation on a single continuous shell is a weight-gradient
 * artifact: two neighbouring vertices bound to substantially different joints get pulled apart in
 * different directions as those joints diverge, and the surface folds along that boundary. In bind
 * pose the field is invisible, which is exactly why the belly looks clean until a clip runs.
 *
 * This walks the real mesh edges and measures the binding difference across each one.
 */
import { decodeModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';

const part = decodeModel(SURFACE_MODEL, SURFACE_STREAM)[0];
const n = part.meta.vertexCount;
const pos = part.position;
const index = part.index;
const names = RIG.bones.map((b) => b.name);

const skinIndex = (() => { const b = Buffer.from(RIG.skinIndex, 'base64'); const o = new Uint16Array(b.length / 2); Buffer.from(o.buffer).set(b); return o; })();
const skinWeight = (() => { const b = Buffer.from(RIG.skinWeight, 'base64'); const o = new Float32Array(b.length / 4); Buffer.from(o.buffer).set(b); return o; })();

const dense = (v: number): Map<number, number> => {
  const m = new Map<number, number>();
  for (let k = 0; k < 4; k += 1) { const w = skinWeight[v * 4 + k]; if (w > 0) m.set(skinIndex[v * 4 + k], (m.get(skinIndex[v * 4 + k]) ?? 0) + w); }
  return m;
};
const delta = (a: Map<number, number>, b: Map<number, number>): number => {
  let d = 0;
  for (const j of new Set([...a.keys(), ...b.keys()])) d += Math.abs((a.get(j) ?? 0) - (b.get(j) ?? 0));
  return d / 2;
};

const denseAll: Map<number, number>[] = [];
for (let v = 0; v < n; v += 1) denseAll.push(dense(v));

// The belly, by the same rule the palette measurement used: light blue on the front of the torso.
const lin2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const col = part.colour;
const hsl = (v: number) => {
  const r = lin2s(col[v * 3]), g = lin2s(col[v * 3 + 1]), b = lin2s(col[v * 3 + 2]);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? ((b - r) / d + 2) : ((r - g) / d + 4);
  return { h: (h / 6) * 360, s, l };
};
const isBelly = new Uint8Array(n);
for (let v = 0; v < n; v += 1) { const c = hsl(v); if (c.h >= 180 && c.h <= 235 && c.l > 0.58 && c.s >= 0.08) isBelly[v] = 1; }

const seen = new Set<number>();
let edges = 0;
const buckets = new Array(10).fill(0);
const bellyBuckets = new Array(10).fill(0);
let bellyEdges = 0;
const worst: { a: number; b: number; d: number; pair: string; y: number }[] = [];

const consider = (a: number, b: number) => {
  const key = a < b ? a * 200000 + b : b * 200000 + a;
  if (seen.has(key)) return;
  seen.add(key);
  edges += 1;
  const d = delta(denseAll[a], denseAll[b]);
  buckets[Math.min(9, Math.floor(d * 10))] += 1;
  if (isBelly[a] && isBelly[b]) { bellyEdges += 1; bellyBuckets[Math.min(9, Math.floor(d * 10))] += 1; }
  if (d > 0.35) {
    const top = (v: number) => [...denseAll[v].entries()].sort((x, y) => y[1] - x[1])[0];
    worst.push({ a, b, d, pair: `${names[top(a)[0]]} -> ${names[top(b)[0]]}`, y: pos[a * 3 + 1] });
  }
};
for (let t = 0; t < index.length; t += 3) {
  consider(index[t], index[t + 1]); consider(index[t + 1], index[t + 2]); consider(index[t + 2], index[t]);
}

console.log(`edges ${edges}   belly-to-belly edges ${bellyEdges}`);
console.log('\nbinding difference across an edge (0 = same joints, 1 = disjoint):');
console.log('  bucket      all edges    belly edges');
for (let i = 0; i < 10; i += 1) {
  console.log(`  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}   ${String(buckets[i]).padStart(9)}   ${String(bellyBuckets[i]).padStart(12)}`);
}
const pairs = new Map<string, number>();
for (const w of worst) pairs.set(w.pair, (pairs.get(w.pair) ?? 0) + 1);
console.log(`\nedges above 0.35: ${worst.length}`);
console.log('joint transitions they straddle (top 10):');
for (const [pair, count] of [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${pair.padEnd(34)} ${count}`);
}
