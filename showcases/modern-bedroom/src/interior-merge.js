import * as THREE from 'three';

// Draw-call reduction for static geometry.
//
// Meshes that render identically - the same material instance (which already encodes lightmap atlas, bed-cloth owner, floor balance
// and palette group), the same shadow behaviour and the same vertex attribute layout - are concatenated into one world-space mesh.
// The originals stay in the scene graph, hidden, and keep their own geometry: picking and occlusion rays, the interiorStudy inventory
// and the palette all still address them by name. Each merged mesh records a name -> vertex/index range map for tooling.
//
// Excluded from merging (they move, bend or sort individually): cloth, anything the caller lists, arrays of materials,
// non-opaque non-transmissive materials, skinned / morphed / instanced meshes and meshes mirrored by their world matrix.

// Attributes a mesh may lack: a missing one reads as zero, which the shaders already treat as "off" (see interior-shading.js).
const OPTIONAL_ATTRIBUTES = new Set(['lightFallback']);
const TRANSFORMED = new Set(['position', 'normal', 'tangent']);

function flatten(attribute) {
  if (!attribute.isInterleavedBufferAttribute) return { array: attribute.array, itemSize: attribute.itemSize, normalized: attribute.normalized };
  const { count, itemSize } = attribute;
  const array = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    array[i * itemSize] = attribute.getX(i);
    if (itemSize > 1) array[i * itemSize + 1] = attribute.getY(i);
    if (itemSize > 2) array[i * itemSize + 2] = attribute.getZ(i);
    if (itemSize > 3) array[i * itemSize + 3] = attribute.getW(i);
  }
  return { array, itemSize, normalized: false };
}

function layoutKey(geometry) {
  const parts = [];
  for (const name of Object.keys(geometry.attributes).sort()) {
    if (OPTIONAL_ATTRIBUTES.has(name)) continue;
    const attribute = geometry.attributes[name];
    const ctor = attribute.isInterleavedBufferAttribute ? 'Float32Array' : attribute.array.constructor.name;
    parts.push(`${name}:${attribute.itemSize}:${ctor}:${attribute.isInterleavedBufferAttribute ? false : attribute.normalized}`);
  }
  return parts.join(',');
}

function mergeable(mesh, material, excluded) {
  if (!mesh.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh || excluded.has(mesh)) return false;
  if (Array.isArray(material) || !material || !mesh.visible || mesh.morphTargetInfluences?.length) return false;
  if (material.transparent && !(material.transmission > 0)) return false;
  if (mesh.matrixWorld.determinant() <= 0) return false;
  const { geometry } = mesh;
  if (geometry.groups.length > 1 || !geometry.attributes.position) return false;
  for (const name of TRANSFORMED) {
    const attribute = geometry.attributes[name];
    if (attribute && !attribute.isInterleavedBufferAttribute && !(attribute.array instanceof Float32Array)) return false;
  }
  return true;
}

