import * as THREE from 'three';

export const ROBOT_SEGMENTS = [
  { id: 'head', label: 'Head & neck', code: '01' },
  { id: 'torso', label: 'Torso', code: '02' },
  { id: 'left-arm', label: 'Left arm', code: '03' },
  { id: 'right-arm', label: 'Right arm', code: '04' },
  { id: 'left-leg', label: 'Left leg', code: '05' },
  { id: 'right-leg', label: 'Right leg', code: '06' },
  { id: 'details', label: 'Other details', code: '07' },
] as const;

export type RobotSegmentId = (typeof ROBOT_SEGMENTS)[number]['id'];

export interface RobotSegmentBucket {
  id: RobotSegmentId;
  label: string;
  code: string;
  meshes: THREE.SkinnedMesh[];
  vertexCount: number;
  center: THREE.Vector3;
}

export interface RobotMeshSegmentation {
  segmentIds: Uint8Array;
  segmentWeights: Float32Array;
}

export interface RobotSegmentation {
  segments: Map<RobotSegmentId, RobotSegmentBucket>;
  byMesh: Map<THREE.SkinnedMesh, RobotMeshSegmentation>;
  totalVertexCount: number;
}

function attributeComponent(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  component: number,
): number {
  if (component === 0) return attribute.getX(index);
  if (component === 1) return attribute.getY(index);
  if (component === 2) return attribute.getZ(index);
  return attribute.getW(index);
}

function segmentForBone(boneName: string): RobotSegmentId {
  const name = boneName.toLowerCase().replace(/^mixamorig:?/, '');
  if (/(head|neck|eye|jaw|face|nose|mouth)/.test(name)) return 'head';

  const side = name.startsWith('left') ? 'left' : name.startsWith('right') ? 'right' : null;
  if (side && /(upleg|leg|foot|toe|thigh|calf|knee)/.test(name)) return side + '-leg' as RobotSegmentId;
  if (side && /(shoulder|arm|forearm|hand|thumb|index|middle|ring|pinky)/.test(name)) {
    return side + '-arm' as RobotSegmentId;
  }
  if (/(spine|hips|chest|torso)/.test(name)) return 'torso';
  return 'details';
}

function segmentForPosition(point: THREE.Vector3, bounds: THREE.Box3): RobotSegmentId {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const normalizedY = size.y > 0 ? (point.y - bounds.min.y) / size.y : 0.5;
  const normalizedX = size.x > 0 ? (point.x - center.x) / (size.x * 0.5) : 0;
  if (normalizedY >= 0.83) return 'head';
  const anatomicalLeft = normalizedX > 0;
  if (normalizedY < 0.47 && Math.abs(normalizedX) > 0.08) {
    return anatomicalLeft ? 'left-leg' : 'right-leg';
  }
  if (Math.abs(normalizedX) < 0.22) return 'torso';
  if (normalizedY < 0.48) return anatomicalLeft ? 'left-leg' : 'right-leg';
  if (normalizedY < 0.65 && Math.abs(normalizedX) < 0.32) return 'torso';
  return anatomicalLeft ? 'left-arm' : 'right-arm';
}

export function assignRobotSegments(
  model: THREE.Object3D,
  meshes: THREE.SkinnedMesh[],
): RobotSegmentation {
  model.updateMatrixWorld(true);
  const modelBounds = new THREE.Box3().setFromObject(model, true);
  if (modelBounds.isEmpty()) throw new Error('Robot surface has no measurable bounds.');

  const segmentIndices = new Map<RobotSegmentId, number>(
    ROBOT_SEGMENTS.map((segment, index) => [segment.id, index]),
  );
  const segments = new Map<RobotSegmentId, RobotSegmentBucket>(
    ROBOT_SEGMENTS.map((segment) => [segment.id, {
      ...segment,
      meshes: [],
      vertexCount: 0,
      center: new THREE.Vector3(),
    }]),
  );
  const byMesh = new Map<THREE.SkinnedMesh, RobotMeshSegmentation>();
  const point = new THREE.Vector3();
  let totalVertexCount = 0;

  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute('position');
    const joints = mesh.geometry.getAttribute('skinIndex');
    const weights = mesh.geometry.getAttribute('skinWeight');
    if (!positions || !joints || !weights || !mesh.skeleton?.bones.length) {
      throw new Error('Source mesh ' + mesh.name + ' lacks its position or skin attributes.');
    }

    const segmentIds = new Uint8Array(positions.count);
    const segmentWeights = new Float32Array(positions.count * ROBOT_SEGMENTS.length);
    const meshHasSegments = new Uint8Array(ROBOT_SEGMENTS.length);
    const totals = new Float64Array(ROBOT_SEGMENTS.length);

    for (let vertex = 0; vertex < positions.count; vertex++) {
      mesh.getVertexPosition(vertex, point);
      mesh.localToWorld(point);
      totals.fill(0);
      let totalWeight = 0;

      for (let influence = 0; influence < 4; influence++) {
        const weight = attributeComponent(weights, vertex, influence);
        if (weight <= 0) continue;
        const jointIndex = Math.round(attributeComponent(joints, vertex, influence));
        const bone = mesh.skeleton.bones[jointIndex];
        if (!bone) continue;
        const segment = segmentForBone(bone.name);
        totals[segmentIndices.get(segment)!] += weight;
        totalWeight += weight;
      }

      if (totalWeight <= 0) {
        const segment = segmentForPosition(point, modelBounds);
        totals[segmentIndices.get(segment)!] = 1;
        totalWeight = 1;
      }

      const offset = vertex * ROBOT_SEGMENTS.length;
      let winner = 0;
      let winnerWeight = -1;
      for (let index = 0; index < ROBOT_SEGMENTS.length; index++) {
        const normalizedWeight = totals[index] / totalWeight;
        segmentWeights[offset + index] = normalizedWeight;
        if (normalizedWeight > winnerWeight) {
          winner = index;
          winnerWeight = normalizedWeight;
        }
      }

      segmentIds[vertex] = winner;
      const bucket = segments.get(ROBOT_SEGMENTS[winner].id)!;
      bucket.vertexCount++;
      bucket.center.add(point);
      meshHasSegments[winner] = 1;
    }

    for (let index = 0; index < ROBOT_SEGMENTS.length; index++) {
      if (meshHasSegments[index] === 0) continue;
      segments.get(ROBOT_SEGMENTS[index].id)!.meshes.push(mesh);
    }
    byMesh.set(mesh, { segmentIds, segmentWeights });
    totalVertexCount += positions.count;
  }

  for (const bucket of segments.values()) {
    if (bucket.vertexCount > 0) bucket.center.multiplyScalar(1 / bucket.vertexCount);
  }
  return { segments, byMesh, totalVertexCount };
}
