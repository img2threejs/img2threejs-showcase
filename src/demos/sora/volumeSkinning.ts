import * as THREE from 'three';

/** Dual-quaternion skinning avoids the volume loss of linear matrix blending. */
export function preserveSkinVolume(mesh: THREE.SkinnedMesh): () => void {
  const count = mesh.skeleton.bones.length;
  const real = Array.from({ length: count }, () => new THREE.Vector4());
  const dual = Array.from({ length: count }, () => new THREE.Vector4());
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const blendedReal = new THREE.Vector4();
  const blendedDual = new THREE.Vector4();
  const indices = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  const material = mesh.material as THREE.MeshStandardMaterial;
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer): void => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.soraReal = { value: real };
    shader.uniforms.soraDual = { value: dual };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec4 soraReal[${count}];
        uniform vec4 soraDual[${count}];
        vec3 soraRotate(vec4 q, vec3 p) {
          return p + 2.0 * cross(q.xyz, cross(q.xyz, p) + q.w * p);
        }
      `)
      .replace('#include <skinbase_vertex>', `
        vec4 soraQ = vec4(0.0);
        vec4 soraD = vec4(0.0);
        vec4 soraReference = soraReal[int(skinIndex.x)];
        for (int slot = 0; slot < 4; slot++) {
          int bone = int(skinIndex[slot]);
          float weight = skinWeight[slot];
          if (dot(soraReference, soraReal[bone]) < 0.0) weight = -weight;
          soraQ += soraReal[bone] * weight;
          soraD += soraDual[bone] * weight;
        }
        float soraLength = max(length(soraQ), 0.000001);
        soraQ /= soraLength;
        soraD /= soraLength;
      `)
      .replace('#include <skinnormal_vertex>', `
        objectNormal = soraRotate(soraQ, objectNormal);
        #ifdef USE_TANGENT
          objectTangent = soraRotate(soraQ, objectTangent);
        #endif
      `)
      .replace('#include <skinning_vertex>', `
        transformed = soraRotate(soraQ, transformed) + 2.0 * (
          soraQ.w * soraD.xyz - soraD.w * soraQ.xyz + cross(soraQ.xyz, soraD.xyz));
      `);
  };
  material.customProgramCacheKey = (): string => `${previousKey()}|sora-dual-quaternion`;
  material.needsUpdate = true;
  mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mesh.customDistanceMaterial = new THREE.MeshDistanceMaterial();
  for (const shadowMaterial of [mesh.customDepthMaterial, mesh.customDistanceMaterial]) {
    shadowMaterial.onBeforeCompile = material.onBeforeCompile;
    shadowMaterial.customProgramCacheKey = material.customProgramCacheKey;
  }

  // Keep picking and animated bounds consistent with the GPU deformation.
  mesh.applyBoneTransform = (index: number, target: THREE.Vector3): THREE.Vector3 => {
    blendedReal.set(0, 0, 0, 0);
    blendedDual.set(0, 0, 0, 0);
    const reference = real[indices.getX(index)];
    for (let slot = 0; slot < 4; slot++) {
      const bone = indices.getComponent(index, slot);
      const weight = weights.getComponent(index, slot) * (reference.dot(real[bone]) < 0 ? -1 : 1);
      blendedReal.addScaledVector(real[bone], weight);
      blendedDual.addScaledVector(dual[bone], weight);
    }
    const length = Math.max(blendedReal.length(), 0.000001);
    blendedReal.divideScalar(length);
    blendedDual.divideScalar(length);
    rotation.set(blendedReal.x, blendedReal.y, blendedReal.z, blendedReal.w);
    target.applyQuaternion(rotation);
    const q = blendedReal;
    const d = blendedDual;
    return target.add(position.set(
      2 * (q.w * d.x - d.w * q.x + q.y * d.z - q.z * d.y),
      2 * (q.w * d.y - d.w * q.y + q.z * d.x - q.x * d.z),
      2 * (q.w * d.z - d.w * q.z + q.x * d.y - q.y * d.x),
    ));
  };

  const update = (): void => {
    mesh.updateWorldMatrix(true, true);
    // updateWorldMatrix does not refresh SkinnedMesh.bindMatrixInverse.
    mesh.bindMatrixInverse.copy(mesh.matrixWorld).invert();
    for (let i = 0; i < count; i++) {
      matrix.multiplyMatrices(mesh.skeleton.bones[i].matrixWorld, mesh.skeleton.boneInverses[i]);
      matrix.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
      matrix.decompose(position, rotation, scale);
      const { x, y, z, w } = rotation;
      real[i].set(x, y, z, w);
      const { x: tx, y: ty, z: tz } = position;
      dual[i].set(
        0.5 * (tx * w + ty * z - tz * y),
        0.5 * (-tx * z + ty * w + tz * x),
        0.5 * (tx * y - ty * x + tz * w),
        -0.5 * (tx * x + ty * y + tz * z),
      );
    }
  };
  update();
  return update;
}
