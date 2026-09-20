import * as THREE from 'three';

import type { PianoModel } from '../PerformanceRig';
import {
  createProceduralPhysicalMaterial,
  createProceduralStandardMaterial,
} from '../../materials/proceduralMaterials';

/**
 * A procedural concert grand built in metres.  The keyboard is on +Z (the
 * audience side), X runs across the 88 notes, and Y=0 is the floor contact
 * plane.  No imported mesh is needed at runtime; repeated detail uses shared
 * geometry or instancing while every playable key keeps its own pivot node.
 */

export const PIANO_FIRST_MIDI = 21;
export const PIANO_LAST_MIDI = 108;
export const PIANO_WHITE_KEY_COUNT = 52;
export const PIANO_BLACK_KEY_COUNT = 36;
export const PIANO_BODY_WIDTH = 1.68;
export const PIANO_BODY_DEPTH = 2.34;

// This stylised grand uses the left rim as its continuous lid hinge.  The
// keyboard remains on +Z, while the lid spans the piano's depth and lifts
// across +X about a positive local-Z rotation.  It starts part-open so the
// moving panel clears the separate music desk during the opening cue.
export const PIANO_LID_START_ANGLE_RADIANS = 0.38;
export const PIANO_LID_PERFORMANCE_OPEN_ANGLE_RADIANS = 0.86;
export const PIANO_LID_OPENING_DURATION_SECONDS = 3;

// The support deploys after the lid reaches its over-open pose, then the lid
// settles onto the fixed-length prop. These values remain private timing
// details of the mechanical cue; the public contract only exposes duration.
const PIANO_LID_OVEROPEN_ANGLE_RADIANS = 0.98;
const PIANO_LID_SUPPORT_DEPLOY_START_SECONDS = 2.10;
const PIANO_LID_SUPPORT_DEPLOY_END_SECONDS = 2.68;

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const GOLD = 0xc18a3f;
const NON_CRITICAL_SHADOW_PREFIXES = [
  'piano.key.',
  'piano.key-gap',
  'piano.strings',
  'piano.tuning-pins',
  'piano.plate-braces',
  'piano.plate.aperture',
  'piano.bridge.pin-line',
  'piano.lid-hinges',
  'piano.caster',
  'piano.pedal.',
  'piano.pedal-rods',
] as const;

type PlanPoint = readonly [number, number];

interface PianoMaterials {
  readonly lacquer: THREE.MeshPhysicalMaterial;
  readonly lacquerEdge: THREE.MeshPhysicalMaterial;
  readonly wood: THREE.MeshPhysicalMaterial;
  readonly woodDark: THREE.MeshStandardMaterial;
  readonly gold: THREE.MeshStandardMaterial;
  readonly brass: THREE.MeshPhysicalMaterial;
  readonly ivory: THREE.MeshPhysicalMaterial;
  readonly ebonized: THREE.MeshPhysicalMaterial;
  readonly felt: THREE.MeshStandardMaterial;
  readonly strings: THREE.MeshPhysicalMaterial;
  readonly rubber: THREE.MeshStandardMaterial;
  readonly cavity: THREE.MeshStandardMaterial;
}

function createMaterials(): PianoMaterials {
  return {
    lacquer: createProceduralPhysicalMaterial({
      materialId: 'piano.lacquer', kind: 'lacquer', color: '#08090b', metalness: 0, roughness: 0.16,
      seed: 101, mapRepeat: [2, 2], normalStrength: 0.12,
      options: { clearcoat: 0.86, clearcoatRoughness: 0.075, envMapIntensity: 1.35 },
    }),
    lacquerEdge: createProceduralPhysicalMaterial({
      materialId: 'piano.lacquer.edge', kind: 'lacquer', color: '#17181d', metalness: 0, roughness: 0.12,
      seed: 103, mapRepeat: [3, 2], normalStrength: 0.10,
      options: { clearcoat: 0.92, clearcoatRoughness: 0.055, envMapIntensity: 1.45 },
    }),
    wood: createProceduralPhysicalMaterial({
      materialId: 'piano.wood', kind: 'wood', color: '#4a2415', metalness: 0, roughness: 0.36,
      seed: 107, mapRepeat: [2, 1], normalStrength: 0.28,
      options: { clearcoat: 0.23, clearcoatRoughness: 0.22, envMapIntensity: 0.72 },
    }),
    woodDark: createProceduralStandardMaterial({
      materialId: 'piano.wood.dark', kind: 'wood-dark', color: '#24130e', metalness: 0, roughness: 0.48,
      seed: 109, mapRepeat: [2, 1], normalStrength: 0.24,
    }),
    gold: createProceduralStandardMaterial({
      materialId: 'piano.metal.gold', kind: 'brass', color: `#${GOLD.toString(16)}`, metalness: 0.9, roughness: 0.2,
      seed: 113, mapRepeat: [2, 2], normalStrength: 0.24,
      options: { envMapIntensity: 1.2 },
    }),
    brass: createProceduralPhysicalMaterial({
      materialId: 'piano.metal.brass', kind: 'brass', color: '#b8792e', metalness: 0.94, roughness: 0.17,
      seed: 127, mapRepeat: [3, 2], normalStrength: 0.22,
      options: { clearcoat: 0.22, clearcoatRoughness: 0.14, envMapIntensity: 1.4 },
    }),
    ivory: createProceduralPhysicalMaterial({
      materialId: 'piano.ivory', kind: 'ivory', color: '#e6dcc5', metalness: 0, roughness: 0.27,
      seed: 131, mapRepeat: [2, 3], normalStrength: 0.30,
      options: { clearcoat: 0.22, clearcoatRoughness: 0.16, envMapIntensity: 0.82 },
    }),
    ebonized: createProceduralPhysicalMaterial({
      materialId: 'piano.keys', kind: 'ebonized', color: '#101015', metalness: 0, roughness: 0.2,
      seed: 137, mapRepeat: [2, 4], normalStrength: 0.14,
      options: { clearcoat: 0.31, clearcoatRoughness: 0.13, envMapIntensity: 0.86 },
    }),
    felt: createProceduralStandardMaterial({
      materialId: 'piano.felt', kind: 'felt', color: '#8e2c27', metalness: 0.02, roughness: 0.78,
      seed: 139, mapRepeat: [4, 3], normalStrength: 0.62,
    }),
    strings: createProceduralPhysicalMaterial({
      materialId: 'piano.strings', kind: 'metal', color: '#b7b4a7', metalness: 0.93, roughness: 0.22,
      seed: 149, mapRepeat: [8, 2], normalStrength: 0.12,
      options: { clearcoat: 0.1, clearcoatRoughness: 0.18, envMapIntensity: 1.45 },
    }),
    rubber: createProceduralStandardMaterial({
      materialId: 'piano.rubber', kind: 'rubber', color: '#111014', metalness: 0.02, roughness: 0.84,
      seed: 151, mapRepeat: [3, 3], normalStrength: 0.50,
    }),
    cavity: createProceduralStandardMaterial({
      materialId: 'piano.cavity', kind: 'cavity', color: '#100a08', metalness: 0.03, roughness: 0.65,
      seed: 157, mapRepeat: [2, 2], normalStrength: 0.34,
    }),
  };
}

