/**
 * Measure the monster-tree rig.  ->  node scripts/measure-monster-tree-rig.mjs [--json]
 * Nothing here asserts that the rig works — it samples the rig and
 * reports numbers, and a check that could not be sampled is reported `unevaluated` with the input
 * it was missing rather than defaulted to a pass.
 *
 *   node tools/measure-rig.mjs [--json]
 *
 * Gates
 *   R1  binding motion   every clip is seeked to >= 5 times and the skinned vertices are
 *                        transformed on the CPU; `maxSampledBindingDelta` is the largest distance
 *                        any sampled vertex travelled from its bind pose. A clip that exists is
 *                        not a clip that runs: a clip whose delta is ~0 is dead weight.
 *   R2  rest pose        with the mixer at t=0 and no clip playing, the skinned vertices must
 *                        reproduce `skinRootWorld * v`. This is what catches the double-scale.
 *   R3  rigid costume    every pairwise distance inside a costume piece must be invariant across
 *                        every sampled pose. This is the "the costume must not be dragged" check,
 *                        stated as a measurement instead of an intention.
 *   R4  seam             the gap between a costume piece and the shell ring it was lifted out of,
 *                        across every sampled pose.
 *   R5  skin integrity   bone indices in range, weights normalised, one shell, one LOD.
 */

import * as esbuild from 'esbuild';
import * as THREE from 'three';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const JSON_OUT = process.argv.includes('--json');
const SEEK_POINTS = 7;          // >= 5, the gate's floor
const VERTEX_SAMPLE = 1500;     // deterministic stride over the shell
const PAIR_SAMPLE = 400;        // rigid-strain pairs per costume piece

