#!/usr/bin/env node
// Parity verifier for the force-measured tropical-island surfaces.
//
// Compares, per role:
//   1. The bundled TS decoder's numeric output (after awaiting
//      preloadMeasuredProps + the per-role loadRoleBytes)
//   2. The committed summary JSON (measured values + hashes recorded at encode time)
//   3. An independently re-decoded GLB measurement (sha / bytes / vertex count /
//      triangle count / bounds / indices / material / node transforms)
//   4. An independent Pillow re-sampling of every per-vertex colour byte, every
//      per-triangle class byte (for campfire / palm), every ORM-sampled map median,
//      and the lamp glass bounds AABB.
//
// The hashes in #1 and #2 are taken over the encoded stream sections (u16 / oct
// / sRGB / varint), so a re-encode-and-decode round-trip self-comparison would
// be a guaranteed pass; this verifier hashes against the recorded values and
// the per-vertex/per-triangle bytes are checked independently of the encoder.
//
// The runtime payload is now a gzip-compressed, <=192 KiB-segmented blob under
// measured/chunks/. The data_ROLE modules are loaded via the runtime's
// preloadMeasuredProps(); the bytes used here come from the awaited
// loadRoleBytes() — the canonical stream the decoder ultimately sees.
//
// Usage:
//   node pipelines/tropical-island/verify-surfaces.mjs [--source-dir DIR]
//
// Final source archive: work/tropical-island/reference-models/ (gitignored).
// Override with --source-dir if the archive is checked out elsewhere.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import esbuild from 'esbuild';
import { Matrix4, Quaternion, Vector3 } from 'three';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..', '..');
const DEFAULT_SOURCE = resolve(REPO, 'work/tropical-island/reference-models');
const MEASURED_DIR = resolve(REPO, 'src/demos/tropical-island/measured');
const SUMMARY_PATH = resolve(REPO, 'pipelines/tropical-island/measured-surfaces.json');
const WORK_TMP = resolve(REPO, 'work/tropical-island/force-measured/.verify-tmp');

const ROLES = ['house', 'palm', 'dock', 'boat', 'rocks', 'redRock', 'crate', 'barrel', 'campfire', 'lamp'];
const GLB_NAMES = {
  house: 'house.glb', palm: 'palm.glb', dock: 'dock.glb', boat: 'boat.glb', rocks: 'rocks.glb',
  redRock: 'red-rock.glb', crate: 'crate.glb', barrel: 'barrel.glb', campfire: 'campfire.glb', lamp: 'lamp.glb',
};

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--source-dir' && i + 1 < argv.length) {
      args.source = resolve(argv[i + 1]); i += 1;
    }
  }
  return args;
}

// ----- assertions -----

class CheckFailed extends Error { constructor(m) { super(m); this.name = 'CheckFailed'; } }

function isFiniteNumber(x) { return typeof x === 'number' && Number.isFinite(x); }


function assertClose(label, actual, expected, tol) {
  if (!isFiniteNumber(actual)) throw new CheckFailed(`${label}: actual is non-finite (${actual})`);
  if (!isFiniteNumber(expected)) throw new CheckFailed(`${label}: expected is non-finite (${expected})`);
  const d = Math.abs(actual - expected);
  if (d > tol) throw new CheckFailed(`${label}: |${actual} - ${expected}| = ${d} > ${tol}`);
}

function assertVecClose(label, actual, expected, tol) {
  if (actual.length !== expected.length) throw new CheckFailed(`${label}: length ${actual.length} != ${expected.length}`);
  for (let i = 0; i < actual.length; i += 1) assertClose(`${label}[${i}]`, actual[i], expected[i], tol);
}