function register(
  components: Map<string, THREE.Object3D>,
  object: THREE.Object3D,
  componentId: string,
  role: string,
  parentId?: string,
): void {
  object.userData.componentId = componentId;
  object.userData.assetSource = 'procedural';
  object.userData.animationRole = role;
  object.userData.parentComponentId = parentId;
  object.userData.actionReady = true;
  object.userData.actionProfile = {
    animationRole: role,
    pivot: 'named-local-pivot',
    transformChannels: {
      translate: true,
      rotate: true,
      scale: true,
      bend: false,
      twist: false,
      detach: role === 'lid' || role === 'caster',
      visibility: true,
      materialState: true,
    },
  };
  object.userData.sockets = [];
  object.userData.collider = {
    type: 'auto-component-proxy',
    componentId,
    isTrigger: false,
  };
  object.userData.destruction = {
    breakable: false,
    fractureGroup: componentId,
    detachableFragments: [],
  };
  if (componentId !== 'root') object.userData.explodeWithParent = true;
  components.set(componentId, object);
}

function markMesh(mesh: THREE.Mesh): void {
  if (mesh.userData.castShadow === undefined) {
    mesh.userData.castShadow = !NON_CRITICAL_SHADOW_PREFIXES.some((prefix) =>
      mesh.name.startsWith(prefix),
    );
  }
  mesh.castShadow = mesh.userData.castShadow !== false;
  mesh.receiveShadow = mesh.userData.receiveShadow !== false;
  mesh.userData.explodeWithParent = true;
}

function createBeveledBoxGeometry(
  width: number,
  height: number,
  depth: number,
  bevel = 0.004,
): THREE.ExtrudeGeometry {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const radius = Math.min(bevel, halfWidth * 0.45, halfHeight * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + radius, -halfHeight);
  shape.lineTo(halfWidth - radius, -halfHeight);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + radius);
  shape.lineTo(halfWidth, halfHeight - radius);
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - radius, halfHeight);
  shape.lineTo(-halfWidth + radius, halfHeight);
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - radius);
  shape.lineTo(-halfWidth, -halfHeight + radius);
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + radius, -halfHeight);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: radius > 0,
    bevelSegments: 2,
    bevelSize: radius,
    bevelThickness: radius,
    curveSegments: 3,
    steps: 1,
  });
  geometry.translate(0, 0, -depth * 0.5);
  return geometry;
}

function createPlanShape(points: readonly PlanPoint[]): THREE.Shape {
  const shape = new THREE.Shape();
  const dense = densifyPlan(points);
  const first = dense[0];
  if (!first) throw new Error('A piano plan needs at least one point');
  shape.moveTo(first[0], -first[1]);
  for (const [x, z] of dense.slice(1)) shape.lineTo(x, -z);
  shape.closePath();
  return shape;
}

function addPlanHole(path: THREE.Path, points: readonly PlanPoint[]): void {
  const dense = densifyPlan(points);
  const first = dense[0];
  if (!first) return;
  path.moveTo(first[0], -first[1]);
  for (const [x, z] of dense.slice(1)) path.lineTo(x, -z);
  path.closePath();
}

function densifyPlan(
  points: readonly PlanPoint[],
  // The shell and lid are silhouette-critical broad curves.  Twelve samples
  // per authored edge keep their side walls continuous in the grazing review
  // views while staying well below the instrument triangle budget.
  segmentsPerEdge = 12,
): PlanPoint[] {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
    0.5,
  );
  return curve
    .getPoints(points.length * segmentsPerEdge)
    .map((point) => [point.x, point.z] as PlanPoint);
}

function createPlanExtrusion(
  points: readonly PlanPoint[],
  height: number,
  bevel = 0,
  hole?: readonly PlanPoint[],
): THREE.ExtrudeGeometry {
  const shape = createPlanShape(points);
  if (hole) {
    const path = new THREE.Path();
    addPlanHole(path, hole);
    shape.holes.push(path);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: bevel > 0,
    bevelSegments: 2,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 4,
    steps: 1,
  });
  geometry.translate(0, 0, -height * 0.5);
  // Shape coordinates are authored as X/Z, while ExtrudeGeometry uses X/Y
  // with its extrusion on Z. This rotation puts the extrusion on world Y.
  geometry.rotateX(-Math.PI * 0.5);
  return geometry;
}

function createPlanSurface(
  points: readonly PlanPoint[],
  hole?: readonly PlanPoint[],
): THREE.ShapeGeometry {
  const shape = createPlanShape(points);
  if (hole) {
    const path = new THREE.Path();
    addPlanHole(path, hole);
    shape.holes.push(path);
  }
  const geometry = new THREE.ShapeGeometry(shape, 4);
  geometry.rotateX(-Math.PI * 0.5);
  return geometry;
}

function createTube(
  points: readonly THREE.Vector3[],
  radius: number,
  material: THREE.Material,
  name: string,
  closed = false,
  tubularSegments = 32,
): THREE.Mesh<THREE.TubeGeometry, THREE.Material> {
  const curve = new THREE.CatmullRomCurve3(
    points.map((point) => point.clone()),
    closed,
    'centripetal',
    0.5,
  );
  const mesh = new THREE.Mesh(
    new THREE.TubeGeometry(curve, tubularSegments, radius, 6, closed),
    material,
  );
  mesh.name = name;
  markMesh(mesh);
  return mesh;
}

function addCylinderBetween(
  parent: THREE.Object3D,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  name: string,
  radialSegments = 8,
): THREE.Mesh<THREE.CylinderGeometry, THREE.Material> {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, Math.max(0.0001, length), radialSegments),
    material,
  );
  mesh.name = name;
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  markMesh(mesh);
  parent.add(mesh);
  return mesh;
}

