import * as THREE from 'three';
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type RiggedDragonOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

export type RiggedDragonMaterials = {
  body: THREE.MeshPhysicalMaterial;
  bodyDark: THREE.MeshPhysicalMaterial;
  innerEar: THREE.MeshPhysicalMaterial;
  muzzle: THREE.MeshPhysicalMaterial;
  horn: THREE.MeshPhysicalMaterial;
  membrane: THREE.MeshPhysicalMaterial;
  gold: THREE.MeshPhysicalMaterial;
  cuff: THREE.MeshPhysicalMaterial;
  strap: THREE.MeshPhysicalMaterial;
  cloth: THREE.MeshPhysicalMaterial;
  eye: THREE.MeshPhysicalMaterial;
  pupil: THREE.MeshPhysicalMaterial;
  ivory: THREE.MeshPhysicalMaterial;
};

export type RiggedDragonRuntime = {
  body: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  bones: Record<string, THREE.Bone>;
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, string[]>;
};

type BoneBook = {
  root: THREE.Bone;
  pelvis: THREE.Bone;
  spine: THREE.Bone;
  chest: THREE.Bone;
  neck: THREE.Bone;
  head: THREE.Bone;
  jaw: THREE.Bone;
  upperArmL: THREE.Bone;
  forearmL: THREE.Bone;
  handL: THREE.Bone;
  upperArmR: THREE.Bone;
  forearmR: THREE.Bone;
  handR: THREE.Bone;
  thighL: THREE.Bone;
  shinL: THREE.Bone;
  footL: THREE.Bone;
  thighR: THREE.Bone;
  shinR: THREE.Bone;
  footR: THREE.Bone;
  tail0: THREE.Bone;
  tail1: THREE.Bone;
  tail2: THREE.Bone;
  tail3: THREE.Bone;
  tail4: THREE.Bone;
  wingRootL: THREE.Bone;
  wingElbowL: THREE.Bone;
  wingTipL: THREE.Bone;
  wingRootR: THREE.Bone;
  wingElbowR: THREE.Bone;
  wingTipR: THREE.Bone;
};

type BoneAnchor = {
  bone: THREE.Bone;
  point: THREE.Vector3;
  region: 'core' | 'head' | 'arm-l' | 'arm-r' | 'leg-l' | 'leg-r' | 'tail';
};

const MODEL_MIN = new THREE.Vector3(-4.35, -3.35, -3.35);
const MODEL_MAX = new THREE.Vector3(4.35, 3.65, 1.7);
const MODEL_SIZE = MODEL_MAX.clone().sub(MODEL_MIN);
const MODEL_CENTER = MODEL_MIN.clone().add(MODEL_MAX).multiplyScalar(0.5);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const TAIL_POINTS = [
  new THREE.Vector3(-0.08, -0.82, -0.5),
  new THREE.Vector3(-0.55, -1.05, -0.82),
  new THREE.Vector3(-1.42, -1.5, -1.25),
  new THREE.Vector3(-1.92, -2.14, -1.9),
  new THREE.Vector3(-1.42, -2.58, -2.28),
  new THREE.Vector3(-0.2, -2.62, -2.02),
  new THREE.Vector3(1.15, -2.48, -1.62),
  new THREE.Vector3(2.28, -2.72, -2.18),
  new THREE.Vector3(3.02, -2.4, -2.92),
];

function sdEllipsoid(point: THREE.Vector3, center: THREE.Vector3, radii: THREE.Vector3): number {
  const p = point.clone().sub(center);
  const q = new THREE.Vector3(p.x / radii.x, p.y / radii.y, p.z / radii.z);
  const q2 = new THREE.Vector3(
    p.x / (radii.x * radii.x),
    p.y / (radii.y * radii.y),
    p.z / (radii.z * radii.z),
  );
  const k0 = q.length();
  const k1 = q2.length();
  return k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -Math.min(radii.x, radii.y, radii.z);
}

function sdCapsule(point: THREE.Vector3, start: THREE.Vector3, end: THREE.Vector3, radius: number): number {
  const pa = point.clone().sub(start);
  const ba = end.clone().sub(start);
  const h = THREE.MathUtils.clamp(pa.dot(ba) / ba.lengthSq(), 0, 1);
  return pa.addScaledVector(ba, -h).length() - radius;
}

function smoothUnion(a: number, b: number, blend: number): number {
  const h = THREE.MathUtils.clamp(0.5 + (b - a) / (2 * blend), 0, 1);
  return THREE.MathUtils.lerp(b, a, h) - blend * h * (1 - h);
}

function unionEllipsoid(
  distance: number,
  point: THREE.Vector3,
  center: [number, number, number],
  radii: [number, number, number],
  blend: number,
): number {
  return smoothUnion(
    distance,
    sdEllipsoid(point, new THREE.Vector3(...center), new THREE.Vector3(...radii)),
    blend,
  );
}

function unionCapsule(
  distance: number,
  point: THREE.Vector3,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  blend: number,
): number {
  return smoothUnion(distance, sdCapsule(point, start, end, radius), blend);
}

