import * as THREE from 'three';

/** Repair the generated elbow weights and shade the resulting bent surface. */
export function repairElbowSkinning(mesh: THREE.SkinnedMesh): () => void {
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  const weights = geometry.getAttribute('skinWeight');
  const indices = geometry.getAttribute('skinIndex');
  const faces = geometry.getIndex()!;
  const bones = mesh.skeleton.bones;
  const blend = new Float32Array(positions.count);
  const vertex = new THREE.Vector3();

  for (const side of ['L', 'R']) {
    const upper = bones.findIndex((bone) => bone.name === `${side}_UpperarmTwist02`);
    const lower = bones.findIndex((bone) => bone.name === `${side}_ForearmTwist01`);
    // These exported twist chains have the same deformation as their parent
    // throughout the clip catalog. Include every chain member so coincident
    // vertices do not acquire different weights at an influence seam.
    const chain = bones.map((bone) => bone.name.startsWith(`${side}_Forearm`) ? 2
      : bone.name.startsWith(`${side}_Upperarm`) ? 1 : 0);
    const joints = ['Upperarm', 'Forearm', 'Hand'].map((name) => {
      const index = bones.findIndex((bone) => bone.name === `${side}_${name}`);
      return new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[index].clone().invert());
    });
    const [shoulder, elbow, wrist] = joints;
    const length = wrist.distanceTo(elbow);
    const axis = elbow.clone().sub(shoulder).normalize()
      .add(wrist.clone().sub(elbow).normalize()).normalize();

    for (let i = 0; i < positions.count; i++) {
      let armWeight = 0;
      let forearmWeight = 0;
      for (let slot = 0; slot < 4; slot++) {
        const bone = indices.getComponent(i, slot);
        const weight = weights.getComponent(i, slot);
        if (chain[bone]) armWeight += weight;
        if (chain[bone] === 2) forearmWeight += weight;
      }
      // Limit repair to the elbow band, leaving wrists, hands and the rest of
      // the figure unchanged. Bind coordinates make this pose-independent.
      if (armWeight < 1 - 1e-6) continue;
      vertex.fromBufferAttribute(positions, i).sub(elbow);
      const along = vertex.dot(axis) / length;
      if (Math.abs(along) >= 0.5) continue;
      const influence = 1 - THREE.MathUtils.smoothstep(Math.abs(along), 0.3, 0.5);
      const smoothWeight = THREE.MathUtils.smoothstep(along, -0.5, 0.5);
      const weight = THREE.MathUtils.lerp(forearmWeight / armWeight, smoothWeight, influence);
      indices.setXYZW(i, upper, lower, 0, 0);
      weights.setXYZW(i, 1 - weight, weight, 0, 0);
      blend[i] = influence;
    }
  }
  indices.needsUpdate = true;
  weights.needsUpdate = true;

  // Exported color/normal seams duplicate positions. Share accumulated face
  // normals at those seams, but never weld or change the original topology.
  const groups = new Map<string, number>();
  const normalSlots = new Int32Array(positions.count).fill(-1);
  const affected: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    if (blend[i] === 0) continue;
    const key = `${positions.getX(i)},${positions.getY(i)},${positions.getZ(i)}`;
    let slot = groups.get(key);
    if (slot === undefined) {
      slot = groups.size;
      groups.set(key, slot);
    }
    normalSlots[i] = slot;
    affected.push(i);
  }
  const sourceVertices: number[] = [];
  const sourceSlots = new Map<number, number>();
  const triangles: number[] = [];
  for (let i = 0; i < faces.count; i += 3) {
    const a = faces.getX(i), b = faces.getX(i + 1), c = faces.getX(i + 2);
    if (normalSlots[a] < 0 && normalSlots[b] < 0 && normalSlots[c] < 0) continue;
    for (const index of [a, b, c]) {
      let slot = sourceSlots.get(index);
      if (slot === undefined) {
        slot = sourceVertices.length;
        sourceSlots.set(index, slot);
        sourceVertices.push(index);
      }
      triangles.push(slot);
    }
  }
  const deformed = new Float32Array(sourceVertices.length * 3);
  const sums = new Float32Array(groups.size * 3);
  const normals = new THREE.BufferAttribute(new Float32Array(positions.count * 3), 3);
  normals.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('soraElbowNormal', normals);
  geometry.setAttribute('soraElbowBlend', new THREE.BufferAttribute(blend, 1));
  const ranges: Array<{ start: number; count: number }> = [];
  for (const index of affected) {
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.count === index * 3) last.count += 3;
    else ranges.push({ start: index * 3, count: 3 });
  }

  const material = mesh.material as THREE.MeshStandardMaterial;
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer): void => {
    previousCompile.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 soraElbowNormal;
        attribute float soraElbowBlend;
      `)
      .replace('#include <defaultnormal_vertex>', `
        objectNormal = normalize(mix(objectNormal, soraElbowNormal, soraElbowBlend));
        #include <defaultnormal_vertex>
      `);
  };
  material.customProgramCacheKey = (): string => `${previousKey()}|sora-elbow-surface-normals`;
  material.needsUpdate = true;

  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const update = (): void => {
    // Called after the volume-skinning pose update. Only elbow-adjacent
    // triangles are evaluated, not the full character mesh.
    for (let i = 0; i < sourceVertices.length; i++) {
      mesh.getVertexPosition(sourceVertices[i], vertex);
      vertex.toArray(deformed, i * 3);
    }
    sums.fill(0);
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
      vertex.fromArray(deformed, a * 3);
      edgeA.fromArray(deformed, b * 3).sub(vertex);
      edgeB.fromArray(deformed, c * 3).sub(vertex);
      edgeA.cross(edgeB);
      for (let corner = 0; corner < 3; corner++) {
        const slot = normalSlots[sourceVertices[triangles[i + corner]]];
        if (slot < 0) continue;
        sums[slot * 3] += edgeA.x;
        sums[slot * 3 + 1] += edgeA.y;
        sums[slot * 3 + 2] += edgeA.z;
      }
    }
    for (const index of affected) {
      vertex.fromArray(sums, normalSlots[index] * 3).normalize();
      normals.setXYZ(index, vertex.x, vertex.y, vertex.z);
    }
    normals.clearUpdateRanges();
    for (const range of ranges) normals.addUpdateRange(range.start, range.count);
    normals.needsUpdate = true;
  };
  update();
  return update;
}
