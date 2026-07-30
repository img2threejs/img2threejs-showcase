#!/usr/bin/env node
// Milestone 0 rig kill test — executes an EMITTED rig module (produced by
// forge/stage5_rig/emit_rig.py from a hand-written RigSpec) with this repo's
// real `three`, and reports MEASURED numbers read off the executed geometry.
//
// This script does not decide pass/fail against the milestone's gate
// thresholds — forge/tests/test_rig_milestone0.py does that, so the actual
// number always comes from execution, never from a hand-computed expectation
// baked into either file. This script's job is: build it for real, or fail
// loudly and exit non-zero.
//
// Modeled on scripts/verify-dragon-rig.mjs (esbuild-bundle a standalone
// entry, then dynamic-import it), generalized to take the target module path
// as an argument instead of hardcoding the dragon file.
//
// Usage:
//   node scripts/rig-milestone0.mjs <path-to-emitted-rig.ts> [--out <json-path>]

import { build } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { perpendicularDistanceFromAxis } from './rig-milestone0-axis.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function fail(reason) {
  console.error(`rig-milestone0: FAIL (execution) — ${reason}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let outPath = null;
const outFlagIndex = args.indexOf('--out');
if (outFlagIndex !== -1) outPath = args[outFlagIndex + 1];

// --self-check: exercises gate (b)'s axis-exemption predicate against a
// small SYNTHETIC rig built inline here (not the emitted-RigSpec capsule),
// so both sides of the AXIS_EPSILON boundary can be pinned without
// perturbing RING_RESOLUTION_DIVISOR / N / the derived tessellation to
// force a real capsule vertex onto the exact pivot. Calls the SAME
// perpendicularDistanceFromAxis() the real gate (b) path uses (imported
// above, not reimplemented) — see forge/tests/test_rig_milestone0.py for
// the assertions against this mode's JSON output.
if (args.includes('--self-check')) {
  const AXIS_EPSILON = 1e-6; // must match the value used in the main gate (b) path below

  const root = new THREE.Bone();
  root.name = 'root';
  root.position.set(0, 0, 0);
  const hinge = new THREE.Bone();
  hinge.name = 'hinge';
  hinge.position.set(0, -1, 0);
  root.add(hinge);

  // Four cases. All weighted 100% to `hinge` so all four are "influenced"
  // under the same definition gate (b) itself uses.
  //   on-axis                  -- at the pivot itself
  //   on-axis-offset-along-axis -- 0.5 along the hinge's local +X (the axis
  //     direction) from the pivot, with ZERO perpendicular offset. This is
  //     the strongest case: it is what distinguishes a correct
  //     implementation (measuring distance from the axis LINE, which is
  //     fixed everywhere along its length) from the plausible wrong one
  //     (measuring distance from the pivot POINT, which would wrongly flag
  //     this vertex as off-axis). Folded in from the now-deleted
  //     rig-milestone0-axis-exemption.test.mjs per team-lead's review.
  //   inside-epsilon / outside-epsilon -- pin the AXIS_EPSILON boundary in
  //     both directions, 10x on each side rather than at a hairline float32
  //     boundary.
  const cases = [
    { label: 'on-axis', offset: [0, 0, 0] },
    { label: 'on-axis-offset-along-axis', offset: [0.5, 0, 0] },
    { label: 'inside-epsilon', offset: [0, 0, 5e-7] },
    { label: 'outside-epsilon', offset: [0, 0, 2e-6] },
  ];
  const positions = new Float32Array(cases.flatMap(({ offset }) => [offset[0], -1 + offset[1], offset[2]]));
  const skinIndices = new Uint16Array(cases.flatMap(() => [1, 0, 0, 0]));
  const skinWeights = new Float32Array(cases.flatMap(() => [1, 0, 0, 0]));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.add(root);
  const skeleton = new THREE.Skeleton([root, hinge]);
  mesh.bindMode = THREE.AttachedBindMode;
  mesh.bind(skeleton);
  mesh.updateMatrixWorld(true);
  skeleton.update();

  const position = geometry.getAttribute('position');
  const axisPivot = new THREE.Vector3().setFromMatrixPosition(hinge.matrixWorld);
  const axisDir = new THREE.Vector3().setFromMatrixColumn(hinge.matrixWorld, 0).normalize();
  const distances = cases.map((_, i) =>
    perpendicularDistanceFromAxis(new THREE.Vector3().fromBufferAttribute(position, i), axisPivot, axisDir),
  );
  const before = cases.map((_, i) =>
    mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(position, i)).clone(),
  );
  hinge.rotation.x += Math.PI / 2; // same convention as the main gate (b) pose sweep
  mesh.updateMatrixWorld(true);
  skeleton.update();
  const after = cases.map((_, i) =>
    mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(position, i)).clone(),
  );

  const result = {
    axisEpsilon: AXIS_EPSILON,
    cases: cases.map(({ label }, i) => ({
      label,
      distanceFromAxis: distances[i],
      exempt: distances[i] <= AXIS_EPSILON,
      displacement: before[i].distanceTo(after[i]),
    })),
  };
  const output = JSON.stringify(result);
  console.log(output);
  if (outPath) await writeFile(resolve(outPath), output, 'utf8');
  process.exit(0);
}

const entryArg = args[0];
if (!entryArg) {
  fail('missing required argument: path to an emitted rig .ts module (or pass --self-check)');
}
const entryPath = resolve(entryArg);
if (!existsSync(entryPath)) {
  fail(`emitted rig module not found at ${entryPath}`);
}

const tempDir = await mkdtemp(join(tmpdir(), 'rig-milestone0-'));
const bundlePath = join(tempDir, 'run.mjs');

// The emitted module is generated by forge/stage5_rig/emit_rig.py into a
// session-scratchpad temp path OUTSIDE this repo, so it has no node_modules
// ancestry of its own for a bare `import ... from 'three'` to resolve
// against. Rather than importing it by path (which esbuild would resolve
// relative to ITS OWN directory, not this repo's), its source text is
// concatenated directly into this single stdin entry, which esbuild bundles
// with `resolveDir: ROOT` — the same trick verify-dragon-rig.mjs uses, just
// applied to inlined text instead of a same-repo file path. The emitted
// module's own `import * as THREE from 'three'` line is what resolves here;
// this harness must not re-import THREE or re-declare it.
const emittedSource = await readFile(entryPath, 'utf8');

const entry = `
${emittedSource}

  import { perpendicularDistanceFromAxis } from './scripts/rig-milestone0-axis.mjs';

  const started = performance.now();
  const { mesh, skeleton, bones, meta } = createRigMilestone0();
  if (!mesh?.isSkinnedMesh) throw new Error('emitted factory did not return a SkinnedMesh');
  if (mesh.skeleton !== skeleton) throw new Error('mesh is not bound to the returned skeleton');
  mesh.updateMatrixWorld(true);
  skeleton.update();
  const constructionMs = performance.now() - started;

  const position = mesh.geometry.getAttribute('position');
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const index = mesh.geometry.index;
  if (!position || !skinIndex || !skinWeight) throw new Error('emitted geometry is missing skin attributes');
  if (!index) throw new Error('emitted geometry is not indexed');
  if (skinIndex.itemSize !== 4 || skinWeight.itemSize !== 4) throw new Error('skin attributes must be itemSize 4');

  // ---- structural sanity (fail closed, not a measured gate) ----
  for (let vertex = 0; vertex < position.count; vertex++) {
    for (let slot = 0; slot < 4; slot++) {
      const boneIdx = skinIndex.getComponent(vertex, slot);
      const weight = skinWeight.getComponent(vertex, slot);
      if (!Number.isInteger(boneIdx) || boneIdx < 0 || boneIdx >= skeleton.bones.length) {
        throw new Error('invalid bone index at vertex ' + vertex + ' slot ' + slot + ': ' + boneIdx);
      }
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error('invalid skin weight at vertex ' + vertex + ' slot ' + slot + ': ' + weight);
      }
    }
  }

  // ---- gate (a) measurement: max |sum(skinWeight) - 1| across all vertices ----
  let maxWeightError = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    let sum = 0;
    for (let slot = 0; slot < 4; slot++) sum += skinWeight.getComponent(vertex, slot);
    maxWeightError = Math.max(maxWeightError, Math.abs(1 - sum));
  }

  // ---- gate (d) measurement: boundary / non-manifold edges after bind ----
  const edgeCounts = new Map();
  for (let offset = 0; offset < index.count; offset += 3) {
    const tri = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? a + ':' + b : b + ':' + a;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  const boundaryEdges = [...edgeCounts.values()].filter((c) => c === 1).length;
  const nonManifoldEdges = [...edgeCounts.values()].filter((c) => c > 2).length;

  // ---- gate (c) measurement: no vertex leaves its (derived) envelope ----
  // For every (vertex, bone) pair the vertex was actually assigned nonzero
  // weight to, its distance to that bone's segment must not exceed the
  // envelope radius R_b that was derived (not proposed) for that bone —
  // except for vertices where the zero-sum nearest-bone fallback fired,
  // which is explicitly allowed to sit outside R_b by PLAN_1.5 §4 / ADR-8.
  // Reuses the emitted module's OWN distanceToSegment/closestPointOnSegment
  // (module-scope, in view here because this harness is concatenated into
  // the same stdin entry as the emitted source — see the note above) rather
  // than a second hand-written copy, so the envelope gate measures against
  // the exact same distance calculation the weight function itself used.
  const fallbackSet = new Set(meta.fallbackVertices);
  const point = new THREE.Vector3();
  const boneNames = skeleton.bones.map((b) => b.name);
  let envelopeViolations = 0;
  let envelopeChecked = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (fallbackSet.has(vertex)) continue;
    point.fromBufferAttribute(position, vertex);
    for (let slot = 0; slot < 4; slot++) {
      const weight = skinWeight.getComponent(vertex, slot);
      if (weight <= 0) continue;
      const boneName = boneNames[skinIndex.getComponent(vertex, slot)];
      const d = distanceToSegment(point, meta.jointPos[boneName], meta.tipPos[boneName]);
      const r = meta.envelopeRadius[boneName];
      envelopeChecked++;
      if (d > r + 1e-6) envelopeViolations++;
    }
  }

  // ---- gate (b) measurement: pose-sweep deformation delta on the elbow's
  // influenced region (every vertex with nonzero weight on the 'elbow' bone) ----
  //
  // PREDICATE (team-lead decision, not this script's call): a point exactly
  // ON the rotation axis is fixed by the rotation, and also fixed by every
  // OTHER bone's transform if that bone didn't move — so a convex blend of
  // transforms that each fix the point also fixes it. Zero displacement
  // there is correct linear-blend skinning, not a defect. The gate therefore
  // exempts vertices within epsilon of the rotation axis from the ">0"
  // check, but the exemption is reported (axisExemptVertexCount), and an
  // exemption that swallows every influenced vertex is itself a FAIL
  // (checked in forge/tests/test_rig_milestone0.py).
  if (!bones.elbow) throw new Error("expected a bone named 'elbow' for the pose sweep");
  const elbowIndex = boneNames.indexOf('elbow');
  const influencedVertices = [];
  for (let vertex = 0; vertex < position.count; vertex++) {
    for (let slot = 0; slot < 4; slot++) {
      if (skinIndex.getComponent(vertex, slot) === elbowIndex && skinWeight.getComponent(vertex, slot) > 0) {
        influencedVertices.push(vertex);
        break;
      }
    }
  }
  if (influencedVertices.length === 0) throw new Error("no vertex has nonzero weight on 'elbow' — cannot pose-sweep");

  // Rotation axis, captured BEFORE the pose change: the elbow bone's own
  // local +X axis, in world space, passing through the elbow's world
  // position at bind pose. The axis itself does not move when the elbow
  // rotates about it (a bone always rotates about its own local axis), so
  // capturing it before or after the increment is equivalent; before is
  // used since it's already the "bind pose" moment other measurements use.
  const AXIS_EPSILON = 1e-6;
  const axisPivot = new THREE.Vector3().setFromMatrixPosition(bones.elbow.matrixWorld);
  const axisDir = new THREE.Vector3().setFromMatrixColumn(bones.elbow.matrixWorld, 0).normalize();
  const axisDistances = influencedVertices.map((v) =>
    perpendicularDistanceFromAxis(new THREE.Vector3().fromBufferAttribute(position, v), axisPivot, axisDir)
  );

  const before = influencedVertices.map((v) =>
    mesh.applyBoneTransform(v, new THREE.Vector3().fromBufferAttribute(position, v)).clone()
  );
  bones.elbow.rotation.x += Math.PI / 2; // 0 -> 90 degrees, hinge on local X
  mesh.updateMatrixWorld(true);
  skeleton.update();
  const after = influencedVertices.map((v) =>
    mesh.applyBoneTransform(v, new THREE.Vector3().fromBufferAttribute(position, v)).clone()
  );
  const deltas = before.map((b, i) => b.distanceTo(after[i]));

  const axisExemptMask = axisDistances.map((d) => d <= AXIS_EPSILON);
  const axisExemptVertexCount = axisExemptMask.filter(Boolean).length;
  const nonExemptDeltas = deltas.filter((_, i) => !axisExemptMask[i]);
  const minInfluencedDeformationDelta = nonExemptDeltas.length > 0 ? Math.min(...nonExemptDeltas) : null;
  const maxInfluencedDeformationDelta = deltas.length > 0 ? Math.max(...deltas) : null;
  const zeroDeltaVertices = influencedVertices.filter((_, i) => !axisExemptMask[i] && deltas[i] === 0);

  // Report-only (not gated): rank correlation (Spearman) between per-vertex
  // displacement and perpendicular distance from the rotation axis. Should
  // be strongly positive for correct skinning; not turned into a gate here
  // because "strongly" has no calibrated threshold yet.
  function spearmanRankCorrelation(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const rank = (values) => {
      const sorted = values.map((value, i) => [value, i]).sort((a, b) => a[0] - b[0]);
      const ranks = new Array(n);
      let i = 0;
      while (i < n) {
        let j = i;
        while (j + 1 < n && sorted[j + 1][0] === sorted[i][0]) j++;
        const avgRank = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[sorted[k][1]] = avgRank;
        i = j + 1;
      }
      return ranks;
    };
    const rx = rank(xs);
    const ry = rank(ys);
    const meanRx = rx.reduce((s, v) => s + v, 0) / n;
    const meanRy = ry.reduce((s, v) => s + v, 0) / n;
    let cov = 0, varX = 0, varY = 0;
    for (let i = 0; i < n; i++) {
      const dx = rx[i] - meanRx;
      const dy = ry[i] - meanRy;
      cov += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }
    if (varX === 0 || varY === 0) return null;
    return cov / Math.sqrt(varX * varY);
  }
  const displacementVsAxisDistanceSpearman = spearmanRankCorrelation(axisDistances, deltas);

  const result = {
    constructionMs: Number(constructionMs.toFixed(3)),
    vertices: position.count,
    triangles: index.count / 3,
    bones: skeleton.bones.length,
    maxWeightError,
    boundaryEdges,
    nonManifoldEdges,
    envelopeViolations,
    envelopeChecked,
    fallbackVertexCount: meta.fallbackVertices.length,
    influencedVertexCount: influencedVertices.length,
    axisExemptVertexCount,
    axisEpsilon: AXIS_EPSILON,
    minInfluencedDeformationDelta,
    maxInfluencedDeformationDelta,
    zeroDeltaVertexCount: zeroDeltaVertices.length,
    displacementVsAxisDistanceSpearman,
    envelopeRadius: meta.envelopeRadius,
  };
  console.log(JSON.stringify(result));
`;

try {
  await build({
    stdin: {
      contents: entry,
      loader: 'ts',
      resolveDir: ROOT,
      sourcefile: 'rig-milestone0-run.ts',
    },
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
} catch (err) {
  fail(`esbuild could not bundle the emitted rig module — ${err?.message ?? err}`);
}

let stdoutCapture = '';
const originalLog = console.log;
console.log = (...logArgs) => {
  stdoutCapture += logArgs.join(' ');
  originalLog(...logArgs);
};

try {
  await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
} catch (err) {
  fail(`emitted rig module failed to execute — ${err?.stack ?? err}`);
} finally {
  console.log = originalLog;
  await rm(tempDir, { recursive: true, force: true });
}

if (outPath) {
  await writeFile(resolve(outPath), stdoutCapture, 'utf8');
}
