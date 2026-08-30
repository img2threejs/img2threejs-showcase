/**
 * Find the crease, by dihedral angle.
 *
 * An edge shared by two triangles has a dihedral angle. On a smooth belly it is near 180 degrees.
 * A fold is an edge whose dihedral was flat in bind pose and is sharp after skinning — that is a
 * crease, measured, with no reference to how it looks.
 */
import * as THREE from 'three';
import { buildRiggedModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';

const CLIP = process.env.CLIP ?? 'preset:biped:dance_03';
const TIME = Number(process.env.TIME ?? 3.1);

const rigged = buildRiggedModel(SURFACE_MODEL, SURFACE_STREAM, RIG);
// DQS=1 measures the same pose through dual quaternion skinning instead of the linear blend.
const { mixer, mesh, group, clips } = rigged;
const clip = clips.find((c) => c.name === CLIP)!;
mixer.stopAllAction();
const action = mixer.clipAction(clip);
action.reset(); action.play(); action.paused = true; action.time = TIME;
mixer.update(0); group.updateMatrixWorld(true); mesh.skeleton.update();

const g = mesh.geometry;
const position = g.getAttribute('position') as THREE.BufferAttribute;
const si = g.getAttribute('skinIndex') as THREE.BufferAttribute;
const sw = g.getAttribute('skinWeight') as THREE.BufferAttribute;
const index = g.getIndex()!;
const n = position.count;
const names = RIG.bones.map((b) => b.name);

const skinned = new Float32Array(n * 3);
{
  const v3 = new THREE.Vector3();
  for (let v = 0; v < n; v += 1) {
    v3.fromBufferAttribute(position, v);
    mesh.applyBoneTransform(v, v3);
    skinned[v * 3] = v3.x; skinned[v * 3 + 1] = v3.y; skinned[v * 3 + 2] = v3.z;
  }
}

const bind = position.array as Float32Array;
const triNormal = (buf: ArrayLike<number>, a: number, b: number, c: number, out: THREE.Vector3) => {
  const A = new THREE.Vector3(buf[a * 3], buf[a * 3 + 1], buf[a * 3 + 2]);
  const B = new THREE.Vector3(buf[b * 3], buf[b * 3 + 1], buf[b * 3 + 2]);
  const C = new THREE.Vector3(buf[c * 3], buf[c * 3 + 1], buf[c * 3 + 2]);
  out.crossVectors(B.sub(A), C.sub(A));
  const l = out.length(); if (l > 0) out.divideScalar(l);
  return l / 2;
};

// edge -> the (at most two) triangles that share it
const edgeTris = new Map<number, number[]>();
const key = (a: number, b: number) => (a < b ? a * 200000 + b : b * 200000 + a);
for (let t = 0; t < index.count; t += 3) {
  const i0 = index.getX(t), i1 = index.getX(t + 1), i2 = index.getX(t + 2);
  for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]] as [number, number][]) {
    const k = key(a, b);
    const list = edgeTris.get(k); if (list) list.push(t); else edgeTris.set(k, [t]);
  }
}

const nb = new THREE.Vector3(), nb2 = new THREE.Vector3(), nd = new THREE.Vector3(), nd2 = new THREE.Vector3();
const creases: { v: number; bindDeg: number; defDeg: number; y: number }[] = [];
for (const [k, tris] of edgeTris) {
  if (tris.length !== 2) continue;
  const [t1, t2] = tris;
  triNormal(bind, index.getX(t1), index.getX(t1 + 1), index.getX(t1 + 2), nb);
  triNormal(bind, index.getX(t2), index.getX(t2 + 1), index.getX(t2 + 2), nb2);
  triNormal(skinned, index.getX(t1), index.getX(t1 + 1), index.getX(t1 + 2), nd);
  triNormal(skinned, index.getX(t2), index.getX(t2 + 1), index.getX(t2 + 2), nd2);
  const bindDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(nb.dot(nb2), -1, 1)));
  const defDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(nd.dot(nd2), -1, 1)));
  // bind flat (normals nearly parallel => angle between normals near 0), deformed sharply bent
  if (bindDeg < 25 && defDeg > 70) {
    const v = Math.floor(k / 200000);
    creases.push({ v, bindDeg, defDeg, y: skinned[v * 3 + 1] });
  }
}

console.log(`clip ${CLIP} @ ${TIME}s`);
console.log(`creased edges (bind normals within 25 deg, deformed beyond 70 deg): ${creases.length}`);

// Collapse, measured the way the warrior demo measured it: how short does an edge get?
{
  const ratios: number[] = [];
  for (const [k] of edgeTris) {
    const a = Math.floor(k / 200000), b = k % 200000;
    const bl = Math.hypot(bind[a * 3] - bind[b * 3], bind[a * 3 + 1] - bind[b * 3 + 1], bind[a * 3 + 2] - bind[b * 3 + 2]);
    if (bl < 1e-9) continue;
    const dl = Math.hypot(skinned[a * 3] - skinned[b * 3], skinned[a * 3 + 1] - skinned[b * 3 + 1], skinned[a * 3 + 2] - skinned[b * 3 + 2]);
    ratios.push(dl / bl);
  }
  ratios.sort((x, y) => x - y);
  const pct = (q: number) => ratios[Math.floor(ratios.length * q)].toFixed(3);
  const under = (v: number) => ratios.filter((r) => r < v).length;
  console.log(`edge length ratio (deformed / bind): min ${ratios[0].toFixed(3)}  p0.1% ${pct(0.001)}  p1% ${pct(0.01)}  median ${pct(0.5)}  max ${ratios[ratios.length - 1].toFixed(3)}`);
  console.log(`edges under 0.50 of rest: ${under(0.5)}    under 0.25: ${under(0.25)}`);
}
if (!creases.length) { console.log('no fold found by this test'); process.exit(0); }

const H = 0.7378;
const bands = new Array(10).fill(0);
for (const c of creases) bands[Math.max(0, Math.min(9, Math.floor((c.y / H) * 10)))] += 1;
console.log('\nby height band (0 = feet, 9 = horns):');
bands.forEach((c, i) => { if (c) console.log(`  band ${i} (${i * 10}-${(i + 1) * 10}%): ${c}`); });

// What are the crease vertices actually blended between?
const pairTally = new Map<string, number>();
const weightSpread: number[] = [];
for (const c of creases) {
  const parts: [string, number][] = [];
  for (let k = 0; k < 4; k += 1) {
    const w = sw.getComponent(c.v, k);
    if (w > 0.02) parts.push([names[si.getComponent(c.v, k)], w]);
  }
  parts.sort((a, b) => b[1] - a[1]);
  weightSpread.push(parts[0]?.[1] ?? 1);
  pairTally.set(parts.map(([nm]) => nm).join(' + '), (pairTally.get(parts.map(([nm]) => nm).join(' + ')) ?? 0) + 1);
}
console.log('\nweight blends on crease vertices (top 10):');
for (const [blend, count] of [...pairTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(count).padStart(5)}  ${blend}`);
}
weightSpread.sort((a, b) => a - b);
console.log(`\ndominant weight on crease vertices: min ${weightSpread[0].toFixed(3)}  median ${weightSpread[weightSpread.length >> 1].toFixed(3)}  max ${weightSpread[weightSpread.length - 1].toFixed(3)}`);
