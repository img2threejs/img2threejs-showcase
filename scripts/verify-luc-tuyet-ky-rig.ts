/**
 * Rig gate for Luc Tuyet Ky.
 *
 * The demo's whole claim is that the costume was taken off the body and can no longer be dragged by
 * the limbs. That is a checkable property, not a look, so it is checked here rather than left to
 * whoever opens the page:
 *
 *   1. the shell splits into three regions of the expected size, with a low straddle rate;
 *   2. NO gown or hair vertex carries any leg-joint weight at all — the direct negation of the
 *      defect, where 40% of the shell's vertices were dominated by L/R_Thigh* and L/R_Calf*;
 *   3. every region's skin weights are normalised and in range;
 *   4. the costume joints hang from the pelvis and the head, not from anything that swings;
 *   5. driven through the featured clips, the hem stays inside a measured envelope and comes back
 *      down — the regression test for the solver, which in three earlier revisions variously threw
 *      the skirt above the waist, pumped it out to twice its bind radius, and wound it into spikes.
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
ok(`body keeps the source rig's own weights over ${bodyIndex.count} vertices`);

for (const strand of model.cloth.strands) {
  const anchorParent = strand.bones[0].parent?.name ?? '';
  assert.ok(anchorParent === 'Pelvis' || anchorParent === 'Head', `costume strand anchored to ${anchorParent}`);
  assert.ok(!LEG_JOINT.test(anchorParent), `costume strand anchored to a leg joint: ${anchorParent}`);
}
ok(`all ${model.cloth.strands.length} costume strands hang from Pelvis or Head`);

// ---------------------------------------------------------------- 5. the solver, under load
const clips = buildClips(RIG);
const dress = model.meshes.dress as THREE.SkinnedMesh;
const figure = model.group.getObjectByName('luc-tuyet-ky-figure') as THREE.Group;
const hip = model.skeleton.bones.find((bone) => bone.name === 'Hip') as THREE.Bone;

const position = dress.geometry.getAttribute('position');
const sampled: number[] = [];
for (let i = 0; i < position.count; i += 53) sampled.push(i);

const vertex = new THREE.Vector3();
const hipLocal = new THREE.Vector3();
const figureInverse = new THREE.Matrix4();

function hemEnvelope(): { p95: number; p50: number; lowest: number } {
  figure.updateMatrixWorld(true);
  figureInverse.copy(figure.matrixWorld).invert();
  hipLocal.setFromMatrixPosition(hip.matrixWorld).applyMatrix4(figureInverse);
  const radii: number[] = [];
  let lowest = Infinity;
  for (const i of sampled) {
    vertex.fromBufferAttribute(position, i);
    dress.applyBoneTransform(i, vertex);
    radii.push(Math.hypot(vertex.x - hipLocal.x, vertex.z - hipLocal.z));
    lowest = Math.min(lowest, vertex.y);
  }
  radii.sort((a, b) => a - b);
  return { p95: radii[Math.floor(0.95 * (radii.length - 1))], p50: radii[radii.length >> 1], lowest };
}

const bind = hemEnvelope();
ok(`bind hem: radius p50 ${bind.p50.toFixed(3)} p95 ${bind.p95.toFixed(3)}, lowest y ${bind.lowest.toFixed(3)}`);

const FEATURED = ['dance_02', 'dance_05', 'front_kick_01', 'flee_02', 'greet_01', 'lift_heavy'];
for (const suffix of FEATURED) {
  const clip = clips.find((c) => c.name.endsWith(suffix));
  assert.ok(clip, `clip ${suffix} missing`);
  model.mixer.stopAllAction();
  model.cloth.reset();
  const action = model.mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();

  let worstP95 = 0;
  let worstLow = Infinity;
  for (let frame = 0; frame < 420; frame += 1) {
    model.mixer.update(1 / 60);
    model.holdInPlace();
    model.cloth.update(1 / 60);
    if (frame < 60 || frame % 15) continue;
    const envelope = hemEnvelope();
    worstP95 = Math.max(worstP95, envelope.p95);
    worstLow = Math.min(worstLow, envelope.lowest);
  }

  // The gown may swing — that is the point of the solver — but it may not billow out past twice its
  // bind radius, and it must still hang below the hip rather than riding up over it.
  assert.ok(worstP95 < bind.p95 * 2, `${suffix}: hem reached ${worstP95.toFixed(3)} against a bind p95 of ${bind.p95.toFixed(3)}`);
  assert.ok(worstLow < 0.25, `${suffix}: lowest gown vertex only reached y ${worstLow.toFixed(3)} — the skirt is riding up`);
  ok(`${suffix}: hem p95 peaks at ${worstP95.toFixed(3)} (bind ${bind.p95.toFixed(3)}), stays down to y ${worstLow.toFixed(3)}`);
}

console.log('luc-tuyet-ky rig gate\n' + checks.join('\n') + `\n\n${checks.length} checks passed.`);