function buildMergedGeometry(members) {
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const { mesh } of members) {
    const { geometry } = mesh;
    vertexTotal += geometry.attributes.position.count;
    indexTotal += geometry.index ? geometry.index.count : geometry.attributes.position.count;
  }
  const names = new Set();
  for (const { mesh } of members) for (const name of Object.keys(mesh.geometry.attributes)) names.add(name);
  const merged = new THREE.BufferGeometry();
  const outputs = new Map();
  for (const name of names) {
    const first = members.find(({ mesh }) => mesh.geometry.attributes[name]).mesh.geometry.attributes[name];
    const { array, itemSize, normalized } = flatten(first);
    outputs.set(name, { itemSize, normalized, array: new array.constructor(vertexTotal * itemSize) });
  }
  const indices = vertexTotal > 65535 ? new Uint32Array(indexTotal) : new Uint16Array(indexTotal);
  const normalMatrix = new THREE.Matrix3();
  const vector = new THREE.Vector3();
  const identity = new THREE.Matrix4();
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const member of members) {
    const { mesh } = member;
    const { geometry } = mesh;
    const count = geometry.attributes.position.count;
    const world = mesh.matrixWorld;
    const isIdentity = world.equals(identity);
    normalMatrix.getNormalMatrix(world);
    for (const [name, output] of outputs) {
      const source = geometry.attributes[name];
      if (!source) continue; // zero fill
      const { array } = flatten(source);
      const { itemSize } = output;
      if (!TRANSFORMED.has(name) || isIdentity) { output.array.set(array, vertexOffset * itemSize); continue; }
      const target = output.array;
      for (let i = 0; i < count; i++) {
        const a = i * itemSize;
        const b = (vertexOffset + i) * itemSize;
        vector.set(array[a], array[a + 1], array[a + 2]);
        if (name === 'position') vector.applyMatrix4(world);
        else vector.applyMatrix3(normalMatrix).normalize();
        target[b] = vector.x; target[b + 1] = vector.y; target[b + 2] = vector.z;
        if (itemSize > 3) target[b + 3] = array[a + 3];
      }
    }
    const firstIndex = indexOffset;
    if (geometry.index) {
      const source = geometry.index.array;
      for (let i = 0; i < source.length; i++) indices[indexOffset + i] = source[i] + vertexOffset;
      indexOffset += source.length;
    } else {
      for (let i = 0; i < count; i++) indices[indexOffset + i] = vertexOffset + i;
      indexOffset += count;
    }
    member.range = { firstVertex: vertexOffset, vertexCount: count, firstIndex, indexCount: indexOffset - firstIndex };
    vertexOffset += count;
  }
  for (const [name, { array, itemSize, normalized }] of outputs) merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize, normalized));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// entries: { mesh, pbr } from bindMaterials. exclude: Set of meshes that must stay individual. Returns
// { meshes: [{ mesh, wire, members: [{ entry, name, range }] }], merged, hidden } and adds the merged meshes to `scene`.
export function mergeStaticMeshes({ entries, exclude = new Set(), scene, root, maxTriangles = 250000 }) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  for (const entry of entries) {
    const { mesh, pbr } = entry;
    if (!mergeable(mesh, pbr, exclude)) continue;
    const key = [pbr.uuid, mesh.castShadow, mesh.renderOrder, mesh.layers.mask, layoutKey(mesh.geometry)].join('|');
    let list = groups.get(key);
    if (!list) groups.set(key, list = { material: pbr, castShadow: mesh.castShadow, renderOrder: mesh.renderOrder, layers: mesh.layers.mask, items: [] });
    list.items.push(entry);
  }
  const result = { meshes: [], merged: 0, hidden: 0, triangles: 0 };
  let serial = 0;
  for (const group of groups.values()) {
    // A group is split only to keep one buffer from growing without bound; the room's static meshes stay far below the cap.
    const batches = [];
    let batch = null;
    let triangles = 0;
    for (const entry of group.items) {
      const { geometry } = entry.mesh;
      const count = (geometry.index?.count ?? geometry.attributes.position.count) / 3;
      if (!batch || triangles + count > maxTriangles) { batch = []; batches.push(batch); triangles = 0; }
      batch.push({ entry, mesh: entry.mesh });
      triangles += count;
    }
    for (const members of batches) {
      if (members.length < 2) continue;
      const geometry = buildMergedGeometry(members);
      const mesh = new THREE.Mesh(geometry, group.material);
      mesh.name = `merged.${group.material.name || 'material'}.${serial++}`;
      mesh.castShadow = group.castShadow;
      mesh.receiveShadow = true;
      mesh.renderOrder = group.renderOrder;
      mesh.layers.mask = group.layers;
      mesh.matrixAutoUpdate = false;
      mesh.userData = { merged: true, component: 'merged', members: members.length };
      scene.add(mesh);
      for (const { mesh: original } of members) {
        original.visible = false;
        original.userData.occluderOnly = true;
        result.hidden++;
      }
      result.meshes.push({ mesh, members: members.map(({ entry, mesh: original, range }) => ({ entry, name: original.name, physicalId: original.userData.physical_id ?? null, range })) });
      result.merged++;
      result.triangles += geometry.index.count / 3;
    }
  }
  return result;
}