function assertExact(label, actual, expected) {
  if (actual !== expected) throw new CheckFailed(`${label}: ${actual} !== ${expected}`);
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

// ----- independent GLB decode -----

function decodeGLB(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('not a GLB');
  const version = buffer.readUInt32LE(4);
  if (version !== 2) throw new Error('unsupported GLB version');
  let pos = 12; let json = ''; let bin = null;
  while (pos < buffer.length) {
    const cl = buffer.readUInt32LE(pos);
    const ct = buffer.readUInt32LE(pos + 4);
    const payload = buffer.subarray(pos + 8, pos + 8 + cl);
    if (ct === 0x4E4F534A) json = payload.toString('utf-8');
    else if (ct === 0x004E4942) bin = payload;
    pos += 8 + cl;
  }
  if (!bin) throw new Error('GLB missing BIN chunk');
  return { gltf: JSON.parse(json), bin };
}

function measureGLB(role, sourceDir) {
  const buf = readFileSync(join(sourceDir, GLB_NAMES[role]));
  const { gltf, bin } = decodeGLB(buf);
  const prim = gltf.meshes[0].primitives[0];
  const posAcc = gltf.accessors[prim.attributes.POSITION];
  const nrmAcc = gltf.accessors[prim.attributes.NORMAL];
  const idxAcc = gltf.accessors[prim.indices];
  const mat = gltf.materials[prim.material];
  const pbr = mat.pbrMetallicRoughness || {};
  const roots = gltf.scenes[gltf.scene ?? 0].nodes;
  assertExact(`${role} scene root count`, roots.length, 1);
  const nodeChain = [], visited = new Set();
  const world = new Matrix4();
  let nodeIndex = roots[0];
  while (nodeIndex !== undefined) {
    if (visited.has(nodeIndex)) throw new CheckFailed(`${role} cyclic source hierarchy`);
    visited.add(nodeIndex);
    const node = gltf.nodes[nodeIndex];
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3().fromArray(node.translation ?? [0, 0, 0]),
      new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
      new Vector3().fromArray(node.scale ?? [1, 1, 1]),
    );
    world.multiply(local);
    nodeChain.push({ name: node.name ?? null, matrix: local.toArray(), isMeshNode: node.mesh !== undefined });
    if (node.mesh !== undefined) {
      assertExact(`${role} source mesh index`, node.mesh, 0);
      assertExact(`${role} mesh-node child count`, node.children?.length ?? 0, 0);
      break;
    }
    assertExact(`${role} source chain child count`, node.children?.length, 1);
    nodeIndex = node.children[0];
  }
  assertExact(`${role} source node count`, visited.size, gltf.nodes.length);
  return {
    role, sha: sha256(buf), bytes: buf.length,
    vertexCount: posAcc.count, triangleCount: idxAcc.count / 3,
    positions: readInterleaved(bin, gltf, posAcc, 3),
    normals: readInterleaved(bin, gltf, nrmAcc, 3),
    indices: readIndices(bin, gltf, idxAcc),
    bounds: { min: posAcc.min, max: posAcc.max, extent: posAcc.max.map((m, i) => m - posAcc.min[i]) },
    nodeChain, meshNodeWorldMatrix: world.toArray(),
    meshName: gltf.meshes[0].name ?? null, materialName: mat.name ?? null,
    baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
    roughnessFactor: pbr.roughnessFactor ?? 1,
    metalnessFactor: pbr.metallicFactor ?? 1,
    alphaMode: mat.alphaMode ?? 'OPAQUE',
    alphaCutoff: mat.alphaCutoff ?? 0.5,
    doubleSided: !!mat.doubleSided,
    emissiveFactor: mat.emissiveFactor ?? [0, 0, 0],
  };
}

function readInterleaved(bin, gltf, accessor, dims) {
  const bv = gltf.bufferViews[accessor.bufferView];
  const stride = bv.byteStride ?? dims * 4;
  const off = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const n = accessor.count;
  const out = new Float32Array(n * dims);
  for (let i = 0; i < n; i += 1) for (let d = 0; d < dims; d += 1) out[i * dims + d] = bin.readFloatLE(off + i * stride + d * 4);
  return out;
}

function readIndices(bin, gltf, accessor) {
  const bv = gltf.bufferViews[accessor.bufferView];
  const off = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = bin.subarray(off);
  if (accessor.componentType === 5125) {
    const out = new Uint32Array(accessor.count);
    for (let i = 0; i < accessor.count; i += 1) out[i] = view.readUInt32LE(i * 4);
    return out;
  }
  if (accessor.componentType === 5123) {
    const out = new Uint32Array(accessor.count);
    for (let i = 0; i < accessor.count; i += 1) out[i] = view.readUInt16LE(i * 2);
    return out;
  }
  throw new Error('unsupported index type');
}

// ----- bundle -----

