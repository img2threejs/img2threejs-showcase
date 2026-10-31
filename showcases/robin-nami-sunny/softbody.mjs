// SPDX-License-Identifier: Apache-2.0
// Project-local runtime. Polynomial topology boundaries and seam-weld approach
// adapted from character/runtime/softbody.mjs (Apache-2.0).
// Artistic surface modes, not biological constants, FEM or collision simulation.
import { BufferAttribute, DynamicDrawUsage, Matrix3, Matrix4, Quaternion, Triangle, Vector3 } from 'three';

export const PROFILES = Object.freeze({
  // Low damping: about 0.70 amplitude retained per half-cycle for lively rebound.
  // Caps sit near the real mesh's topology-guard range; larger modal travel only
  // saturated into flat-topped, jerky swings without increasing visible travel.
  chest: Object.freeze({ frequency: 2.4, dampingRatio: 0.11, cap: 0.008, compression: 0.16 }),
  hips: Object.freeze({ frequency: 2.9, dampingRatio: 0.13, cap: 0.015, compression: 0.18 }),
  abdomen: Object.freeze({ frequency: 2.8, dampingRatio: 0.30, cap: 0.014, compression: 0.06, pressDepth: .008 }),
  waist: Object.freeze({ frequency: 5, dampingRatio: 0.6, cap: 0.006, compression: 0.10 }),
  // Signed press depth: cheeks gently lift/stretch instead of denting inward.
  cheek: Object.freeze({ frequency: 4.5, dampingRatio: 0.80, cap: 0.0025, compression: 0, pressDepth: -.0012 }),
});
export const REGION_IDS = Object.freeze(['chest-left', 'chest-right', 'hips-left', 'hips-right', 'waist-left', 'waist-right', 'abdomen', 'cheek-left', 'cheek-right']);
const registry = new WeakSet();
const STEP = 1 / 120, MAX_STEPS = 12, MAX_CONTACTS = 8;
// Artistic contact-pad radii/depths in the normalized metre-scale asset.
const PADS = Object.freeze({ chest: [.022,.0035], hips: [.025,.004], abdomen: [.025,.0005], waist: [.015,.0012], cheek: [.014,0] });
const MAX_PATCHES = 16;
const MIN_AREA = 0.2, MIN_EDGE = 0.65, MAX_EDGE = 1.45;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const smooth = (w) => w * w * (3 - 2 * w);
const error = (message) => new Error(`SoftRig: ${message}`);
const attribute = (geometry, name) => typeof name === 'string' ? geometry.getAttribute(name) ?? geometry.getAttribute(name.toLowerCase()) : undefined;
function finiteVector(v) { return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z); }
function copyPositions(a) {
  const result = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) { result[i * 3] = a.getX(i); result[i * 3 + 1] = a.getY(i); result[i * 3 + 2] = a.getZ(i); }
  if (!result.every(Number.isFinite)) throw error('nonfinite vertex attribute');
  return result;
}
function firstBoundary(a, b, c) {
  // All callers have c > 0. If this quadratic is positive throughout [0,1],
  // no boundary can reduce the admissible scale; avoid solving remote roots.
  if (a + b + c > 0 && (a <= 0 || b >= 0 || b <= -2 * a || 4 * a * c > b * b)) return Infinity;
  if (Math.abs(a) < 1e-20) return b < 0 ? -c / b : Infinity;
  const d = b * b - 4 * a * c;
  if (d < 0) return Infinity;
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(d));
  const r1 = q / a, r2 = q === 0 ? Infinity : c / q;
  return Math.min(r1 > 0 ? r1 : Infinity, r2 > 0 ? r2 : Infinity);
}
function edgeBoundary(x, y, z, dx, dy, dz, l2) {
  const a = dx * dx + dy * dy + dz * dz, b = 2 * (x * dx + y * dy + z * dz);
  return Math.min(firstBoundary(a, b, (1 - MIN_EDGE * MIN_EDGE) * l2), firstBoundary(-a, -b, (MAX_EDGE * MAX_EDGE - 1) * l2));
}
// Exact constant-target underdamped solution. No Euler instability at stiff cheeks.
function spring(position, velocity, target, profile, dt, result) {
  const omega = 2 * Math.PI * profile.frequency, decay = profile.dampingRatio * omega;
  const frequency = omega * Math.sqrt(1 - profile.dampingRatio ** 2);
  const c = Math.cos(frequency * dt), s = Math.sin(frequency * dt), e = Math.exp(-decay * dt);
  const x = position - target;
  result[0] = target + e * (x * c + (velocity + decay * x) * s / frequency);
  result[1] = e * (velocity * c - (decay * velocity + omega * omega * x) * s / frequency);
}
// Screened surface smoothing prevents thin source triangles from turning a
// smooth abdominal paint field into a steep discrete shear. Prepared once;
// zero-mask vertices stay fixed and chest/hip fields never enter this solve.
function conditionAbdomen(entry, indices, weights) {
  const lookup = new Int32Array(entry.support.length).fill(-1);
  indices.forEach((i, j) => { lookup[i] = j; });
  const count = indices.length, rows = Array.from({ length: count }, () => new Map()), mass = new Float64Array(count);
  const a = new Vector3(), u = new Vector3(), v = new Vector3(), n = new Vector3();
  const gradients = [new Vector3(), new Vector3(), new Vector3()];
  for (let o = 0; o < entry.indices.length; o += 3) {
    const vertices = [entry.indices[o], entry.indices[o + 1], entry.indices[o + 2]], ids = vertices.map(i => lookup[i]);
    if (ids.every(i => i < 0)) continue;
    a.fromArray(entry.sharedRest, vertices[0] * 3);
    u.fromArray(entry.sharedRest, vertices[1] * 3).sub(a); v.fromArray(entry.sharedRest, vertices[2] * 3).sub(a);
    n.crossVectors(u, v); const area2 = n.lengthSq(), area = Math.sqrt(area2) * .5;
    gradients[1].crossVectors(v, n).divideScalar(area2); gradients[2].crossVectors(n, u).divideScalar(area2);
    gradients[0].copy(gradients[1]).add(gradients[2]).negate();
    for (let k = 0; k < 3; k++) if (ids[k] >= 0) {
      const i = ids[k], row = rows[i]; mass[i] += area / 3;
      for (let l = 0; l < 3; l++) if (ids[l] >= 0) {
        const j = ids[l]; row.set(j, (row.get(j) ?? 0) + .0001 * area * gradients[k].dot(gradients[l]));
      }
    }
  }
  const x = weights.slice(), r = new Float64Array(count), p = new Float64Array(count), z = new Float64Array(count), ap = new Float64Array(count);
  for (let i = 0; i < count; i++) rows[i].set(i, (rows[i].get(i) ?? 0) + mass[i]);
  function multiply(input, output) {
    for (let i = 0; i < count; i++) { let sum = 0; for (const [j, value] of rows[i]) sum += value * input[j]; output[i] = sum; }
  }
  multiply(x, ap);
  let rz = 0;
  for (let i = 0; i < count; i++) { r[i] = mass[i] * weights[i] - ap[i]; p[i] = z[i] = r[i] / rows[i].get(i); rz += r[i] * z[i]; }
  for (let iteration = 0; iteration < 300 && rz > 1e-20; iteration++) {
    multiply(p, ap); let pap = 0; for (let i = 0; i < count; i++) pap += p[i] * ap[i];
    const alpha = rz / pap; let next = 0;
    for (let i = 0; i < count; i++) { x[i] += alpha * p[i]; r[i] -= alpha * ap[i]; z[i] = r[i] / rows[i].get(i); next += r[i] * z[i]; }
    const beta = next / rz; for (let i = 0; i < count; i++) p[i] = z[i] + beta * p[i]; rz = next;
  }
  for (let i = 0; i < count; i++) weights[i] = clamp(x[i], 0, 1);
}
function makeWeld(entry) {
  const { geometry, rest, restNormals, masks } = entry;
  const groups = new Map(), weld = new Uint32Array(rest.length / 3);
  const attrs = [geometry.getAttribute('skinIndex'), geometry.getAttribute('skinWeight')].filter(Boolean);
  for (const list of Object.values(geometry.morphAttributes)) attrs.push(...list);
  for (let i = 0; i < weld.length; i++) {
    const k = i * 3;
    // Exact rest normals preserve deliberate hard edges. UV is intentionally absent.
    let key = `${rest[k]},${rest[k + 1]},${rest[k + 2]}|${restNormals[k]},${restNormals[k + 1]},${restNormals[k + 2]}`;
    for (const mask of masks.values()) key += `|${mask[i]}`;
    for (const a of attrs) for (let c = 0; c < a.itemSize; c++) key += `|${a.getComponent(i, c)}`;
    if (!groups.has(key)) groups.set(key, i);
    weld[i] = groups.get(key);
  }
  return weld;
}