function createInstancedBetween(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  starts: readonly THREE.Vector3[],
  ends: readonly THREE.Vector3[],
  name: string,
): THREE.InstancedMesh {
  const count = Math.min(starts.length, ends.length);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const helper = new THREE.Object3D();
  const axis = new THREE.Vector3(0, 1, 0);
  for (let index = 0; index < count; index += 1) {
    const start = starts[index]!;
    const end = ends[index]!;
    const direction = new THREE.Vector3().subVectors(end, start);
    helper.position.copy(start).add(end).multiplyScalar(0.5);
    helper.quaternion.setFromUnitVectors(axis, direction.normalize());
    helper.scale.set(1, Math.max(0.0001, start.distanceTo(end)), 1);
    helper.updateMatrix();
    mesh.setMatrixAt(index, helper.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(midi % 12);
}

function whiteIndex(midi: number): number {
  let index = 0;
  for (let pitch = PIANO_FIRST_MIDI; pitch < midi; pitch += 1) {
    if (!isBlackKey(pitch)) index += 1;
  }
  return index;
}

function whiteKeyX(index: number): number {
  const spacing = 1.56 / (PIANO_WHITE_KEY_COUNT - 1);
  return (index - (PIANO_WHITE_KEY_COUNT - 1) * 0.5) * spacing;
}

function blackKeyX(midi: number): number {
  const left = whiteIndex(midi);
  return (whiteKeyX(left - 1) + whiteKeyX(left)) * 0.5;
}

function createKeyGeometry(
  isBlack: boolean,
): THREE.ExtrudeGeometry {
  return createBeveledBoxGeometry(
    isBlack ? 0.0165 : 0.028,
    isBlack ? 0.10 : 0.092,
    isBlack ? 0.26 : 0.49,
    isBlack ? 0.0028 : 0.0018,
  );
}

function addGrainLines(
  parent: THREE.Object3D,
  material: THREE.LineBasicMaterial,
  region: { readonly xMin: number; readonly xMax: number; readonly z: number; readonly y: number },
  count: number,
  prefix: string,
): void {
  for (let index = 0; index < count; index += 1) {
    const points: THREE.Vector3[] = [];
    const phase = index * 1.73;
    for (let step = 0; step <= 12; step += 1) {
      const u = step / 12;
      const x = THREE.MathUtils.lerp(region.xMin, region.xMax, u);
      points.push(
        new THREE.Vector3(
          x,
          region.y + Math.sin(phase + u * 5.1) * 0.0015,
          region.z + Math.cos(phase + u * 4.0) * 0.004,
        ),
      );
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      material,
    );
    line.name = `${prefix}.${index}`;
    line.renderOrder = 2;
    parent.add(line);
  }
}

const OUTER_PLAN: readonly PlanPoint[] = [
  [-0.84, 1.06],
  [0.84, 1.06],
  [0.91, 0.84],
  [0.92, 0.48],
  [0.88, 0.12],
  [0.74, -0.27],
  [0.47, -0.58],
  [0.10, -0.78],
  [-0.25, -0.80],
  [-0.57, -0.66],
  [-0.78, -0.40],
  [-0.86, -0.08],
  [-0.86, 0.52],
];

const INNER_PLAN: readonly PlanPoint[] = [
  [-0.73, 0.90],
  [0.73, 0.90],
  [0.79, 0.68],
  [0.80, 0.42],
  [0.76, 0.13],
  [0.63, -0.19],
  [0.39, -0.45],
  [0.08, -0.63],
  [-0.22, -0.65],
  [-0.48, -0.53],
  [-0.66, -0.31],
  [-0.73, -0.02],
  [-0.73, 0.48],
];

// The lid is the rear half of the case plan, with its front edge clipped
// at z≈.55. That leaves the music desk at z=.77 in front of the moving
// panel while still covering the string bank (which ends around z=.50).
// Points are expressed in the root's piano-local X/Z frame. addLid offsets
// them by +.88 X under a left-edge hinge at x=-.88.
const LID_PLAN: readonly PlanPoint[] = [
  [-0.86, 0.54],
  [0.90, 0.54],
  [0.92, 0.48],
  [0.91, 0.12],
  [0.74, -0.27],
  [0.47, -0.58],
  [0.10, -0.78],
  [-0.25, -0.80],
  [-0.57, -0.66],
  [-0.78, -0.40],
  [-0.86, -0.08],
  [-0.86, 0.48],
];

const LID_INNER_PLAN: readonly PlanPoint[] = [
  [-0.73, 0.47],
  [0.74, 0.47],
  [0.79, 0.42],
  [0.76, 0.13],
  [0.63, -0.19],
  [0.39, -0.45],
  [0.08, -0.63],
  [-0.22, -0.65],
  [-0.48, -0.53],
  [-0.66, -0.31],
  [-0.73, -0.02],
  [-0.73, 0.44],
];

function addCase(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: PianoMaterials,
): {
  readonly caseGroup: THREE.Group;
  readonly plate: THREE.Group;
} {
  const caseGroup = new THREE.Group();
  caseGroup.name = 'piano.case';
  register(components, caseGroup, 'piano.case', 'body-shell', 'root');
  root.add(caseGroup);

  const lower = new THREE.Mesh(
    createPlanExtrusion(OUTER_PLAN, 0.40, 0.018),
    materials.lacquer,
  );
  lower.name = 'piano.case.lower-shell';
  lower.position.y = 0.90;
  markMesh(lower);
  caseGroup.add(lower);

  const outerRim = new THREE.Group();
  outerRim.name = 'piano.outer-rim';
  register(components, outerRim, 'piano.outer-rim', 'rim', 'piano.case');
  const rimMesh = new THREE.Mesh(
    createPlanExtrusion(OUTER_PLAN, 0.12, 0.009, INNER_PLAN),
    materials.lacquerEdge,
  );
  rimMesh.name = 'piano.outer-rim.shell';
  rimMesh.position.y = 1.13;
  markMesh(rimMesh);
  outerRim.add(rimMesh);
  caseGroup.add(outerRim);

  const innerRim = new THREE.Group();
  innerRim.name = 'piano.inner-rim';
  register(components, innerRim, 'piano.inner-rim', 'rim-frame', 'piano.case');
  const innerRimMesh = new THREE.Mesh(
    createPlanExtrusion(INNER_PLAN, 0.06, 0.006),
    materials.wood,
  );
  innerRimMesh.name = 'piano.inner-rim.wood-frame';
  innerRimMesh.position.y = 1.135;
  markMesh(innerRimMesh);
  innerRim.add(innerRimMesh);
  caseGroup.add(innerRim);

  const grainMaterial = new THREE.LineBasicMaterial({
    color: '#8b4d2f',
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  addGrainLines(innerRim, grainMaterial, {
    xMin: -0.62,
    xMax: 0.58,
    z: 0.915,
    y: 1.171,
  }, 5, 'piano.inner-rim.grain');

  const plate = new THREE.Group();
  plate.name = 'piano.plate';
  register(components, plate, 'piano.plate', 'plate', 'piano.case');
  // Keep the cast plate, strings and pin field below the rim/lid contact line.
  // This is a rigid assembly offset, not a per-frame geometry correction.
  plate.position.y = -0.085;
  const soundboard = new THREE.Mesh(
    createPlanExtrusion(INNER_PLAN, 0.026, 0.002),
    materials.woodDark,
  );
  soundboard.name = 'piano.soundboard';
  soundboard.position.y = 1.173;
  markMesh(soundboard);
  plate.add(soundboard);

  const plateMesh = new THREE.Mesh(
    createPlanExtrusion(INNER_PLAN, 0.026, 0.004),
    materials.gold,
  );
  plateMesh.name = 'piano.plate.cast-iron';
  plateMesh.position.y = 1.199;
  markMesh(plateMesh);
  plate.add(plateMesh);

  // Dark apertures and raised rings break up the gold field in the same
  // places the reference exposes the cast plate's large openings.
  for (const [index, [x, z, radius]] of ([
    [-0.48, -0.25, 0.095],
    [0.38, -0.39, 0.12],
    [0.58, 0.17, 0.075],
  ] as const).entries()) {
    const aperture = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.012, 24),
      materials.cavity,
    );
    aperture.name = `piano.plate.aperture.${index}`;
    aperture.position.set(x, 1.218, z);
    markMesh(aperture);
    plate.add(aperture);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.03, 0.006, 6, 24),
      materials.gold,
    );
    ring.name = `piano.plate.aperture-ring.${index}`;
    ring.position.set(x, 1.224, z);
    ring.rotation.x = Math.PI * 0.5;
    markMesh(ring);
    plate.add(ring);
  }

  caseGroup.add(plate);
  return { caseGroup, plate };
}

