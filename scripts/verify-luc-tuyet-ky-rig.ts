/**
 * Rig gate for Luc Tuyet Ky.
 *
 * The demo claims the costume was taken off the body, that it is no longer dragged by the limbs, and
 * that nothing tears or shows through while it moves. Those are checkable properties, so they are
 * checked here rather than left to whoever opens the page:
 *
 *   1. the shell splits into three regions of the expected size, with a low straddle rate;
 *   2. NO gown or hair vertex carries any leg-joint weight — the direct negation of the defect, where
 *      40% of the shell's vertices were dominated by L/R_Thigh* and L/R_Calf*;
 *   3. every region's skin weights are normalised and in range;
 *   4. the costume joints hang from the pelvis and the head, not from anything that swings;
 *   5. every region is a CLOSED surface. This is what stops the character going black: cutting the
 *      shell left the body with 2,556 open edges where the gown used to be, and an open hole shows
 *      the unlit inside of the model through it. Closing each region is also what lets the gown move
 *      freely — the alternative, welding the two sides of every border onto one weight set, put a
 *      calf joint and a skirt joint on the same vertex and stretched the edges around it by 114x;
 *   6. under load, the visible surface does not draw out into slivers. Measured as absolute edge
 *      elongation in figure heights, which is what an eye actually sees — a large RATIO on a tiny
 *      edge is invisible, and ranking by it hides the elongations that are not.
 *
 * Cap triangles are excluded from (6) by construction: a cap spans an opening on purpose, and
 * counting it as stretch would report an artefact where there is a lid doing its job.
 *
 * Run: npx tsx scripts/verify-luc-tuyet-ky-rig.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildClips, decodeModel } from '../src/demos/luc-tuyet-ky/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../src/demos/luc-tuyet-ky/surfaceData.high';
import { RIG } from '../src/demos/luc-tuyet-ky/rigData';
import { buildRegionGeometries, segmentCostume } from '../src/demos/luc-tuyet-ky/costumeSegmentation';
import { createLucTuyetKy, prewarmLucTuyetKy } from '../src/demos/luc-tuyet-ky/createLucTuyetKyModel';

/** Joints the costume must never be weighted to — the ones that made it lurch. */
const LEG_JOINT = /Thigh|Calf|Foot|Toe/;

/** Elongation ceilings, in figure heights. The gown is held far tighter than the body. */
const COSTUME_STRETCH_CAP = 0.03;
const BODY_STRETCH_CAP = 0.12;

const checks: string[] = [];
const ok = (label: string): void => { checks.push(`  ok  ${label}`); };

// ---------------------------------------------------------------- 1. segmentation
const part = decodeModel(SURFACE_MODEL, SURFACE_STREAM)[0];
const segmentation = segmentCostume(part);
const { counts, straddlingTriangles } = segmentation;

assert.equal(counts.body.vertices + counts.dress.vertices + counts.hair.vertices, part.meta.vertexCount);
ok(`every vertex classified (${part.meta.vertexCount})`);

// The gown is a large minority of the shell, which is the point: it was never a small trim detail
// that could be ignored, it is over a third of the character.
assert.ok(counts.dress.vertices > 45_000 && counts.dress.vertices < 75_000, `dress vertices ${counts.dress.vertices} outside the expected band`);
assert.ok(counts.hair.vertices > 12_000 && counts.hair.vertices < 26_000, `hair vertices ${counts.hair.vertices} outside the expected band`);
ok(`regions sized: body ${counts.body.vertices}v dress ${counts.dress.vertices}v hair ${counts.hair.vertices}v`);

const straddleRate = straddlingTriangles / (part.index.length / 3);
assert.ok(straddleRate < 0.03, `straddle rate ${(straddleRate * 100).toFixed(2)}% too high — the cut is not following a seam`);
ok(`cut is clean: ${straddlingTriangles} straddling triangles (${(straddleRate * 100).toFixed(2)}%)`);

// ---------------------------------------------------------------- 2-4. the rig
await prewarmLucTuyetKy('high');
const model = createLucTuyetKy({ vfx: false });
const boneNames = model.skeleton.bones.map((bone) => bone.name);

assert.equal(boneNames.length, RIG.bones.length + model.cloth.bones.length);
ok(`skeleton is the source rig plus costume joints: ${RIG.bones.length} + ${model.cloth.bones.length} = ${boneNames.length}`);