/**
 * Exporter v1 sidecar: {meshes:[{name,regions:[{id,attribute,bone?}]}]}.
 * All nine IDs are required; each mesh lists only its actual painted regions.
 * Shared vectors/centers use the FIRST configured mesh's bind-local coordinates.
 * Centers are measured from exported masks, never guessed from Blender-axis metadata.
 * meshes values expose live {mesh, rest, positions, masks, geometry, originalGeometry}.
 * update must follow the caller's animation/morph updates. No animation is synthesized.
 */
export function createSoftRig(root, sidecar) {
  if (!root?.isObject3D || !Array.isArray(sidecar?.meshes) || sidecar.meshes.length === 0) throw error('root and nonempty exporter sidecar.meshes required');
  const meshes = new Map(), regions = new Map(), byObject = new Map(), contacts = new Map(), patches = new Map();
  const scratch = new Vector3(), a = new Vector3(), b = new Vector3(), c = new Vector3(), bary = new Vector3();
  const matrix = new Matrix4(), boneMatrix = new Matrix4(), blend = new Matrix4(), inverse = new Matrix4(), linear = new Matrix3();
  const springResult = new Float64Array(2);
  const normalRotation = new Quaternion();
  let disposed = false, nextToken = 1, accumulator = 0, topologyScale = 1, minimumScale = 1, guardHits = 0, droppedTime = 0, lastSteps = 0;
  let geometryDeformed = false;
  root.updateWorldMatrix(true, false);
  root.updateMatrixWorld(true);
  let referenceInverse;
  try {
    for (const spec of sidecar.meshes) {
      const found = [];
      root.traverse((object) => { if (object.name === spec.name) found.push(object); });
      if (found.length !== 1 || !found[0].isMesh || found[0].isInstancedMesh || found[0].isBatchedMesh) throw error(`mesh ${spec.name} must resolve to exactly one ordinary Mesh/SkinnedMesh`);
      const mesh = found[0], originalGeometry = mesh.geometry;
      if (registry.has(mesh) || meshes.has(spec.name)) throw error(`mesh ${spec.name} already attached`);
      const position = originalGeometry.getAttribute('position');
      if (!position || position.itemSize !== 3 || position.isGLBufferAttribute) throw error(`${spec.name} needs CPU xyz positions`);
      if (!Array.isArray(spec.regions) || !spec.regions.length) throw error(`${spec.name} has no regions`);
      if (mesh.isSkinnedMesh && (!mesh.skeleton || !originalGeometry.getAttribute('skinIndex') || !originalGeometry.getAttribute('skinWeight'))) throw error(`${spec.name} has incomplete skin data`);
      const rest = copyPositions(position), masks = new Map();
      for (const item of spec.regions) {
        if (!REGION_IDS.includes(item.id) || masks.has(item.id)) throw error(`unknown/duplicate region ${item.id} on ${spec.name}`);
        const source = attribute(originalGeometry, item.attribute);
        if (!source || source.itemSize !== 1 || source.count !== position.count || source.isGLBufferAttribute) throw error(`${spec.name}/${item.id} missing or non-scalar mask ${item.attribute}`);
        const mask = new Float32Array(position.count);
        let sum = 0;
        for (let i = 0; i < mask.length; i++) {
          const value = source.getX(i);
          if (!Number.isFinite(value) || value < 0 || value > 1) throw error(`${spec.name}/${item.id} mask outside finite [0,1] at ${i}`);
          mask[i] = value; sum += value;
        }
        if (sum === 0) throw error(`${spec.name}/${item.id} has empty support`);
        masks.set(item.id, mask);
      }
      const corners = originalGeometry.index?.count ?? position.count;
      if (corners % 3) throw error(`${spec.name} is not triangle geometry`);
      const indices = new Uint32Array(corners);
      for (let i = 0; i < corners; i++) {
        const index = originalGeometry.index?.getX(i) ?? i;
        if (!Number.isInteger(index) || index < 0 || index >= position.count) throw error(`${spec.name} invalid index`);
        indices[i] = index;
      }
      const geometry = originalGeometry.clone();
      // Preserve immutable caller-owned UV/skin/morph/color/index attributes by reference.
      for (const [name, value] of Object.entries(originalGeometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.setAttribute(name, value);
      geometry.morphAttributes = originalGeometry.morphAttributes;
      geometry.setIndex(originalGeometry.index);
      const positions = rest.slice();
      geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
      if (!originalGeometry.getAttribute('normal')) geometry.computeVertexNormals();
      const restNormals = copyPositions(geometry.getAttribute('normal'));
      geometry.setAttribute('normal', new BufferAttribute(restNormals.slice(), 3).setUsage(DynamicDrawUsage));
      if (!referenceInverse) referenceInverse = mesh.matrixWorld.clone().invert();
      const toShared = new Matrix4().multiplyMatrices(referenceInverse, mesh.matrixWorld), fromShared = toShared.clone().invert();
      const sharedRest = new Float32Array(rest.length), support = new Float32Array(position.count);
      for (let i = 0; i < position.count; i++) {
        scratch.fromArray(rest, i * 3).applyMatrix4(toShared).toArray(sharedRest, i * 3);
        for (const mask of masks.values()) support[i] = Math.max(support[i], mask[i]);
      }
      const entry = { mesh, geometry, originalGeometry, rest, positions, masks, indices, restNormals, sharedRest, support, toShared, fromShared,
        candidate: new Float32Array(rest.length), normalSum: new Float64Array(rest.length), originalMeshBox: mesh.boundingBox, originalMeshSphere: mesh.boundingSphere,
        originalFrustumCulled: mesh.frustumCulled };
      meshes.set(spec.name, entry); byObject.set(mesh, entry);
      entry.weld = makeWeld(entry);
      for (const item of spec.regions) {
        const bone = item.bone ? mesh.skeleton?.bones.find((value) => value.name === item.bone) : null;
        if (item.bone && !bone) throw error(`${spec.name}/${item.id} cannot resolve skeleton bone ${item.bone}`);
        const existing = regions.get(item.id);
        if (existing) {
          if ((existing.bone?.name ?? null) !== (bone?.name ?? null)) throw error(`${item.id} coupled meshes disagree on anchor bone`);
          existing.meshes.push(entry);
          continue;
        }
        const center = new Vector3(), mask = masks.get(item.id);
        let weight = 0;
        for (let i = 0; i < mask.length; i++) { scratch.fromArray(sharedRest, i * 3); center.addScaledVector(scratch, mask[i]); weight += mask[i]; }
        center.divideScalar(weight);
        const profile = PROFILES[item.id.split('-')[0]];
        regions.set(item.id, { id: item.id, profile, center, axis: new Vector3(0, 0, 1), displacement: new Vector3(), velocity: new Vector3(), compression: 0, compressionVelocity: 0,
          target: new Vector3(), tension: new Vector3(), acceleration: new Vector3(), anchor: new Vector3(), previousAnchor: new Vector3(), previousVelocity: new Vector3(), history: 0,
          bone, boneIndex: bone ? mesh.skeleton.bones.indexOf(bone) : -1, anchorEntry: entry, meshes: [entry], contactCount: 0 });
      }
    }
    for (const id of REGION_IDS) if (!regions.has(id)) throw error(`missing required region ${id}`);
    // Check source topology before attaching; a guard cannot repair degenerate input.
    for (const entry of meshes.values()) {
      entry.supported = Uint32Array.from(entry.support.keys()).filter(i => entry.support[i]);
      const leftCheek = entry.masks.get('cheek-left'), rightCheek = entry.masks.get('cheek-right');
      entry.cheekSupport = Float32Array.from(entry.support, (_, i) => (leftCheek?.[i] ?? 0) + (rightCheek?.[i] ?? 0));
      entry.delta = new Float64Array(entry.rest.length);
      entry.vectorFromShared = new Matrix3().setFromMatrix4(entry.fromShared);
      entry.modeFields = [];
      for (const [id, mask] of entry.masks) {
        const active = [];
        for (let i = 0; i < mask.length; i++) if (mask[i]) active.push(i);
        const indices = Uint32Array.from(active), weights = new Float64Array(active.length), offsets = new Float64Array(active.length * 3);
        const region = regions.get(id);
        for (let j = 0; j < indices.length; j++) {
          const i = indices[j], k = i * 3, q = j * 3;
          weights[j] = smooth(mask[i]);
          offsets[q] = entry.sharedRest[k] - region.center.x;
          offsets[q + 1] = entry.sharedRest[k + 1] - region.center.y;
          offsets[q + 2] = entry.sharedRest[k + 2] - region.center.z;
        }
        if (id === 'abdomen') conditionAbdomen(entry, indices, weights);
        entry.modeFields.push({ region, indices, weights, offsets });
      }
      let affectedCount = 0;
      for (let i = 0; i < entry.indices.length; i += 3) {
        if (entry.support[entry.indices[i]] || entry.support[entry.indices[i + 1]] || entry.support[entry.indices[i + 2]]) affectedCount++;
      }
      entry.affectedTriangles = new Uint32Array(affectedCount);
      entry.restCross = new Float64Array(affectedCount * 3);
      // Rest edges and their squared lengths never change. Keep double precision
      // and the original arithmetic order so guard boundaries are unchanged.
      entry.restEdges = new Float64Array(affectedCount * 6);
      entry.restEdgeLengths = new Float64Array(affectedCount * 3);
      entry.restArea2 = new Float64Array(affectedCount);
      entry.restNormalSum = new Float64Array(entry.rest.length);
      let affected = 0;
      for (let i = 0; i < entry.indices.length; i += 3) {
        triangleCross(entry, entry.rest, i);
        if (scratch.lengthSq() <= 1e-24) throw error(`${entry.mesh.name} has degenerate rest triangle ${i / 3}`);
        accumulateCross(entry, i, entry.restNormalSum);
        if (entry.support[entry.indices[i]] || entry.support[entry.indices[i + 1]] || entry.support[entry.indices[i + 2]]) {
          entry.affectedTriangles[affected] = i;
          scratch.toArray(entry.restCross, affected * 3);
          const ia = entry.indices[i] * 3, ib = entry.indices[i + 1] * 3, ic = entry.indices[i + 2] * 3, r = entry.rest;
          const ux = r[ib] - r[ia], uy = r[ib + 1] - r[ia + 1], uz = r[ib + 2] - r[ia + 2];
          const vx = r[ic] - r[ia], vy = r[ic + 1] - r[ia + 1], vz = r[ic + 2] - r[ia + 2];
          const j = affected * 6, k = affected * 3;
          entry.restEdges[j] = ux; entry.restEdges[j + 1] = uy; entry.restEdges[j + 2] = uz;
          entry.restEdges[j + 3] = vx; entry.restEdges[j + 4] = vy; entry.restEdges[j + 5] = vz;
          entry.restEdgeLengths[k] = ux * ux + uy * uy + uz * uz;
          entry.restEdgeLengths[k + 1] = vx * vx + vy * vy + vz * vz;
          entry.restEdgeLengths[k + 2] = (vx - ux) * (vx - ux) + (vy - uy) * (vy - uy) + (vz - uz) * (vz - uz);
          entry.restArea2[affected] = scratch.lengthSq();
          affected++;
        }
      }
    }
    for (const entry of meshes.values()) {
      entry.mesh.geometry = entry.geometry;
      if (entry.mesh.isSkinnedMesh) {
        entry.mesh.boundingBox = null; entry.mesh.boundingSphere = null;
        // Pose/morph bounds are expensive and can change even with resting tissue.
        // Render conservatively; raycasting computes its posed sphere on demand.
        entry.mesh.frustumCulled = false;
      }
      registry.add(entry.mesh);
    }
  } catch (cause) {
    for (const entry of meshes.values()) entry.geometry.dispose();
    throw cause;
  }

  function updateWorld() {
    root.updateWorldMatrix(true, false);
    root.updateMatrixWorld(true);
    for (const entry of meshes.values()) if (entry.mesh.isSkinnedMesh) {
      entry.mesh.skeleton.update();
      entry.mesh.boundingBox = null; entry.mesh.boundingSphere = null;
    }
  }
  // Exact affine skin transform at a barycentric material point, with bind matrices.
  function pointMatrix(entry, triangle, weights, out, anchorBone = -1) {
    const mesh = entry.mesh;
    out.copy(mesh.matrixWorld);
    if (!mesh.isSkinnedMesh) return out;
    blend.elements.fill(0);
    if (anchorBone >= 0) {
      blend.multiplyMatrices(mesh.skeleton.bones[anchorBone].matrixWorld, mesh.skeleton.boneInverses[anchorBone]);
    } else {
      const skinIndex = entry.geometry.getAttribute('skinIndex'), skinWeight = entry.geometry.getAttribute('skinWeight');
      for (let corner = 0; corner < 3; corner++) {
        const vertex = triangle[corner], w = weights.getComponent(corner);
        for (let component = 0; component < 4; component++) {
          const weight = w * skinWeight.getComponent(vertex, component);
          if (!weight) continue;
          const index = skinIndex.getComponent(vertex, component);
          boneMatrix.multiplyMatrices(mesh.skeleton.bones[index].matrixWorld, mesh.skeleton.boneInverses[index]);
          for (let j = 0; j < 16; j++) blend.elements[j] += weight * boneMatrix.elements[j];
        }
      }
    }
    return out.multiply(mesh.bindMatrixInverse).multiply(blend).multiply(mesh.bindMatrix);
  }
  function mapHit(hit) {
    const entry = byObject.get(hit?.object);
    if (!entry || !finiteVector(hit.point)) return null;
    let ia, ib, ic;
    if (Number.isInteger(hit.faceIndex) && hit.faceIndex >= 0 && hit.faceIndex * 3 + 2 < entry.indices.length) {
      const k = hit.faceIndex * 3; ia = entry.indices[k]; ib = entry.indices[k + 1]; ic = entry.indices[k + 2];
    } else if (hit.face) { ({ a: ia, b: ib, c: ic } = hit.face); }
    if (![ia, ib, ic].every((i) => Number.isInteger(i) && i >= 0 && i < entry.rest.length / 3)) return null;
    updateWorld();
    entry.mesh.getVertexPosition(ia, a).applyMatrix4(entry.mesh.matrixWorld);
    entry.mesh.getVertexPosition(ib, b).applyMatrix4(entry.mesh.matrixWorld);
    entry.mesh.getVertexPosition(ic, c).applyMatrix4(entry.mesh.matrixWorld);
    if (!Triangle.getBarycoord(hit.point, a, b, c, bary) || !finiteVector(bary) || Math.min(bary.x, bary.y, bary.z) < -0.001) return null;
    let selected = null, best = 0.001;
    for (const [id, mask] of entry.masks) {
      const weight = bary.x * mask[ia] + bary.y * mask[ib] + bary.z * mask[ic];
      if (weight > best) { selected = id; best = weight; }
    }
    if (!selected) return null;
    const restPoint = new Vector3();
    a.fromArray(entry.sharedRest, ia * 3); b.fromArray(entry.sharedRest, ib * 3); c.fromArray(entry.sharedRest, ic * 3);
    restPoint.addScaledVector(a, bary.x).addScaledVector(b, bary.y).addScaledVector(c, bary.z);
    const normal = new Vector3().crossVectors(b.sub(a), c.sub(a)).normalize();
    return { entry, id: selected, triangle: [ia, ib, ic], barycentric: bary.clone(), restPoint, normal };
  }
  function padFields(mapped, radius) {
    const fields = [];
    for (const entry of regions.get(mapped.id).meshes) {
      const mask = entry.masks.get(mapped.id), indices = [], vectors = [];
      linear.setFromMatrix4(entry.fromShared);
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        scratch.fromArray(entry.sharedRest, i * 3).sub(mapped.restPoint);
        const axial = scratch.dot(mapped.normal), normalQ = axial * axial / (radius * radius);
        const q = Math.max(0, scratch.lengthSq() - axial * axial) / (radius * radius);
        if (q >= 1 || normalQ >= 1) continue;
        // Zero net displacement over a flat disk, not global volume conservation.
        const kernel = (1-q)**2 * (1-4*q) * (1-normalQ)**2 * smooth(mask[i]);
        scratch.copy(mapped.normal).multiplyScalar(-kernel).applyMatrix3(linear);
        indices.push(i * 3); vectors.push(scratch.x, scratch.y, scratch.z);
      }
      fields.push({ entry, indices: new Uint32Array(indices), vectors: new Float32Array(vectors) });
    }
    return fields;
  }
  function grab(hit, pointerId, { mode = 'squeeze' } = {}) {
    if (disposed) return null;
    if (mode !== 'squeeze' && mode !== 'grab') throw error('mode must be squeeze or grab');
    for (const contact of contacts.values()) if (contact.pointerId === pointerId) release(contact.token);
    if (contacts.size >= MAX_CONTACTS || patches.size >= MAX_PATCHES) return null;
    const mapped = mapHit(hit);
    if (!mapped) return null;
    pointMatrix(mapped.entry, mapped.triangle, mapped.barycentric, matrix);
    if (Math.abs(matrix.determinant()) < 1e-12) return null;
    const materialPoint = hit.point.clone().applyMatrix4(inverse.copy(matrix).invert());
    const token = Object.freeze({ id: nextToken++ });
    const region = regions.get(mapped.id);
    if (!region.contactCount) region.axis.copy(mapped.normal);
    const [radius, depth] = PADS[mapped.id.split('-')[0]];
    const contact = { ...mapped, pointerId, mode, token, materialPoint, worldTarget: hit.point.clone(), motion: new Vector3(),
      active: true, depth: 0, depthVelocity: 0, targetDepth: depth * (mode === 'grab' ? .5 : 1),
      radius, fields: depth > 0 ? padFields(mapped, radius) : [], padProfile: { frequency: region.profile.frequency * 1.8, dampingRatio: .55 } };
    contacts.set(token, contact); if (depth > 0) patches.set(token, contact); region.contactCount++;
    return token;
  }
  function refreshContactMotion(contact) {
    pointMatrix(contact.entry, contact.triangle, contact.barycentric, matrix);
    if (Math.abs(matrix.determinant()) < 1e-12) return false;
    inverse.copy(matrix).invert();
    scratch.copy(contact.worldTarget).applyMatrix4(inverse).sub(contact.materialPoint);
    scratch.applyMatrix3(linear.setFromMatrix4(contact.entry.toShared));
    contact.motion.copy(scratch).clampLength(0, regions.get(contact.id).profile.cap);
    return true;
  }
  function drag(token, worldPoint) {
    const contact = contacts.get(token);
    if (!contact || disposed || !finiteVector(worldPoint)) return false;
    contact.worldTarget.copy(worldPoint);
    updateWorld();
    return refreshContactMotion(contact);
  }
  function release(token) {
    const contact = contacts.get(token);
    if (!contact) return false;
    regions.get(contact.id).contactCount--;
    contacts.delete(token);
    contact.active = false;
    // Re-warm anchor history after an interaction; no stale acceleration kick.
    regions.get(contact.id).history = 0;
    return true;
  }
  function releaseAll() { for (const token of contacts.keys()) release(token); }
  function sampleInertia(dt) {
    for (const region of regions.values()) {
      const entry = region.anchorEntry;
      if (!region.bone) { region.acceleration.set(0, 0, 0); continue; }
      pointMatrix(entry, null, null, matrix, region.boneIndex);
      region.anchor.copy(region.center).applyMatrix4(entry.fromShared).applyMatrix4(matrix);
      scratch.copy(region.anchor).sub(region.previousAnchor).divideScalar(dt);
      if (region.history >= 2 && Math.abs(matrix.determinant()) > 1e-12) {
        region.acceleration.copy(scratch).sub(region.previousVelocity).multiplyScalar(-1 / dt);
        inverse.copy(matrix).invert();
        region.acceleration.applyMatrix3(linear.setFromMatrix4(inverse)).applyMatrix3(linear.setFromMatrix4(entry.toShared)).clampLength(0, 20);
      } else region.acceleration.set(0, 0, 0);
      region.previousAnchor.copy(region.anchor);
      if (region.history > 0) region.previousVelocity.copy(scratch);
      region.history = Math.min(2, region.history + 1);
    }
  }
  function step(dt) {
    for (const region of regions.values()) {
      const p = region.profile;
      let count = 0, squeezing = false;
      region.target.set(0, 0, 0);
      for (const contact of contacts.values()) if (contact.id === region.id) {
        region.target.add(contact.motion);
        // Flat surface patches need coherent normal travel; affine squash alone
        // mainly wrinkles them. Convex chest/hip modes retain their exact driver.
        if (contact.mode === 'squeeze' && p.pressDepth) region.target.addScaledVector(contact.normal, -p.pressDepth);
        count++; squeezing ||= contact.mode === 'squeeze';
      }
      if (count) region.target.divideScalar(count);
      region.target.add(region.tension);
      const omega2 = (2 * Math.PI * p.frequency) ** 2;
      region.target.addScaledVector(region.acceleration, 1 / omega2).clampLength(0, p.cap);
      for (let k = 0; k < 3; k++) {
        spring(region.displacement.getComponent(k), region.velocity.getComponent(k), region.target.getComponent(k), p, dt, springResult);
        region.displacement.setComponent(k, springResult[0]); region.velocity.setComponent(k, springResult[1]);
      }
      if (region.displacement.length() > p.cap) {
        region.displacement.clampLength(0, p.cap);
        const outward = region.velocity.dot(region.displacement) / (p.cap * p.cap);
        if (outward > 0) region.velocity.addScaledVector(region.displacement, -outward);
      }
      region.velocity.clampLength(0, p.cap * 2 * Math.PI * p.frequency * 3);
      spring(region.compression, region.compressionVelocity, squeezing ? p.compression : 0, p, dt, springResult);
      region.compression = clamp(springResult[0], -0.18, 0.18); region.compressionVelocity = springResult[1];
      if (region.compression !== springResult[0] && region.compression * region.compressionVelocity > 0) region.compressionVelocity = 0;
      if (!count && region.tension.lengthSq() === 0 && region.acceleration.lengthSq() < 1e-12 && region.displacement.lengthSq() < 1e-14 && region.velocity.lengthSq() < 1e-12 && Math.abs(region.compression) < 1e-7 && Math.abs(region.compressionVelocity) < 1e-6) {
        region.displacement.set(0, 0, 0); region.velocity.set(0, 0, 0); region.compression = 0; region.compressionVelocity = 0;
      }
    }
    for (const [token, patch] of patches) {
      spring(patch.depth, patch.depthVelocity, patch.active ? patch.targetDepth : 0, patch.padProfile, dt, springResult);
      patch.depth = springResult[0]; patch.depthVelocity = springResult[1];
      if (!patch.active && Math.abs(patch.depth) < 1e-8 && Math.abs(patch.depthVelocity) < 1e-7) patches.delete(token);
    }
  }
  function candidates() {
    for (const entry of meshes.values()) {
      entry.candidate.set(entry.rest);
      entry.delta.fill(0);
      for (const field of entry.modeFields) {
        const { region: r, indices, weights, offsets } = field;
        if (r.compression === 0 && r.displacement.lengthSq() === 0) continue;
        // Same affine mode and summation order as the dense evaluator.
        const tangent = 1 / Math.sqrt(1 - r.compression) - 1;
        for (let j = 0; j < indices.length; j++) {
          const k = indices[j] * 3, q = j * 3, w = weights[j];
          const rx = offsets[q], ry = offsets[q + 1], rz = offsets[q + 2];
          const axial = (rx * r.axis.x + ry * r.axis.y + rz * r.axis.z) * (-r.compression - tangent);
          entry.delta[k] += w * (r.displacement.x + tangent * rx + axial * r.axis.x);
          entry.delta[k + 1] += w * (r.displacement.y + tangent * ry + axial * r.axis.y);
          entry.delta[k + 2] += w * (r.displacement.z + tangent * rz + axial * r.axis.z);
        }
      }
      for (const i of entry.supported) {
        const k = i * 3;
        scratch.fromArray(entry.delta, k).applyMatrix3(entry.vectorFromShared);
        entry.candidate[k] = entry.rest[k] + scratch.x; entry.candidate[k + 1] = entry.rest[k + 1] + scratch.y; entry.candidate[k + 2] = entry.rest[k + 2] + scratch.z;
      }
    }
    for (const patch of patches.values()) for (const field of patch.fields) {
      for (let i = 0; i < field.indices.length; i++) {
        const k = field.indices[i], j = i * 3, p = field.entry.candidate;
        p[k] += field.vectors[j] * patch.depth;
        p[k+1] += field.vectors[j+1] * patch.depth;
        p[k+2] += field.vectors[j+2] * patch.depth;
      }
    }
  }
  function constrain() {
    let scale = 1;
    for (const entry of meshes.values()) {
      const p = entry.candidate, indices = entry.indices, edges = entry.restEdges, lengths = entry.restEdgeLengths;
      for (let triangle = 0; triangle < entry.affectedTriangles.length; triangle++) {
        const i = entry.affectedTriangles[triangle], j = triangle * 6, k = triangle * 3;
        const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
        const ux = edges[j], uy = edges[j + 1], uz = edges[j + 2];
        const vx = edges[j + 3], vy = edges[j + 4], vz = edges[j + 5];
        const dux = p[ib] - p[ia] - ux, duy = p[ib + 1] - p[ia + 1] - uy, duz = p[ib + 2] - p[ia + 2] - uz;
        const dvx = p[ic] - p[ia] - vx, dvy = p[ic + 1] - p[ia + 1] - vy, dvz = p[ic + 2] - p[ia + 2] - vz;
        const nx = entry.restCross[k], ny = entry.restCross[k + 1], nz = entry.restCross[k + 2];
        const qa = nx * (duy * dvz - duz * dvy) + ny * (duz * dvx - dux * dvz) + nz * (dux * dvy - duy * dvx);
        const qb = nx * (duy * vz - duz * vy + uy * dvz - uz * dvy) + ny * (duz * vx - dux * vz + uz * dvx - ux * dvz) + nz * (dux * vy - duy * vx + ux * dvy - uy * dvx);
        scale = Math.min(scale, firstBoundary(qa, qb, (1 - MIN_AREA) * entry.restArea2[triangle]), edgeBoundary(ux, uy, uz, dux, duy, duz, lengths[k]), edgeBoundary(vx, vy, vz, dvx, dvy, dvz, lengths[k + 1]), edgeBoundary(vx - ux, vy - uy, vz - uz, dvx - dux, dvy - duy, dvz - duz, lengths[k + 2]));
      }
    }
    if (scale < 1) { scale = Math.max(0, scale * 0.995); guardHits++; }
    topologyScale = scale; minimumScale = Math.min(minimumScale, scale);
    for (const entry of meshes.values()) {
      for (let i = 0; i < entry.positions.length; i++) {
        const delta = entry.candidate[i] - entry.rest[i];
        entry.positions[i] = delta === 0 || scale === 0 ? entry.rest[i] : entry.rest[i] + scale * delta;
      }
      entry.geometry.getAttribute('position').needsUpdate = true;
      updateNormals(entry);
      // Geometry bounds are not recomputed per frame: skinned meshes ignore them (they use their own
      // posed sphere) and a full-vertex pass here cost about a quarter of a walking character's frame.
    }
  }
  function triangleCross(entry, positions, offset) {
    const indices = entry.indices;
    a.fromArray(positions, indices[offset] * 3);
    b.fromArray(positions, indices[offset + 1] * 3).sub(a);
    c.fromArray(positions, indices[offset + 2] * 3).sub(a);
    scratch.crossVectors(b, c);
  }
  function accumulateCross(entry, offset, sum) {
    for (let j = 0; j < 3; j++) {
      const k = entry.weld[entry.indices[offset + j]] * 3;
      sum[k] += scratch.x; sum[k + 1] += scratch.y; sum[k + 2] += scratch.z;
    }
  }
  function updateNormals(entry) {
    const { weld, normalSum: sum, restNormals, support, affectedTriangles, restCross } = entry;
    sum.set(entry.restNormalSum);
    for (let triangle = 0; triangle < affectedTriangles.length; triangle++) {
      const offset = affectedTriangles[triangle], k = triangle * 3;
      triangleCross(entry, entry.positions, offset);
      scratch.x -= restCross[k]; scratch.y -= restCross[k + 1]; scratch.z -= restCross[k + 2];
      accumulateCross(entry, offset, sum);
    }
    const normals = entry.geometry.getAttribute('normal');
    for (const i of entry.supported) {
      const k = i * 3;
      const normalIndex = weld[i] * 3;
      if (entry.cheekSupport[i] && sum[normalIndex] === entry.restNormalSum[normalIndex] && sum[normalIndex + 1] === entry.restNormalSum[normalIndex + 1] && sum[normalIndex + 2] === entry.restNormalSum[normalIndex + 2]) {
        normals.setXYZ(i, restNormals[k], restNormals[k + 1], restNormals[k + 2]); continue;
      }
      scratch.fromArray(sum, normalIndex).normalize();
      a.fromArray(restNormals, k);
      if (entry.cheekSupport[i]) {
        // Transport the authored smooth normal by the actual geometric rotation.
        // Blending toward absolute triangle normals introduces a crease at zero strain.
        b.fromArray(entry.restNormalSum, normalIndex).normalize();
        normalRotation.setFromUnitVectors(b, scratch); a.applyQuaternion(normalRotation).normalize();
      } else a.lerp(scratch, smooth(support[i])).normalize();
      normals.setXYZ(i, a.x, a.y, a.z);
    }
    normals.needsUpdate = true;
  }
  function restoreRest() {
    for (const entry of meshes.values()) {
      entry.positions.set(entry.rest); entry.candidate.set(entry.rest);
      entry.geometry.getAttribute('normal').array.set(entry.restNormals);
      entry.geometry.getAttribute('position').needsUpdate = true; entry.geometry.getAttribute('normal').needsUpdate = true;
      // See constrain(): geometry bounds stay at their creation values.
      if (entry.mesh.isSkinnedMesh) { entry.mesh.boundingBox = null; entry.mesh.boundingSphere = null; }
    }
    geometryDeformed = false;
    topologyScale = 1;
  }
  // `deformGeometry = false` keeps the springs integrating but skips the vertex pass (and restores
  // rest geometry): for a character too far from the camera for the deformation to be visible.
  function update(dt, deformGeometry = true) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    updateWorld();
    for (const contact of contacts.values()) refreshContactMotion(contact);
    const admitted = Math.min(dt, STEP * MAX_STEPS);
    droppedTime += dt - admitted;
    if (dt > STEP * MAX_STEPS) for (const region of regions.values()) region.history = 0;
    sampleInertia(dt);
    accumulator += admitted;
    lastSteps = Math.min(MAX_STEPS, Math.floor((accumulator + 1e-12) / STEP));
    for (let i = 0; i < lastSteps; i++) step(STEP);
    accumulator = Math.max(0, accumulator - lastSteps * STEP);
    // Keep sampling anchors and integrating springs at rest; only vertex work sleeps.
    let deformed = patches.size > 0;
    for (const region of regions.values()) {
      if (region.displacement.x !== 0 || region.displacement.y !== 0 || region.displacement.z !== 0 || region.compression !== 0) { deformed = true; break; }
    }
    if (deformed && deformGeometry) {
      candidates(); constrain();
      geometryDeformed = true;
    } else if (geometryDeformed) restoreRest();
  }
  function reset() {
    if (disposed) return;
    releaseAll(); accumulator = 0; topologyScale = 1; minimumScale = 1; guardHits = 0; droppedTime = 0; lastSteps = 0;
    patches.clear();
    for (const region of regions.values()) {
      for (const key of ['displacement', 'velocity', 'target', 'tension', 'acceleration', 'anchor', 'previousAnchor', 'previousVelocity']) region[key].set(0, 0, 0);
      region.compression = 0; region.compressionVelocity = 0; region.history = 0;
    }
    restoreRest();
  }
  function dispose() {
    if (disposed) return;
    reset();
    for (const entry of meshes.values()) {
      entry.mesh.geometry = entry.originalGeometry;
      entry.mesh.boundingBox = entry.originalMeshBox; entry.mesh.boundingSphere = entry.originalMeshSphere;
      entry.mesh.frustumCulled = entry.originalFrustumCulled;
      registry.delete(entry.mesh); entry.geometry.dispose();
    }
    disposed = true;
  }
  function getDiagnostics() {
    let fadingPads = 0;
    for (const patch of patches.values()) if (!patch.active) fadingPads++;
    return { disposed, contactCount: contacts.size, profiles: PROFILES, coordinateSpace: 'first configured mesh bind-local',
      contactPads: { count: patches.size, fading: fadingPads,
        states: [...patches.values()].map((p) => ({ id: p.id, active: p.active, radius: p.radius, depth: p.depth, velocity: p.depthVelocity })) },
      solver: { fixedStep: STEP, maxSubsteps: MAX_STEPS, lastSubsteps: lastSteps, droppedTime, accumulator },
      guards: { topologyScale, minimumScale, hits: guardHits, minProjectedAreaRatio: MIN_AREA, minEdgeRatio: MIN_EDGE, maxEdgeRatio: MAX_EDGE, sharedAcrossMeshes: true },
      regions: Object.fromEntries([...regions].map(([id, r]) => [id, { profile: r.profile, center: r.center.toArray(), axis: r.axis.toArray(), displacement: r.displacement.toArray(), velocity: r.velocity.toArray(), compression: r.compression, compressionVelocity: r.compressionVelocity, contactCount: r.contactCount, anchorBone: r.bone?.name ?? null, inertiaHistory: r.history, acceleration: r.acceleration.toArray(), topologyScale, coupledMeshes: r.meshes.map((entry) => entry.mesh.name) }])) };
  }
  return { regions, meshes, pick: (hit) => disposed ? null : mapHit(hit)?.id ?? null, grab, drag, release, releaseAll,
    impulse(id, localVector) {
      if (disposed) return false;
      const region = regions.get(id);
      if (!region) throw error(`unknown region ${id}`);
      if (!finiteVector(localVector)) throw error('impulse needs a finite Vector3-like velocity change');
      region.velocity.add(localVector).clampLength(0, region.profile.cap * 2 * Math.PI * region.profile.frequency * 3);
      return true;
    },
    // Sustained external pull (e.g. a held garment strap), in the shared rig space;
    // bounded by the region cap. Clearing it lets the region spring rebound naturally.
    setTension(id, localVector) {
      if (disposed) return false;
      const region = regions.get(id);
      if (!region) throw error(`unknown region ${id}`);
      if (localVector === null) { region.tension.set(0, 0, 0); return true; }
      if (!finiteVector(localVector)) throw error('tension needs a finite Vector3-like offset or null');
      region.tension.copy(localVector).clampLength(0, region.profile.cap);
      return true;
    }, update, reset, dispose, getDiagnostics };
}