// Bundled inside the repo, not in /tmp: node resolves `three` from node_modules by walking up
// from the importing file, and a temp directory has no node_modules above it.
const out = 'node_modules/.monster-tree';
mkdirSync(out, { recursive: true });
const bundle = join(out, 'measure-entry.mjs');
await esbuild.build({
  entryPoints: ['src/demos/monster-tree/measureEntry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['three'],
  outfile: bundle,
  logLevel: 'warning',
});
const entry = await import(pathToFileURL(join(process.cwd(), bundle)).href);
const { loadRig } = entry;
const { rig: RIG, model, stream, build } = await loadRig();

const report = { gates: {}, notes: [] };
const fail = [];

// ---------------------------------------------------------------- R5 skin integrity
{
  const bones = RIG.bones.length;
  const verts = RIG.vertexCount;
  const si = decodeU16(RIG.skinIndex);
  const sw = decodeF32(RIG.skinWeight);
  let maxIndex = 0;
  let worstSum = 0;
  for (let v = 0; v < verts; v += 1) {
    let sum = 0;
    for (let k = 0; k < 4; k += 1) {
      maxIndex = Math.max(maxIndex, si[v * 4 + k]);
      sum += sw[v * 4 + k];
    }
    worstSum = Math.max(worstSum, Math.abs(sum - 1));
  }
  const ok = maxIndex < bones && worstSum < 1e-3 && si.length === verts * 4 && sw.length === verts * 4;
  report.gates.R5_skinIntegrity = {
    status: ok ? 'pass' : 'fail',
    bones, vertices: verts,
    maxBoneIndex: maxIndex,
    maxWeightSumError: round(worstSum, 7),
    levelsOfDetail: 1,
    lodNote: 'one level by design — decimation would invalidate skinIndex/skinWeight',
  };
  if (!ok) fail.push('R5');
}

// ---------------------------------------------------------------- build the rig
const rigged = build();
const scene = new THREE.Scene();
scene.add(rigged.group);
scene.updateMatrixWorld(true);

const geometry = rigged.shell.geometry;
const position = geometry.attributes.position;
const sampleStride = Math.max(1, Math.floor(position.count / VERTEX_SAMPLE));
const sampled = [];
for (let i = 0; i < position.count; i += sampleStride) sampled.push(i);

const skinRootWorld = rigged.group.getObjectByName('monster-tree-skin-root').matrixWorld.clone();

function skinnedWorld(i, target) {
  target.fromBufferAttribute(position, i);
  rigged.shell.applyBoneTransform(i, target);
  return target.applyMatrix4(rigged.shell.matrixWorld);
}

// ---------------------------------------------------------------- R0 export baseline
// The defect this build exists to fix, measured on the code that shipped it rather than asserted.
{
  const { buildRiggedModel } = entry.codec();
  const baseline = buildRiggedModel(model, stream, RIG, {});
  const bscene = new THREE.Scene();
  bscene.add(baseline.group);
  bscene.updateMatrixWorld(true);
  const bp = baseline.mesh.geometry.attributes.position;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let ratio = 0;
  const step = Math.max(1, Math.floor(bp.count / 400));
  const ratios = [];
  for (let i = 0; i + step < bp.count; i += step * 2) {
    a.fromBufferAttribute(bp, i);
    b.fromBufferAttribute(bp, i + step);
    const local = a.distanceTo(b);
    if (local < 1e-4) continue;
    baseline.mesh.applyBoneTransform(i, a.fromBufferAttribute(bp, i));
    baseline.mesh.applyBoneTransform(i + step, b.fromBufferAttribute(bp, i + step));
    a.applyMatrix4(baseline.mesh.matrixWorld);
    b.applyMatrix4(baseline.mesh.matrixWorld);
    ratios.push(a.distanceTo(b) / local);
  }
  ratios.sort((x, y) => x - y);
  ratio = ratios[Math.floor(ratios.length / 2)] ?? 0;
  const box = new THREE.Box3().setFromObject(baseline.group).getSize(new THREE.Vector3());
  report.gates.R0_exportBaseline = {
    status: 'measured',
    what: "the export's own buildRiggedModel, measured the same way as R2 below, for comparison",
    medianSkinScale: round(ratio, 5),
    expectedSkinScale: round(RIG.normalise.scale, 5),
    scaleAppliedTimes: round(Math.log(ratio) / Math.log(RIG.normalise.scale), 3),
    renderedHeight: round(box.y, 4),
    expectedHeight: round(RIG.normalise.scale * model.parts[0].bounds.max[1], 4),
  };
  baseline.mixer.stopAllAction();
}

// ---------------------------------------------------------------- R2 rest pose
// The rest pose has to be a SIMILARITY of the decoded bind-pose geometry: one uniform scale, one
// rotation, one translation, no per-vertex residual. Testing it that way is what catches a
// normalise scale that got applied twice (the ratio comes out 3.96 instead of 1.99) without
// tripping over the Tripo rig's own bind-vs-rest offset, which is a single constant translation
// (a uniform 4.43e-3 rig units on every bone) and therefore lands in the translation term.
{
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const ratios = [];
  for (let k = 0; k + 1 < sampled.length; k += 2) {
    const i = sampled[k];
    const j = sampled[k + 1];
    const local = a.fromBufferAttribute(position, i).distanceTo(b.fromBufferAttribute(position, j));
    if (local < 1e-4) continue;
    ratios.push(skinnedWorld(i, a).distanceTo(skinnedWorld(j, b)) / local);
  }
  ratios.sort((x, y) => x - y);
  const median = ratios[Math.floor(ratios.length / 2)];
  const spread = Math.max(...ratios.map((r) => Math.abs(r - median)));
  const box = new THREE.Box3().setFromObject(rigged.group);
  const size = box.getSize(new THREE.Vector3());
  const expected = RIG.normalise.scale;
  const ok = Math.abs(median - expected) < 1e-3 && spread < 1e-3;
  report.gates.R2_restPose = {
    status: ok ? 'pass' : 'fail',
    medianSkinScale: round(median, 6),
    expectedSkinScale: round(expected, 6),
    scaleAppliedTimes: round(Math.log(median) / Math.log(expected), 4),
    maxRatioSpread: round(spread, 8),
    tolerance: 1e-3,
    figureSize: [round(size.x, 4), round(size.y, 4), round(size.z, 4)],
    expectedHeight: round(expected * model.parts[0].bounds.max[1], 4),
    what: 'skinned rest pose vs decoded bind pose, as a distance ratio; a double-applied normalise scale reads 2.0 here instead of 1.0',
  };
  if (!ok) fail.push('R2');
}

// ---------------------------------------------------------------- bind-pose reference
const bindPose = new Map();
{
  const v = new THREE.Vector3();
  for (const i of sampled) bindPose.set(i, skinnedWorld(i, v).clone());
}
const costumeBind = rigged.costume.map((piece) => {
  const p = piece.mesh.geometry.attributes.position;
  const stride = Math.max(1, Math.floor(p.count / 260));
  const idx = [];
  for (let i = 0; i < p.count; i += stride) idx.push(i);
  const pairs = [];
  for (let k = 0; k < PAIR_SAMPLE && idx.length > 1; k += 1) {
    const a = idx[(k * 7 + 1) % idx.length];
    const b = idx[(k * 13 + 5) % idx.length];
    if (a !== b) pairs.push([a, b]);
  }
  // Bind-pose reference distances in WORLD space — the same space the posed samples are taken in.
  // Comparing a local-space rest distance against a world-space posed one just measures the
  // 1.9899x normalise scale and calls a perfectly rigid piece sheared.
  const world = piece.mesh.matrixWorld;
  const rest = pairs.map(([a, b]) =>
    new THREE.Vector3().fromBufferAttribute(p, a).applyMatrix4(world)
      .distanceTo(new THREE.Vector3().fromBufferAttribute(p, b).applyMatrix4(world)));
  return { piece, idx, pairs, rest, maxStrain: 0, maxSeam: 0 };
});

// The seam ring, found exactly rather than by proximity: a vertex on the cut ring was copied into
// BOTH the shell and the piece, so it appears in the two geometries at byte-identical bind-pose
// coordinates. Hashing the quantised coordinate finds those duplicates outright, which makes the
// gap below a real gap between two copies of one vertex — not a re-pairing to whatever happened to
// be nearest in the current pose.
const seamPairs = costumeBind.map(({ piece }) => {
  const key = (x, y, z) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
  const shellByKey = new Map();
  for (let i = 0; i < position.count; i += 1) {
    shellByKey.set(key(position.getX(i), position.getY(i), position.getZ(i)), i);
  }
  const cp = piece.mesh.geometry.attributes.position;
  const pairs = [];
  for (let j = 0; j < cp.count; j += 1) {
    const shell = shellByKey.get(key(cp.getX(j), cp.getY(j), cp.getZ(j)));
    if (shell !== undefined) pairs.push({ shell, piece: j });
  }
  return pairs;
});

// ---------------------------------------------------------------- R1 + R3 + R4 over every clip
const clipRows = [];
const scratch = new THREE.Vector3();
const scratchB = new THREE.Vector3();

for (const clip of rigged.clips) {
  const row = { clip: clip.name, duration: round(clip.duration, 3), tracks: clip.tracks.length };
  if (!clip.tracks.length || !(clip.duration > 0)) {
    row.status = 'unevaluated';
    row.missing = !clip.tracks.length ? 'clip carries no keyframe tracks' : 'clip duration is zero';
    clipRows.push(row);
    continue;
  }

  rigged.mixer.stopAllAction();
  const action = rigged.mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.setEffectiveWeight(1);
  action.play();

  let maxDelta = 0;
  let maxMoved = 0;
  const seeks = [];
  for (let s = 0; s < SEEK_POINTS; s += 1) {
    const t = (clip.duration * s) / (SEEK_POINTS - 1);
    action.time = Math.min(t, clip.duration - 1e-5);
    rigged.mixer.setTime(action.time);
    scene.updateMatrixWorld(true);

    let frameMax = 0;
    let moved = 0;
    for (const i of sampled) {
      const d = skinnedWorld(i, scratch).distanceTo(bindPose.get(i));
      if (d > frameMax) frameMax = d;
      if (d > 0.01) moved += 1;
    }
    maxDelta = Math.max(maxDelta, frameMax);
    maxMoved = Math.max(maxMoved, moved / sampled.length);
    seeks.push({ t: round(action.time, 3), delta: round(frameMax, 5) });

    // R3 rigid strain + R4 seam, at this same pose
    for (const entry of costumeBind) {
      const p = entry.piece.mesh.geometry.attributes.position;
      const world = entry.piece.mesh.matrixWorld;
      for (let k = 0; k < entry.pairs.length; k += 1) {
        const [a, b] = entry.pairs[k];
        scratch.fromBufferAttribute(p, a).applyMatrix4(world);
        scratchB.fromBufferAttribute(p, b).applyMatrix4(world);
        entry.maxStrain = Math.max(entry.maxStrain, Math.abs(scratch.distanceTo(scratchB) - entry.rest[k]));
      }
    }
    costumeBind.forEach((entry, pi) => {
      const p = entry.piece.mesh.geometry.attributes.position;
      const world = entry.piece.mesh.matrixWorld;
      for (const pair of seamPairs[pi]) {
        skinnedWorld(pair.shell, scratch);
        scratchB.fromBufferAttribute(p, pair.piece).applyMatrix4(world);
        entry.maxSeam = Math.max(entry.maxSeam, scratch.distanceTo(scratchB));
      }
    });
  }

  action.stop();
  row.status = maxDelta > 0.02 ? 'pass' : 'fail';
  row.maxSampledBindingDelta = round(maxDelta, 5);
  row.movingVertexFraction = round(maxMoved, 3);
  row.seeks = seeks;
  if (row.status === 'fail') row.why = 'no sampled vertex moved more than 2 cm from bind pose — the clip exists but does not drive the skin';
  clipRows.push(row);
}

report.gates.R1_bindingMotion = {
  status: clipRows.every((r) => r.status === 'pass') ? 'pass'
    : clipRows.some((r) => r.status === 'fail') ? 'fail' : 'partial',
  seekPointsPerClip: SEEK_POINTS,
  sampledVertices: sampled.length,
  sampledOf: position.count,
  maxSampledBindingDelta: round(Math.max(...clipRows.map((r) => r.maxSampledBindingDelta ?? 0)), 5),
  clips: clipRows,
  unevaluated: clipRows.filter((r) => r.status === 'unevaluated').map((r) => ({ clip: r.clip, missing: r.missing })),
};
if (clipRows.some((r) => r.status === 'fail')) fail.push('R1');

const figureHeight = new THREE.Box3().setFromObject(rigged.group).getSize(new THREE.Vector3()).y;
report.gates.R3_rigidCostume = {
  status: costumeBind.every((e) => e.maxStrain < 1e-5) ? 'pass' : 'fail',
  tolerance: 1e-5,
  what: 'largest change in any within-piece vertex-pair distance across every sampled pose of every clip. A skinned piece shears; a rigid piece cannot.',
  pieces: costumeBind.map((e) => ({
    id: e.piece.id,
    bone: e.piece.bone,
    triangles: e.piece.triangles,
    pairsMeasured: e.pairs.length,
    maxRigidStrain: round(e.maxStrain, 9),
  })),
};
if (costumeBind.some((e) => e.maxStrain >= 1e-5)) fail.push('R3');

report.gates.R4_seam = {
  status: 'measured',
  what: 'largest distance between the two copies of a shared cut-ring vertex — one skinned on the shell, one rigid on the piece — across every sampled pose',
  figureHeight: round(figureHeight, 3),
  pieces: costumeBind.map((e, i) => ({
    id: e.piece.id,
    pairsMeasured: seamPairs[i].length,
    maxSeamGap: round(e.maxSeam, 5),
    asFigureHeight: seamPairs[i].length ? `${round((e.maxSeam / figureHeight) * 100, 3)}%` : 'unevaluated',
    ...(seamPairs[i].length ? {} : { missing: 'no vertex is shared between this piece and the shell — the cut ring could not be identified' }),
  })),
};

report.summary = {
  status: fail.length ? 'FAIL' : 'PASS',
  failed: fail,
  shellTriangles: geometry.index.count / 3,
  costumeTriangles: rigged.costume.reduce((n, p) => n + p.triangles, 0),
  costumePieces: rigged.costume.length,
  clips: rigged.clips.length,
  sockets: Object.keys(rigged.sockets).length,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  print(report);
}
rmSync(bundle, { force: true });
process.exit(fail.length ? 1 : 0);

// ---------------------------------------------------------------- helpers
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }
function decodeU16(text) {
  const b = Buffer.from(text, 'base64');
  const o = new Uint16Array(b.length / 2);
  Buffer.from(o.buffer).set(b);
  return o;
}
function decodeF32(text) {
  const b = Buffer.from(text, 'base64');
  const o = new Float32Array(b.length / 4);
  Buffer.from(o.buffer).set(b);
  return o;
}
function print(r) {
  const g = r.gates;
  console.log('\nmonster-tree rig measurement\n' + '='.repeat(78));
  console.log(`\nR5 skin integrity            ${g.R5_skinIntegrity.status.toUpperCase()}`);
  console.log(`   ${g.R5_skinIntegrity.bones} bones, ${g.R5_skinIntegrity.vertices} vertices, max bone index ${g.R5_skinIntegrity.maxBoneIndex}`);
  console.log(`   max weight-sum error ${g.R5_skinIntegrity.maxWeightSumError}, ${g.R5_skinIntegrity.levelsOfDetail} LOD (${g.R5_skinIntegrity.lodNote})`);

  const b = g.R0_exportBaseline;
  console.log(`\nR0 export baseline           MEASURED  (the playground's own buildRiggedModel)`);
  console.log(`   median skin scale ${b.medianSkinScale} vs expected ${b.expectedSkinScale} — normalise scale applied ${b.scaleAppliedTimes}x`);
  console.log(`   rendered height ${b.renderedHeight} vs expected ${b.expectedHeight}`);

  console.log(`\nR2 rest pose                 ${g.R2_restPose.status.toUpperCase()}`);
  console.log(`   median skin scale ${g.R2_restPose.medianSkinScale} vs expected ${g.R2_restPose.expectedSkinScale} — applied ${g.R2_restPose.scaleAppliedTimes}x`);
  console.log(`   max ratio spread ${g.R2_restPose.maxRatioSpread} (tolerance ${g.R2_restPose.tolerance})`);
  console.log(`   figure ${g.R2_restPose.figureSize.join(' x ')}, expected height ${g.R2_restPose.expectedHeight}`);

  console.log(`\nR1 binding motion            ${g.R1_bindingMotion.status.toUpperCase()}`);
  console.log(`   ${g.R1_bindingMotion.seekPointsPerClip} seeks/clip, ${g.R1_bindingMotion.sampledVertices} of ${g.R1_bindingMotion.sampledOf} vertices sampled`);
  console.log(`   maxSampledBindingDelta ${g.R1_bindingMotion.maxSampledBindingDelta}`);
  console.log(`   ${'clip'.padEnd(32)} ${'dur'.padStart(6)} ${'delta'.padStart(8)} ${'moving'.padStart(7)}  status`);
  for (const c of g.R1_bindingMotion.clips) {
    console.log(`   ${c.clip.padEnd(32)} ${String(c.duration).padStart(6)} ${String(c.maxSampledBindingDelta ?? '-').padStart(8)} ${String(c.movingVertexFraction ?? '-').padStart(7)}  ${c.status}${c.missing ? ` (${c.missing})` : ''}${c.why ? ` — ${c.why}` : ''}`);
  }

  console.log(`\nR3 rigid costume             ${g.R3_rigidCostume.status.toUpperCase()}`);
  console.log(`   ${g.R3_rigidCostume.what}`);
  for (const p of g.R3_rigidCostume.pieces) {
    console.log(`   ${p.id.padEnd(10)} -> ${p.bone.padEnd(12)} ${String(p.triangles).padStart(5)} tris  ${p.pairsMeasured} pairs  maxRigidStrain ${p.maxRigidStrain}`);
  }

  console.log(`\nR4 seam                      MEASURED`);
  for (const p of g.R4_seam.pieces) {
    console.log(`   ${p.id.padEnd(10)} ${String(p.pairsMeasured).padStart(4)} pairs  maxSeamGap ${String(p.maxSeamGap).padStart(8)}  ${p.asFigureHeight}${p.missing ? `  (${p.missing})` : ''}`);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`summary  ${r.summary.status}   shell ${r.summary.shellTriangles} tris + costume ${r.summary.costumeTriangles} tris in ${r.summary.costumePieces} rigid pieces`);
  console.log(`         ${r.summary.clips} clips, ${r.summary.sockets} sockets${r.summary.failed.length ? `, failed: ${r.summary.failed.join(', ')}` : ''}\n`);
}
