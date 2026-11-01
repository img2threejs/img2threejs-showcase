// SPDX-License-Identifier: Apache-2.0
// Local, bind-space contact for the worn garment, not a general cloth simulator.
import { Matrix3, Matrix4, Triangle, Vector3 } from 'three';

// Weld only for adjacency; original mesh topology and UVs remain unchanged.
function vertexFans(positions, index, faces) {
  const welded = new Map(), vertexFaces = [], keys = new Uint32Array(positions.length / 3), fans = new Map();
  for (let i = 0; i < keys.length; i++) {
    const key = `${Math.round(positions[i * 3] * 1e6)},${Math.round(positions[i * 3 + 1] * 1e6)},${Math.round(positions[i * 3 + 2] * 1e6)}`;
    if (!welded.has(key)) { welded.set(key, welded.size); vertexFaces.push([]); }
    keys[i] = welded.get(key);
  }
  for (const { t } of faces) for (let k = 0; k < 3; k++) vertexFaces[keys[index[t + k]]].push(t);
  for (const { t } of faces) {
    const fan = new Set([t]);
    for (let k = 0; k < 3; k++) for (const f of vertexFaces[keys[index[t + k]]]) fan.add(f);
    fans.set(t, Uint32Array.from(fan));
  }
  return fans;
}