function bodyDistance(point: THREE.Vector3): number {
  let d = 1e6;

  // One continuous barrel-chested body. The overlap is deliberate: Marching Cubes
  // resolves these anatomical masses into a single manifold surface.
  d = unionEllipsoid(d, point, [0, 0.18, -0.02], [0.88, 0.93, 0.72], 0.18);
  d = unionEllipsoid(d, point, [0, -0.52, -0.02], [0.64, 0.72, 0.58], 0.15);
  d = unionEllipsoid(d, point, [0, -0.78, -0.03], [0.58, 0.54, 0.55], 0.12);
  d = unionEllipsoid(d, point, [0, 0.93, 0.06], [0.66, 0.52, 0.56], 0.16);
  d = unionEllipsoid(d, point, [-0.36, 0.43, 0.52], [0.58, 0.42, 0.3], 0.12);
  d = unionEllipsoid(d, point, [0.36, 0.43, 0.52], [0.58, 0.42, 0.3], 0.12);
  d = unionEllipsoid(d, point, [0, 1.55, 0.2], [1.38, 0.8, 0.78], 0.2);
  d = unionEllipsoid(d, point, [0, 1.2, -0.02], [1.12, 0.52, 0.75], 0.16);
  d = unionEllipsoid(d, point, [0, 1.02, -0.28], [1.16, 0.69, 0.76], 0.16);
  d = unionEllipsoid(d, point, [-0.64, 1.33, 0.51], [0.74, 0.49, 0.52], 0.16);
  d = unionEllipsoid(d, point, [0.64, 1.33, 0.51], [0.74, 0.49, 0.52], 0.16);
  d = unionEllipsoid(d, point, [-0.43, 0.46, -0.49], [0.54, 0.45, 0.27], 0.11);
  d = unionEllipsoid(d, point, [0.43, 0.46, -0.49], [0.54, 0.45, 0.27], 0.11);

  for (const side of [-1, 1] as const) {
    const shoulder = new THREE.Vector3(side * 0.72, 0.43, 0.05);
    const upperBulge = new THREE.Vector3(side * 1.18, 0.18, 0.24);
    const elbow = new THREE.Vector3(side * 1.48, -0.18, 0.43);
    const wrist = new THREE.Vector3(side * 1.72, -0.86, 0.68);
    const palm = new THREE.Vector3(side * 1.82, -1.22, 0.76);

    d = unionEllipsoid(d, point, [side * 0.82, 0.42, 0.04], [0.46, 0.46, 0.49], 0.15);
    d = unionCapsule(d, point, shoulder, upperBulge, 0.4, 0.14);
    d = unionCapsule(d, point, upperBulge, elbow, 0.37, 0.13);
    d = unionCapsule(d, point, elbow, wrist, 0.32, 0.12);
    d = unionEllipsoid(d, point, [palm.x, palm.y, palm.z], [0.38, 0.38, 0.37], 0.11);

    const hip = new THREE.Vector3(side * 0.48, -0.72, -0.02);
    const thighMid = new THREE.Vector3(side * 0.72, -1.13, 0.18);
    const knee = new THREE.Vector3(side * 1.02, -1.5, 0.34);
    const ankle = new THREE.Vector3(side * 0.48, -2.26, 0.62);
    d = unionEllipsoid(d, point, [side * 0.5, -0.88, 0.04], [0.43, 0.56, 0.47], 0.11);
    d = unionCapsule(d, point, hip, thighMid, 0.36, 0.1);
    d = unionCapsule(d, point, thighMid, knee, 0.32, 0.09);
    d = unionCapsule(d, point, knee, ankle, 0.23, 0.08);
  }

  for (let i = 0; i < TAIL_POINTS.length - 1; i++) {
    const t = i / (TAIL_POINTS.length - 2);
    d = unionCapsule(
      d,
      point,
      TAIL_POINTS[i],
      TAIL_POINTS[i + 1],
      THREE.MathUtils.lerp(0.3, 0.085, t),
      THREE.MathUtils.lerp(0.1, 0.06, t),
    );
  }

  return d;
}

function extractBodySurface(resolution = 58): THREE.BufferGeometry {
  const marching = new MarchingCubes(
    resolution,
    new THREE.MeshBasicMaterial(),
    false,
    false,
    160_000,
  );
  marching.isolation = 0;

  const point = new THREE.Vector3();
  for (let z = 0; z < resolution; z++) {
    const nz = (z - resolution / 2) / (resolution / 2);
    for (let y = 0; y < resolution; y++) {
      const ny = (y - resolution / 2) / (resolution / 2);
      for (let x = 0; x < resolution; x++) {
        const nx = (x - resolution / 2) / (resolution / 2);
        point.set(
          MODEL_CENTER.x + nx * MODEL_SIZE.x * 0.5,
          MODEL_CENTER.y + ny * MODEL_SIZE.y * 0.5,
          MODEL_CENTER.z + nz * MODEL_SIZE.z * 0.5,
        );
        marching.setCell(x, y, z, bodyDistance(point));
      }
    }
  }
  marching.update();

  const count = marching.geometry.drawRange.count;
  const sourcePosition = marching.geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) positions[i] = sourcePosition.array[i] as number;

  const rawGeometry = new THREE.BufferGeometry();
  rawGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  rawGeometry.applyMatrix4(
    new THREE.Matrix4()
      .makeScale(MODEL_SIZE.x * 0.5, MODEL_SIZE.y * 0.5, MODEL_SIZE.z * 0.5)
      .premultiply(new THREE.Matrix4().makeTranslation(MODEL_CENTER.x, MODEL_CENTER.y, MODEL_CENTER.z)),
  );
  const geometry = mergeVertices(rawGeometry, 1e-5);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  marching.geometry.dispose();
  (marching.material as THREE.Material).dispose();
  rawGeometry.dispose();
  return geometry;
}

function addBone(
  parent: THREE.Bone,
  name: string,
  worldPoint: THREE.Vector3,
  parentWorldPoint: THREE.Vector3,
): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.copy(worldPoint).sub(parentWorldPoint);
  parent.add(bone);
  return bone;
}

function createBones(): BoneBook {
  const root = new THREE.Bone();
  root.name = 'dragon-root';
  root.position.set(0, -0.7, -0.02);
  const rootPoint = root.position.clone();

  const pelvisPoint = new THREE.Vector3(0, -0.62, -0.02);
  const spinePoint = new THREE.Vector3(0, -0.08, 0);
  const chestPoint = new THREE.Vector3(0, 0.55, 0.02);
  const neckPoint = new THREE.Vector3(0, 1.1, 0.08);
  const headPoint = new THREE.Vector3(0, 1.55, 0.2);
  const jawPoint = new THREE.Vector3(0, 1.18, 0.61);

  const pelvis = addBone(root, 'pelvis', pelvisPoint, rootPoint);
  const spine = addBone(pelvis, 'spine', spinePoint, pelvisPoint);
  const chest = addBone(spine, 'chest', chestPoint, spinePoint);
  const neck = addBone(chest, 'neck', neckPoint, chestPoint);
  const head = addBone(neck, 'head', headPoint, neckPoint);
  const jaw = addBone(head, 'jaw', jawPoint, headPoint);

  const sideBones = (side: -1 | 1, suffix: 'L' | 'R') => {
    const upperArmPoint = new THREE.Vector3(side * 0.91, 0.53, 0.08);
    const forearmPoint = new THREE.Vector3(side * 1.47, -0.08, 0.43);
    const handPoint = new THREE.Vector3(side * 1.72, -0.86, 0.68);
    const upperArm = addBone(chest, `upperArm${suffix}`, upperArmPoint, chestPoint);
    const forearm = addBone(upperArm, `forearm${suffix}`, forearmPoint, upperArmPoint);
    const hand = addBone(forearm, `hand${suffix}`, handPoint, forearmPoint);

    const thighPoint = new THREE.Vector3(side * 0.47, -0.72, 0);
    const shinPoint = new THREE.Vector3(side * 1.02, -1.5, 0.34);
    const footPoint = new THREE.Vector3(side * 0.48, -2.26, 0.62);
    const thigh = addBone(pelvis, `thigh${suffix}`, thighPoint, pelvisPoint);
    const shin = addBone(thigh, `shin${suffix}`, shinPoint, thighPoint);
    const foot = addBone(shin, `foot${suffix}`, footPoint, shinPoint);

    const wingRootPoint = new THREE.Vector3(side * 0.74, 0.78, -0.48);
    const wingElbowPoint = new THREE.Vector3(side * 2.15, 2.45, -1.72);
    const wingTipPoint = new THREE.Vector3(side * 3.82, 2.45, -2.72);
    const wingRoot = addBone(chest, `wingRoot${suffix}`, wingRootPoint, chestPoint);
    const wingElbow = addBone(wingRoot, `wingElbow${suffix}`, wingElbowPoint, wingRootPoint);
    const wingTip = addBone(wingElbow, `wingTip${suffix}`, wingTipPoint, wingElbowPoint);

    return { upperArm, forearm, hand, thigh, shin, foot, wingRoot, wingElbow, wingTip };
  };

  const left = sideBones(1, 'L');
  const right = sideBones(-1, 'R');

  const tail0Point = TAIL_POINTS[0];
  const tail1Point = TAIL_POINTS[2];
  const tail2Point = TAIL_POINTS[4];
  const tail3Point = TAIL_POINTS[6];
  const tail4Point = TAIL_POINTS[8];
  const tail0 = addBone(pelvis, 'tail0', tail0Point, pelvisPoint);
  const tail1 = addBone(tail0, 'tail1', tail1Point, tail0Point);
  const tail2 = addBone(tail1, 'tail2', tail2Point, tail1Point);
  const tail3 = addBone(tail2, 'tail3', tail3Point, tail2Point);
  const tail4 = addBone(tail3, 'tail4', tail4Point, tail3Point);

  return {
    root,
    pelvis,
    spine,
    chest,
    neck,
    head,
    jaw,
    upperArmL: left.upperArm,
    forearmL: left.forearm,
    handL: left.hand,
    upperArmR: right.upperArm,
    forearmR: right.forearm,
    handR: right.hand,
    thighL: left.thigh,
    shinL: left.shin,
    footL: left.foot,
    thighR: right.thigh,
    shinR: right.shin,
    footR: right.foot,
    tail0,
    tail1,
    tail2,
    tail3,
    tail4,
    wingRootL: left.wingRoot,
    wingElbowL: left.wingElbow,
    wingTipL: left.wingTip,
    wingRootR: right.wingRoot,
    wingElbowR: right.wingElbow,
    wingTipR: right.wingTip,
  };
}