async function buildBundle() {
  mkdirSync(WORK_TMP, { recursive: true });
  const tmp = mkdtempSync(join(WORK_TMP, 'verify-'));
  try {
    const entry = join(tmp, 'entry.mjs');
    const reExports = ROLES.map(r =>
      `export * as ${r} from ${JSON.stringify(join(MEASURED_DIR, 'data_' + r + '.ts'))};`);
    reExports.push(`export { preloadMeasuredProps, createMeasuredProp } from ${JSON.stringify(join(MEASURED_DIR, 'props.ts'))};`);
    writeFileSync(entry, reExports.join('\n') + '\n');
    const out = join(tmp, 'bundle.mjs');
    await esbuild.build({
      entryPoints: [entry], outfile: out, bundle: true, platform: 'node',
      format: 'esm', target: 'es2020', logLevel: 'warning', external: ['three'],
    });
    return await import(pathToFileURL(out).href);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ----- helpers -----


// The runtime exposes `loadRoleBytes()` which returns the canonical
// decompressed stream after the chunk -> base64 -> gzip pipeline has run.
// The verifier uses it directly to hash the stream sections against the
// recorded codecHashes.* values without re-running the encoder.
async function readCanonicalStreamFromChunks(bundle, role) {
  const data = bundle[role];
  if (data && typeof data.loadRoleBytes === 'function') {
    return Buffer.from(await data.loadRoleBytes());
  }
  throw new Error(`${role}: no loadRoleBytes in bundle (legacy surfaceBase64 not supported)`);
}

// ----- per-role gate -----

async function verifyRole(role, bundle, independent, summary, args) {
  // 1) GLB identity (independent measurement)
  if (independent.sha !== summary.sourceSha256) {
    throw new CheckFailed(`${role}: GLB sha256 drifted (${independent.sha} vs ${summary.sourceSha256}). Re-run encode-surfaces.py.`);
  }
  if (independent.bytes !== summary.sourceBytes) {
    throw new CheckFailed(`${role}: GLB byte count drifted (${independent.bytes} vs ${summary.sourceBytes}).`);
  }
  if (independent.vertexCount !== summary.sourceVertexCount) {
    throw new CheckFailed(`${role}: source vertex count drift (${summary.sourceVertexCount} -> ${independent.vertexCount})`);
  }
  if (independent.triangleCount !== summary.sourceTriangleCount) {
    throw new CheckFailed(`${role}: source triangle count drift (${summary.sourceTriangleCount} -> ${independent.triangleCount})`);
  }
  assertVecClose(`${role} sourceBounds.min`, summary.sourceBounds.min, independent.bounds.min, 1e-6);
  assertVecClose(`${role} sourceBounds.max`, summary.sourceBounds.max, independent.bounds.max, 1e-6);

  // 2) Bundled TS data is current
  const data = bundle[role];
  if (!data) throw new CheckFailed(`${role}: missing bundle entry`);
  assertExact(`${role} data sourceSha256`, data.surfaceMeta.sourceSha256, summary.sourceSha256);
  assertExact(`${role} data sourceBytes`, data.surfaceMeta.sourceBytes, summary.sourceBytes);
  assertExact(`${role} data vertexCount`, data.surfaceMeta.vertexCount, summary.sourceVertexCount);
  assertExact(`${role} data triangleCount`, data.surfaceMeta.triangleCount, summary.sourceTriangleCount);

  // 3) Decode the codec stream.
  const decoded = data.decodeRoleSurface();
  if (decoded.position.length !== summary.sourceVertexCount * 3) {
    throw new CheckFailed(`${role} decoded.position length ${decoded.position.length} vs expected ${summary.sourceVertexCount * 3}`);
  }
  if (decoded.normal.length !== summary.sourceVertexCount * 3) {
    throw new CheckFailed(`${role} decoded.normal length`);
  }
  if (decoded.colour.length !== summary.sourceVertexCount * 3) {
    throw new CheckFailed(`${role} decoded.colour length`);
  }
  if (decoded.index.length !== summary.sourceTriangleCount * 3) {
    throw new CheckFailed(`${role} decoded.index length`);
  }

  // 4) Hash the encoded stream sections and compare to recorded hashes. The
  // canonical stream is reached via the runtime's loadRoleBytes(): it returns
  // the decompressed Uint8Array after the chunk -> base64 -> gzip pipeline
  // runs. A re-encode/decode self-roundtrip is NOT a pass: the recorded
  // hashes come from a different file (the JSON).
  const streamBytes = await readCanonicalStreamFromChunks(bundle, role);
  const sizes = data.surfaceMeta.bytes;
  const total = sizes[0] + sizes[1] + sizes[2] + sizes[3];
  if (total !== streamBytes.length) {
    throw new CheckFailed(`${role} stream length ${streamBytes.length} != sum of section sizes ${total}`);
  }
  const secPos = streamBytes.subarray(0, sizes[0]);
  const secNrm = streamBytes.subarray(sizes[0], sizes[0] + sizes[1]);
  const secCol = streamBytes.subarray(sizes[0] + sizes[1], sizes[0] + sizes[1] + sizes[2]);
  const secIdx = streamBytes.subarray(sizes[0] + sizes[1] + sizes[2], total);
  const hPos = sha256(secPos);
  const hNrm = sha256(secNrm);
  const hCol = sha256(secCol);
  const hIdx = sha256(secIdx);
  const hStream = sha256(streamBytes);
  if (hPos !== summary.codecHashes.position) throw new CheckFailed(`${role} position section hash drift (${hPos} vs ${summary.codecHashes.position})`);
  if (hNrm !== summary.codecHashes.normal) throw new CheckFailed(`${role} normal section hash drift (${hNrm} vs ${summary.codecHashes.normal})`);
  if (hCol !== summary.codecHashes.colour) throw new CheckFailed(`${role} colour section hash drift (${hCol} vs ${summary.codecHashes.colour})`);
  if (hIdx !== summary.codecHashes.index) throw new CheckFailed(`${role} index section hash drift (${hIdx} vs ${summary.codecHashes.index})`);
  if (hStream !== summary.codecHashes.stream) throw new CheckFailed(`${role} stream hash drift (${hStream} vs ${summary.codecHashes.stream})`);

  // 5) Per-vertex position within 0.5 step of the GLB's exact value.
  let maxPositionError = 0;
  const decodedMin = [Infinity, Infinity, Infinity], decodedMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < decoded.position.length; i += 1) {
    const axis = i % 3;
    const limit = independent.bounds.extent[axis] / 65535 / 2 + 1e-7;
    assertClose(`${role} position[${i}]`, decoded.position[i], independent.positions[i], limit);
    maxPositionError = Math.max(maxPositionError, Math.abs(decoded.position[i] - independent.positions[i]));
    decodedMin[axis] = Math.min(decodedMin[axis], decoded.position[i]);
    decodedMax[axis] = Math.max(decodedMax[axis], decoded.position[i]);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const limit = independent.bounds.extent[axis] / 65535 + 1e-7;
    assertClose(`${role} bounds.min[${axis}]`, decodedMin[axis], independent.bounds.min[axis], limit);
    assertClose(`${role} bounds.max[${axis}]`, decodedMax[axis], independent.bounds.max[axis], limit);
  }

  // 6) Per-vertex normal: zero -> exact (0,0,0); otherwise angular error <= 1°.
  let maxAngle = 0; let zeroCount = 0;
  for (let i = 0; i < decoded.normal.length; i += 3) {
    const a = [decoded.normal[i], decoded.normal[i + 1], decoded.normal[i + 2]];
    const bnx = independent.normals[i], bny = independent.normals[i + 1], bnz = independent.normals[i + 2];
    if (![...a, bnx, bny, bnz].every(Number.isFinite)) throw new CheckFailed(`${role} non-finite normal at ${i / 3}`);
    const lenSq = bnx * bnx + bny * bny + bnz * bnz;
    if (lenSq < 1e-12) {
      // Source zero normal: decoded must be exact (0,0,0).
      if (Math.abs(a[0]) > 0 || Math.abs(a[1]) > 0 || Math.abs(a[2]) > 0) {
        throw new CheckFailed(`${role} normal[${i / 3}]: source zero normal but decoded (${a[0]},${a[1]},${a[2]})`);
      }
      zeroCount += 1;
      continue;
    }
    const bLen = Math.sqrt(lenSq);
    const nb = [bnx / bLen, bny / bLen, bnz / bLen];
    const aLen = Math.hypot(a[0], a[1], a[2]);
    if (aLen < 1e-12) throw new CheckFailed(`${role} normal[${i / 3}]: decoded zero but source non-zero`);
    const na = [a[0] / aLen, a[1] / aLen, a[2] / aLen];
    const dot = Math.max(-1, Math.min(1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]));
    const ang = Math.acos(dot) * 180 / Math.PI;
    if (ang > maxAngle) maxAngle = ang;
    if (ang > 1.0) throw new CheckFailed(`${role} normal[${i / 3}]: angular error ${ang.toFixed(3)}° > 1°`);
  }

  // 7) Per-vertex linear colour: verify the sRGB -> linear conversion is correct
  // by checking that the decoded linear value matches the formula applied to the
  // RECORDED sRGB byte, not just round-tripping through the byte.
  for (let i = 0; i < decoded.colour.length; i += 1) {
    if (!isFiniteNumber(decoded.colour[i])) throw new CheckFailed(`${role} decoded.colour[${i}] non-finite`);
    const byte = secCol[i];
    const c = byte / 255;
    const expected = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    if (Math.abs(decoded.colour[i] - expected) > 1e-5) {
      throw new CheckFailed(`${role} colour linear[${i}]: decoded ${decoded.colour[i]} vs formula ${expected}`);
    }
  }

  // 8) Per-vertex sRGB byte comparison: independent Pillow measurement.
  const colorRes = spawnSync('python3', [
    join(__dirname, 'verify-color.py'),
    '--source-dir', args.source, '--role', role, '--glb', GLB_NAMES[role],
  ], { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 });
  if (colorRes.status !== 0) throw new CheckFailed(`${role}: verify-color.py exit ${colorRes.status}: ${colorRes.stderr || colorRes.stdout}`);
  const colourMeasure = JSON.parse(colorRes.stdout);
  if (colourMeasure.vertexCount !== summary.sourceVertexCount) {
    throw new CheckFailed(`${role} verify-color vertexCount ${colourMeasure.vertexCount} vs ${summary.sourceVertexCount}`);
  }
  if (colourMeasure.triangleCount !== summary.sourceTriangleCount) {
    throw new CheckFailed(`${role} verify-color triangleCount ${colourMeasure.triangleCount} vs ${summary.sourceTriangleCount}`);
  }
  if (colourMeasure.colourHash !== summary.codecHashes.colour) {
    throw new CheckFailed(`${role} colour hash drift vs Pillow (${colourMeasure.colourHash} vs ${summary.codecHashes.colour})`);
  }
  const independentColours = Buffer.from(colourMeasure.vertexColors, 'base64');
  for (let i = 0; i < independentColours.length; i += 1) {
    if (secCol[i] !== independentColours[i]) {
      throw new CheckFailed(`${role} colour byte[${i}]: codec ${secCol[i]} vs Pillow ${independentColours[i]}`);
    }
  }

  // 9) Triangle class bytes (campfire / palm)
  if (role === 'campfire' || role === 'palm') {
    if (!colourMeasure.triangleClasses) throw new CheckFailed(`${role} verify-color missing triangleClasses`);
    if (!data.surfaceEvidence.triangleClasses) throw new CheckFailed(`${role} surfaceEvidence missing triangleClasses`);
    const indep = Buffer.from(colourMeasure.triangleClasses, 'base64');
    if (indep.length !== summary.sourceTriangleCount) {
      throw new CheckFailed(`${role} triangleClass length ${indep.length} vs ${summary.sourceTriangleCount}`);
    }
    if (data.surfaceEvidence.triangleClasses.length !== summary.sourceTriangleCount) {
      throw new CheckFailed(`${role} surfaceEvidence.triangleClasses length drift`);
    }
    if (colourMeasure.triangleClassHash !== sha256(Buffer.from(data.surfaceEvidence.triangleClasses))) {
      throw new CheckFailed(`${role} triangleClass hash drift (Pillow ${colourMeasure.triangleClassHash} vs data file hash)`);
    }
    for (let i = 0; i < indep.length; i += 1) {
      if (data.surfaceEvidence.triangleClasses[i] !== indep[i]) {
        throw new CheckFailed(`${role} triangleClass[${i}]: data ${data.surfaceEvidence.triangleClasses[i]} vs Pillow ${indep[i]}`);
      }
    }
    if (summary.triangleClassSummary) {
      const warm = countMask(data.surfaceEvidence.triangleClasses, 0x01);
      const dark = countMask(data.surfaceEvidence.triangleClasses, 0x02);
      assertExact(`${role} triangleClassSummary.warmOrLeaf`, warm, summary.triangleClassSummary.warmOrLeaf);
      assertExact(`${role} triangleClassSummary.darkWood`, dark, summary.triangleClassSummary.darkWood);
    }
  }

  // 10) Lamp glass bounds
  if (role === 'lamp') {
    if (!colourMeasure.glassBounds) throw new CheckFailed(`${role} verify-color missing glassBounds`);
    if (!data.surfaceEvidence.glassBounds) throw new CheckFailed(`${role} surfaceEvidence missing glassBounds`);
    assertVecClose(`${role} glassBounds.min (data)`, [...data.surfaceEvidence.glassBounds.min], colourMeasure.glassBounds.min, 1e-5);
    assertVecClose(`${role} glassBounds.max (data)`, [...data.surfaceEvidence.glassBounds.max], colourMeasure.glassBounds.max, 1e-5);
    if (summary.glassBounds) {
      assertVecClose(`${role} glassBounds.min (json)`, [...data.surfaceEvidence.glassBounds.min], summary.glassBounds.min, 1e-5);
      assertVecClose(`${role} glassBounds.max (json)`, [...data.surfaceEvidence.glassBounds.max], summary.glassBounds.max, 1e-5);
    }
  }

  // 11) Map medians (independent re-measurement)
  assertClose(`${role} medianRoughness (data)`, data.surfaceMeta.medianRoughness, colourMeasure.medianRoughness, 1e-4);
  assertClose(`${role} medianMetalness (data)`, data.surfaceMeta.medianMetalness, colourMeasure.medianMetalness, 1e-4);
  assertClose(`${role} medianRoughness (json)`, summary.measured.medianRoughness, colourMeasure.medianRoughness, 1e-4);
  assertClose(`${role} medianMetalness (json)`, summary.measured.medianMetalness, colourMeasure.medianMetalness, 1e-4);
  assertClose(`${role} medianBaseColor.r`, data.surfaceMeta.medianBaseColor[0], colourMeasure.medianBaseColor[0], 1);
  assertClose(`${role} medianBaseColor.g`, data.surfaceMeta.medianBaseColor[1], colourMeasure.medianBaseColor[1], 1);
  assertClose(`${role} medianBaseColor.b`, data.surfaceMeta.medianBaseColor[2], colourMeasure.medianBaseColor[2], 1);

  // 12) Material factors vs the GLB and the recorded values.
  assertVecClose(`${role} baseColorFactor`, data.surfaceMeta.baseColorFactor, independent.baseColorFactor, 1e-6);
  assertClose(`${role} roughnessFactor`, data.surfaceMeta.roughnessFactor, independent.roughnessFactor, 1e-6);
  assertClose(`${role} metalnessFactor`, data.surfaceMeta.metalnessFactor, independent.metalnessFactor, 1e-6);
  assertExact(`${role} alphaMode`, data.surfaceMeta.alphaMode, independent.alphaMode);
  assertClose(`${role} alphaCutoff`, data.surfaceMeta.alphaCutoff, independent.alphaCutoff, 1e-6);
  assertExact(`${role} doubleSided`, data.surfaceMeta.doubleSided, independent.doubleSided);
  assertVecClose(`${role} emissiveFactor`, data.surfaceMeta.emissiveFactor, independent.emissiveFactor, 1e-6);

  // 13) Index array: EXACT match.
  if (decoded.index.length !== independent.indices.length) {
    throw new CheckFailed(`${role} index length: ${decoded.index.length} vs ${independent.indices.length}`);
  }
  for (let i = 0; i < decoded.index.length; i += 1) {
    if (decoded.index[i] !== independent.indices[i]) {
      throw new CheckFailed(`${role} index[${i}]: ${decoded.index[i]} vs ${independent.indices[i]} (order/count drift)`);
    }
  }

  // 14) Node chain: every entry's local matrix matches the GLB's walk.
  const chain = data.surfaceMeta.nodeChain;
  if (!Array.isArray(chain) || chain.length < 1) throw new CheckFailed(`${role} nodeChain missing or empty`);
  const expected = independent.nodeChain;
  if (chain.length !== expected.length) {
    throw new CheckFailed(`${role} nodeChain length: ${chain.length} vs ${expected.length}`);
  }
  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i].name !== expected[i].name) {
      throw new CheckFailed(`${role} nodeChain[${i}].name: ${chain[i].name} vs ${expected[i].name}`);
    }
    if (chain[i].isMeshNode !== expected[i].isMeshNode) {
      throw new CheckFailed(`${role} nodeChain[${i}].isMeshNode: ${chain[i].isMeshNode} vs ${expected[i].isMeshNode}`);
    }
    for (let j = 0; j < 16; j += 1) {
      assertClose(`${role} nodeChain[${i}].matrix[${j}]`, chain[i].matrix[j], expected[i].matrix[j], 1e-6);
    }
  }
  // The mesh-bearing node's world matrix must match the GLB's walk.
  for (let j = 0; j < 16; j += 1) {
    assertClose(`${role} meshNodeWorldMatrix[${j}]`, data.surfaceMeta.meshNodeWorldMatrix[j], independent.meshNodeWorldMatrix[j], 1e-6);
  }

  assertExact(`${role} mesh name`, data.surfaceMeta.meshName, independent.meshName);
  assertExact(`${role} material name`, data.surfaceMeta.materialName, independent.materialName);
  return { role, maxAngle, zeroCount, maxPositionError, decoded };
}

