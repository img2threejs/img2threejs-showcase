/**
 * How far up the body does the leg influence reach?
 *
 * The belly folds because its vertices are blended roughly half-and-half between the spine and the
 * thighs, and linear blend skinning collapses when it averages two transforms that have swung far
 * apart. Before touching a single weight, this measures the actual reach: total leg-chain weight
 * against height, and where the hip joint really sits.
 */
import * as THREE from 'three';
import { decodeModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';

const part = decodeModel(SURFACE_MODEL, SURFACE_STREAM)[0];
const n = part.meta.vertexCount;
const pos = part.position;
const names = RIG.bones.map((b) => b.name);
const si = (() => { const b = Buffer.from(RIG.skinIndex, 'base64'); const o = new Uint16Array(b.length / 2); Buffer.from(o.buffer).set(b); return o; })();
const sw = (() => { const b = Buffer.from(RIG.skinWeight, 'base64'); const o = new Float32Array(b.length / 4); Buffer.from(o.buffer).set(b); return o; })();

const bindWorld = RIG.bones.map((b) => new THREE.Matrix4().fromArray(b.inverseBind).invert());
const bonePos = bindWorld.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
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
const LEG = new Set(names.filter((nm) => descends(nm, 'L_Thigh') || descends(nm, 'R_Thigh')));

const hipY = bonePos[idx.get('Hip')!].y;
const pelvisY = bonePos[idx.get('Pelvis')!].y;
const lThighY = bonePos[idx.get('L_Thigh')!].y;
const spine01Y = bonePos[idx.get('Spine01')!].y;
const spine02Y = bonePos[idx.get('Spine02')!].y;
const top = 0.7378;

console.log(`joint heights (fraction of figure height):`);
for (const [nm, y] of [['L_Thigh', lThighY], ['Pelvis', pelvisY], ['Hip', hipY], ['Spine01', spine01Y], ['Spine02', spine02Y]] as [string, number][]) {
  console.log(`  ${nm.padEnd(10)} ${(y / top * 100).toFixed(1)}%`);
}

const BANDS = 20;
const totalLeg = new Array(BANDS).fill(0);
const count = new Array(BANDS).fill(0);
const maxLeg = new Array(BANDS).fill(0);
for (let v = 0; v < n; v += 1) {
  const y = pos[v * 3 + 1];
  const band = Math.max(0, Math.min(BANDS - 1, Math.floor((y / top) * BANDS)));
  let leg = 0;
  for (let k = 0; k < 4; k += 1) { const w = sw[v * 4 + k]; if (w > 0 && LEG.has(names[si[v * 4 + k]])) leg += w; }
  totalLeg[band] += leg; count[band] += 1; maxLeg[band] = Math.max(maxLeg[band], leg);
}
console.log(`\nleg-chain weight by height band (thigh joint sits at ${(lThighY / top * 100).toFixed(1)}%):`);
console.log('  band        verts   mean leg w   max leg w');
for (let i = 0; i < BANDS; i += 1) {
  if (!count[i]) continue;
  const mean = totalLeg[i] / count[i];
  const bar = '#'.repeat(Math.round(mean * 40));
  console.log(`  ${String(i * 5).padStart(3)}-${String((i + 1) * 5).padStart(3)}% ${String(count[i]).padStart(7)}   ${mean.toFixed(3)}  ${maxLeg[i].toFixed(3)}  ${bar}`);
}
