#!/usr/bin/env node

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const helperPath = resolve(
  ROOT,
  'src/demos/vijay-ghume-mini-dragon-character/createRiggedDragon.ts',
);
const tempDir = await mkdtemp(join(tmpdir(), 'dragon-rig-check-'));
const bundlePath = join(tempDir, 'verify.mjs');

const entry = `
  import * as THREE from 'three';
  import { createRiggedDragon } from ${JSON.stringify(helperPath)};

  const make = () => new THREE.MeshPhysicalMaterial();
  const materials = {
    body: make(),
    bodyDark: make(),
    innerEar: make(),
    muzzle: make(),
    horn: make(),
    membrane: make(),
    gold: make(),
    cuff: make(),
    strap: make(),
    cloth: make(),
    eye: make(),
    pupil: make(),
    ivory: make(),
  };

  const started = performance.now();
  const { root, runtime } = createRiggedDragon(materials);
  root.updateMatrixWorld(true);
  runtime.skeleton.update();
  const constructionMs = performance.now() - started;

  const body = runtime.body;
  if (!body.isSkinnedMesh) throw new Error('body is not a SkinnedMesh');
  if (body.skeleton !== runtime.skeleton) throw new Error('body is not bound to runtime skeleton');
  if (runtime.skeleton.bones.length < 24) throw new Error('skeleton is missing required articulation');

  const position = body.geometry.getAttribute('position');
  const skinIndex = body.geometry.getAttribute('skinIndex');
  const skinWeight = body.geometry.getAttribute('skinWeight');
  if (!position || !skinIndex || !skinWeight) throw new Error('body skin attributes are incomplete');
  if (skinIndex.itemSize !== 4 || skinWeight.itemSize !== 4) {
    throw new Error('skin attributes must provide four influences');
  }
  if (position.count !== skinIndex.count || position.count !== skinWeight.count) {
    throw new Error('skin attribute counts do not match position count');
  }

  let maxWeightError = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    let sum = 0;
    for (let slot = 0; slot < 4; slot++) {
      const index = skinIndex.getComponent(vertex, slot);
      const weight = skinWeight.getComponent(vertex, slot);
      if (!Number.isInteger(index) || index < 0 || index >= runtime.skeleton.bones.length) {
        throw new Error('invalid bone index at vertex ' + vertex);
      }
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error('invalid skin weight at vertex ' + vertex);
      }
      sum += weight;
    }
    maxWeightError = Math.max(maxWeightError, Math.abs(1 - sum));
  }
  if (maxWeightError > 1e-5) throw new Error('skin weights are not normalized');

  const index = body.geometry.index;
  if (!index) throw new Error('continuous body must be indexed after welding');
  const edges = new Map();
  for (let offset = 0; offset < index.count; offset += 3) {
    const triangle = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge];
      const b = triangle[(edge + 1) % 3];
      const key = a < b ? a + ':' + b : b + ':' + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const boundaryEdges = [...edges.values()].filter((count) => count === 1).length;
  const nonManifoldEdges = [...edges.values()].filter((count) => count > 2).length;
  if (boundaryEdges !== 0 || nonManifoldEdges !== 0) {
    throw new Error(
      'body topology is not closed manifold: boundary='
        + boundaryEdges
        + ', nonManifold='
        + nonManifoldEdges,
    );
  }

  const wingMeshes = [
    runtime.meshes['wing-l-membrane'],
    runtime.meshes['wing-r-membrane'],
  ];
  for (const wing of wingMeshes) {
    if (!wing?.isSkinnedMesh) throw new Error('wing membrane is not skinned');
    const triangles = wing.geometry.index.count / 3;
    if (triangles < 500) throw new Error('wing membrane is under-subdivided');
  }

  const requiredBoneOwned = [
    'lower-jaw',
    'wing-l-leading-spar',
    'wing-r-leading-spar',
    'cuff-l',
    'cuff-r',
    'hoof-l',
    'hoof-r',
    'tail-gold-ring',
    'tail-arrowhead',
  ];
  for (const name of requiredBoneOwned) {
    const mesh = runtime.meshes[name];
    if (!mesh || !mesh.parent?.isBone) throw new Error(name + ' is not owned by a bone');
  }

  const sample = Math.floor(position.count * 0.72);
  const before = body.applyBoneTransform(
    sample,
    new THREE.Vector3().fromBufferAttribute(position, sample),
  ).clone();
  runtime.bones.forearmL.rotation.z += 0.42;
  runtime.bones.wingRootL.rotation.z += 0.2;
  runtime.bones.tail3.rotation.z -= 0.25;
  root.updateMatrixWorld(true);
  runtime.skeleton.update();
  const after = body.applyBoneTransform(
    sample,
    new THREE.Vector3().fromBufferAttribute(position, sample),
  );
  const sampleDelta = before.distanceTo(after);

  const result = {
    constructionMs: Number(constructionMs.toFixed(1)),
    bodyVertices: position.count,
    bodyTriangles: index.count / 3,
    bones: runtime.skeleton.bones.length,
    boundaryEdges,
    nonManifoldEdges,
    maxWeightError,
    wingTriangles: wingMeshes.map((wing) => wing.geometry.index.count / 3),
    sampleDeformationDelta: Number(sampleDelta.toFixed(5)),
    boneOwnedParts: requiredBoneOwned.length,
  };
  console.log(JSON.stringify(result, null, 2));
`;

try {
  await build({
    stdin: {
      contents: entry,
      loader: 'ts',
      resolveDir: ROOT,
      sourcefile: 'verify-dragon-rig.ts',
    },
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
