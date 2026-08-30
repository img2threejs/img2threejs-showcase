/**
 * What drives the face?
 *
 * The eyes and fangs distort under animation while the rest of the head holds, which points at the
 * weights rather than at the clips. A feature that must stay RIGID — an eyeball, a tooth — has to
 * ride one joint. The moment it is split across two joints that rotate apart, it stops being a
 * solid object and starts being a blend of two, which is exactly what a torn sclera and a sheared
 * fang look like.
 */
import * as THREE from 'three';
import { decodeModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';

const part = decodeModel(SURFACE_MODEL, SURFACE_STREAM)[0];
const n = part.meta.vertexCount;
const pos = part.position;
const col = part.colour;
const names = RIG.bones.map((b) => b.name);
const si = (() => { const b = Buffer.from(RIG.skinIndex, 'base64'); const o = new Uint16Array(b.length / 2); Buffer.from(o.buffer).set(b); return o; })();
const sw = (() => { const b = Buffer.from(RIG.skinWeight, 'base64'); const o = new Float32Array(b.length / 4); Buffer.from(o.buffer).set(b); return o; })();

const lin2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hsl = (v: number) => {
  const r = lin2s(col[v * 3]), g = lin2s(col[v * 3 + 1]), b = lin2s(col[v * 3 + 2]);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return { s: 0, l };
  return { s: l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn), l };
};

const idx = new Map(names.map((nm, i) => [nm, i]));
const descends = (name: string, ancestor: string): boolean => {
  let i = idx.get(name);
  while (i !== undefined && i >= 0) {
    if (names[i] === ancestor) return true;
    const p: number = RIG.bones[i].parent;
    if (p < 0) return false;
    i = p;
  }
  return false;
};
const HEAD_SET = new Set(names.filter((b) => descends(b, 'Head')));
const boneOf = (v: number) => {
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k += 1) { const w = sw[v * 4 + k]; if (w > bw) { bw = w; best = si[v * 4 + k]; } }
  return names[best];
};

const all = Array.from({ length: n }, (_, v) => v);
const eyeWhite = all.filter((v) => { const c = hsl(v); return c.l > 0.8 && c.s < 0.18 && HEAD_SET.has(boneOf(v)); });
const iris = all.filter((v) => hsl(v).l < 0.22 && HEAD_SET.has(boneOf(v)));
const headAll = all.filter((v) => HEAD_SET.has(boneOf(v)));

function report(label: string, members: number[]): void {
  const tally = new Map<string, { count: number; weight: number }>();
  let splitVerts = 0;
  let worstSecondary = 0;
  const secondaryTally = new Map<string, number>();
  for (const v of members) {
    let dominant = 0;
    for (let k = 0; k < 4; k += 1) dominant = Math.max(dominant, sw[v * 4 + k]);
    if (dominant < 0.999) splitVerts += 1;
    worstSecondary = Math.max(worstSecondary, 1 - dominant);
    for (let k = 0; k < 4; k += 1) {
      const w = sw[v * 4 + k];
      if (w <= 0) continue;
      const nm = names[si[v * 4 + k]];
      const e = tally.get(nm) ?? { count: 0, weight: 0 };
      e.count += 1; e.weight += w; tally.set(nm, e);
      if (w < dominant && w > 0.001) secondaryTally.set(nm, (secondaryTally.get(nm) ?? 0) + 1);
    }
  }
  console.log(`\n${label}  (${members.length} vertices)`);
  console.log(`  vertices NOT rigid to one joint: ${splitVerts} (${((splitVerts / members.length) * 100).toFixed(1)}%)`);
  console.log(`  largest share held by a non-dominant joint: ${worstSecondary.toFixed(3)}`);
  console.log('  joints involved (share of total weight):');
  const total = members.length;
  for (const [nm, e] of [...tally.entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, 6)) {
    console.log(`    ${nm.padEnd(18)} ${(e.weight / total).toFixed(3)}  on ${e.count} verts`);
  }
  if (secondaryTally.size) {
    console.log('  joints appearing as a SECONDARY influence:');
    for (const [nm, c] of [...secondaryTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    ${nm.padEnd(18)} on ${c} verts`);
    }
  }
}

report('eye whites', eyeWhite);
report('irises', iris);
report('whole head', headAll);