export function createClothContact(garment, body, strapCoordinates) {
  const transform = new Matrix4().multiplyMatrices(garment.fromShared, body.toShared);
  const rest = new Float32Array(body.rest.length), live = new Float32Array(body.rest.length);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), q = new Vector3(), normal = new Vector3();
  const bestPoint = new Vector3(), bestNormal = new Vector3(), skinNormal = new Vector3(), point = new Vector3(), triangle = new Triangle();
  const bary = new Vector3(), vn = new Vector3(), normalMatrix = new Matrix3().setFromMatrix4(transform).invert().transpose();
  const clearance = new Float32Array(garment.rest.length / 3), attachedFace = new Uint32Array(clearance.length);
  const index = body.indices;
  for (let i = 0; i < rest.length; i += 3) a.fromArray(body.rest, i).applyMatrix4(transform).toArray(rest, i);
  const faces = [];
  // The delivered garment occupies the upper torso; retain both sides of it.
  for (let t = 0; t < index.length; t += 3) {
    a.fromArray(rest, index[t] * 3); b.fromArray(rest, index[t + 1] * 3); c.fromArray(rest, index[t + 2] * 3);
    if (Math.max(a.y, b.y, c.y) < 1.19 || Math.min(a.y, b.y, c.y) > 1.65) continue;
    faces.push({ t, minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x),
      minY: Math.min(a.y, b.y, c.y), maxY: Math.max(a.y, b.y, c.y), minZ: Math.min(a.z, b.z, c.z), maxZ: Math.max(a.z, b.z, c.z) });
  }
  // UV seams must not stop contact walking. A vertex fan also crosses a shared
  // corner without getting stuck on equal-distance edges.
  const neighborhoods = vertexFans(rest, index, faces);
  let bestFace = 0;
  function nearest(ids, positions, target) {
    let distance = Infinity;
    for (let k = 0; k < ids.length; k++) {
      const t = ids[k];
      a.fromArray(positions, index[t] * 3); b.fromArray(positions, index[t + 1] * 3); c.fromArray(positions, index[t + 2] * 3);
      triangle.set(a, b, c).closestPointToPoint(target, q);
      const d = q.distanceToSquared(target);
      if (d < distance) { distance = d; bestFace = t; bestPoint.copy(q); triangle.getNormal(bestNormal); }
    }
    return distance;
  }
  // Interpolated vertex normal at the closest point of `bestFace`: continuous across
  // facet edges, unlike the face normal, so neighbouring vertices keep their spacing.
  function smoothNormal(face, at, out) {
    const normals = body.geometry.attributes.normal.array;
    a.fromArray(live, index[face] * 3); b.fromArray(live, index[face + 1] * 3); c.fromArray(live, index[face + 2] * 3);
    triangle.set(a, b, c).getBarycoord(at, bary);
    out.set(0, 0, 0);
    for (let k = 0; k < 3; k++) out.addScaledVector(vn.fromArray(normals, index[face + k] * 3), bary.getComponent(k));
    out.applyMatrix3(normalMatrix);
    return out.lengthSq() > 1e-12 ? out.normalize() : out;
  }
  let orientation = 0, settled = 0;
  for (let i = 0; i < clearance.length; i++) {
    point.fromArray(garment.rest, i * 3);
    const radius = strapCoordinates[i * 2] ? 0.14 : 0.055, ids = [];
    for (const f of faces) {
      const dx = Math.max(f.minX - point.x, 0, point.x - f.maxX);
      const dy = Math.max(f.minY - point.y, 0, point.y - f.maxY);
      const dz = Math.max(f.minZ - point.z, 0, point.z - f.maxZ);
      if (dx * dx + dy * dy + dz * dz <= radius * radius) ids.push(f.t);
    }
    if (!ids.length) throw new Error(`Garment contact: no torso surface near vertex ${i}`);
    nearest(ids, rest, point);
    attachedFace[i] = bestFace;
    const gap = normal.subVectors(point, bestPoint).dot(bestNormal);
    orientation += Math.sign(gap);
    // The vertex's REAL rest gap to the skin (not a thin clamp): contact then corrects only what
    // the pull changed, so a vertex that barely moves stays where it was instead of being snapped
    // toward the skin while its unmoved neighbour stays behind (which tore the cloth open).
    clearance[i] = Math.max(0.0008, Math.min(0.02, Math.abs(gap)));
  }
  const winding = orientation < 0 ? -1 : 1;
  const restFace = attachedFace.slice();
  let version = -1;
  function refresh() {
    const nextVersion = body.geometry.attributes.position.version;
    if (version === nextVersion) return;
    for (let i = 0; i < live.length; i += 3) a.fromArray(body.positions, i).applyMatrix4(transform).toArray(live, i);
    version = nextVersion;
  }
  // Walk vertex i's tracked torso patch to the skin point nearest `target`, then orient
  // the interpolated skin normal outward. Tracking the continuous patch (instead of
  // scanning every nearby face) never jumps to a nearer but unrelated arm/cleavage surface.
  function locate(i, target) {
    let face = attachedFace[i];
    for (let step = 0; step < 128; step++) {
      nearest(neighborhoods.get(face), live, target);
      if (bestFace === face) break;
      face = bestFace;
    }
    attachedFace[i] = bestFace;
    smoothNormal(bestFace, bestPoint, skinNormal);
    if (skinNormal.lengthSq() === 0 || skinNormal.dot(bestNormal) < 0) skinNormal.copy(bestNormal);
    skinNormal.multiplyScalar(winding);
    return normal.subVectors(target, bestPoint).dot(skinNormal);
  }
  return {
    refresh,
    reset() { attachedFace.set(restFace); },
    // Keeps the tangential spread of a pulled patch (so it never collapses) and corrects
    // only the distance along the skin normal: to the vertex's own rest clearance plus an
    // optional `gap` (a cup lifting off the skin).
    project(i, target, out, gap = 0) {
      const height = locate(i, target);
      settled = clearance[i] + gap;
      return out.copy(target).addScaledVector(skinNormal, clearance[i] + gap - height);
    },
    // Height above the skin that the last project()/lift() left its vertex at (exact, along the skin normal).
    settledHeight() { return settled; },
    // Per triangle of `indices`: how far the triangle centre lies BELOW the mean height of its corners
    // over the skin at rest (a skin ridge under a clear triangle); 0 where the skin is flat.
    restSag(indices, positions) {
      live.set(rest);
      const sag = new Float32Array(indices.length / 3), p0 = new Vector3(), p1 = new Vector3(), p2 = new Vector3(), centre = new Vector3();
      for (let t = 0; t < indices.length; t += 3) {
        p0.fromArray(positions, indices[t] * 3); p1.fromArray(positions, indices[t + 1] * 3); p2.fromArray(positions, indices[t + 2] * 3);
        centre.copy(p0).add(p1).add(p2).divideScalar(3);
        const mean = (locate(indices[t], p0) + locate(indices[t + 1], p1) + locate(indices[t + 2], p2)) / 3;
        sag[t / 3] = Math.max(0, mean - locate(indices[t], centre));
      }
      attachedFace.set(restFace); version = -1;
      return sag;
    },
    // Height of `target` above the skin along the outward skin normal (written to `outNormal`);
    // negative = inside the body. Does not move anything.
    measure(i, target, outNormal) {
      const height = locate(i, target);
      outNormal.copy(skinNormal);
      return height;
    },
    // One-sided: raise `target` to at least clearance + `extra` above the skin, never
    // lower it. Lets a folded flap lie over the cup instead of inside it.
    lift(i, target, out, extra) {
      const height = locate(i, target);
      settled = Math.max(height, clearance[i] + extra);
      return out.copy(target).addScaledVector(skinNormal, Math.max(0, clearance[i] + extra - height));
    },
  };
}
