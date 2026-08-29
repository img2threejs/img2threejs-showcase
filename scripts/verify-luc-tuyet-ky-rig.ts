/**
 * Rig gate for Luc Tuyet Ky.
 *
 * The demo's whole claim is that the costume was taken off the body and can no longer be dragged by
 * the limbs. That is a checkable property, not a look, so it is checked here rather than left to
 * whoever opens the page:
 *
 *   1. the shell splits into three regions of the expected size, with a low straddle rate;
 *   2. no vertex LABELLED gown or hair carries any leg-joint weight — the direct negation of the
 *      defect, where 40% of the shell's vertices were dominated by L/R_Thigh* and L/R_Calf*. The
 *      body-side fringe each costume mesh carries across its own border is counted separately and
 *      only bounded, because that fringe has to match the body rather than the skirt joints;
 *   3. every region's skin weights are normalised and in range;
 *   4. the costume joints hang from the pelvis and the head, not from anything that swings;
 *   5. the seam stays shut — every vertex shared between two meshes lands in the same place in both
 *      of them, in bind pose and through every featured clip. This is the one that matters most to
 *      a viewer: when it failed, the gown and the body drifted a quarter of a figure height apart at
 *      the waist and the unlit inside of the character showed through as a black hole;
 *   6. driven through the featured clips, the hem stays inside a measured envelope and comes back
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

/*
 * The gown proper carries no leg influence at all.
 *
 * Scoped to vertices the segmentation actually LABELLED as costume, which is the gown, rather than
 * to every vertex the gown mesh happens to hold. The mesh also holds the body-side fringe of its own
 * border — a vertex on a seam exists in both meshes — and that fringe has to match the body or the
 * character opens up, which the seam check below is what enforces.
 */
const regions = buildRegionGeometries(part, segmentation);
for (const region of ['dress', 'hair'] as const) {
  const mesh = model.meshes[region];
  const source = regions.find((r) => r.region === region)?.sourceVertex;
  assert.ok(mesh && source, `${region} mesh missing`);
  const index = mesh.geometry.getAttribute('skinIndex');
  const weight = mesh.geometry.getAttribute('skinWeight');
  let ownLegWeight = 0;
  let fringeLegWeight = 0;
  let worstSum = 0;
  for (let i = 0; i < index.count; i += 1) {
    const labelled = segmentation.vertexRegion[source[i]] !== 0;
    let sum = 0;
    for (let k = 0; k < 4; k += 1) {
      const bone = index.getComponent(i, k);
      const w = weight.getComponent(i, k);
      sum += w;
      assert.ok(bone >= 0 && bone < boneNames.length, `${region} vertex ${i} references joint ${bone}`);
      if (w > 0 && LEG_JOINT.test(boneNames[bone])) {
        if (labelled) ownLegWeight += w;
        else fringeLegWeight += w;
      }
    }
    worstSum = Math.max(worstSum, Math.abs(sum - 1));
  }
  assert.equal(ownLegWeight, 0, `${region} still carries ${ownLegWeight} of leg-joint weight`);
  assert.ok(worstSum < 1e-3, `${region} weights not normalised (worst error ${worstSum})`);
  // The fringe may borrow from the body, but only a little of it, and only there.
  assert.ok(fringeLegWeight < index.count * 0.01, `${region} border fringe leans too hard on the legs (${fringeLegWeight.toFixed(1)})`);
  ok(`${region}: zero leg-joint influence over ${index.count} vertices; border fringe holds ${fringeLegWeight.toFixed(1)}`);
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

/*
 * The seam is watertight, in bind pose AND under load.
 *
 * This is the check that would have caught the hole at the waist: 1,094 vertices are shared between
 * the body and the gown, and when each mesh resolved its own weights they coincided in bind pose —
 * so any static check passed — and then drifted up to 0.25 of figure height apart four seconds into
 * a dance, which reads on screen as the unlit inside of the character showing through her hip.
 */
const shared: Array<{ regions: [string, string]; local: [number, number] }> = [];
{
  const seen = new Map<number, Array<[string, number]>>();
  for (const region of regions) {
    for (let i = 0; i < region.sourceVertex.length; i += 1) {
      const list = seen.get(region.sourceVertex[i]) ?? [];
      list.push([region.region, i]);
      seen.set(region.sourceVertex[i], list);
    }
  }
  for (const list of seen.values()) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        shared.push({ regions: [list[a][0], list[b][0]], local: [list[a][1], list[b][1]] });
      }
    }
  }
}
assert.ok(shared.length > 500, `only ${shared.length} shared border vertices found — the seam scan is not seeing the border`);

function worstSeamGap(): number {
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  let worst = 0;
  for (const pair of shared) {
    const a = model.meshes[pair.regions[0] as 'body' | 'dress' | 'hair'] as THREE.SkinnedMesh;
    const b = model.meshes[pair.regions[1] as 'body' | 'dress' | 'hair'] as THREE.SkinnedMesh;
    left.fromBufferAttribute(a.geometry.getAttribute('position'), pair.local[0]);
    a.applyBoneTransform(pair.local[0], left);
    right.fromBufferAttribute(b.geometry.getAttribute('position'), pair.local[1]);
    b.applyBoneTransform(pair.local[1], right);
    worst = Math.max(worst, left.distanceTo(right));
  }
  return worst;
}

assert.ok(worstSeamGap() < 1e-6, 'seam already open in bind pose');
ok(`seam closed in bind pose across ${shared.length} shared border vertices`);

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

// Every clip the viewer offers a button for. The seam has to hold on all of them, not on a sample.
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
  const gap = worstSeamGap();
  assert.ok(gap < 1e-6, `${suffix}: seam opened to ${gap.toFixed(4)} — the character has a hole in it`);
  ok(`${suffix}: hem p95 ${worstP95.toFixed(3)} (bind ${bind.p95.toFixed(3)}), down to y ${worstLow.toFixed(3)}, seam gap ${gap.toExponential(1)}`);
}

console.log('luc-tuyet-ky rig gate\n' + checks.join('\n') + `\n\n${checks.length} checks passed.`);