function addPlateDetails(
  plate: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: PianoMaterials,
): void {
  const braces = new THREE.Group();
  braces.name = 'piano.plate-braces';
  register(components, braces, 'piano.plate-braces', 'plate-rib', 'piano.plate');
  const braceStarts: THREE.Vector3[] = [];
  const braceEnds: THREE.Vector3[] = [];
  const braceAngles = [-1.06, -0.67, -0.28, 0.18, 0.58, 0.94];
  for (const angle of braceAngles) {
    braceStarts.push(new THREE.Vector3(-0.02, 1.229, -0.05));
    braceEnds.push(new THREE.Vector3(Math.cos(angle) * 0.74, 1.229, Math.sin(angle) * 0.60));
  }
  const braceGeometry = new THREE.CylinderGeometry(0.017, 0.023, 1, 8);
  const braceMesh = createInstancedBetween(
    braceGeometry,
    materials.gold,
    braceStarts,
    braceEnds,
    'piano.plate-braces.radial-set',
  );
  braces.add(braceMesh);
  plate.add(braces);

  const bridge = new THREE.Group();
  bridge.name = 'piano.bridge';
  register(components, bridge, 'piano.bridge', 'bridge', 'piano.plate');
  const bridgeMesh = createTube(
    [
      new THREE.Vector3(-0.68, 1.237, 0.42),
      new THREE.Vector3(-0.20, 1.245, 0.51),
      new THREE.Vector3(0.25, 1.245, 0.48),
      new THREE.Vector3(0.70, 1.229, 0.33),
    ],
    0.024,
    materials.wood,
    'piano.bridge.curved-wood',
    false,
    32,
  );
  bridge.add(bridgeMesh);
  const bridgePins = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.004, 0.004, 0.032, 6),
    materials.brass,
    30,
  );
  bridgePins.name = 'piano.bridge.pin-line';
  bridgePins.castShadow = true;
  bridgePins.receiveShadow = true;
  const pinHelper = new THREE.Object3D();
  for (let index = 0; index < 30; index += 1) {
    const u = index / 29;
    const x = THREE.MathUtils.lerp(-0.63, 0.64, u);
    const z = 0.46 + Math.sin(u * Math.PI) * 0.065 - u * 0.11;
    pinHelper.position.set(x, 1.265, z);
    pinHelper.updateMatrix();
    bridgePins.setMatrixAt(index, pinHelper.matrix);
  }
  bridgePins.instanceMatrix.needsUpdate = true;
  bridge.add(bridgePins);
  plate.add(bridge);

  const strings = new THREE.Group();
  strings.name = 'piano.strings';
  register(components, strings, 'piano.strings', 'string-bank', 'piano.plate');
  const bassStarts: THREE.Vector3[] = [];
  const bassEnds: THREE.Vector3[] = [];
  const trebleStarts: THREE.Vector3[] = [];
  const trebleEnds: THREE.Vector3[] = [];
  for (let index = 0; index < 176; index += 1) {
    const u = index / 175;
    const x = THREE.MathUtils.lerp(-0.69, 0.69, u);
    const start = new THREE.Vector3(
      x * 0.98,
      1.252 + Math.sin(u * 7.0) * 0.002,
      -0.45 + Math.sin(u * Math.PI) * 0.025,
    );
    const end = new THREE.Vector3(
      THREE.MathUtils.lerp(-0.63, 0.65, u),
      1.267,
      0.44 + Math.sin(u * Math.PI) * 0.07 - u * 0.11,
    );
    if (index < 45) {
      bassStarts.push(start);
      bassEnds.push(end);
    } else {
      trebleStarts.push(start);
      trebleEnds.push(end);
    }
  }
  const bassMesh = createInstancedBetween(
    new THREE.CylinderGeometry(0.0048, 0.0048, 1, 5),
    materials.brass,
    bassStarts,
    bassEnds,
    'piano.strings.bass-bank',
  );
  const trebleMesh = createInstancedBetween(
    new THREE.CylinderGeometry(0.0021, 0.0021, 1, 5),
    materials.strings,
    trebleStarts,
    trebleEnds,
    'piano.strings.treble-bank',
  );
  strings.add(bassMesh, trebleMesh);
  plate.add(strings);

  const pins = new THREE.Group();
  pins.name = 'piano.tuning-pins';
  register(components, pins, 'piano.tuning-pins', 'tuning-pin-set', 'piano.plate');
  const tuningPinMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.008, 0.008, 0.042, 8),
    materials.brass,
    88,
  );
  tuningPinMesh.name = 'piano.tuning-pins.row';
  tuningPinMesh.castShadow = true;
  tuningPinMesh.receiveShadow = true;
  const tuningHelper = new THREE.Object3D();
  for (let index = 0; index < 88; index += 1) {
    const u = index / 87;
    tuningHelper.position.set(
      THREE.MathUtils.lerp(-0.69, 0.69, u),
      1.282,
      -0.46 + Math.sin(u * Math.PI * 2) * 0.018,
    );
    tuningHelper.updateMatrix();
    tuningPinMesh.setMatrixAt(index, tuningHelper.matrix);
  }
  tuningPinMesh.instanceMatrix.needsUpdate = true;
  pins.add(tuningPinMesh);
  plate.add(pins);

  const actionRail = new THREE.Group();
  actionRail.name = 'piano.action-rail';
  register(components, actionRail, 'piano.action-rail', 'action-rail', 'piano.plate');
  const actionMesh = new THREE.Mesh(
    createBeveledBoxGeometry(1.50, 0.045, 0.055, 0.006),
    materials.wood,
  );
  actionMesh.name = 'piano.action-rail.bar';
  actionMesh.position.set(0, 1.246, -0.20);
  markMesh(actionMesh);
  actionRail.add(actionMesh);
  plate.add(actionRail);

  const damperRail = new THREE.Group();
  damperRail.name = 'piano.damper-rail';
  register(components, damperRail, 'piano.damper-rail', 'damper-rail', 'piano.plate');
  const damperMesh = new THREE.Mesh(
    createBeveledBoxGeometry(1.46, 0.034, 0.048, 0.005),
    materials.woodDark,
  );
  damperMesh.name = 'piano.damper-rail.bar';
  damperMesh.position.set(0, 1.275, 0.30);
  markMesh(damperMesh);
  damperRail.add(damperMesh);
  const damperFelt = new THREE.Mesh(
    createBeveledBoxGeometry(1.39, 0.008, 0.018, 0.002),
    materials.felt,
  );
  damperFelt.name = 'piano.damper-rail.felt';
  damperFelt.position.set(0, 1.296, 0.295);
  markMesh(damperFelt);
  damperRail.add(damperFelt);
  plate.add(damperRail);
}