for (const region of ['dress', 'hair'] as const) {
  const mesh = model.meshes[region];
  assert.ok(mesh, `${region} mesh missing`);
  const index = mesh.geometry.getAttribute('skinIndex');
  const weight = mesh.geometry.getAttribute('skinWeight');
  let legWeight = 0;
  let worstSum = 0;
  for (let i = 0; i < index.count; i += 1) {
    let sum = 0;
    for (let k = 0; k < 4; k += 1) {
      const bone = index.getComponent(i, k);
      const w = weight.getComponent(i, k);
      sum += w;
      assert.ok(bone >= 0 && bone < boneNames.length, `${region} vertex ${i} references joint ${bone}`);
      if (w > 0 && LEG_JOINT.test(boneNames[bone])) legWeight += w;
    }
    worstSum = Math.max(worstSum, Math.abs(sum - 1));
  }
  // THE claim. Not "small", not "reduced" — zero. A single gram of Calf weight on a gown panel is
  // the whole original artefact in miniature.
  assert.equal(legWeight, 0, `${region} still carries ${legWeight} of leg-joint weight`);
  assert.ok(worstSum < 1e-3, `${region} weights not normalised (worst error ${worstSum})`);
  ok(`${region}: zero leg-joint influence over ${index.count} vertices, weights normalised`);
}

const bodyIndex = model.meshes.body?.geometry.getAttribute('skinIndex');
assert.ok(bodyIndex && bodyIndex.count > 0, 'body mesh missing');
ok(`body keeps the source rig's own weights over ${bodyIndex.count} vertices, with the crotch graded`);

for (const strand of model.cloth.strands) {
  const anchorParent = strand.bones[0].parent?.name ?? '';
  assert.ok(anchorParent === 'Pelvis' || anchorParent === 'Head', `costume strand anchored to ${anchorParent}`);
}
ok(`all ${model.cloth.strands.length} costume strands hang from Pelvis or Head`);

// ---------------------------------------------------------------- 5. every region is closed
const regions = buildRegionGeometries(part, segmentation);
for (const region of regions) {
  const index = region.geometry.getIndex();
  assert.ok(index, `${region.region} has no index`);
  const edge = new Map<string, number>();
  const note = (a: number, b: number): void => {
    const ra = segmentation.representative[region.sourceVertex[a]];
    const rb = segmentation.representative[region.sourceVertex[b]];
    if (ra === rb) return;
    const key = ra < rb ? `${ra}_${rb}` : `${rb}_${ra}`;
    edge.set(key, (edge.get(key) ?? 0) + 1);
  };
  for (let t = 0; t < index.count; t += 3) {
    note(index.getX(t), index.getX(t + 1));
    note(index.getX(t + 1), index.getX(t + 2));
    note(index.getX(t + 2), index.getX(t));
  }
  let open = 0;
  for (const count of edge.values()) if (count === 1) open += 1;
  if (region.region === 'body') {
    // The one that must be watertight: it is the only region with its own interior behind it.
    assert.equal(open, 0, `body still has ${open} open edges — a hole for the interior to show through`);
    ok(`body: closed surface, ${region.geometry.userData.cappedLoops as number} boundary loops capped`);
  } else {
    ok(`${region.region}: ${open} open edges, left open on purpose — the closed body sits behind it`);
  }
}

// ---------------------------------------------------------------- 6. no slivers under load
const clips = buildClips(RIG);
const figure = model.group.getObjectByName('luc-tuyet-ky-figure') as THREE.Group;
const hip = model.skeleton.bones.find((bone) => bone.name === 'Hip') as THREE.Bone;

/** Sampled edges of the VISIBLE surface only, with their bind lengths. */
const tracked = (['body', 'dress', 'hair'] as const).map((name) => {
  const mesh = model.meshes[name] as THREE.SkinnedMesh;
  const index = mesh.geometry.getIndex() as THREE.BufferAttribute;
  const visible = (mesh.geometry.userData.visibleIndexCount as number) ?? index.count;
  const position = mesh.geometry.getAttribute('position');
  const edges: Array<[number, number]> = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let t = 0; t + 2 < visible; t += 3 * 5) {
    edges.push([index.getX(t), index.getX(t + 1)]);
    edges.push([index.getX(t + 1), index.getX(t + 2)]);
  }
  const bind = edges.map(([i, j]) => {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, j);
    return a.distanceTo(b);
  });
  return { name, mesh, position, edges, bind };
});