function countMask(arr, mask) {
  let n = 0;
  for (let i = 0; i < arr.length; i += 1) if (arr[i] & mask) n += 1;
  return n;
}

// ----- factory check -----

async function checkFactory(role, bundle, independent, decoded) {
  const group = bundle.createMeasuredProp(role);
  const meta = bundle[role].surfaceMeta;
  if (!(group instanceof Object) || !group.isGroup) throw new CheckFailed(`${role} factory: not a Group`);
  if (group.name === '' || group.name == null) throw new CheckFailed(`${role} factory: group has empty name`);
  // The outer group must be a fresh, mutable, identity group. matrixAutoUpdate
  // defaults to true; main mutates root.position / root.scale at runtime.
  if (group.matrixAutoUpdate !== true) throw new CheckFailed(`${role} factory: outer matrixAutoUpdate is ${group.matrixAutoUpdate}, expected true`);
  // Walk to find the mesh and the inner groups.
  let meshCount = 0; let mesh = null; let groupsInChain = 0; let lastInnerGroup = null;
  group.traverse(o => {
    if (o.isMesh) {
      meshCount += 1;
      mesh = o;
    } else if (o !== group && o.isGroup) {
      groupsInChain += 1;
      lastInnerGroup = o;
    }
  });
  if (meshCount !== 1) throw new CheckFailed(`${role} factory: expected 1 mesh, got ${meshCount}`);
  if (groupsInChain < 1) throw new CheckFailed(`${role} factory: expected >=1 inner group(s), got ${groupsInChain}`);
  // mesh attributes
  const geom = mesh.geometry;
  for (const k of ['position', 'normal', 'color']) {
    if (!geom.getAttribute(k)) throw new CheckFailed(`${role} factory: missing attribute ${k}`);
  }
  for (const [attribute, values] of [['position', decoded.position], ['normal', decoded.normal], ['color', decoded.colour]]) {
    assertVecClose(`${role} factory ${attribute}`, geom.getAttribute(attribute).array, values, 0);
  }
  if (!geom.getIndex()) throw new CheckFailed(`${role} factory: missing index`);
  assertVecClose(`${role} factory indices`, geom.getIndex().array, independent.indices, 0);
  if (geom.getAttribute('uv')) throw new CheckFailed(`${role} factory: UV attribute present (must be absent)`);
  // No source map references anywhere on the material.
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
    if (mesh.material[k]) throw new CheckFailed(`${role} factory: material.${k} is set`);
  }
  // Material actually uses the measured medians.
  assertClose(`${role} factory material.roughness`, mesh.material.roughness, meta.medianRoughness, 0);
  assertClose(`${role} factory material.metalness`, mesh.material.metalness, meta.medianMetalness, 0);
  assertClose(`${role} factory material.opacity`, mesh.material.opacity, independent.baseColorFactor[3], 0);
  assertVecClose(`${role} factory emissive`, mesh.material.emissive.toArray(), independent.emissiveFactor, 0);
  assertExact(`${role} factory vertexColors`, mesh.material.vertexColors, true);
  assertExact(`${role} factory side`, mesh.material.side, independent.doubleSided ? 2 : 0);
  // Material: BLEND only marks transparent; MASK uses alphaTest; OPAQUE neither.
  const am = meta.alphaMode;
  if (am === 'OPAQUE') {
    if (mesh.material.transparent) throw new CheckFailed(`${role} factory: OPAQUE material marked transparent`);
    if (mesh.material.alphaTest !== 0) throw new CheckFailed(`${role} factory: OPAQUE material has alphaTest`);
  } else if (am === 'MASK') {
    if (mesh.material.transparent) throw new CheckFailed(`${role} factory: MASK material marked transparent`);
    if (Math.abs(mesh.material.alphaTest - meta.alphaCutoff) > 1e-6) {
      throw new CheckFailed(`${role} factory: MASK alphaTest ${mesh.material.alphaTest} vs cutoff ${meta.alphaCutoff}`);
    }
  } else if (am === 'BLEND') {
    if (!mesh.material.transparent) throw new CheckFailed(`${role} factory: BLEND material not marked transparent`);
  }
  // Inner groups: each must have matrixAutoUpdate=false and a matrix matching the
  // recorded chain. Verify against the meta directly so we catch encoded values
  // that don't reach the runtime.
  const chain = independent.nodeChain;
  // Walk the inner groups in document order, skipping the outer.
  const inner = [];
  group.traverse(o => { if (o !== group && o.isGroup) inner.push(o); });
  if (inner.length !== chain.length) {
    throw new CheckFailed(`${role} factory: inner group count ${inner.length} vs chain ${chain.length}`);
  }
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i].matrixAutoUpdate !== false) {
      throw new CheckFailed(`${role} factory: inner group ${i} matrixAutoUpdate is ${inner[i].matrixAutoUpdate}, expected false`);
    }
    const m = inner[i].matrix.elements;
    for (let j = 0; j < 16; j += 1) {
      assertClose(`${role} factory inner group ${i} matrix[${j}]`, m[j], chain[i].matrix[j], 1e-6);
    }
  }
  group.updateMatrixWorld(true);
  assertVecClose(`${role} factory world matrix`, mesh.matrixWorld.elements, independent.meshNodeWorldMatrix, 1e-6);
  group.position.set(1, 2, -3);
  group.scale.set(1.4, 0.8, 1.7);
  group.rotation.y = 0.3;
  group.updateMatrixWorld(true);
  const placed = group.matrix.clone().multiply(new Matrix4().fromArray(independent.meshNodeWorldMatrix));
  assertVecClose(`${role} mutable placement`, mesh.matrixWorld.elements, placed.elements, 1e-6);
  // evidence installed non-enumerably
  const desc = Object.getOwnPropertyDescriptor(geom.userData, 'surfaceEvidence');
  if (!desc) throw new CheckFailed(`${role} factory: surfaceEvidence not installed`);
  if (desc.enumerable) throw new CheckFailed(`${role} factory: surfaceEvidence is enumerable (should be hidden from glTF exporters)`);
  return { role, vertexCount: geom.getAttribute('position').count, triangleCount: geom.getIndex().count / 3, groups: inner.length };
}