function addKeyboard(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  keyPivots: Map<number, THREE.Group>,
  sustainPedalRef: { value?: THREE.Object3D },
  materials: PianoMaterials,
): void {
  const keyboard = new THREE.Group();
  keyboard.name = 'piano.keyboard';
  register(components, keyboard, 'piano.keyboard', 'keyboard', 'root');
  root.add(keyboard);

  const keybed = new THREE.Group();
  keybed.name = 'piano.keybed';
  register(components, keybed, 'piano.keybed', 'keybed', 'piano.keyboard');
  const keybedMesh = new THREE.Mesh(
    createBeveledBoxGeometry(1.70, 0.16, 0.54, 0.018),
    materials.lacquerEdge,
  );
  keybedMesh.name = 'piano.keybed.shelf';
  keybedMesh.position.set(0, 1.00, 1.05);
  markMesh(keybedMesh);
  keybed.add(keybedMesh);
  keyboard.add(keybed);

  const keys = new THREE.Group();
  keys.name = 'piano.keys';
  register(components, keys, 'piano.keys', 'key-set', 'piano.keybed');
  keybed.add(keys);

  const blackKeys = new THREE.Group();
  blackKeys.name = 'piano.black-keys';
  register(components, blackKeys, 'piano.black-keys', 'black-key-set', 'piano.keys');
  keys.add(blackKeys);

  const whiteGeometry = createKeyGeometry(false);
  const blackGeometry = createKeyGeometry(true);
  for (let midi = PIANO_FIRST_MIDI; midi <= PIANO_LAST_MIDI; midi += 1) {
    const black = isBlackKey(midi);
    const pivot = new THREE.Group();
    const id = `piano.key.${midi}`;
    pivot.name = `${id}.pivot`;
    pivot.position.set(
      black ? blackKeyX(midi) : whiteKeyX(whiteIndex(midi)),
      black ? 1.205 : 1.145,
      black ? 0.995 : 1.015,
    );
    register(components, pivot, id, black ? 'black-key-pivot' : 'white-key-pivot', 'piano.keys');
    keyPivots.set(midi, pivot);
    const mesh = new THREE.Mesh(
      black ? blackGeometry : whiteGeometry,
      black ? materials.ebonized : materials.ivory,
    );
    mesh.name = id;
    // Keep the action pivot at the keybed height while placing the sharp's
    // visible top only about 14 mm above the natural key.  The old 160 mm
    // block read as a row of tall black teeth in the close reference view.
    mesh.position.y = black ? -0.050 : 0;
    mesh.position.z = black ? 0.13 : 0.245;
    // The 88 keys remain independently addressable and animated, while their
    // tiny shadow contribution is omitted from the expensive shadow pass.
    mesh.userData.castShadow = false;
    markMesh(mesh);
    mesh.userData.componentId = id;
    pivot.add(mesh);
    (black ? blackKeys : keys).add(pivot);
  }

  // One shared geometry draw call preserves the fine dark separators between
  // white keys without allocating another object for every gap.
  const gapMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.0018, 0.012, 0.46),
    materials.cavity,
    PIANO_WHITE_KEY_COUNT - 1,
  );
  gapMesh.name = 'piano.key-gap-micro.separators';
  gapMesh.userData.castShadow = false;
  gapMesh.castShadow = false;
  gapMesh.receiveShadow = true;
  const gapHelper = new THREE.Object3D();
  for (let index = 0; index < PIANO_WHITE_KEY_COUNT - 1; index += 1) {
    gapHelper.position.set((whiteKeyX(index) + whiteKeyX(index + 1)) * 0.5, 1.149, 1.25);
    gapHelper.updateMatrix();
    gapMesh.setMatrixAt(index, gapHelper.matrix);
  }
  gapMesh.instanceMatrix.needsUpdate = true;
  const gapGroup = new THREE.Group();
  gapGroup.name = 'piano.key-gap-micro';
  register(components, gapGroup, 'piano.key-gap-micro', 'key-gap', 'piano.keys');
  gapGroup.add(gapMesh);
  keys.add(gapGroup);

  const frontRail = new THREE.Group();
  frontRail.name = 'piano.front-rail';
  register(components, frontRail, 'piano.front-rail', 'key-slip', 'piano.keybed');
  const railMesh = new THREE.Mesh(
    createBeveledBoxGeometry(1.68, 0.12, 0.075, 0.009),
    materials.lacquer,
  );
  railMesh.name = 'piano.front-rail.black';
  railMesh.position.set(0, 1.065, 1.535);
  markMesh(railMesh);
  frontRail.add(railMesh);
  keybed.add(frontRail);

  // The felt is a stationary rear detail. Keeping it on its own rail leaves
  // the playable keys free to travel through their full score-driven pose.
  // It remains a sibling of the key pivots so no single note can carry the
  // strip along with it.
  const rearRail = new THREE.Group();
  rearRail.name = 'piano.rear-rail';
  register(components, rearRail, 'piano.rear-rail', 'rear-key-rail', 'piano.keybed');
  const rearBacking = new THREE.Mesh(
    createBeveledBoxGeometry(1.56, 0.08, 0.034, 0.006),
    materials.woodDark,
  );
  rearBacking.name = 'piano.rear-rail.backing';
  rearBacking.position.set(0, 1.135, 0.945);
  markMesh(rearBacking);
  rearRail.add(rearBacking);
  const feltStrip = new THREE.Mesh(
    createBeveledBoxGeometry(1.50, 0.014, 0.012, 0.002),
    materials.felt,
  );
  feltStrip.name = 'piano.rear-rail.red-felt';
  feltStrip.position.set(0, 1.182, 0.968);
  markMesh(feltStrip);
  rearRail.add(feltStrip);
  keybed.add(rearRail);

  const endBlocks = new THREE.Group();
  endBlocks.name = 'piano.key-endblocks';
  register(components, endBlocks, 'piano.key-endblocks', 'key-endblock', 'piano.keyboard');
  for (const x of [-0.83, 0.83]) {
    const block = new THREE.Mesh(
      createBeveledBoxGeometry(0.085, 0.18, 0.54, 0.012),
      materials.lacquerEdge,
    );
    block.name = `piano.key-endblock.${x < 0 ? 'left' : 'right'}`;
    block.position.set(x, 1.105, 1.05);
    markMesh(block);
    endBlocks.add(block);
  }
  keyboard.add(endBlocks);

  const fallboard = new THREE.Group();
  fallboard.name = 'piano.fallboard';
  register(components, fallboard, 'piano.fallboard', 'fallboard', 'piano.keyboard');
  const musicDeskMaterial = createProceduralPhysicalMaterial({
    materialId: 'piano.lacquer.music-desk',
    kind: 'lacquer',
    color: '#0b0d12',
    metalness: 0,
    roughness: 0.19,
    seed: 163,
    mapRepeat: [2, 2],
    normalStrength: 0.08,
    options: {
      clearcoat: 0.80,
      clearcoatRoughness: 0.075,
      envMapIntensity: 1.15,
      side: THREE.DoubleSide,
    },
  });
  const musicDesk = new THREE.Mesh(
    createBeveledBoxGeometry(1.40, 0.34, 0.045, 0.012),
    musicDeskMaterial,
  );
  musicDesk.name = 'piano.fallboard.music-desk';
  musicDesk.position.set(0, 1.39, 0.77);
  musicDesk.rotation.x = -0.12;
  markMesh(musicDesk);
  fallboard.add(musicDesk);
  const deskEdge = new THREE.Mesh(
    createBeveledBoxGeometry(1.31, 0.018, 0.035, 0.004),
    materials.lacquerEdge,
  );
  deskEdge.name = 'piano.fallboard.edge-seam';
  deskEdge.position.set(0, 1.215, 0.98);
  markMesh(deskEdge);
  fallboard.add(deskEdge);
  keyboard.add(fallboard);

  // The sustain object is the middle pedal pivot exposed through the public
  // factory contract. The soft pedal and sostenuto remain independently
  // addressable siblings for future score extensions.
  const pedal = new THREE.Group();
  pedal.name = 'piano.pedal';
  register(components, pedal, 'piano.pedal', 'pedal-board', 'root');
  pedal.position.set(0, 0, 0);
  root.add(pedal);

  const lyre = new THREE.Group();
  lyre.name = 'piano.pedal.lyre';
  register(components, lyre, 'piano.pedal.lyre', 'pedal-support', 'piano.pedal');
  const lyreBlock = new THREE.Mesh(
    createBeveledBoxGeometry(0.30, 0.52, 0.16, 0.015),
    materials.lacquer,
  );
  lyreBlock.name = 'piano.pedal.lyre.block';
  lyreBlock.position.set(0, 0.47, 1.14);
  markMesh(lyreBlock);
  lyre.add(lyreBlock);
  const lyreBase = new THREE.Mesh(
    createBeveledBoxGeometry(0.38, 0.10, 0.22, 0.012),
    materials.lacquerEdge,
  );
  lyreBase.name = 'piano.pedal.lyre.base';
  lyreBase.position.set(0, 0.19, 1.24);
  markMesh(lyreBase);
  lyre.add(lyreBase);
  pedal.add(lyre);
  for (const [index, x] of [-0.23, 0, 0.23].entries()) {
    const pedalPivot = new THREE.Group();
    const id = `piano.pedal.${index === 0 ? 'soft' : index === 1 ? 'sustain' : 'sostenuto'}`;
    pedalPivot.name = `${id}.pivot`;
    pedalPivot.position.set(x, 0.18, 1.28);
    register(components, pedalPivot, id, 'pedal-pivot', 'piano.pedal');
    const stem = addCylinderBetween(
      pedalPivot,
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -0.10, 0.13),
      0.014,
      materials.brass,
      `${id}.stem`,
      8,
    );
    stem.castShadow = true;
    const head = new THREE.Mesh(
      createBeveledBoxGeometry(0.13, 0.045, 0.28, 0.012),
      materials.brass,
    );
    head.name = id;
    head.position.set(0, -0.11, 0.19);
    head.rotation.x = -0.08;
    markMesh(head);
    pedalPivot.add(head);
    pedal.add(pedalPivot);
    if (id === 'piano.pedal.sustain') sustainPedalRef.value = pedalPivot;
  }

  const rods = new THREE.Group();
  rods.name = 'piano.pedal-rods';
  register(components, rods, 'piano.pedal-rods', 'connector-rods', 'piano.pedal');
  for (const x of [-0.23, 0, 0.23]) {
    addCylinderBetween(
      rods,
      new THREE.Vector3(x, 0.19, 1.28),
      new THREE.Vector3(x, 0.73, 1.11),
      0.008,
      materials.brass,
      'piano.pedal-rods.link',
      7,
    );
  }
  root.add(rods);
}