function skinBody(geometry: THREE.BufferGeometry, bones: BoneBook): void {
  const anchors: BoneAnchor[] = [
    { bone: bones.pelvis, point: new THREE.Vector3(0, -0.62, 0), region: 'core' },
    { bone: bones.spine, point: new THREE.Vector3(0, -0.08, 0), region: 'core' },
    { bone: bones.chest, point: new THREE.Vector3(0, 0.55, 0), region: 'core' },
    { bone: bones.neck, point: new THREE.Vector3(0, 1.1, 0.08), region: 'head' },
    { bone: bones.head, point: new THREE.Vector3(0, 1.55, 0.2), region: 'head' },
    { bone: bones.jaw, point: new THREE.Vector3(0, 1.18, 0.61), region: 'head' },
    { bone: bones.upperArmL, point: new THREE.Vector3(0.92, 0.5, 0.08), region: 'arm-l' },
    { bone: bones.forearmL, point: new THREE.Vector3(1.47, -0.08, 0.43), region: 'arm-l' },
    { bone: bones.handL, point: new THREE.Vector3(1.78, -1.08, 0.73), region: 'arm-l' },
    { bone: bones.upperArmR, point: new THREE.Vector3(-0.92, 0.5, 0.08), region: 'arm-r' },
    { bone: bones.forearmR, point: new THREE.Vector3(-1.47, -0.08, 0.43), region: 'arm-r' },
    { bone: bones.handR, point: new THREE.Vector3(-1.78, -1.08, 0.73), region: 'arm-r' },
    { bone: bones.thighL, point: new THREE.Vector3(0.53, -0.9, 0.06), region: 'leg-l' },
    { bone: bones.shinL, point: new THREE.Vector3(1.0, -1.54, 0.36), region: 'leg-l' },
    { bone: bones.footL, point: new THREE.Vector3(0.48, -2.28, 0.62), region: 'leg-l' },
    { bone: bones.thighR, point: new THREE.Vector3(-0.53, -0.9, 0.06), region: 'leg-r' },
    { bone: bones.shinR, point: new THREE.Vector3(-1.0, -1.54, 0.36), region: 'leg-r' },
    { bone: bones.footR, point: new THREE.Vector3(-0.48, -2.28, 0.62), region: 'leg-r' },
    { bone: bones.tail0, point: TAIL_POINTS[0], region: 'tail' },
    { bone: bones.tail1, point: TAIL_POINTS[2], region: 'tail' },
    { bone: bones.tail2, point: TAIL_POINTS[4], region: 'tail' },
    { bone: bones.tail3, point: TAIL_POINTS[6], region: 'tail' },
    { bone: bones.tail4, point: TAIL_POINTS[8], region: 'tail' },
  ];
  const orderedBones = Object.values(bones);
  const boneIndex = new Map(orderedBones.map((bone, index) => [bone, index]));
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const skinIndices = new Uint16Array(positions.count * 4);
  const skinWeights = new Float32Array(positions.count * 4);
  const vertex = new THREE.Vector3();

  const regionPenalty = (region: BoneAnchor['region'], p: THREE.Vector3): number => {
    if (region === 'head') return p.y > 0.95 && Math.abs(p.x) < 1.38 ? 0 : 2.4;
    if (region === 'arm-l') return p.x > 0.72 && p.y > -1.62 ? 0 : 2.8;
    if (region === 'arm-r') return p.x < -0.72 && p.y > -1.62 ? 0 : 2.8;
    if (region === 'leg-l') return p.x > 0.18 && p.y < -0.55 && p.z > -0.35 ? 0 : 2.4;
    if (region === 'leg-r') return p.x < -0.18 && p.y < -0.55 && p.z > -0.35 ? 0 : 2.4;
    if (region === 'tail') {
      const tailDistance = Math.min(
        ...TAIL_POINTS.slice(0, -1).map((point, i) =>
          sdCapsule(p, point, TAIL_POINTS[i + 1], THREE.MathUtils.lerp(0.42, 0.11, i / 8)),
        ),
      );
      return tailDistance < 0.3 ? 0 : 3.2;
    }
    return Math.abs(p.x) < 1.2 && p.y > -1.25 ? 0 : 1.6;
  };

  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i);
    const ranked = anchors
      .map((anchor) => ({
        anchor,
        distance: vertex.distanceTo(anchor.point) + regionPenalty(anchor.region, vertex),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 4);
    const raw = ranked.map(({ distance }) => 1 / Math.max(0.035, distance * distance));
    const total = raw.reduce((sum, value) => sum + value, 0);
    ranked.forEach(({ anchor }, slot) => {
      skinIndices[i * 4 + slot] = boneIndex.get(anchor.bone) ?? 0;
      skinWeights[i * 4 + slot] = raw[slot] / total;
    });
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
}

function markMesh(
  mesh: THREE.Mesh,
  runtime: RiggedDragonRuntime,
  id: string,
  options: RiggedDragonOptions,
  integral = false,
): THREE.Mesh {
  mesh.name = id;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.userData.explodeWithParent = integral;
  runtime.meshes[id] = mesh;
  return mesh;
}

function ellipsoid(
  center: THREE.Vector3,
  radii: THREE.Vector3,
  material: THREE.Material,
  segments = 40,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segments, Math.round(segments * 0.66)), material);
  mesh.position.copy(center);
  mesh.scale.copy(radii);
  return mesh;
}

