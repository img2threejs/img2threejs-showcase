import * as THREE from 'three';
import { SORA_PARTS, type SoraPart } from './createSoraModel';

const PART_LABELS: Record<SoraPart, string> = {
  head: 'Head and hair',
  torso: 'Torso and shoulders',
  hips: 'Hips',
  'left-upper-arm': 'Left upper arm',
  'left-forearm': 'Left forearm',
  'left-hand': 'Left hand',
  'right-upper-arm': 'Right upper arm',
  'right-forearm': 'Right forearm',
  'right-hand': 'Right hand',
  'left-thigh': 'Left thigh',
  'left-lower-leg': 'Left lower leg',
  'left-foot': 'Left foot',
  'right-thigh': 'Right thigh',
  'right-lower-leg': 'Right lower leg',
  'right-foot': 'Right foot',
};

const PART_INDEX: Record<SoraPart, number> = {
  head: 0,
  torso: 1,
  hips: 2,
  'left-upper-arm': 3,
  'left-forearm': 4,
  'left-hand': 5,
  'right-upper-arm': 6,
  'right-forearm': 7,
  'right-hand': 8,
  'left-thigh': 9,
  'left-lower-leg': 10,
  'left-foot': 11,
  'right-thigh': 12,
  'right-lower-leg': 13,
  'right-foot': 14,
};

function partForBone(name: string): SoraPart {
  if (name === 'Head' || name.startsWith('Neck')) return 'head';
  if (name.startsWith('L_Upperarm')) return 'left-upper-arm';
  if (name.startsWith('L_Forearm')) return 'left-forearm';
  if (name === 'L_Hand') return 'left-hand';
  if (name.startsWith('R_Upperarm')) return 'right-upper-arm';
  if (name.startsWith('R_Forearm')) return 'right-forearm';
  if (name === 'R_Hand') return 'right-hand';
  if (name.startsWith('L_Thigh')) return 'left-thigh';
  if (name.startsWith('L_Calf')) return 'left-lower-leg';
  if (name === 'L_Foot' || name === 'L_ToeBase') return 'left-foot';
  if (name.startsWith('R_Thigh')) return 'right-thigh';
  if (name.startsWith('R_Calf')) return 'right-lower-leg';
  if (name === 'R_Foot' || name === 'R_ToeBase') return 'right-foot';
  if (name === 'Root' || name === 'Hip' || name === 'Pelvis' || name === 'Waist') return 'hips';
  return 'torso';
}

function component(attribute: THREE.BufferAttribute, vertex: number, slot: number): number {
  switch (slot) {
    case 0: return attribute.getX(vertex);
    case 1: return attribute.getY(vertex);
    case 2: return attribute.getZ(vertex);
    default: return attribute.getW(vertex);
  }
}

function segmentBounds(
  position: THREE.BufferAttribute,
  indices: readonly number[],
): { box: THREE.Box3; sphere: THREE.Sphere } {
  const box = new THREE.Box3().makeEmpty();
  const point = new THREE.Vector3();
  for (const index of indices) box.expandByPoint(point.fromBufferAttribute(position, index));
  return { box, sphere: box.getBoundingSphere(new THREE.Sphere()) };
}

/**
 * Split only the index buffer. Every selectable segment shares the original
 * positions, normals, UVs, skin weights, material and skeleton, so animation
 * and outfit materials remain one source of truth without copying vertices.
 */
export function installSoraSelectableParts(mesh: THREE.SkinnedMesh): void {
  const geometry = mesh.geometry;
  const sourceIndex = geometry.getIndex();
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  if (!sourceIndex || !position || !skinIndex || !skinWeight) {
    throw new Error('Sora selectable parts require indexed skinned geometry');
  }
  const parent = mesh.parent;
  if (!parent) throw new Error('Sora selectable parts require a mounted skinned mesh');

  const boneParts = mesh.skeleton.bones.map((bone) => PART_INDEX[partForBone(bone.name)]);
  const indicesByPart = SORA_PARTS.map(() => [] as number[]);
  const scores = new Float32Array(SORA_PARTS.length);

  for (let offset = 0; offset < sourceIndex.count; offset += 3) {
    scores.fill(0);
    const a = sourceIndex.getX(offset);
    const b = sourceIndex.getX(offset + 1);
    const c = sourceIndex.getX(offset + 2);
    for (let triangleSlot = 0; triangleSlot < 3; triangleSlot++) {
      const vertex = triangleSlot === 0 ? a : triangleSlot === 1 ? b : c;
      for (let slot = 0; slot < 4; slot++) {
        const weight = component(skinWeight, vertex, slot);
        if (weight <= 0) continue;
        const bone = Math.round(component(skinIndex, vertex, slot));
        scores[boneParts[bone] ?? PART_INDEX.torso] += weight;
      }
    }
    let owner = 0;
    for (let part = 1; part < scores.length; part++) {
      if (scores[part] > scores[owner]) owner = part;
    }
    indicesByPart[owner].push(a, b, c);
  }

  mesh.userData.explodeWithParent = true;
  geometry.setDrawRange(0, 0);
  for (const [partIndex, indices] of indicesByPart.entries()) {
    if (!indices.length) continue;
    const part = SORA_PARTS[partIndex];
    const partGeometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      partGeometry.setAttribute(name, attribute);
    }
    partGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    const bounds = segmentBounds(position, indices);
    partGeometry.boundingBox = bounds.box;
    partGeometry.boundingSphere = bounds.sphere;

    const segment = new THREE.SkinnedMesh(partGeometry, mesh.material);
    segment.boundingBox = bounds.box.clone();
    segment.boundingSphere = bounds.sphere.clone();
    segment.name = part;
    segment.castShadow = mesh.castShadow;
    segment.receiveShadow = mesh.receiveShadow;
    segment.position.copy(mesh.position);
    segment.quaternion.copy(mesh.quaternion);
    segment.scale.copy(mesh.scale);
    // Static per-segment bounds describe the bind pose; animated vertices can
    // leave them, so culling must not discard a valid moving body region.
    segment.frustumCulled = false;
    segment.bindMode = mesh.bindMode;
    segment.bind(mesh.skeleton, mesh.bindMatrix);
    segment.userData.soraSelectablePart = true;
    segment.userData.part = {
      label: PART_LABELS[part],
      hypothesis: 'dominant skin-weight region',
      confidence: 1,
      triangles: indices.length / 3,
    };
    parent.add(segment);
  }
}

export function disposeSoraSelectableParts(mesh: THREE.SkinnedMesh): void {
  const parent = mesh.parent;
  if (!parent) return;
  for (const child of parent.children) {
    if (child.userData.soraSelectablePart && (child as THREE.Mesh).geometry) {
      (child as THREE.Mesh).geometry.dispose();
    }
  }
}
