import * as THREE from 'three';
import { createGloveSurfaceMaterials, type GloveSurfaceMaterials } from './demos/sport-gloves-hedge-maze/gloveTextures';

export interface GloveModelOptions {
  readonly shadows?: boolean;
}

type Point = [number, number, number];

const PROJECTION_BOUNDS = {
  minX: -0.65,
  maxX: 1.26,
  minY: -1.25,
  maxY: 1.725,
} as const;

function materialArray(
  front: THREE.MeshPhysicalMaterial,
  back: THREE.MeshPhysicalMaterial,
): THREE.MeshPhysicalMaterial[] {
  return [front, back];
}

function applyProjectedUvs(geometry: THREE.BufferGeometry, offset: Point): void {
  const position = geometry.getAttribute('position');
  const uvs = new Float32Array(position.count * 2);
  const width = PROJECTION_BOUNDS.maxX - PROJECTION_BOUNDS.minX;
  const height = PROJECTION_BOUNDS.maxY - PROJECTION_BOUNDS.minY;
  for (let index = 0; index < position.count; index += 1) {
    const worldX = position.getX(index) + offset[0];
    const worldY = position.getY(index) + offset[1];
    uvs[index * 2] = THREE.MathUtils.clamp((worldX - PROJECTION_BOUNDS.minX) / width, 0, 1);
    uvs[index * 2 + 1] = THREE.MathUtils.clamp((worldY - PROJECTION_BOUNDS.minY) / height, 0, 1);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function createEllipsoidGeometry(
  width: number,
  height: number,
  depth: number,
  latitudeSegments = 28,
  longitudeSegments = 44,
  profilePower = 1,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const frontIndices: number[] = [];
  const backIndices: number[] = [];
  for (let lat = 0; lat <= latitudeSegments; lat += 1) {
    const v = lat / latitudeSegments;
    const phi = v * Math.PI - Math.PI * 0.5;
    const cosPhi = Math.cos(phi);
    for (let lon = 0; lon <= longitudeSegments; lon += 1) {
      const u = lon / longitudeSegments;
      const theta = u * Math.PI * 2;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);
      const sinPhi = Math.sin(phi);
      const crossProfile = Math.pow(Math.max(0, cosPhi), profilePower);
      const heightProfile = Math.sign(sinPhi) * Math.pow(Math.abs(sinPhi), profilePower);
      const x = crossProfile * cosTheta * width;
      const y = heightProfile * height;
      const z = crossProfile * sinTheta * depth;
      positions.push(x, y, z);
      normals.push(x / (width * width), y / (height * height), z / (depth * depth));
      uvs.push(0.5 + x / (2 * width), 0.5 + y / (2 * height));
    }
  }
  const rowLength = longitudeSegments + 1;
  for (let lat = 0; lat < latitudeSegments; lat += 1) {
    for (let lon = 0; lon < longitudeSegments; lon += 1) {
      const a = lat * rowLength + lon;
      const b = a + 1;
      const c = a + rowLength;
      const d = c + 1;
      const centerZ = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2] + positions[d * 3 + 2]) * 0.25;
      const target = centerZ > 0 ? frontIndices : backIndices;
      target.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([...frontIndices, ...backIndices]);
  geometry.clearGroups();
  geometry.addGroup(0, frontIndices.length, 0);
  geometry.addGroup(frontIndices.length, backIndices.length, 1);
  geometry.computeVertexNormals();
  return geometry;
}

function createCurvedTubeGeometry(
  points: readonly Point[],
  radius: number,
  tubularSegments = 22,
  radialSegments = 36,
  depthScale = 0.85,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const frontIndices: number[] = [];
  const backIndices: number[] = [];
  const sideIndices: number[] = [];
  const tipFrontIndices: number[] = [];
  const tipBackIndices: number[] = [];
  const tipCrownIndices: number[] = [];
  const ringCenterDepths: number[] = [];
  const ringRadii: number[] = [];
  const tipRings: boolean[] = [];
  const ringLength = radialSegments + 1;

  const addRing = (center: THREE.Vector3, tangent: THREE.Vector3, ringRadius: number, u: number, frameIndex: number, capSide?: 'start' | 'end', capAngle?: number): void => {
    ringCenterDepths.push(center.z);
    ringRadii.push(ringRadius);
    tipRings.push(capSide === 'end');
    for (let radial = 0; radial <= radialSegments; radial += 1) {
      const angle = radial / radialSegments * Math.PI * 2;
      const radialDirection = frames.normals[frameIndex].clone().multiplyScalar(Math.cos(angle))
        .add(frames.binormals[frameIndex].clone().multiplyScalar(Math.sin(angle))).normalize();
      let normal = radialDirection;
      if (capSide && capAngle !== undefined) {
        const axialSign = capSide === 'start' ? -1 : 1;
        normal = radialDirection.clone().multiplyScalar(Math.sin(capAngle))
          .addScaledVector(tangent, axialSign * Math.cos(capAngle)).normalize();
      }
      const vertex = center.clone().addScaledVector(radialDirection, ringRadius);
      vertex.z = center.z + (vertex.z - center.z) * depthScale;
      normal = new THREE.Vector3(normal.x, normal.y, normal.z / depthScale).normalize();
      positions.push(vertex.x, vertex.y, vertex.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(u, radial / radialSegments);
    }
  };

  const capSegments = 7;
  const startCapLength = radius * 0.38;
  const endCapLength = radius * 0.52;
  const start = curve.getPointAt(0);
  const startTangent = frames.tangents[0].clone().normalize();
  for (let cap = 0; cap <= capSegments; cap += 1) {
    const angle = cap / capSegments * Math.PI * 0.5;
    const center = start.clone().addScaledVector(startTangent, -startCapLength * Math.cos(angle));
    addRing(center, startTangent, radius * 1.3 * Math.sin(angle), 0, 0, 'start', angle);
  }

  for (let segment = 1; segment < tubularSegments; segment += 1) {
    const t = segment / tubularSegments;
    const point = curve.getPointAt(t);
    const taper = 0.96 + Math.sin(Math.PI * t) * 0.04;
    const baseFlare = 1 + Math.max(0, 1 - t / 0.35) * 0.35;
    addRing(point, frames.tangents[segment].clone().normalize(), radius * taper * baseFlare, t, segment);
  }

  const end = curve.getPointAt(1);
  const endTangent = frames.tangents[tubularSegments].clone().normalize();
  for (let cap = 0; cap <= capSegments; cap += 1) {
    const angle = Math.PI * 0.5 - cap / capSegments * Math.PI * 0.5;
    const center = end.clone().addScaledVector(endTangent, endCapLength * Math.cos(angle));
    const tipProfile = Math.pow(Math.sin(angle), 0.78);
    addRing(
      center,
      endTangent,
      radius * 0.95 * tipProfile,
      cap / capSegments,
      tubularSegments,
      'end',
      angle,
    );
  }

  const ringCount = positions.length / 3 / ringLength;
  const faceCenterZ = (a: number, b: number, c: number, d: number): number => (
    positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2] + positions[d * 3 + 2]
  ) * 0.25;
  for (let segment = 0; segment < ringCount - 1; segment += 1) {
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const a = segment * ringLength + radial;
      const b = a + 1;
      const c = a + ringLength;
      const d = c + 1;
      const centerDepth = (ringCenterDepths[segment] + ringCenterDepths[segment + 1]) * 0.5;
      const relativeDepth = faceCenterZ(a, b, c, d) - centerDepth;
      const faceRadius = (ringRadii[segment] + ringRadii[segment + 1]) * 0.5;
      const isSide = Math.abs(relativeDepth) <= faceRadius * depthScale * 0.18;
      const isTip = tipRings[segment] === true && tipRings[segment + 1] === true;
      const target = isTip
        ? isSide
          ? tipCrownIndices
          : relativeDepth > 0 ? tipFrontIndices : tipBackIndices
        : isSide
          ? sideIndices
          : relativeDepth > 0 ? frontIndices : backIndices;
      target.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([...frontIndices, ...backIndices, ...sideIndices, ...tipFrontIndices, ...tipBackIndices, ...tipCrownIndices]);
  geometry.clearGroups();
  geometry.addGroup(0, frontIndices.length, 0);
  geometry.addGroup(frontIndices.length, backIndices.length, 1);
  geometry.addGroup(frontIndices.length + backIndices.length, sideIndices.length, 2);
  geometry.addGroup(frontIndices.length + backIndices.length + sideIndices.length, tipFrontIndices.length, 3);
  geometry.addGroup(frontIndices.length + backIndices.length + sideIndices.length + tipFrontIndices.length, tipBackIndices.length, 4);
  geometry.addGroup(frontIndices.length + backIndices.length + sideIndices.length + tipFrontIndices.length + tipBackIndices.length, tipCrownIndices.length, 5);
  return geometry;
}

function addBaseMesh(
  root: THREE.Group,
  name: string,
  geometry: THREE.BufferGeometry,
  materials: THREE.MeshPhysicalMaterial[],
  position: Point,
  shadows: boolean,
  module: string,
): THREE.Mesh {
  const authoredUv = geometry.getAttribute('uv');
  if (authoredUv) geometry.setAttribute('uv1', authoredUv.clone());
  applyProjectedUvs(geometry, position);
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.userData.gloveBaseComponent = true;
  mesh.userData.gloveModule = module;
  root.add(mesh);
  return mesh;
}

export function createGloveModel(options: GloveModelOptions = {}): THREE.Group {
  const shadows = options.shadows ?? true;
  const materials: GloveSurfaceMaterials = createGloveSurfaceMaterials();
  const root = new THREE.Group();
  root.name = 'sport-gloves-hedge-maze-organic';

  addBaseMesh(root, 'organic-palm-shell', createEllipsoidGeometry(0.82, 0.66, 0.16, 28, 44, 0.4), materialArray(materials.dorsal, materials.palmar), [0.23, -0.38, 0], shadows, 'palm');
  const wristShell = addBaseMesh(root, 'organic-wrist-shell', createEllipsoidGeometry(0.72, 0.25, 0.15, 18, 36), materialArray(materials.dorsal, materials.palmar), [0.17, -1, 0], shadows, 'cuff');
  const cuffBridge = addBaseMesh(root, 'organic-cuff-bridge-liner', createEllipsoidGeometry(0.72, 0.4, 0.1, 18, 36), materialArray(materials.dorsal, materials.palmar), [0.17, -0.84, 0], shadows, 'cuff');
  cuffBridge.userData.gloveBaseComponent = false;
  cuffBridge.userData.explodeWithParent = true;
  wristShell.attach(cuffBridge);
  const thumbSaddle = addBaseMesh(root, 'organic-thumb-saddle-liner', createEllipsoidGeometry(0.34, 0.45, 0.17, 18, 32), materialArray(materials.dorsal, materials.palmar), [0.7, -0.13, 0], shadows, 'thumb');
  thumbSaddle.userData.gloveBaseComponent = false;
  thumbSaddle.userData.explodeWithParent = true;

  const fingers: ReadonlyArray<{ readonly id: string; readonly points: readonly Point[]; readonly radius: number }> = [
    { id: 'little', radius: 0.16, points: [[-0.45, 0.07, 0], [-0.48, 0.52, 0.012], [-0.48, 0.94, 0.018], [-0.47, 1.2, 0.01]] },
    { id: 'ring', radius: 0.18, points: [[-0.1, 0.08, 0], [-0.12, 0.64, 0.016], [-0.11, 1.12, 0.018], [-0.1, 1.46, 0.008]] },
    { id: 'middle', radius: 0.19, points: [[0.31, 0.09, 0], [0.31, 0.68, 0.018], [0.32, 1.24, 0.018], [0.32, 1.63, 0.006]] },
    { id: 'index', radius: 0.18, points: [[0.78, 0.08, 0], [0.8, 0.64, 0.016], [0.82, 1.2, 0.018], [0.84, 1.53, 0.008]] },
  ];
  for (const finger of fingers) {
    addBaseMesh(root, `${finger.id}-finger-shell`, createCurvedTubeGeometry(finger.points, finger.radius), [materials.fingerPalmar, materials.fingerDorsal, materials.side, materials.tipPalmar, materials.tipDorsal, materials.tipCrown], [0, 0, 0], shadows, 'fingerStalls');
  }
  const thumbPoints: readonly Point[] = [[0.68, -0.42, 0], [0.89, -0.14, -0.01], [1.07, 0.32, -0.015], [1.08, 0.82, 0.006]];
  const thumbShell = addBaseMesh(root, 'thumb-organic-shell', createCurvedTubeGeometry(thumbPoints, 0.19, 26, 40), [materials.thumbPalmar, materials.thumbDorsal, materials.side, materials.tipPalmar, materials.tipDorsal, materials.tipCrown], [0, 0, 0], shadows, 'thumb');
  thumbShell.attach(thumbSaddle);

  root.userData.sculptRuntime = {
    version: 'glove-organic-runtime-v3',
    provenance: {
      route: 'reference-projection',
      exactnessTier: 'image-only',
      familyAdapter: 'procedural-organic-glove-v1',
      thicknessConfidence: 0.32,
      inferred: ['organic shell thickness', 'hidden lining', 'thumb gusset depth', 'palm cavity'],
    },
    sockets: {
      wrist: { parent: 'organic-wrist-shell', position: [0.17, -1.02, 0] },
      palm: { parent: 'organic-palm-shell', position: [0.23, -0.24, 0] },
      fingers: { parent: 'organic-palm-shell', position: [0.23, 0.3, 0] },
      thumb: { parent: 'organic-palm-shell', position: [0.76, -0.4, 0] },
    },
    destructionGroups: {
      palm: ['organic-palm-shell'],
      cuff: ['organic-wrist-shell'],
      fingerStalls: fingers.map((finger) => `${finger.id}-finger-shell`),
      thumb: ['thumb-organic-shell'],
    },
    attachments: {
      fingers: { parentSocket: 'fingers', localStart: [0, 0.28, 0], localEnd: [0, 1.64, 0], contactType: 'sewn-overlap', overlap: 0.08, gapTolerance: 0.02 },
      thumb: { parentSocket: 'thumb', localStart: [0.76, -0.4, 0], localEnd: [1.08, 0.82, 0], contactType: 'gusset-overlap', overlap: 0.09, gapTolerance: 0.02 },
      cuff: { parentSocket: 'wrist', localStart: [0.17, -0.98, 0], localEnd: [0.17, -1.2, 0], contactType: 'sewn-overlap', overlap: 0.08, gapTolerance: 0.02 },
    },
  };
  return root;
}