interface PianoLidMechanics {
  readonly lid: THREE.Group;
  readonly support: THREE.Group;
  readonly supportMesh: THREE.Mesh;
  readonly supportFoot: THREE.Object3D;
  readonly hingePosition: THREE.Vector3;
  readonly supportBase: THREE.Vector3;
  readonly lidSocket: THREE.Object3D;
  readonly supportTip: THREE.Vector3;
  readonly supportLength: number;
  apply(angleRadians: number, supportDeployment: number): void;
}

function addLid(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: PianoMaterials,
): PianoLidMechanics {
  // The continuous hinge follows the piano's left rim (the local Z/depth
  // direction). The panel itself is authored in root-local X/Z coordinates;
  // the +.88 child offset puts its left edge on this x=-.88 pivot rail.
  const hingePosition = new THREE.Vector3(-0.88, 1.225, 0);
  const lid = new THREE.Group();
  lid.name = 'piano.lid';
  lid.position.copy(hingePosition);
  lid.rotation.set(0, 0, 0);
  register(components, lid, 'piano.lid', 'lid', 'root');
  root.add(lid);

  // The review camera sees the underside of the raised lid. Keep both
  // surfaces available instead of letting back-face culling erase the panel.
  const lidLacquer = materials.lacquer.clone();
  lidLacquer.side = THREE.DoubleSide;
  const lidWood = materials.woodDark.clone();
  lidWood.side = THREE.DoubleSide;
  const lidCavity = materials.cavity.clone();
  lidCavity.side = THREE.DoubleSide;

  // LID_PLAN is expressed in the piano root frame so its clipped front edge
  // matches the case's rear footprint. Offset the complete plan under the left hinge;
  // this removes the old half-width child placement and keeps the lid broad
  // enough to cover the actual rear case footprint.
  const lidGeometry = new THREE.Group();
  lidGeometry.name = 'piano.lid.geometry';
  lidGeometry.position.x = 0.88;
  lid.add(lidGeometry);

  const slab = new THREE.Mesh(
    createPlanExtrusion(LID_PLAN, 0.058, 0.009),
    lidLacquer,
  );
  slab.name = 'piano.lid.panel';
  slab.position.y = 0.005;
  markMesh(slab);
  lidGeometry.add(slab);

  const underframe = new THREE.Group();
  underframe.name = 'piano.lid-underframe';
  register(components, underframe, 'piano.lid-underframe', 'lid-frame', 'piano.lid');
  const frame = new THREE.Mesh(
    createPlanExtrusion(LID_PLAN, 0.028, 0.005, LID_INNER_PLAN),
    lidWood,
  );
  frame.name = 'piano.lid-underframe.inner-edge';
  frame.position.y = -0.034;
  markMesh(frame);
  underframe.add(frame);
  const innerPanel = new THREE.Mesh(
    createPlanSurface(LID_INNER_PLAN),
    lidCavity,
  );
  innerPanel.name = 'piano.lid-underframe.panel';
  innerPanel.position.y = -0.050;
  markMesh(innerPanel);
  underframe.add(innerPanel);
  lidGeometry.add(underframe);

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: '#e0ad5a',
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  const edgePoints = LID_PLAN.map(([x, z]) => new THREE.Vector3(x, 0.038, z));
  const edge = createTube(edgePoints, 0.007, edgeMaterial, 'piano.lid.gold-edge', true, 72);
  edge.position.x = 0.88;
  lid.add(edge);

  const hinges = new THREE.Group();
  hinges.name = 'piano.lid-hinges';
  register(components, hinges, 'piano.lid-hinges', 'hinge-hardware', 'root');
  // Keep the barrel and leaves on the fixed case rail. Parenting them to the
  // moving lid makes the gold rectangles orbit away from the rim as the lid
  // opens. The lid rotates around these case anchored Z-axis pins.
  hinges.position.copy(hingePosition);
  root.add(hinges);
  for (const z of [-0.24, 0.02, 0.28, 0.52]) {
    const leaf = new THREE.Mesh(
      createBeveledBoxGeometry(0.17, 0.018, 0.07, 0.003),
      materials.brass,
    );
    leaf.name = 'piano.lid-hinges.leaf';
    leaf.position.set(0.025, -0.03, z);
    markMesh(leaf);
    hinges.add(leaf);
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.11, 8),
      materials.gold,
    );
    pin.name = 'piano.lid-hinges.pin';
    pin.position.set(0.0, -0.002, z);
    // CylinderGeometry is Y aligned; rotate it onto the continuous Z hinge.
    pin.rotation.x = Math.PI * 0.5;
    markMesh(pin);
    hinges.add(pin);
  }
  // A concert lid uses a rigid prop rather than a telescoping, stretched
  // cylinder. The prop deploys late in the cue while the lid holds a small
  // over-open angle, then the lid settles onto its tip at the final pose.
  const support = new THREE.Group();
  support.name = 'piano.lid-support';
  register(components, support, 'piano.lid-support', 'support-stick', 'root');
  const supportBase = new THREE.Vector3(0.46, 1.205, 0.22);
  const lidSocket = new THREE.Object3D();
  lidSocket.name = 'piano.lid-support.socket';
  lidSocket.position.set(0.42, -0.066, 0.30);
  lidGeometry.add(lidSocket);

  const supportMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.021, 1, 10),
    materials.brass,
  );
  supportMesh.name = 'piano.lid-support.gold-stick';
  markMesh(supportMesh);
  support.add(supportMesh);

  const supportFoot = new THREE.Mesh(
    createBeveledBoxGeometry(0.095, 0.026, 0.07, 0.006),
    materials.brass,
  );
  supportFoot.name = 'piano.lid-support.foot';
  supportFoot.position.copy(supportBase);
  markMesh(supportFoot);
  support.add(supportFoot);
  root.add(support);

  const supportAxis = new THREE.Vector3(0, 1, 0);
  const foldedDirection = new THREE.Vector3(0, 0, -1);
  const endWorld = new THREE.Vector3();
  const finalTip = new THREE.Vector3();
  const finalDirection = new THREE.Vector3();

  // Measure the final support from the authored moving socket once in
  // root-local space. The resulting cylinder scale is set exactly once and
  // never changes during a frame or a seek.
  lid.rotation.z = PIANO_LID_PERFORMANCE_OPEN_ANGLE_RADIANS;
  root.updateMatrixWorld(true);
  lidSocket.getWorldPosition(endWorld);
  root.worldToLocal(finalTip.copy(endWorld));
  finalDirection.subVectors(finalTip, supportBase);
  const supportLength = finalDirection.length();
  if (supportLength <= 0.11) throw new Error('Piano lid support is too short');
  finalDirection.normalize();
  supportMesh.scale.set(1, supportLength, 1);
  lid.rotation.z = PIANO_LID_START_ANGLE_RADIANS;

  function updateSupport(deployment: number): void {
    const amount = THREE.MathUtils.clamp(deployment, 0, 1);
    const direction = foldedDirection.clone().lerp(finalDirection, amount).normalize();
    supportMesh.position.copy(supportBase).addScaledVector(direction, supportLength * 0.5);
    supportMesh.quaternion.setFromUnitVectors(supportAxis, direction);
    supportMesh.visible = amount > 0.001;
    supportMesh.userData.mechanics = {
      base: supportBase.toArray(),
      fixedTip: finalTip.toArray(),
      fixedLengthMetres: supportLength,
      deployment: amount,
      transformOnly: true,
    };
  }

  const mechanics: PianoLidMechanics = {
    lid,
    support,
    supportMesh,
    supportFoot,
    hingePosition,
    supportBase,
    lidSocket,
    supportTip: finalTip,
    supportLength,
    apply(angleRadians: number, supportDeployment: number): void {
      lid.rotation.x = 0;
      lid.rotation.y = 0;
      lid.rotation.z = THREE.MathUtils.clamp(angleRadians, 0, PIANO_LID_OVEROPEN_ANGLE_RADIANS);
      updateSupport(supportDeployment);
    },
  };
  return mechanics;
}