function sweepGeometry(points: THREE.Vector3[], radii: number[], radialSegments = 16): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const tangents = points.map((point, index) => {
    if (index === 0) return points[1].clone().sub(point).normalize();
    if (index === points.length - 1) return point.clone().sub(points[index - 1]).normalize();
    return points[index + 1].clone().sub(points[index - 1]).normalize();
  });
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const fallback = new THREE.Vector3(0, 0, 1);

  points.forEach((point, index) => {
    const tangent = tangents[index];
    const reference = Math.abs(tangent.dot(fallback)) > 0.88 ? new THREE.Vector3(1, 0, 0) : fallback;
    normal.crossVectors(tangent, reference).normalize();
    binormal.crossVectors(tangent, normal).normalize();
    for (let radial = 0; radial < radialSegments; radial++) {
      const angle = (radial / radialSegments) * Math.PI * 2;
      const offset = normal
        .clone()
        .multiplyScalar(Math.cos(angle) * radii[index])
        .addScaledVector(binormal, Math.sin(angle) * radii[index]);
      positions.push(point.x + offset.x, point.y + offset.y, point.z + offset.z);
    }
  });

  for (let ring = 0; ring < points.length - 1; ring++) {
    for (let radial = 0; radial < radialSegments; radial++) {
      const next = (radial + 1) % radialSegments;
      const a = ring * radialSegments + radial;
      const b = ring * radialSegments + next;
      const c = (ring + 1) * radialSegments + next;
      const d = (ring + 1) * radialSegments + radial;
      indices.push(a, b, d, b, c, d);
    }
  }

  const startCenter = positions.length / 3;
  positions.push(points[0].x, points[0].y, points[0].z);
  const endCenter = positions.length / 3;
  const finalPoint = points[points.length - 1];
  positions.push(finalPoint.x, finalPoint.y, finalPoint.z);
  for (let radial = 0; radial < radialSegments; radial++) {
    const next = (radial + 1) % radialSegments;
    indices.push(startCenter, next, radial);
    const lastRing = (points.length - 1) * radialSegments;
    indices.push(endCenter, lastRing + radial, lastRing + next);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function sweep(points: THREE.Vector3[], radii: number[], material: THREE.Material, radialSegments = 16): THREE.Mesh {
  return new THREE.Mesh(sweepGeometry(points, radii, radialSegments), material);
}

function torusOnAxis(
  center: THREE.Vector3,
  axis: THREE.Vector3,
  radius: number,
  tube: number,
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 12, 48), material);
  mesh.position.copy(center);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
  return mesh;
}

