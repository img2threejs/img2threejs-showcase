import * as THREE from 'three';
import rigDefinitionJson from './rig/rig-definition.json';

type RigDefinition = {
  names: string[];
  parents: Array<number | null>;
  localMatricesColumnMajor: number[][];
};

const rigDefinition = rigDefinitionJson as RigDefinition;

export function createMeasuredRigDebug(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'mars-cat-measured-rig-debug';
  const bones = rigDefinition.names.map((name, index) => {
    const bone = new THREE.Bone();
    bone.name = name;
    new THREE.Matrix4()
      .fromArray(rigDefinition.localMatricesColumnMajor[index])
      .decompose(bone.position, bone.quaternion, bone.scale);
    bone.userData.measuredJointIndex = index;
    return bone;
  });
  for (let index = 0; index < bones.length; index += 1) {
    const parent = rigDefinition.parents[index];
    if (parent === null) group.add(bones[index]);
    else bones[parent].add(bones[index]);
  }
  group.updateMatrixWorld(true);

  const helper = new THREE.SkeletonHelper(group);
  helper.name = 'mars-cat-measured-rig-lines';
  const material = helper.material as THREE.LineBasicMaterial;
  material.color.setHex(0xff7a18);
  material.depthTest = false;
  material.transparent = true;
  material.opacity = 0.9;
  helper.renderOrder = 1000;
  group.add(helper);
  group.userData.measurement = {
    sourceSkin: 'Armature.001',
    jointCount: bones.length,
    hierarchyAndRestTransforms: 'measured-exactly-from-source-glb',
    skinBinding: false,
    reason: 'inspection-only: joint_loops gate inherits 12 failures from the reference surface',
  };
  return group;
}