function addSupportAndLegs(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: PianoMaterials,
): void {
  const support = new THREE.Group();
  support.name = 'piano.support';
  register(components, support, 'piano.support', 'support-frame', 'piano.case');
  const supportBeam = new THREE.Mesh(
    createBeveledBoxGeometry(1.42, 0.11, 0.18, 0.014),
    materials.woodDark,
  );
  supportBeam.name = 'piano.support.inner-rail';
  supportBeam.position.set(0, 0.68, -0.20);
  markMesh(supportBeam);
  support.add(supportBeam);
  for (const x of [-0.58, 0, 0.58]) {
    addCylinderBetween(
      support,
      new THREE.Vector3(x, 0.70, -0.25),
      new THREE.Vector3(x * 0.82, 0.27, -0.18),
      0.025,
      materials.woodDark,
      'piano.support.lower-brace',
      8,
    );
  }
  root.add(support);

  const legs = new THREE.Group();
  legs.name = 'piano.leg';
  register(components, legs, 'piano.leg', 'leg-column-set', 'root');
  root.add(legs);
  const placements: readonly [string, number, number, number][] = [
    ['left', -0.62, 0.56, -0.04],
    // Keep the center column plumb so the wheel remains directly under the
    // authored bottom of the leg; the side columns retain their slight stance
    // angles for the period furniture silhouette.
    ['center', 0.00, 0.47, 0.00],
    ['right', 0.64, -0.36, 0.02],
  ];
  const casterSet = new THREE.Group();
  casterSet.name = 'piano.caster';
  register(components, casterSet, 'piano.caster', 'caster-set', 'piano.leg');
  root.add(casterSet);

  for (const [side, x, z, twist] of placements) {
    const legPivot = new THREE.Group();
    const legId = `piano.leg.${side}`;
    legPivot.name = `${legId}.pivot`;
    legPivot.position.set(x, 0.79, z);
    legPivot.rotation.z = twist;
    register(components, legPivot, legId, 'leg-column', 'piano.leg');
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.073, 0.050, 0.70, 4),
      materials.lacquer,
    );
    leg.name = legId;
    leg.rotation.y = Math.PI * 0.25;
    leg.position.y = -0.35;
    markMesh(leg);
    legPivot.add(leg);
    legs.add(legPivot);

    const collar = new THREE.Group();
    const collarId = `piano.leg-collar.${side}`;
    collar.name = collarId;
    register(components, collar, collarId, 'leg-collar', legId);
    const collarMesh = new THREE.Mesh(
      createBeveledBoxGeometry(0.13, 0.065, 0.13, 0.009),
      materials.lacquerEdge,
    );
    collarMesh.name = `${collarId}.block`;
    collarMesh.position.y = -0.11;
    markMesh(collarMesh);
    collar.add(collarMesh);
    legPivot.add(collar);

    const caster = new THREE.Group();
    const casterId = `piano.caster.${side}`;
    caster.name = casterId;
    register(components, caster, casterId, 'caster', legId);
    // casterSet is a root sibling of the leg pivots, so carry the authored
    // leg X/Z placement explicitly. The old Y-only placement stacked every
    // caster at the origin and left a gold wheel floating below the piano.
    caster.position.set(x, 0.07, z);
    const fork = addCylinderBetween(
      caster,
      new THREE.Vector3(0, 0.05, 0),
      new THREE.Vector3(0, -0.04, 0),
      0.018,
      materials.brass,
      `${casterId}.fork`,
      8,
    );
    fork.castShadow = true;
    const wheel = new THREE.Mesh(
      new THREE.TorusGeometry(0.062, 0.022, 8, 18),
      materials.brass,
    );
    wheel.name = `${casterId}.wheel`;
    wheel.rotation.y = Math.PI * 0.5;
    wheel.position.set(0, -0.045, 0.01);
    markMesh(wheel);
    caster.add(wheel);
    const tire = new THREE.Mesh(
      new THREE.TorusGeometry(0.062, 0.008, 6, 18),
      materials.rubber,
    );
    tire.name = `${casterId}.tire-groove`;
    tire.rotation.y = Math.PI * 0.5;
    tire.position.set(0, -0.045, 0.011);
    markMesh(tire);
    caster.add(tire);
    casterSet.add(caster);
  }
}