// ----- main -----

async function main() {
  const args = parseArgs(process.argv);
  const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf-8'));
  const summaryByRole = new Map(summary.roles.map(r => [r.role, r]));

  const bundle = await buildBundle();
  // The runtime contract requires preloadMeasuredProps() to have resolved
  // before any buildRole call. The verifier is a stricter caller: it needs
  // the per-role decompressed bytes to hash the encoded stream sections
  // against the recorded codecHashes values. Awaiting preloadMeasuredProps
  // runs every prepareRole in parallel and settles the module-scope byte
  // slots, which loadRoleBytes then returns synchronously-fast.
  await bundle.preloadMeasuredProps();

  let failures = 0;
  const results = [];
  for (const role of ROLES) {
    try {
      const independent = measureGLB(role, args.source);
      const result = await verifyRole(role, bundle, independent, summaryByRole.get(role), args);
      const factory = await checkFactory(role, bundle, independent, result.decoded);
      results.push({
        role, vertices: [factory.vertexCount, independent.vertexCount],
        triangles: [factory.triangleCount, independent.triangleCount],
        maxPositionError: result.maxPositionError, maxNormalAngleDegrees: result.maxAngle,
        zeroNormals: result.zeroCount, nodeCount: factory.groups,
        roughness: bundle[role].surfaceMeta.medianRoughness, metalness: bundle[role].surfaceMeta.medianMetalness,
      });
      console.log(`[verify] ${role.padEnd(9)} OK v=${factory.vertexCount}/${independent.vertexCount} t=${factory.triangleCount}/${independent.triangleCount} positionΔ=${result.maxPositionError.toExponential(3)} normalΔ=${result.maxAngle.toFixed(3)}° zeroNormals=${result.zeroCount}; all colors, indices, flags, material and placement checked`);
    } catch (err) {
      failures += 1;
      console.error(`[verify] ${role.padEnd(9)} FAIL ${err.message}`);
    }
  }
  if (failures > 0) {
    console.error(`[verify] FAILED roles=${failures}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(join(__dirname, 'verification/force-surface-parity.json'), JSON.stringify({
    sourceDirectory: args.source, positionTolerance: 'half u16 quantization step + 1e-7 float32 allowance',
    normalToleranceDegrees: 1, colorByteTolerance: 0, skins: 0, animations: 0, roles: results,
  }, null, 2) + '\n');
  console.log('[verify] all parity gates passed');
}

main().catch(err => { console.error(err); process.exit(1); });