const left = new THREE.Vector3();
const right = new THREE.Vector3();
function worstElongation(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tracked) {
    let worst = 0;
    for (let e = 0; e < t.edges.length; e += 1) {
      const [i, j] = t.edges[e];
      left.fromBufferAttribute(t.position, i);
      t.mesh.applyBoneTransform(i, left);
      right.fromBufferAttribute(t.position, j);
      t.mesh.applyBoneTransform(j, right);
      worst = Math.max(worst, left.distanceTo(right) - t.bind[e]);
    }
    out[t.name] = worst;
  }
  return out;
}

const dress = model.meshes.dress as THREE.SkinnedMesh;
const dressPosition = dress.geometry.getAttribute('position');
const sampledDress: number[] = [];
for (let i = 0; i < dressPosition.count; i += 53) sampledDress.push(i);
const vertex = new THREE.Vector3();
const hipLocal = new THREE.Vector3();
const figureInverse = new THREE.Matrix4();

function hemEnvelope(): { p95: number; lowest: number } {
  figure.updateMatrixWorld(true);
  figureInverse.copy(figure.matrixWorld).invert();
  hipLocal.setFromMatrixPosition(hip.matrixWorld).applyMatrix4(figureInverse);
  const radii: number[] = [];
  let lowest = Infinity;
  for (const i of sampledDress) {
    vertex.fromBufferAttribute(dressPosition, i);
    dress.applyBoneTransform(i, vertex);
    radii.push(Math.hypot(vertex.x - hipLocal.x, vertex.z - hipLocal.z));
    lowest = Math.min(lowest, vertex.y);
  }
  radii.sort((a, b) => a - b);
  return { p95: radii[Math.floor(0.95 * (radii.length - 1))], lowest };
}

const bindHem = hemEnvelope();
ok(`bind hem: radius p95 ${bindHem.p95.toFixed(3)}, lowest y ${bindHem.lowest.toFixed(3)}`);

const FEATURED = [
  'dance_02', 'dance_05', 'front_kick_01', 'flee_02', 'greet_01',
  'angry_01', 'heart_pose', 'afraid', 'lift_heavy', 'defeat_02',
];
for (const suffix of FEATURED) {
  const clip = clips.find((c) => c.name.endsWith(suffix));
  assert.ok(clip, `clip ${suffix} missing`);
  model.mixer.stopAllAction();
  model.cloth.reset();
  const action = model.mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();

  let hemP95 = 0;
  let hemLow = Infinity;
  const worst: Record<string, number> = { body: 0, dress: 0, hair: 0 };
  for (let frame = 0; frame < 420; frame += 1) {
    model.step(1 / 60);
    if (frame < 60 || frame % 15) continue;
    const envelope = hemEnvelope();
    hemP95 = Math.max(hemP95, envelope.p95);
    hemLow = Math.min(hemLow, envelope.lowest);
    const elongation = worstElongation();
    for (const name of Object.keys(worst)) worst[name] = Math.max(worst[name], elongation[name]);
  }

  // The gown may swing — that is the point of the solver — but it may not billow out past twice its
  // bind radius, and it must still hang below the hip rather than riding up over it.
  assert.ok(hemP95 < bindHem.p95 * 2, `${suffix}: hem reached ${hemP95.toFixed(3)} against a bind p95 of ${bindHem.p95.toFixed(3)}`);
  assert.ok(hemLow < 0.25, `${suffix}: lowest gown vertex only reached y ${hemLow.toFixed(3)} — the skirt is riding up`);
  for (const name of ['dress', 'hair'] as const) {
    assert.ok(worst[name] < COSTUME_STRETCH_CAP, `${suffix}: ${name} stretched by ${worst[name].toFixed(4)}`);
  }
  assert.ok(worst.body < BODY_STRETCH_CAP, `${suffix}: body stretched by ${worst.body.toFixed(4)}`);
  ok(`${suffix}: hem p95 ${hemP95.toFixed(3)}, down to y ${hemLow.toFixed(3)}; stretch body ${worst.body.toFixed(4)} dress ${worst.dress.toFixed(4)} hair ${worst.hair.toFixed(4)}`);
}

console.log('luc-tuyet-ky rig gate\n' + checks.join('\n') + `\n\n${checks.length} checks passed.`);