function addApron(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: PianoMaterials,
): void {
  const apron = new THREE.Group();
  apron.name = 'piano.apron';
  register(components, apron, 'piano.apron', 'front-apron', 'root');
  const apronMesh = new THREE.Mesh(
    createBeveledBoxGeometry(1.62, 0.34, 0.12, 0.018),
    materials.lacquer,
  );
  apronMesh.name = 'piano.apron.front-panel';
  apronMesh.position.set(0, 0.76, 1.07);
  markMesh(apronMesh);
  apron.add(apronMesh);
  const apronTrim = new THREE.Mesh(
    createBeveledBoxGeometry(1.54, 0.025, 0.035, 0.005),
    materials.lacquerEdge,
  );
  apronTrim.name = 'piano.apron.highlight';
  apronTrim.position.set(0, 0.93, 1.138);
  markMesh(apronTrim);
  apron.add(apronTrim);
  root.add(apron);
}

/**
 * Create the action-ready concert grand used by the performance rig.
 *
 * `keyPivots` contains all MIDI notes 21 through 108, including the 36 black
 * keys. `sustainPedal` is the middle pedal pivot; all three pedal pivots and
 * repeated static hardware remain available through `components`.
 */
export interface PianoMechanicalModel extends PianoModel {
  applyMechanics(timeSeconds: number, reducedMotion?: boolean): void;
}

export function createPianoModel(): PianoMechanicalModel {
  const root = new THREE.Group();
  root.name = 'piano.procedural';
  root.userData.instrumentId = 'piano';
  root.userData.assetSource = 'procedural';
  root.userData.coordinateFrame = {
    x: 'keyboard left to right',
    y: 'up from floor',
    z: 'audience/front positive',
    units: 'metres',
  };
  root.userData.componentCounts = {
    keys: 88,
    whiteKeys: PIANO_WHITE_KEY_COUNT,
    blackKeys: PIANO_BLACK_KEY_COUNT,
    pedals: 3,
    legs: 3,
    casters: 3,
    strings: 176,
    tuningPins: 88,
    plateBraces: 6,
  };
  root.userData.performanceBudget = {
    maxDrawCalls: 220,
    preserveKeyPivots: true,
    staticDetailInstanced: true,
    perFrameGeometryRebuild: false,
  };

  const components = new Map<string, THREE.Object3D>();
  register(components, root, 'root', 'instrument-root');
  const materials = createMaterials();
  const keyPivots = new Map<number, THREE.Group>();
  const sustainPedalRef: { value?: THREE.Object3D } = {};

  const { plate } = addCase(root, components, materials);
  addPlateDetails(plate, components, materials);
  addKeyboard(root, components, keyPivots, sustainPedalRef, materials);
  const lidMechanics = addLid(root, components, materials);
  addSupportAndLegs(root, components, materials);
  addApron(root, components, materials);

  const sustainPedal = sustainPedalRef.value;
  if (!sustainPedal) throw new Error('Piano sustain pedal pivot was not created');
  root.userData.components = components;
  root.userData.keyPivots = keyPivots;
  root.userData.sustainPedal = sustainPedal;
  root.userData.mechanics = {
    lid: {
      hingeAxis: 'Z',
      hingePosition: lidMechanics.hingePosition.toArray(),
      startupAngleRadians: PIANO_LID_START_ANGLE_RADIANS,
      performanceOpenAngleRadians: PIANO_LID_PERFORMANCE_OPEN_ANGLE_RADIANS,
      openingDurationSeconds: PIANO_LID_OPENING_DURATION_SECONDS,
      supportBase: lidMechanics.supportBase.toArray(),
      supportSocket: lidMechanics.lidSocket.position.toArray(),
      supportLengthMetres: lidMechanics.supportLength,
      supportType: 'fixed-length-prop',
      transformOnly: true,
    },
  };
  root.userData.sculptRuntime = {
    version: 1,
    rigType: 'action-ready-static-rig',
    coordinateFrame: root.userData.coordinateFrame,
    components,
    keyPivots,
    sustainPedal,
    rootMotionNode: root,
    assembly: {
      explodable: true,
      clickable: true,
      staticDetailInstanced: true,
      perFrameGeometryRebuild: false,
    },
  };
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) markMesh(mesh);
  });

  const smoothStep = (value: number): number => {
    const normalized = THREE.MathUtils.clamp(value, 0, 1);
    return normalized * normalized * (3 - 2 * normalized);
  };

  const applyMechanics = (timeSeconds: number, reducedMotion = false): void => {
    const time = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
    let angle = PIANO_LID_START_ANGLE_RADIANS;
    let supportDeployment = 0;
    if (reducedMotion || time >= PIANO_LID_OPENING_DURATION_SECONDS) {
      angle = PIANO_LID_PERFORMANCE_OPEN_ANGLE_RADIANS;
      supportDeployment = 1;
    } else if (time < PIANO_LID_SUPPORT_DEPLOY_START_SECONDS) {
      // Raise the lid clear of the desk before the prop leaves its folded
      // rest along the rim.
      angle = THREE.MathUtils.lerp(
        PIANO_LID_START_ANGLE_RADIANS,
        PIANO_LID_OVEROPEN_ANGLE_RADIANS,
        smoothStep(time / PIANO_LID_SUPPORT_DEPLOY_START_SECONDS),
      );
    } else if (time < PIANO_LID_SUPPORT_DEPLOY_END_SECONDS) {
      angle = PIANO_LID_OVEROPEN_ANGLE_RADIANS;
      supportDeployment = smoothStep(
        (time - PIANO_LID_SUPPORT_DEPLOY_START_SECONDS) /
          (PIANO_LID_SUPPORT_DEPLOY_END_SECONDS - PIANO_LID_SUPPORT_DEPLOY_START_SECONDS),
      );
    } else {
      // Once the rigid prop is deployed, settle the panel onto its fixed tip
      // over the remaining cue tail.
      angle = THREE.MathUtils.lerp(
        PIANO_LID_OVEROPEN_ANGLE_RADIANS,
        PIANO_LID_PERFORMANCE_OPEN_ANGLE_RADIANS,
        smoothStep(
          (time - PIANO_LID_SUPPORT_DEPLOY_END_SECONDS) /
            (PIANO_LID_OPENING_DURATION_SECONDS - PIANO_LID_SUPPORT_DEPLOY_END_SECONDS),
        ),
      );
      supportDeployment = 1;
    }
    lidMechanics.apply(angle, supportDeployment);
  };

  applyMechanics(0);
  return { root, components, keyPivots, sustainPedal, applyMechanics };
}

export default createPianoModel;