function solidPolygon(points: THREE.Vector3[], thickness: number): THREE.BufferGeometry {
  const projected = points.map((point) => new THREE.Vector2(point.x, point.y));
  const faces = THREE.ShapeUtils.triangulateShape(projected, []);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const zOffset of [thickness * 0.5, -thickness * 0.5]) {
    for (const point of points) positions.push(point.x, point.y, point.z + zOffset);
  }
  const count = points.length;
  for (const [a, b, c] of faces) {
    indices.push(a, b, c);
    indices.push(count + c, count + b, count + a);
  }
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    indices.push(i, next, count + i, next, count + next, count + i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function subdivideGeometry(source: THREE.BufferGeometry, iterations: number): THREE.BufferGeometry {
  let positions = Array.from((source.getAttribute('position') as THREE.BufferAttribute).array as ArrayLike<number>);
  let triangles = Array.from(source.index!.array as ArrayLike<number>);

  for (let iteration = 0; iteration < iterations; iteration++) {
    const midpointCache = new Map<string, number>();
    const nextTriangles: number[] = [];
    const midpoint = (a: number, b: number): number => {
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const key = `${low}:${high}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const index = positions.length / 3;
      positions.push(
        (positions[a * 3] + positions[b * 3]) * 0.5,
        (positions[a * 3 + 1] + positions[b * 3 + 1]) * 0.5,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) * 0.5,
      );
      midpointCache.set(key, index);
      return index;
    };

    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i];
      const b = triangles[i + 1];
      const c = triangles[i + 2];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      nextTriangles.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    triangles = nextTriangles;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  source.dispose();
  return geometry;
}

function attachWorld(parent: THREE.Object3D, child: THREE.Object3D, worldPosition: THREE.Vector3): void {
  parent.updateWorldMatrix(true, false);
  child.position.copy(parent.worldToLocal(worldPosition.clone()));
  parent.add(child);
}

function attachPreservingWorld(root: THREE.Object3D, parent: THREE.Object3D, child: THREE.Object3D): void {
  root.updateWorldMatrix(true, true);
  child.updateWorldMatrix(true, true);
  parent.attach(child);
}

function createWingGeometry(side: -1 | 1): THREE.BufferGeometry {
  const points = [
    new THREE.Vector3(side * 0.72, 0.76, -0.48),
    new THREE.Vector3(side * 1.28, 1.98, -1.02),
    new THREE.Vector3(side * 2.16, 2.52, -1.72),
    new THREE.Vector3(side * 3.12, 2.72, -2.3),
    new THREE.Vector3(side * 4.02, 2.36, -2.78),
    new THREE.Vector3(side * 3.54, 1.76, -2.55),
    new THREE.Vector3(side * 3.18, 2.03, -2.34),
    new THREE.Vector3(side * 2.88, 1.42, -2.1),
    new THREE.Vector3(side * 2.48, 1.72, -1.82),
    new THREE.Vector3(side * 2.12, 1.12, -1.48),
    new THREE.Vector3(side * 1.72, 1.47, -1.12),
    new THREE.Vector3(side * 1.2, 0.83, -0.55),
  ];
  if (side < 0) points.reverse();
  const geometry = subdivideGeometry(solidPolygon(points, 0.1), 3);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    const distance = Math.abs(positions.getX(i));
    const spanT = THREE.MathUtils.clamp((distance - 0.72) / 3.3, 0, 1);
    const bow = Math.sin(spanT * Math.PI) * 0.12;
    positions.setZ(i, positions.getZ(i) - bow);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function skinWing(geometry: THREE.BufferGeometry, bones: BoneBook, side: -1 | 1): void {
  const orderedBones = Object.values(bones);
  const names = side > 0
    ? [bones.wingRootL, bones.wingElbowL, bones.wingTipL]
    : [bones.wingRootR, bones.wingElbowR, bones.wingTipR];
  const boneIndices = names.map((bone) => orderedBones.indexOf(bone));
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const indices = new Uint16Array(positions.count * 4);
  const weights = new Float32Array(positions.count * 4);
  for (let i = 0; i < positions.count; i++) {
    const distance = Math.abs(positions.getX(i));
    const t = THREE.MathUtils.clamp((distance - 0.72) / 3.3, 0, 1);
    const segment = t < 0.48 ? 0 : 1;
    const local = segment === 0 ? t / 0.48 : (t - 0.48) / 0.52;
    indices[i * 4] = boneIndices[segment];
    indices[i * 4 + 1] = boneIndices[segment + 1];
    weights[i * 4] = 1 - local;
    weights[i * 4 + 1] = local;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
}

function addHeadDetails(
  root: THREE.Group,
  bones: BoneBook,
  materials: RiggedDragonMaterials,
  runtime: RiggedDragonRuntime,
  options: RiggedDragonOptions,
): void {
  const headDetails = new THREE.Group();
  headDetails.name = 'facial-features';
  attachWorld(bones.head, headDetails, new THREE.Vector3(0, 1.55, 0.2));
  runtime.nodes[headDetails.name] = headDetails;
  runtime.destructionGroups.head = [headDetails.name];

  const muzzle = ellipsoid(
    new THREE.Vector3(0, -0.43, 0.59),
    new THREE.Vector3(0.94, 0.34, 0.5),
    materials.muzzle,
  );
  markMesh(muzzle, runtime, 'muzzle-continuous-volume', options);
  headDetails.add(muzzle);

  const lowerJaw = ellipsoid(
    new THREE.Vector3(0, -0.61, 0.52),
    new THREE.Vector3(0.8, 0.27, 0.45),
    materials.muzzle,
  );
  markMesh(lowerJaw, runtime, 'lower-jaw', options, true);
  headDetails.add(lowerJaw);
  attachPreservingWorld(root, bones.jaw, lowerJaw);

  const mouth = sweep(
    [new THREE.Vector3(-0.72, -0.47, 1.0), new THREE.Vector3(0, -0.52, 1.04), new THREE.Vector3(0.72, -0.47, 1.0)],
    [0.035, 0.045, 0.035],
    materials.cuff,
    10,
  );
  markMesh(mouth, runtime, 'mouth-seam', options, true);
  headDetails.add(mouth);

  const nose = ellipsoid(
    new THREE.Vector3(0, -0.2, 0.9),
    new THREE.Vector3(0.25, 0.17, 0.18),
    materials.body,
    32,
  );
  markMesh(nose, runtime, 'nose-bridge', options, true);
  headDetails.add(nose);

  for (const side of [-1, 1] as const) {
    const suffix = side > 0 ? 'l' : 'r';
    const maskPoints = [
      new THREE.Vector3(side * 0.06, 0.2, 0.69),
      new THREE.Vector3(side * 0.98, 0.31, 0.64),
      new THREE.Vector3(side * 0.86, -0.25, 0.72),
      new THREE.Vector3(side * 0.12, -0.17, 0.77),
    ];
    if (side < 0) maskPoints.reverse();
    const mask = new THREE.Mesh(solidPolygon(maskPoints, 0.08), materials.bodyDark);
    markMesh(mask, runtime, `eye-mask-${suffix}`, options, true);
    headDetails.add(mask);

    const eyePoints = [
      new THREE.Vector3(side * 0.12, 0.14, 0.79),
      new THREE.Vector3(side * 0.88, 0.17, 0.74),
      new THREE.Vector3(side * 0.72, -0.15, 0.82),
      new THREE.Vector3(side * 0.2, -0.12, 0.86),
    ];
    if (side < 0) eyePoints.reverse();
    const eye = new THREE.Mesh(solidPolygon(eyePoints, 0.075), materials.eye);
    markMesh(eye, runtime, `eye-${suffix}`, options);
    headDetails.add(eye);

    const pupil = ellipsoid(
      new THREE.Vector3(side * 0.49, 0.0, 0.91),
      new THREE.Vector3(0.065, 0.14, 0.035),
      materials.pupil,
      28,
    );
    pupil.rotation.z = side * -0.18;
    markMesh(pupil, runtime, `pupil-${suffix}`, options, true);
    headDetails.add(pupil);

    const brow = sweep(
      [
        new THREE.Vector3(side * 0.05, 0.28, 0.7),
        new THREE.Vector3(side * 0.48, 0.29, 0.8),
        new THREE.Vector3(side * 0.93, 0.16, 0.68),
      ],
      [0.12, 0.13, 0.045],
      materials.body,
      14,
    );
    markMesh(brow, runtime, `brow-${suffix}`, options, true);
    headDetails.add(brow);

    const nostril = ellipsoid(
      new THREE.Vector3(side * 0.11, -0.22, 1.06),
      new THREE.Vector3(0.08, 0.045, 0.035),
      materials.cuff,
      24,
    );
    markMesh(nostril, runtime, `nostril-${suffix}`, options, true);
    headDetails.add(nostril);

    for (const [fangIndex, x] of [[0, 0.72], [1, 0.32]] as const) {
      const fang = sweep(
        [
          new THREE.Vector3(side * x, -0.38, 1.02),
          new THREE.Vector3(side * x, -0.68 - fangIndex * 0.03, 1.08),
        ],
        [fangIndex === 0 ? 0.11 : 0.08, 0.008],
        materials.ivory,
        16,
      );
      markMesh(fang, runtime, `fang-${suffix}-${fangIndex}`, options);
      headDetails.add(fang);
    }
  }
}

function addEarsHornsAndEarring(
  bones: BoneBook,
  materials: RiggedDragonMaterials,
  runtime: RiggedDragonRuntime,
  options: RiggedDragonOptions,
): void {
  const rearCranialShell = ellipsoid(
    new THREE.Vector3(0, 1.19, -0.62),
    new THREE.Vector3(1.05, 0.48, 0.3),
    materials.body,
    42,
  );
  markMesh(rearCranialShell, runtime, 'rear-cranial-shell', options, true);
  bones.head.add(rearCranialShell);
  rearCranialShell.position.sub(new THREE.Vector3(0, 1.55, 0.2));

  for (const side of [-1, 1] as const) {
    const suffix = side > 0 ? 'l' : 'r';
    const rimPoints = [
      new THREE.Vector3(side * 0.82, 1.72, 0.26),
      new THREE.Vector3(side * 1.78, 2.56, 0.8),
      new THREE.Vector3(side * 1.38, 1.34, 0.55),
    ];
    const outerPoints = rimPoints.map((point) => point.clone());
    if (side < 0) outerPoints.reverse();
    const ear = new THREE.Mesh(solidPolygon(outerPoints, 0.3), materials.body);
    markMesh(ear, runtime, `ear-${suffix}`, options);
    bones.head.add(ear);
    ear.position.sub(new THREE.Vector3(0, 1.55, 0.2));

    const earRim = sweep(rimPoints, [0.16, 0.08, 0.13], materials.body, 16);
    markMesh(earRim, runtime, `ear-${suffix}-rim`, options, true);
    bones.head.add(earRim);
    earRim.position.sub(new THREE.Vector3(0, 1.55, 0.2));

    const innerPoints = [
      new THREE.Vector3(side * 1.02, 1.76, 0.56),
      new THREE.Vector3(side * 1.58, 2.32, 0.96),
      new THREE.Vector3(side * 1.35, 1.49, 0.76),
    ];
    if (side < 0) innerPoints.reverse();
    const inner = new THREE.Mesh(solidPolygon(innerPoints, 0.055), materials.innerEar);
    markMesh(inner, runtime, `ear-${suffix}-inner`, options, true);
    bones.head.add(inner);
    inner.position.sub(new THREE.Vector3(0, 1.55, 0.2));

    const earCavity = ellipsoid(
      new THREE.Vector3(side * 1.31, 1.88, 0.88),
      new THREE.Vector3(0.16, 0.42, 0.08),
      materials.innerEar,
      28,
    );
    earCavity.rotation.z = side * -0.36;
    markMesh(earCavity, runtime, `ear-${suffix}-cavity`, options, true);
    bones.head.add(earCavity);
    earCavity.position.sub(new THREE.Vector3(0, 1.55, 0.2));

    const horn = sweep(
      [
        new THREE.Vector3(side * 0.36, 2.06, -0.02),
        new THREE.Vector3(side * 0.34, 2.56, -0.28),
        new THREE.Vector3(side * 0.48, 3.02, -0.62),
        new THREE.Vector3(side * 0.73, 3.38, -0.88),
        new THREE.Vector3(side * 0.88, 3.43, -0.74),
      ],
      [0.36, 0.31, 0.22, 0.095, 0.012],
      materials.horn,
      22,
    );
    markMesh(horn, runtime, `horn-${suffix}`, options);
    bones.head.add(horn);
    horn.position.sub(new THREE.Vector3(0, 1.55, 0.2));

    for (const ridgeOffset of [-0.08, 0.08]) {
      const ridge = sweep(
        [
          new THREE.Vector3(side * (0.36 + ridgeOffset), 2.12, 0.23),
          new THREE.Vector3(side * (0.35 + ridgeOffset), 2.57, -0.04),
          new THREE.Vector3(side * (0.48 + ridgeOffset * 0.7), 3.01, -0.39),
          new THREE.Vector3(side * (0.7 + ridgeOffset * 0.4), 3.34, -0.66),
        ],
        [0.018, 0.016, 0.012, 0.004],
        materials.cuff,
        8,
      );
      markMesh(
        ridge,
        runtime,
        `horn-${suffix}-ridge-${ridgeOffset > 0 ? 'outer' : 'inner'}`,
        options,
        true,
      );
      bones.head.add(ridge);
      ridge.position.sub(new THREE.Vector3(0, 1.55, 0.2));
    }
  }

  const ring = torusOnAxis(
    new THREE.Vector3(1.53, 1.82, 0.36),
    new THREE.Vector3(0, 0, 1),
    0.23,
    0.07,
    materials.gold,
  );
  markMesh(ring, runtime, 'earring-l', options);
  bones.head.add(ring);
  ring.position.sub(new THREE.Vector3(0, 1.55, 0.2));
}

function addWings(
  root: THREE.Group,
  bones: BoneBook,
  skeleton: THREE.Skeleton,
  materials: RiggedDragonMaterials,
  runtime: RiggedDragonRuntime,
  options: RiggedDragonOptions,
): void {
  for (const side of [-1, 1] as const) {
    const suffix = side > 0 ? 'l' : 'r';
    const geometry = createWingGeometry(side);
    skinWing(geometry, bones, side);
    const wing = new THREE.SkinnedMesh(geometry, materials.membrane);
    markMesh(wing, runtime, `wing-${suffix}-membrane`, options);
    root.add(wing);
    wing.bindMode = THREE.AttachedBindMode;
    wing.bind(skeleton);
    runtime.nodes[`wing-${suffix}`] = wing;
    (runtime.destructionGroups.wings ??= []).push(`wing-${suffix}`);

    const rootPoint = new THREE.Vector3(side * 0.73, 0.77, -0.42);
    const elbowPoint = new THREE.Vector3(side * 2.16, 2.52, -1.72);
    const tipPoint = new THREE.Vector3(side * 4.04, 2.36, -2.78);
    const leading = sweep(
      [rootPoint, elbowPoint, tipPoint],
      [0.22, 0.17, 0.045],
      materials.horn,
      18,
    );
    markMesh(leading, runtime, `wing-${suffix}-leading-spar`, options, true);
    root.add(leading);
    attachPreservingWorld(
      root,
      side > 0 ? bones.wingRootL : bones.wingRootR,
      leading,
    );

    const lower = sweep(
      [rootPoint, new THREE.Vector3(side * 1.72, 1.47, -1.12), new THREE.Vector3(side * 2.15, 1.12, -1.48)],
      [0.18, 0.11, 0.035],
      materials.horn,
      16,
    );
    markMesh(lower, runtime, `wing-${suffix}-lower-spar`, options, true);
    root.add(lower);
    attachPreservingWorld(
      root,
      side > 0 ? bones.wingRootL : bones.wingRootR,
      lower,
    );

    const radial = sweep(
      [elbowPoint, new THREE.Vector3(side * 2.55, 1.9, -1.92), new THREE.Vector3(side * 2.9, 1.43, -2.1)],
      [0.13, 0.075, 0.025],
      materials.horn,
      14,
    );
    markMesh(radial, runtime, `wing-${suffix}-radial-spar`, options, true);
    root.add(radial);
    attachPreservingWorld(
      root,
      side > 0 ? bones.wingElbowL : bones.wingElbowR,
      radial,
    );
  }
}

function addHandsFeetAndAccessories(
  root: THREE.Group,
  bones: BoneBook,
  materials: RiggedDragonMaterials,
  runtime: RiggedDragonRuntime,
  options: RiggedDragonOptions,
): void {
  for (const side of [-1, 1] as const) {
    const suffix = side > 0 ? 'l' : 'r';
    const handCenter = new THREE.Vector3(side * 1.84, -1.22, 0.76);
    const handBone = side > 0 ? bones.handL : bones.handR;
    const handGroup = new THREE.Group();
    handGroup.name = `hand-detail-${suffix}`;
    attachWorld(handBone, handGroup, handCenter);
    runtime.nodes[handGroup.name] = handGroup;
    (runtime.destructionGroups.hands ??= []).push(handGroup.name);
    for (let finger = 0; finger < 4; finger++) {
      const spread = (finger - 1.5) * 0.095;
      const fingerMesh = sweep(
        [
          new THREE.Vector3(side * spread, 0.03 + Math.abs(spread) * 0.1, 0.16),
          new THREE.Vector3(side * (spread + 0.16), -0.08, 0.21),
          new THREE.Vector3(side * (spread + 0.18), -0.25, 0.08),
          new THREE.Vector3(side * spread, -0.31, -0.05),
        ],
        [0.13, 0.12, 0.085, 0.035],
        materials.body,
        12,
      );
      markMesh(fingerMesh, runtime, `finger-${suffix}-${finger}`, options, true);
      handGroup.add(fingerMesh);
      const claw = sweep(
        [
          new THREE.Vector3(side * spread, -0.31, -0.05),
          new THREE.Vector3(side * (spread - 0.03), -0.4, -0.13),
          new THREE.Vector3(side * (spread - 0.09), -0.43, -0.22),
        ],
        [0.045, 0.025, 0.004],
        materials.horn,
        10,
      );
      markMesh(claw, runtime, `claw-${suffix}-${finger}`, options, true);
      handGroup.add(claw);
    }

    const fingerCurl = new THREE.Mesh(
      new THREE.TorusGeometry(0.2, 0.09, 12, 40, Math.PI * 1.64),
      materials.body,
    );
    fingerCurl.position.set(side * -0.01, -0.1, 0.24);
    fingerCurl.rotation.z = side > 0 ? -0.48 : Math.PI + 0.48;
    markMesh(fingerCurl, runtime, `finger-curl-${suffix}`, options, true);
    handGroup.add(fingerCurl);

    const elbow = new THREE.Vector3(side * 1.48, -0.08, 0.43);
    const wrist = new THREE.Vector3(side * 1.72, -0.86, 0.68);
    const axis = wrist.clone().sub(elbow).normalize();
    const cuffCenter = elbow.clone().lerp(wrist, 0.65);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.49, 0.62, 40), materials.cuff);
    cuff.position.copy(cuffCenter);
    cuff.quaternion.setFromUnitVectors(Y_AXIS, axis);
    markMesh(cuff, runtime, `cuff-${suffix}`, options);
    root.add(cuff);
    attachPreservingWorld(root, side > 0 ? bones.forearmL : bones.forearmR, cuff);
    for (const offset of [-0.31, 0.31]) {
      const ring = torusOnAxis(cuffCenter.clone().addScaledVector(axis, offset), axis, 0.49, 0.075, materials.gold);
      markMesh(ring, runtime, `cuff-${suffix}-gold-${offset > 0 ? 'wrist' : 'elbow'}`, options, true);
      root.add(ring);
      attachPreservingWorld(root, side > 0 ? bones.forearmL : bones.forearmR, ring);
    }

    const ankle = new THREE.Vector3(side * 0.48, -2.26, 0.62);
    const foot = sweep(
      [
        ankle,
        new THREE.Vector3(side * 0.47, -2.49, 0.76),
        new THREE.Vector3(side * 0.48, -2.78, 0.9),
      ],
      [0.25, 0.3, 0.025],
      materials.horn,
      22,
    );
    markMesh(foot, runtime, `hoof-${suffix}`, options);
    root.add(foot);
    attachPreservingWorld(root, side > 0 ? bones.footL : bones.footR, foot);
    const ankleRing = torusOnAxis(ankle, new THREE.Vector3(side * -0.25, -0.94, 0.18), 0.25, 0.06, materials.gold);
    markMesh(ankleRing, runtime, `ankle-ring-${suffix}`, options, true);
    root.add(ankleRing);
    attachPreservingWorld(root, side > 0 ? bones.footL : bones.footR, ankleRing);
  }

  for (const side of [-1, 1] as const) {
    for (let stripe = 0; stripe < 3; stripe++) {
      const y = 0.48 - stripe * 0.1;
      const stripeMesh = sweep(
        [
          new THREE.Vector3(side * 0.7, y + 0.08, 0.58),
          new THREE.Vector3(side * 0.98, y + 0.04, 0.68),
          new THREE.Vector3(side * 1.28, y - 0.1, 0.58),
        ],
        [0.026, 0.03, 0.022],
        materials.bodyDark,
        10,
      );
      markMesh(stripeMesh, runtime, `arm-stripe-${side > 0 ? 'l' : 'r'}-${stripe}`, options, true);
      root.add(stripeMesh);
      attachPreservingWorld(root, side > 0 ? bones.upperArmL : bones.upperArmR, stripeMesh);
    }
  }

  const collar = torusOnAxis(
    new THREE.Vector3(0, 0.91, 0.25),
    new THREE.Vector3(0, 1, 0),
    0.73,
    0.105,
    materials.strap,
  );
  collar.scale.z = 0.8;
  markMesh(collar, runtime, 'collar-dark-band', options);
  root.add(collar);
  attachPreservingWorld(root, bones.neck, collar);
  const collarRing = torusOnAxis(
    new THREE.Vector3(0, 0.68, 0.68),
    new THREE.Vector3(0, 0, 1),
    0.23,
    0.065,
    materials.gold,
  );
  markMesh(collarRing, runtime, 'collar-gold-ring', options);
  root.add(collarRing);
  attachPreservingWorld(root, bones.chest, collarRing);
  const pendant = ellipsoid(
    new THREE.Vector3(0, 0.3, 0.72),
    new THREE.Vector3(0.23, 0.27, 0.11),
    materials.gold,
    32,
  );
  markMesh(pendant, runtime, 'collar-pendant', options);
  root.add(pendant);
  attachPreservingWorld(root, bones.chest, pendant);

  const belt = torusOnAxis(
    new THREE.Vector3(0, -0.82, 0.02),
    new THREE.Vector3(0, 1, 0),
    0.76,
    0.11,
    materials.strap,
  );
  belt.scale.z = 0.85;
  markMesh(belt, runtime, 'waist-belt', options);
  root.add(belt);
  attachPreservingWorld(root, bones.pelvis, belt);
  const clothPoints = [
    new THREE.Vector3(-0.66, -0.83, 0.58),
    new THREE.Vector3(0.66, -0.83, 0.58),
    new THREE.Vector3(0.57, -1.64, 0.62),
    new THREE.Vector3(0.27, -1.43, 0.64),
    new THREE.Vector3(0, -1.78, 0.65),
    new THREE.Vector3(-0.28, -1.43, 0.64),
    new THREE.Vector3(-0.58, -1.63, 0.62),
  ];
  const loincloth = new THREE.Mesh(solidPolygon(clothPoints, 0.11), materials.cloth);
  markMesh(loincloth, runtime, 'torn-loincloth-front', options);
  root.add(loincloth);
  attachPreservingWorld(root, bones.pelvis, loincloth);

  const rearClothPoints = [
    new THREE.Vector3(-0.62, -0.83, -0.56),
    new THREE.Vector3(0.62, -0.83, -0.56),
    new THREE.Vector3(0.55, -1.48, -0.62),
    new THREE.Vector3(0.22, -1.34, -0.64),
    new THREE.Vector3(0, -1.65, -0.65),
    new THREE.Vector3(-0.22, -1.34, -0.64),
    new THREE.Vector3(-0.55, -1.48, -0.62),
  ];
  const rearLoincloth = new THREE.Mesh(solidPolygon(rearClothPoints, 0.1), materials.cloth);
  markMesh(rearLoincloth, runtime, 'torn-loincloth-rear', options);
  root.add(rearLoincloth);
  attachPreservingWorld(root, bones.pelvis, rearLoincloth);

  const throatPatch = ellipsoid(
    new THREE.Vector3(0, 0.61, 0.69),
    new THREE.Vector3(0.39, 0.35, 0.16),
    materials.muzzle,
    34,
  );
  markMesh(throatPatch, runtime, 'warm-throat-patch', options, true);
  root.add(throatPatch);
  attachPreservingWorld(root, bones.chest, throatPatch);

  const finalTail = TAIL_POINTS[TAIL_POINTS.length - 1];
  const previousTail = TAIL_POINTS[TAIL_POINTS.length - 2];
  const tailAxis = finalTail.clone().sub(previousTail).normalize();
  const tailRing = torusOnAxis(finalTail.clone().addScaledVector(tailAxis, -0.05), tailAxis, 0.14, 0.055, materials.gold);
  markMesh(tailRing, runtime, 'tail-gold-ring', options);
  root.add(tailRing);
  attachPreservingWorld(root, bones.tail4, tailRing);
  const normal = new THREE.Vector3(-tailAxis.y, tailAxis.x, 0).normalize();
  const arrowBase = finalTail.clone().addScaledVector(tailAxis, 0.02);
  const arrowPoints = [
    arrowBase.clone().addScaledVector(normal, 0.34),
    arrowBase.clone().addScaledVector(tailAxis, 0.82),
    arrowBase.clone().addScaledVector(normal, -0.34),
    arrowBase.clone().addScaledVector(tailAxis, 0.2),
  ];
  const arrow = new THREE.Mesh(solidPolygon(arrowPoints, 0.18), materials.body);
  markMesh(arrow, runtime, 'tail-arrowhead', options);
  root.add(arrow);
  attachPreservingWorld(root, bones.tail4, arrow);
}

export function createRiggedDragon(
  materials: RiggedDragonMaterials,
  options: RiggedDragonOptions = {},
): { root: THREE.Group; runtime: RiggedDragonRuntime } {
  const root = new THREE.Group();
  root.name = 'Vijay Ghume Mini Dragon Character';
  const bones = createBones();
  const orderedBones = Object.values(bones);
  const skeleton = new THREE.Skeleton(orderedBones);

  const bodyGeometry = extractBodySurface(options.wireframe ? 44 : 66);
  skinBody(bodyGeometry, bones);
  const body = new THREE.SkinnedMesh(bodyGeometry, materials.body);
  body.name = 'continuous-rigged-body';
  body.castShadow = options.castShadow ?? true;
  body.receiveShadow = options.receiveShadow ?? true;
  body.add(bones.root);
  body.bind(skeleton);
  root.add(body);

  const runtime: RiggedDragonRuntime = {
    body,
    skeleton,
    bones,
    nodes: { body },
    meshes: { body },
    sockets: {},
    colliders: {
      body: { type: 'continuous-implicit-surface', bounds: [MODEL_MIN.toArray(), MODEL_MAX.toArray()] },
      wings: { type: 'skinned-membranes' },
      tail: { type: 'continuous-body-tail-chain', points: TAIL_POINTS.map((point) => point.toArray()) },
    },
    destructionGroups: { body: ['continuous-rigged-body'] },
  };

  addWings(root, bones, skeleton, materials, runtime, options);
  addHeadDetails(root, bones, materials, runtime, options);
  addEarsHornsAndEarring(bones, materials, runtime, options);
  addHandsFeetAndAccessories(root, bones, materials, runtime, options);

  const sockets: Record<string, [THREE.Bone, THREE.Vector3]> = {
    'head-socket': [bones.head, new THREE.Vector3(0, 0, 0.45)],
    'hand-l-socket': [bones.handL, new THREE.Vector3(0.1, -0.35, 0.08)],
    'hand-r-socket': [bones.handR, new THREE.Vector3(-0.1, -0.35, 0.08)],
    'tail-socket': [bones.tail4, new THREE.Vector3(0.2, 0, 0)],
    'wing-l-socket': [bones.wingRootL, new THREE.Vector3()],
    'wing-r-socket': [bones.wingRootR, new THREE.Vector3()],
  };
  for (const [name, [bone, position]] of Object.entries(sockets)) {
    const socket = new THREE.Object3D();
    socket.name = name;
    socket.position.copy(position);
    bone.add(socket);
    runtime.sockets[name] = socket;
  }

  root.userData.sculptRuntime = runtime;
  root.userData.rig = {
    type: 'THREE.SkinnedMesh',
    skeleton,
    bones,
    bodyMesh: body,
    wingMeshes: [runtime.meshes['wing-l-membrane'], runtime.meshes['wing-r-membrane']],
  };

  let time = 0;
  root.userData.tick = (delta: number) => {
    time += delta;
    root.position.y = Math.sin(time * 1.25) * 0.035;
    bones.head.rotation.y = Math.sin(time * 0.55) * 0.035;
    bones.jaw.rotation.x = Math.sin(time * 0.7) * 0.015;
    bones.wingRootL.rotation.z = Math.sin(time * 1.45) * 0.045;
    bones.wingRootR.rotation.z = -Math.sin(time * 1.45) * 0.045;
    bones.wingElbowL.rotation.z = Math.sin(time * 1.45 + 0.4) * 0.025;
    bones.wingElbowR.rotation.z = -Math.sin(time * 1.45 + 0.4) * 0.025;
    bones.tail2.rotation.z = Math.sin(time * 0.72) * 0.035;
    bones.tail3.rotation.z = Math.sin(time * 0.72 + 0.6) * 0.045;
  };

  return { root, runtime };
}
