// SPDX-License-Identifier: Apache-2.0
// Conservative bind-space hierarchy; exact posed triangles decide the hit.
import { BackSide, Box3, DoubleSide, Matrix4, Triangle, Vector3 } from 'three';

export function createPicker(meshes, softMeshes) {
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), point = new Vector3();
  const localBox = new Box3(), worldBox = new Box3(), transformed = new Box3();
  const inverse = new Matrix4(), triangle = new Triangle();
  const trees = meshes.map(mesh => {
    const geometry = mesh.geometry, position = geometry.attributes.position, index = geometry.index;
    const corner = i => index ? index.getX(i) : i;
    const faces = Array.from({ length: (index?.count ?? position.count) / 3 }, (_, i) => i);
    function build(items) {
      const box = new Box3(), bones = new Set(), morphs = geometry.morphAttributes.position ?? [];
      const morphBounds = morphs.map(() => new Box3());
      for (const face of items) for (let j = 0; j < 3; j++) {
        const i = corner(face * 3 + j); a.fromBufferAttribute(position, i); box.expandByPoint(a);
        for (let m = 0; m < morphs.length; m++) {
          b.fromBufferAttribute(morphs[m], i); if (!geometry.morphTargetsRelative) b.sub(a);
          morphBounds[m].expandByPoint(b);
        }
        if (mesh.isSkinnedMesh) for (let k = 0; k < 4; k++) if (geometry.attributes.skinWeight.getComponent(i, k) > 0) bones.add(geometry.attributes.skinIndex.getComponent(i, k));
      }
      const node = { box, bones: [...bones], morphBounds };
      if (items.length <= 24) node.faces = items;
      else {
        box.getSize(a); const axis = a.x >= a.y && a.x >= a.z ? 0 : a.y >= a.z ? 1 : 2;
        const value = f => (position.getComponent(corner(f * 3), axis) + position.getComponent(corner(f * 3 + 1), axis) + position.getComponent(corner(f * 3 + 2), axis));
        items.sort((x, y) => value(x) - value(y)); const half = items.length >> 1;
        node.left = build(items.slice(0, half)); node.right = build(items.slice(half));
      }
      return node;
    }
    return { mesh, corner, tree: build(faces), boneMatrices: [], expansion: new Vector3(), cache: new Float64Array(position.count * 3), stamps: new Uint32Array(position.count), generation: 0 };
  });
  function bounds(entry, node) {
    localBox.copy(node.box); localBox.min.sub(entry.expansion); localBox.max.add(entry.expansion);
    for (let m = 0; m < node.morphBounds.length; m++) {
      const weight = entry.mesh.morphTargetInfluences[m] ?? 0, box = node.morphBounds[m];
      if (weight >= 0) { localBox.min.addScaledVector(box.min, weight); localBox.max.addScaledVector(box.max, weight); }
      else { localBox.min.addScaledVector(box.max, weight); localBox.max.addScaledVector(box.min, weight); }
    }
    worldBox.makeEmpty();
    if (entry.mesh.isSkinnedMesh) for (const bone of node.bones) worldBox.union(transformed.copy(localBox).applyMatrix4(entry.boneMatrices[bone]));
    else worldBox.copy(localBox).applyMatrix4(entry.mesh.matrixWorld);
    return worldBox;
  }
  function vertex(entry, i, out) {
    if (entry.stamps[i] !== entry.generation) {
      entry.mesh.getVertexPosition(i, out).toArray(entry.cache, i * 3); entry.stamps[i] = entry.generation;
    }
    return out.fromArray(entry.cache, i * 3);
  }
  return {
    cast(raycaster) {
      let closest = null;
      for (const entry of trees) {
        const mesh = entry.mesh, geometry = mesh.geometry;
        if (!mesh.layers.test(raycaster.layers)) continue;
        entry.generation++; entry.expansion.set(0, 0, 0);
        const soft = softMeshes.get(mesh.name);
        // The garment has its own contact-constrained render surface, beyond soft support.
        if (soft) for (let i = 0; i < geometry.attributes.position.count; i++) for (let k = 0; k < 3; k++) entry.expansion.setComponent(k, Math.max(entry.expansion.getComponent(k), Math.abs(geometry.attributes.position.getComponent(i, k) - soft.rest[i * 3 + k])));
        if (mesh.isSkinnedMesh) {
          mesh.skeleton.update();
          for (let i = 0; i < mesh.skeleton.bones.length; i++) {
            const target = entry.boneMatrices[i] ??= new Matrix4();
            target.multiplyMatrices(mesh.skeleton.bones[i].matrixWorld, mesh.skeleton.boneInverses[i]).premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix).premultiply(mesh.matrixWorld);
          }
        }
        inverse.copy(mesh.matrixWorld).invert();
        const ray = raycaster.ray.clone().applyMatrix4(inverse);
        function visit(node) {
          if (!raycaster.ray.intersectsBox(bounds(entry, node))) return;
          if (!node.faces) { visit(node.left); visit(node.right); return; }
          for (const faceIndex of node.faces) {
            const offset = faceIndex * 3, draw = geometry.drawRange;
            if (offset < draw.start || offset + 3 > draw.start + draw.count) continue;
            let material = mesh.material, materialIndex = 0;
            if (Array.isArray(material)) {
              const group = geometry.groups.find(g => offset >= g.start && offset + 3 <= g.start + g.count);
              if (!group) continue; materialIndex = group.materialIndex; material = material[materialIndex];
            }
            if (!material) continue;
            const ia = entry.corner(offset), ib = entry.corner(offset + 1), ic = entry.corner(offset + 2);
            vertex(entry, ia, a); vertex(entry, ib, b); vertex(entry, ic, c);
            const hit = material.side === BackSide ? ray.intersectTriangle(c, b, a, true, point) : ray.intersectTriangle(a, b, c, material.side !== DoubleSide, point);
            if (!hit) continue;
            point.applyMatrix4(mesh.matrixWorld); const distance = point.distanceTo(raycaster.ray.origin);
            if (distance < raycaster.near || distance > raycaster.far || (closest && distance >= closest.distance)) continue;
            triangle.set(a, b, c);
            closest = { distance, point: point.clone(), object: mesh, faceIndex, face: { a: ia, b: ib, c: ic, normal: triangle.getNormal(new Vector3()), materialIndex } };
          }
        }
        visit(entry.tree);
      }
      return closest;
    },
  };
}
