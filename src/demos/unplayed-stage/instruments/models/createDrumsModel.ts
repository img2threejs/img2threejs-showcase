import * as THREE from 'three';

import type { DrumModel } from '../PerformanceRig';
import type { NoteEvent } from '../../music/ScoreLoader';
import {
  applyDrumMechanics,
  playerGripDirection,
  type DrumMechanicsHost,
  type DrumMotionObstacle,
  type KickBeaterContact,
} from '../drumMechanics';
import {
  createProceduralPhysicalMaterial,
  type ProceduralSurfaceKind,
} from '../../materials/proceduralMaterials';
import {
  createDrumImpactEffects,
  type DrumImpactEffects,
  type DrumImpactSurface,
} from '../drumEffects';

type PhysicalMaterial = THREE.MeshPhysicalMaterial;
type Vec3 = readonly [number, number, number];

const TAU = Math.PI * 2;
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const STICK_TIP_RADIUS = 0.022;
// CapsuleGeometry's scaled half-heights. These centers put the authored
// rubber feet and pedal heel exactly on the local floor (y=0) while keeping
// the stand rods and pedal boards at their existing mechanical elevations.
const SUPPORT_FOOT_CENTER_Y = (0.095 + 2 * 0.048) * 0.82 * 0.5;
const PEDAL_HEEL_CENTER_Y = (0.14 + 2 * 0.06) * 0.55 * 0.5;
const KICK_LUG_GROUND_LIFT = 0.03;

export const DRUM_PLAYABLE_SURFACES = Object.freeze([
  'drums.kick',
  'drums.snare',
  'drums.tom',
  'drums.floortom',
  'drums.hihat',
  'drums.crash',
  'drums.ride',
] as const);

export type DrumPlayableSurface = (typeof DRUM_PLAYABLE_SURFACES)[number];

export interface DrumModelWithMechanics extends DrumModel {
  readonly applyMechanics: (
    timeSeconds: number,
    notes: readonly NoteEvent[],
    reducedMotion?: boolean,
  ) => void;
  readonly kickBeaterContact: KickBeaterContact;
  readonly impactEffects: DrumImpactEffects;
}

function makeMaterial(
  materialId: string,
  kind: ProceduralSurfaceKind,
  color: number,
  roughness: number,
  metalness: number,
  options: Partial<THREE.MeshPhysicalMaterialParameters> = {},
): PhysicalMaterial {
  const seed = Array.from(materialId).reduce(
    (total, character, index) => total + character.charCodeAt(0) * (index + 11),
    17,
  );
  return createProceduralPhysicalMaterial({
    materialId,
    kind,
    color,
    roughness,
    metalness,
    seed,
    mapRepeat:
      kind === 'drum-head'
        ? [2, 2]
        : kind === 'brass' || kind === 'brass-dark'
          ? [4, 2]
          : [3, 2],
    normalStrength:
      kind === 'drum-head'
        ? 0.38
        : kind === 'rubber' || kind === 'rubber-edge'
          ? 0.46
          : 0.22,
    options: {
      envMapIntensity: metalness > 0.5 ? 1.35 : 0.8,
      ...options,
    },
  });
}

function addMesh<T extends THREE.BufferGeometry>(
  parent: THREE.Object3D,
  geometry: T,
  material: THREE.Material,
  name: string,
  position?: Vec3,
): THREE.Mesh<T, THREE.Material> {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  if (position) mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinderZ(
  parent: THREE.Object3D,
  radius: number,
  depth: number,
  material: THREE.Material,
  name: string,
  position: Vec3 = [0, 0, 0],
  radialSegments = 48,
  openEnded = false,
): THREE.Mesh<THREE.CylinderGeometry, THREE.Material> {
  const mesh = addMesh(
    parent,
    new THREE.CylinderGeometry(radius, radius, depth, radialSegments, 1, openEnded),
    material,
    name,
    position,
  );
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function cylinderY(
  parent: THREE.Object3D,
  radius: number,
  depth: number,
  material: THREE.Material,
  name: string,
  position: Vec3 = [0, 0, 0],
  radialSegments = 48,
  openEnded = false,
): THREE.Mesh<THREE.CylinderGeometry, THREE.Material> {
  return addMesh(
    parent,
    new THREE.CylinderGeometry(radius, radius, depth, radialSegments, 1, openEnded),
    material,
    name,
    position,
  );
}

function torusZ(
  parent: THREE.Object3D,
  radius: number,
  tube: number,
  material: THREE.Material,
  name: string,
  position: Vec3 = [0, 0, 0],
): THREE.Mesh<THREE.TorusGeometry, THREE.Material> {
  return addMesh(
    parent,
    new THREE.TorusGeometry(radius, tube, 12, 64),
    material,
    name,
    position,
  );
}

function torusY(
  parent: THREE.Object3D,
  radius: number,
  tube: number,
  material: THREE.Material,
  name: string,
  position: Vec3 = [0, 0, 0],
): THREE.Mesh<THREE.TorusGeometry, THREE.Material> {
  const mesh = addMesh(
    parent,
    new THREE.TorusGeometry(radius, tube, 12, 64),
    material,
    name,
    position,
  );
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function rodBetween(
  parent: THREE.Object3D,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  name: string,
  radialSegments = 12,
): THREE.Mesh<THREE.CylinderGeometry, THREE.Material> {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const mesh = addMesh(
    parent,
    new THREE.CylinderGeometry(radius, radius, Math.max(length, 0.001), radialSegments),
    material,
    name,
  );
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(AXIS_Y, direction.normalize());
  return mesh;
}

function markComponent(
  object: THREE.Object3D,
  componentId: string,
  pivot: THREE.Object3D = object,
): void {
  object.userData.componentId = componentId;
  object.userData.pivot = pivot;
}

function addCollar(
  parent: THREE.Object3D,
  position: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  name: string,
): THREE.Mesh<THREE.CylinderGeometry, THREE.Material> {
  return addMesh(
    parent,
    new THREE.CylinderGeometry(radius, radius * 1.06, 0.065, 16),
    material,
    name,
    [position.x, position.y, position.z],
  );
}

function addTripod(
  parent: THREE.Object3D,
  base: Vec3,
  top: Vec3,
  spread: number,
  chrome: THREE.Material,
  rubber: THREE.Material,
  name: string,
): THREE.Group {
  const stand = new THREE.Group();
  stand.name = name;
  stand.userData.supports = true;
  parent.add(stand);

  const baseVector = new THREE.Vector3(...base);
  const topVector = new THREE.Vector3(...top);
  rodBetween(stand, baseVector, topVector, 0.022, chrome, `${name}.main-tube`, 14);
  addCollar(stand, topVector, 0.045, chrome, `${name}.top-collar`);
  addCollar(
    stand,
    new THREE.Vector3(baseVector.x, baseVector.y + 0.16, baseVector.z),
    0.052,
    chrome,
    `${name}.base-collar`,
  );

  for (let index = 0; index < 3; index += 1) {
    const angle = index * (TAU / 3) + Math.PI / 6;
    const foot = new THREE.Vector3(
      baseVector.x + Math.cos(angle) * spread,
      SUPPORT_FOOT_CENTER_Y,
      baseVector.z + Math.sin(angle) * spread,
    );
    rodBetween(
      stand,
      new THREE.Vector3(baseVector.x, baseVector.y + 0.12, baseVector.z),
      foot,
      0.014,
      chrome,
      `${name}.leg.${index}`,
      10,
    );
    const footMesh = addMesh(
      stand,
      new THREE.CapsuleGeometry(0.048, 0.095, 6, 12),
      rubber,
      `${name}.rubber-foot.${index}`,
      [foot.x, foot.y, foot.z],
    );
    footMesh.scale.y = 0.82;
    footMesh.userData.supportFoot = true;
  }

  return stand;
}

function addClamp(
  parent: THREE.Object3D,
  position: Vec3,
  chrome: THREE.Material,
  name: string,
): THREE.Group {
  const clamp = new THREE.Group();
  clamp.name = name;
  clamp.position.set(...position);
  parent.add(clamp);
  cylinderZ(clamp, 0.052, 0.07, chrome, `${name}.hinge`, [0, 0, 0], 16);
  addMesh(
    clamp,
    new THREE.BoxGeometry(0.13, 0.055, 0.07),
    chrome,
    `${name}.body`,
    [0, 0, 0],
  );
  return clamp;
}

const CYMBAL_PROFILE = [
  [0, -0.016],
  [0.055, -0.015],
  [0.13, 0.006],
  [0.22, 0.07],
  [0.34, 0.095],
  [0.48, 0.043],
  [0.73, 0.012],
  [0.94, -0.004],
  [1, -0.024],
] as const;

interface CymbalProfileSample {
  readonly height: number;
  /** dh/dr in the cymbal's local radial +X direction. */
  readonly slope: number;
}

function cymbalProfileSample(radius: number, radial: number): CymbalProfileSample {
  const safeRadius = Math.max(Math.abs(radius), 1e-6);
  const normalized = Math.max(0, Math.min(1, radial / safeRadius));
  for (let index = 1; index < CYMBAL_PROFILE.length; index += 1) {
    const [rightX, rightY] = CYMBAL_PROFILE[index];
    const [leftX, leftY] = CYMBAL_PROFILE[index - 1];
    if (normalized <= rightX) {
      const span = Math.max(rightX - leftX, 1e-6);
      const amount = (normalized - leftX) / span;
      return {
        height: leftY + (rightY - leftY) * amount,
        slope: (rightY - leftY) / (safeRadius * span),
      };
    }
  }
  const last = CYMBAL_PROFILE[CYMBAL_PROFILE.length - 1];
  const previous = CYMBAL_PROFILE[CYMBAL_PROFILE.length - 2];
  return {
    height: last[1],
    slope: (last[1] - previous[1]) / (safeRadius * Math.max(last[0] - previous[0], 1e-6)),
  };
}

function cymbalSurfaceFrame(
  radius: number,
  radial: number,
): { pointLocal: THREE.Vector3; normalLocal: THREE.Vector3 } {
  const sample = cymbalProfileSample(radius, radial);
  return {
    pointLocal: new THREE.Vector3(radial, sample.height, 0),
    // The upper lathe surface is (r, h(r)); its outward normal at +X is
    // (-dh/dr, 1, 0).  This keeps offsets and stick-tip tangency on the
    // authored dish rather than assuming every cymbal patch is horizontal.
    normalLocal: new THREE.Vector3(-sample.slope, 1, 0).normalize(),
  };
}

function addCymbalGrooves(
  parent: THREE.Object3D,
  radius: number,
  material: THREE.Material,
  name: string,
): void {
  for (let index = 1; index <= 7; index += 1) {
    const grooveRadius = radius * (0.18 + index * 0.105);
    const ring = addMesh(
      parent,
      new THREE.TorusGeometry(grooveRadius, 0.0012, 7, 64),
      material,
      `${name}.lathe-groove.${index}`,
      [0, 0.022 + index * 0.0004, 0],
    );
    ring.rotation.x = Math.PI / 2;
    ring.userData.surfaceBand = 'micro-lathe-relief';
  }
}

function createCymbal(
  parent: THREE.Object3D,
  componentId: string,
  position: Vec3,
  radius: number,
  tilt: number,
  brass: THREE.Material,
  grooveMaterial: THREE.Material,
  chrome: THREE.Material,
  rubber: THREE.Material,
): THREE.Group {
  const cymbal = new THREE.Group();
  cymbal.name = componentId;
  cymbal.position.set(...position);
  cymbal.rotation.z = tilt;
  markComponent(cymbal, componentId, cymbal);
  cymbal.userData.playableSurface = 'cymbal';
  cymbal.userData.surfaceNormal = [0, 1, 0];
  cymbal.userData.radius = radius;
  parent.add(cymbal);

  const profile = CYMBAL_PROFILE.map(
    ([radial, height]) => new THREE.Vector2(radius * radial, height),
  );
  profile.push(new THREE.Vector2(0, -0.016));
  addMesh(cymbal, new THREE.LatheGeometry(profile, 96), brass, `${componentId}.dish`);
  addCymbalGrooves(cymbal, radius, grooveMaterial, componentId);

  const felt = addMesh(
    cymbal,
    new THREE.CylinderGeometry(0.065, 0.072, 0.04, 24),
    rubber,
    `${componentId}.felt-washer`,
    [0, 0.105, 0],
  );
  felt.userData.localFeature = `${componentId}.felt-washer`;
  addMesh(
    cymbal,
    new THREE.CylinderGeometry(0.022, 0.028, 0.10, 16),
    chrome,
    `${componentId}.wing-nut`,
    [0, 0.165, 0],
  );
  const wingLeft = addMesh(
    cymbal,
    new THREE.BoxGeometry(0.11, 0.018, 0.025),
    chrome,
    `${componentId}.wing-nut.left`,
    [-0.045, 0.195, 0],
  );
  wingLeft.rotation.y = -0.18;
  const wingRight = wingLeft.clone();
  wingRight.name = `${componentId}.wing-nut.right`;
  wingRight.position.x = 0.045;
  wingRight.rotation.y = 0.18;
  cymbal.add(wingRight);

  return cymbal;
}

interface DrumAssembly {
  readonly group: THREE.Group;
  readonly center: THREE.Vector3;
  readonly radius: number;
  readonly depth: number;
  readonly frontSurface: THREE.Vector3;
  readonly rearSurface: THREE.Vector3;
  readonly headTop: THREE.Vector3;
  readonly axis: 'Y' | 'Z';
}

function createDrumAssembly(
  parent: THREE.Object3D,
  componentId: string,
  center: Vec3,
  radius: number,
  depth: number,
  shell: THREE.Material,
  head: THREE.Material,
  chrome: THREE.Material,
  options: { readonly kick?: boolean; readonly lugCount?: number; readonly axis?: 'Y' | 'Z' } = {},
): DrumAssembly {
  const axis = options.axis ?? (options.kick ? 'Z' : 'Y');
  const group = new THREE.Group();
  group.name = componentId;
  group.position.set(...center);
  markComponent(group, componentId, group);
  group.userData.playableSurface = options.kick ? 'kick-membrane' : 'drum-membrane';
  group.userData.surfaceAxis = axis;
  group.userData.radius = radius;
  parent.add(group);

  const shellMesh =
    axis === 'Y'
      ? cylinderY(
          group,
          radius * 0.965,
          depth,
          shell,
          `${componentId}.shell`,
          [0, 0, 0],
          64,
          true,
        )
      : cylinderZ(
          group,
          radius * 0.965,
          depth,
          shell,
          `${componentId}.shell`,
          [0, 0, 0],
          64,
          true,
        );
  shellMesh.userData.shell = true;

  const positive = depth / 2;
  const negative = -depth / 2;
  const face = axis === 'Y' ? cylinderY : cylinderZ;
  const ring = axis === 'Y' ? torusY : torusZ;
  const positivePosition: Vec3 =
    axis === 'Y' ? [0, positive + 0.012, 0] : [0, 0, positive + 0.012];
  const negativePosition: Vec3 =
    axis === 'Y' ? [0, negative - 0.012, 0] : [0, 0, negative - 0.012];
  const hoopPositivePosition: Vec3 =
    axis === 'Y' ? [0, positive + 0.025, 0] : [0, 0, positive + 0.025];
  const hoopNegativePosition: Vec3 =
    axis === 'Y' ? [0, negative - 0.025, 0] : [0, 0, negative - 0.025];
  const edgePositivePosition: Vec3 =
    axis === 'Y' ? [0, positive - 0.005, 0] : [0, 0, positive - 0.005];
  const edgeNegativePosition: Vec3 =
    axis === 'Y' ? [0, negative + 0.005, 0] : [0, 0, negative + 0.005];
  const positiveHead = face(
    group,
    radius * 0.94,
    0.018,
    options.kick ? shell : head,
    `${componentId}.head.positive`,
    positivePosition,
    64,
  );
  const negativeHead = face(
    group,
    radius * 0.94,
    0.018,
    options.kick ? shell : head,
    `${componentId}.head.negative`,
    negativePosition,
    64,
  );
  positiveHead.userData.playableSurface = true;
  negativeHead.userData.playableSurface = true;
  ring(
    group,
    radius * 0.985,
    options.kick ? 0.033 : 0.024,
    chrome,
    `${componentId}.hoop.positive`,
    hoopPositivePosition,
  );
  ring(
    group,
    radius * 0.985,
    options.kick ? 0.033 : 0.024,
    chrome,
    `${componentId}.hoop.negative`,
    hoopNegativePosition,
  );
  ring(
    group,
    radius * 0.95,
    0.009,
    chrome,
    `${componentId}.shell-edge.positive`,
    edgePositivePosition,
  );
  ring(
    group,
    radius * 0.95,
    0.009,
    chrome,
    `${componentId}.shell-edge.negative`,
    edgeNegativePosition,
  );

  const lugCount = options.lugCount ?? (radius > 0.55 ? 10 : 8);
  for (let index = 0; index < lugCount; index += 1) {
    const angle = index * (TAU / lugCount) + Math.PI / lugCount;
    const x = Math.cos(angle) * radius * 0.992;
    const circumference = Math.sin(angle) * radius * 0.992;
    const y = axis === 'Z' ? circumference : 0;
    const z = axis === 'Y' ? circumference : 0;
    // The lowest kick lug's authored box extends below the floor because it
    // is taller than the shell's radial clearance. Lift the lower kick
    // hardware as one aligned unit instead of translating the whole kit,
    // which would float every stand and pedal above the riser.
    const lugGroundLift = options.kick && axis === 'Z' && y < 0
      ? KICK_LUG_GROUND_LIFT
      : 0;
    const hardwareY = y + lugGroundLift;
    const lug = addMesh(
      group,
      new THREE.BoxGeometry(
        options.kick ? 0.075 : 0.058,
        options.kick ? 0.16 : 0.13,
        0.055,
      ),
      chrome,
      `${componentId}.lug.${index}`,
      [x, hardwareY, z],
    );
    if (axis === 'Y') lug.rotation.y = -Math.sin(angle) * 0.14;
    else lug.rotation.z = -Math.sin(angle) * 0.14;
    const rodPosition: Vec3 = axis === 'Y' ? [x, 0, z] : [x, hardwareY, 0];
    const capPositivePosition: Vec3 =
      axis === 'Y' ? [x, positive + 0.036, z] : [x, hardwareY, positive + 0.036];
    const capNegativePosition: Vec3 =
      axis === 'Y' ? [x, negative - 0.036, z] : [x, hardwareY, negative - 0.036];
    const rod = axis === 'Y' ? cylinderY : cylinderZ;
    rod(
      group,
      0.019,
      depth + 0.11,
      chrome,
      `${componentId}.tension-rod.${index}`,
      rodPosition,
      10,
    );
    rod(
      group,
      0.027,
      0.025,
      chrome,
      `${componentId}.lug-cap.positive.${index}`,
      capPositivePosition,
      12,
    );
    rod(
      group,
      0.027,
      0.025,
      chrome,
      `${componentId}.lug-cap.negative.${index}`,
      capNegativePosition,
      12,
    );
  }

  const centerVector = new THREE.Vector3(...center);
  const frontSurface =
    axis === 'Z'
      ? new THREE.Vector3(centerVector.x, centerVector.y, centerVector.z + positive + 0.021)
      : new THREE.Vector3(centerVector.x, centerVector.y + positive + 0.021, centerVector.z);
  const rearSurface =
    axis === 'Z'
      ? new THREE.Vector3(centerVector.x, centerVector.y, centerVector.z - positive - 0.021)
      : new THREE.Vector3(centerVector.x, centerVector.y - positive - 0.021, centerVector.z);
  const headTop = axis === 'Y' ? frontSurface.clone() : frontSurface.clone();
  group.userData.frontSurface = frontSurface.toArray();
  group.userData.rearSurface = rearSurface.toArray();
  return {
    group,
    center: centerVector,
    radius,
    depth,
    frontSurface,
    rearSurface,
    headTop,
    axis,
  };
}

function addKickPort(
  kick: DrumAssembly,
  rubber: THREE.Material,
  shell: THREE.Material,
): THREE.Group {
  const port = new THREE.Group();
  port.name = 'drums.kick.port';
  const localFront = kick.frontSurface.clone().sub(kick.center);
  port.position.set(localFront.x + 0.22, localFront.y - 0.20, localFront.z + 0.004);
  kick.group.add(port);
  cylinderZ(port, 0.155, 0.026, shell, 'drums.kick.port.inner', [0, 0, 0], 48);
  torusZ(port, 0.16, 0.012, rubber, 'drums.kick.port.rim', [0, 0, 0.018]);
  port.userData.localFeature = 'kick.port-hole';
  return port;
}

function addDrumPedal(
  parent: THREE.Object3D,
  x: number,
  z: number,
  chrome: THREE.Material,
  rubber: THREE.Material,
  name: string,
): THREE.Group {
  const pedal = new THREE.Group();
  pedal.name = name;
  pedal.userData.componentId = name;
  pedal.userData.pivot = pedal;
  pedal.userData.playerSide = 'rear-negative-Z';
  pedal.userData.footboardCenter = [x, 0.095, z];
  parent.add(pedal);

  const board = addMesh(
    pedal,
    new THREE.BoxGeometry(0.22, 0.055, 0.42),
    chrome,
    `${name}.footboard`,
    [x, 0.095, z],
  );
  board.userData.footContact = true;
  addMesh(
    pedal,
    new THREE.BoxGeometry(0.17, 0.025, 0.32),
    rubber,
    `${name}.grip-pad`,
    [x, 0.13, z - 0.01],
  );
  for (let index = -2; index <= 2; index += 1) {
    addMesh(
      pedal,
      new THREE.BoxGeometry(0.18, 0.008, 0.012),
      chrome,
      `${name}.grip-rib.${index + 2}`,
      [x, 0.148, z + index * 0.052],
    );
  }
  const hingeZ = z + 0.18;
  rodBetween(
    pedal,
    new THREE.Vector3(x - 0.10, 0.075, hingeZ),
    new THREE.Vector3(x + 0.10, 0.075, hingeZ),
    0.014,
    chrome,
    `${name}.hinge`,
  );
    const heel = addMesh(
      pedal,
      new THREE.CapsuleGeometry(0.06, 0.14, 6, 12),
      rubber,
      `${name}.heel`,
      [x, PEDAL_HEEL_CENTER_Y, z - 0.23],
    );
  heel.scale.y = 0.55;
  pedal.userData.hinge = [x, 0.075, hingeZ];
  pedal.userData.heel = [x, PEDAL_HEEL_CENTER_Y, z - 0.23];
  return pedal;
}

function addKickBeater(
  parent: THREE.Object3D,
  position: Vec3,
  contact: KickBeaterContact,
  chrome: THREE.Material,
  rubber: THREE.Material,
): THREE.Object3D {
  const beater = new THREE.Group();
  beater.name = 'drums.kick.beater';
  beater.position.set(...position);
  beater.rotation.x = contact.restRotationX;
  beater.userData.componentId = 'drums.kick.beater';
  beater.userData.pivot = beater;
  beater.userData.animationRole = 'kick-beater';
  beater.userData.playerSide = 'rear-negative-Z';
  beater.userData.contactSurfaceId = 'drums.kick';
  beater.userData.restRotationX = contact.restRotationX;
  beater.userData.contactRotationX = contact.contactRotationX;
  parent.add(beater);

  const shaft = addMesh(
    beater,
    new THREE.CylinderGeometry(0.012, 0.016, 0.58, 12),
    chrome,
    'drums.kick.beater.shaft',
    [0, 0.29, 0],
  );
  shaft.userData.componentId = 'drums.kick.beater';
  const head = addMesh(
    beater,
    new THREE.CapsuleGeometry(0.052, 0.075, 6, 12),
    rubber,
    'drums.kick.beater.head',
    [0, 0.58, 0],
  );
  head.scale.set(1.05, 0.82, 0.72);
  head.userData.componentId = 'drums.kick.beater';
  head.userData.contactRadius = 0.052;
  return beater;
}

function createStick(
  parent: THREE.Object3D,
  id: 'left' | 'right',
  wood: THREE.Material,
  restTip: THREE.Vector3,
): THREE.Group {
  const stick = new THREE.Group();
  stick.name = `drums.stick.${id}`;
  const direction = playerGripDirection(restTip, restTip, id);
  stick.quaternion.setFromUnitVectors(AXIS_Z, direction);
  stick.position.copy(restTip).addScaledVector(direction, -0.4);
  stick.userData.componentId = `drums.stick.${id}`;
  stick.userData.pivot = stick;
  stick.userData.tipLocalPosition = [0, 0, 0.4];
  stick.userData.tipLength = 0.4;
  stick.userData.fixedShaftLength = 0.4;
  stick.userData.playerGripDirection = direction.toArray();
  stick.userData.playerGrip = stick.position.toArray();
  stick.userData.mechanicsTip = restTip.toArray();
  stick.userData.tipRadius = STICK_TIP_RADIUS;
  stick.userData.animationRole = `${id}-stick-stroke`;
  stick.userData.mechanicsRestTip = restTip.toArray();
  parent.add(stick);

  const shaft = addMesh(
    stick,
    new THREE.CylinderGeometry(0.014, 0.019, 0.38, 14),
    wood,
    `drums.stick.${id}.shaft`,
    [0, 0, 0.2],
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.userData.componentId = `drums.stick.${id}`;
  const tip = addMesh(
    stick,
    new THREE.SphereGeometry(STICK_TIP_RADIUS, 14, 10),
    wood,
    `drums.stick.${id}.tip`,
    [0, 0, 0.4],
  );
  tip.userData.playableTip = true;
  for (let index = 0; index < 3; index += 1) {
    const grain = addMesh(
      stick,
      new THREE.TorusGeometry(0.018, 0.0014, 5, 18),
      wood,
      `drums.stick.${id}.grain.${index}`,
      [0, 0, 0.08 + index * 0.1],
    );
    grain.rotation.x = Math.PI / 2;
  }
  return stick;
}

function addDrummerStool(
  parent: THREE.Object3D,
  chrome: THREE.Material,
  rubber: THREE.Material,
  upholstery: THREE.Material,
): THREE.Group {
  const stool = new THREE.Group();
  stool.name = 'drums.stool';
  stool.position.set(-0.12, 0, -1.25);
  stool.userData.playerSeat = true;
  stool.userData.playerSide = 'rear-negative-Z';
  parent.add(stool);

  addMesh(
    stool,
    new THREE.CylinderGeometry(0.34, 0.34, 0.12, 32),
    upholstery,
    'drums.stool.seat',
    [0, 0.99, 0],
  );
  addMesh(
    stool,
    new THREE.CylinderGeometry(0.23, 0.26, 0.07, 24),
    chrome,
    'drums.stool.seat-trim',
    [0, 0.92, 0],
  );
  addMesh(
    stool,
    new THREE.CylinderGeometry(0.055, 0.065, 0.52, 16),
    chrome,
    'drums.stool.post',
    [0, 0.64, 0],
  );
  addCollar(stool, new THREE.Vector3(0, 0.42, 0), 0.10, chrome, 'drums.stool.base-collar');
  for (let index = 0; index < 3; index += 1) {
    const angle = index * (TAU / 3) + Math.PI / 2;
    const foot = new THREE.Vector3(Math.cos(angle) * 0.30, 0.055, Math.sin(angle) * 0.30);
    foot.y = SUPPORT_FOOT_CENTER_Y;
    rodBetween(
      stool,
      new THREE.Vector3(0, 0.43, 0),
      foot,
      0.018,
      chrome,
      `drums.stool.leg.${index}`,
      10,
    );
    const footMesh = addMesh(
      stool,
      new THREE.CapsuleGeometry(0.048, 0.095, 6, 12),
      rubber,
      `drums.stool.rubber-foot.${index}`,
      [foot.x, foot.y, foot.z],
    );
    footMesh.scale.y = 0.82;
  }
  return stool;
}

/**
 * Build the procedural acoustic kit in a Y-up, +Z-audience frame.
 *
 * The kick's audience-facing resonant head is +Z. Its batter head, pedal,
 * beater pivot and stool are on the player side at -Z. Every hand-played
 * surface has its own component and root-local anchor; the score must use
 * those IDs directly.
 */
export function createDrumsModel(): DrumModelWithMechanics {
  const root = new THREE.Group();
  root.name = 'drums.procedural-kit';
  root.userData.instrumentId = 'drums';
  root.userData.assetSource = 'procedural';
  root.userData.coordinateFrame = { up: '+Y', front: '+Z audience', playerSide: '-Z' };
  root.userData.sculptRuntime = {
    schemaVersion: '2.2',
    targetId: 'drums',
    coordinateFrame: { up: '+Y', front: '+Z audience', playerSide: '-Z', units: 'meters' },
    dimensions: { width: 3.36, height: 2.43, depth: 2.6 },
    sourceImage: 'references/genimage/drums-v1.png',
    referencePbr: {
      status: 'reference-derived',
      threshold: 0.7,
      materials: ['lacquer', 'head', 'brass', 'chrome', 'wood', 'rubber'],
    },
    action: {
      hitAnchors: [...DRUM_PLAYABLE_SURFACES],
      handSurfaces: ['drums.snare', 'drums.tom', 'drums.floortom', 'drums.hihat', 'drums.crash', 'drums.ride'],
      kickSurface: 'drums.kick',
      sticksTipLocalZ: 0.4,
      kickBeaterRotationAxis: 'X',
      kickBeaterPlayerSide: '-Z',
      cymbalSwayRotationAxis: 'Z',
    },
  };

  const lacquer = makeMaterial(
    'drums.lacquer',
    'lacquer',
    0x24292f,
    0.24,
    0.05,
    { clearcoat: 0.82, clearcoatRoughness: 0.14 },
  );
  const lacquerEdge = makeMaterial(
    'drums.lacquer.edge',
    'lacquer',
    0x3a424a,
    0.25,
    0.08,
    { clearcoat: 0.68, clearcoatRoughness: 0.18 },
  );
  const head = makeMaterial(
    'drums.head',
    'drum-head',
    0xd5d0c5,
    0.44,
    0.02,
    { sheen: 0.12, sheenRoughness: 0.75 },
  );
  const brass = makeMaterial('drums.brass', 'brass', 0xb4814b, 0.24, 0.88, {
    side: THREE.DoubleSide,
    anisotropy: 0.42,
    anisotropyRotation: 0.35,
  });
  const brassDark = makeMaterial(
    'drums.brass.dark',
    'brass-dark',
    0x7c532b,
    0.34,
    0.82,
    { side: THREE.DoubleSide, anisotropy: 0.34 },
  );
  const chrome = makeMaterial(
    'drums.chrome',
    'chrome',
    0xd2dae2,
    0.16,
    0.96,
    { clearcoat: 0.22, clearcoatRoughness: 0.1 },
  );
  const chromeDark = makeMaterial('drums.chrome.dark', 'chrome-dark', 0x5f6871, 0.22, 0.82);
  const wood = makeMaterial(
    'drums.stick.wood',
    'wood',
    0xd0a16b,
    0.34,
    0.02,
    { clearcoat: 0.18, clearcoatRoughness: 0.24 },
  );
  const rubber = makeMaterial('drums.rubber', 'rubber', 0x111314, 0.76, 0.02);
  const rubberEdge = makeMaterial('drums.rubber.edge', 'rubber-edge', 0x2c2e2d, 0.64, 0.02);
  const upholstery = makeMaterial(
    'drums.stool.upholstery',
    'rubber',
    0x252227,
    0.88,
    0.01,
  );

  const components = new Map<string, THREE.Object3D>();
  const hitAnchors = new Map<string, THREE.Vector3>();
  const cymbals = new Map<string, THREE.Object3D>();
  const sticks = new Map<'left' | 'right', THREE.Group>();
  const playableSurfaces = new Map<string, Record<string, unknown>>();

  // Audience-facing +Z resonant head. The pedal and beater deliberately sit
  // behind it at -Z, leaving no pedal board inside the kick shell envelope.
  const kick = createDrumAssembly(
    root,
    'drums.kick',
    [0, 0.72, 0.14],
    0.67,
    0.62,
    lacquer,
    head,
    chrome,
    { kick: true, axis: 'Z', lugCount: 10 },
  );
  // The snare is left of the shell with a small lateral gap; its player-side
  // position keeps it reachable without crossing the kick body.
  const snare = createDrumAssembly(
    root,
    'drums.snare',
    [-1.04, 0.94, -0.12],
    0.34,
    0.34,
    lacquer,
    head,
    chrome,
    { axis: 'Y', lugCount: 8 },
  );
  // Keep the rack tom above the kick with a real vertical gap under its shell.
  const tom = createDrumAssembly(
    root,
    'drums.tom',
    [0.08, 1.76, -0.34],
    0.36,
    0.34,
    lacquer,
    head,
    chrome,
    { axis: 'Y', lugCount: 6 },
  );
  const floorTom = createDrumAssembly(
    root,
    'drums.floortom',
    [1.04, 0.86, -0.18],
    0.38,
    0.50,
    lacquer,
    head,
    chrome,
    { axis: 'Y', lugCount: 8 },
  );
  for (const [id, assembly] of [
    ['drums.kick', kick],
    ['drums.snare', snare],
    ['drums.tom', tom],
    ['drums.floortom', floorTom],
  ] as const) {
    components.set(id, assembly.group);
  }

  // Kick is struck on the rear/player-side batter head. Hand anchors include
  // the authored stick-tip radius so the visible wooden tip is tangent.
  hitAnchors.set('drums.kick', kick.rearSurface.clone());
  hitAnchors.set(
    'drums.snare',
    snare.headTop.clone().add(new THREE.Vector3(0, STICK_TIP_RADIUS, 0)),
  );
  hitAnchors.set(
    'drums.tom',
    tom.headTop.clone().add(new THREE.Vector3(0, STICK_TIP_RADIUS, 0)),
  );
  hitAnchors.set(
    'drums.floortom',
    floorTom.headTop.clone().add(new THREE.Vector3(0, STICK_TIP_RADIUS, 0)),
  );
  playableSurfaces.set('drums.kick', {
    componentId: 'drums.kick',
    kind: 'membrane',
    meshName: 'drums.kick.head.negative',
    pitch: 36,
    side: 'player-rear',
    anchor: hitAnchors.get('drums.kick')!.toArray(),
  });
  for (const [id, , pitch] of [
    ['drums.snare', snare, 38],
    ['drums.tom', tom, 45],
    ['drums.floortom', floorTom, 41],
  ] as const) {
    playableSurfaces.set(id, {
      componentId: id,
      kind: 'membrane',
      meshName: `${id}.head.positive`,
      pitch,
      side: 'player-top',
      anchor: hitAnchors.get(id)!.toArray(),
    });
  }

  addKickPort(kick, rubber, lacquerEdge);
  // Keep the kick footboard in the player corridor between the batter head
  // and stool. This leaves a visible rear gap instead of tucking the board
  // under the stool's front edge.
  const kickPedal = addDrumPedal(root, 0.10, -0.58, chrome, rubber, 'drums.kick.pedal');
  const hihatPedal = addDrumPedal(root, -1.25, 0.02, chrome, rubber, 'drums.hihat.pedal');
  components.set('drums.kick.pedal', kickPedal);
  components.set('drums.hihat.pedal', hihatPedal);

  const standRoot = new THREE.Group();
  standRoot.name = 'drums.stands';
  standRoot.userData.supportGroup = true;
  root.add(standRoot);
  const hiHatStand = addTripod(
    standRoot,
    [-1.25, 0, 0.28],
    [-1.25, 1.50, 0.28],
    0.20,
    chrome,
    rubber,
    'drums.hihat.stand',
  );
  const snareStand = addTripod(
    standRoot,
    [-1.04, 0, -0.12],
    [-1.04, 0.68, -0.12],
    0.22,
    chrome,
    rubber,
    'drums.snare.stand',
  );
  const floorTomStand = addTripod(
    standRoot,
    [1.04, 0, -0.18],
    [1.04, 0.52, -0.18],
    0.25,
    chrome,
    rubber,
    'drums.floortom.stand',
  );
  const crashStand = addTripod(
    standRoot,
    [-0.66, 0, -0.76],
    [-0.66, 1.74, -0.76],
    0.21,
    chrome,
    rubber,
    'drums.crash.stand',
  );
  // The ride pole sits outside the floor tom's x envelope; the boom reaches
  // inward to the ride dish instead of drilling through its shell.
  const rideStand = addTripod(
    standRoot,
    [1.52, 0, -0.42],
    [1.52, 1.74, -0.42],
    0.18,
    chrome,
    rubber,
    'drums.ride.stand',
  );
  components.set('drums.stands', standRoot);
  markComponent(standRoot, 'drums.stands', standRoot);
  void hiHatStand;
  void snareStand;
  void floorTomStand;

  // Rack mount starts above the kick hoop; it cannot pass through the shell.
  rodBetween(
    standRoot,
    new THREE.Vector3(0.08, 1.50, -0.22),
    new THREE.Vector3(0.08, 1.60, -0.34),
    0.026,
    chrome,
    'drums.tom.mount-post',
    14,
  );
  addClamp(standRoot, [0.08, 1.60, -0.34], chrome, 'drums.tom.mount-clamp');
  rodBetween(
    crashStand,
    new THREE.Vector3(-0.66, 1.74, -0.76),
    new THREE.Vector3(-0.66, 2.10, -0.56),
    0.018,
    chrome,
    'drums.crash.stand.upper',
  );
  rodBetween(
    rideStand,
    new THREE.Vector3(1.52, 1.74, -0.42),
    new THREE.Vector3(0.88, 2.06, -0.42),
    0.018,
    chrome,
    'drums.ride.stand.upper',
  );
  rodBetween(
    standRoot,
    new THREE.Vector3(-0.66, 1.90, -0.66),
    new THREE.Vector3(-0.66, 2.15, -0.56),
    0.014,
    chrome,
    'drums.crash.boom',
  );
  rodBetween(
    standRoot,
    new THREE.Vector3(1.52, 1.90, -0.42),
    new THREE.Vector3(0.88, 2.12, -0.42),
    0.014,
    chrome,
    'drums.ride.boom',
  );
  addClamp(standRoot, [-0.66, 1.86, -0.70], chrome, 'drums.crash.boom-clamp');
  addClamp(standRoot, [1.30, 1.86, -0.42], chrome, 'drums.ride.boom-clamp');

  // The hi-hat animation target contains only the cymbal stack. Its fixed
  // stand/rod remains in standRoot, so cymbal sway cannot swing the floor base.
  const hihat = new THREE.Group();
  hihat.name = 'drums.hihat';
  hihat.position.set(-1.25, 1.58, 0.28);
  markComponent(hihat, 'drums.hihat', hihat);
  hihat.userData.playableSurface = 'cymbal-pair';
  hihat.userData.surfaceNormal = [0, 1, 0];
  root.add(hihat);
  const hihatLower = createCymbal(
    hihat,
    'drums.hihat.lower',
    [0, -0.065, 0],
    0.34,
    0,
    brassDark,
    brassDark,
    chrome,
    rubber,
  );
  const hihatUpper = createCymbal(
    hihat,
    'drums.hihat.upper',
    [0, 0.065, 0],
    0.34,
    0,
    brass,
    brassDark,
    chrome,
    rubber,
  );
  hihatLower.userData.surfaceBand = 'lathed-bronze-lower';
  hihatUpper.userData.surfaceBand = 'lathed-bronze-upper';
  cylinderY(hihat, 0.045, 0.035, chrome, 'drums.hihat.bell-cap', [0, 0.17, 0], 24);
  const clutch = addCollar(
    hihat,
    new THREE.Vector3(0, 0.22, 0),
    0.054,
    rubber,
    'drums.hihat.clutch',
  );
  clutch.rotation.x = 0;
  // Fixed vertical shaft is separate from the animated cymbal group.
  rodBetween(
    standRoot,
    new THREE.Vector3(-1.25, 0.16, 0.28),
    new THREE.Vector3(-1.25, 1.55, 0.28),
    0.014,
    chrome,
    'drums.hihat.rod',
    12,
  );
  components.set('drums.hihat', hihat);
  cymbals.set('drums.hihat', hihat);
  const hihatRadial = 0.18;
  const hihatFrame = cymbalSurfaceFrame(0.34, hihatRadial);
  const hihatSurfacePoint = hihatFrame.pointLocal.clone().add(new THREE.Vector3(0, 0.065, 0));
  hihat.userData.surfaceNormal = hihatFrame.normalLocal.toArray();
  const hihatAnchor = hihatSurfacePoint
    .clone()
    .addScaledVector(hihatFrame.normalLocal, STICK_TIP_RADIUS)
    .add(hihat.position);
  hitAnchors.set('drums.hihat', hihatAnchor);
  playableSurfaces.set('drums.hihat', {
    componentId: 'drums.hihat',
    kind: 'cymbal',
    meshName: 'drums.hihat.upper.dish',
    pitch: 42,
    side: 'player-top',
    anchor: hihatAnchor.toArray(),
  });

  const crash = createCymbal(
    root,
    'drums.crash',
    [-0.66, 2.18, -0.56],
    0.48,
    -0.10,
    brass,
    brassDark,
    chrome,
    rubber,
  );
  const ride = createCymbal(
    root,
    'drums.ride',
    [0.88, 2.16, -0.42],
    0.50,
    0.08,
    brass,
    brassDark,
    chrome,
    rubber,
  );
  components.set('drums.crash', crash);
  components.set('drums.ride', ride);
  cymbals.set('drums.crash', crash);
  cymbals.set('drums.ride', ride);

  const crashRadial = 0.48 * 0.56;
  const crashFrame = cymbalSurfaceFrame(0.48, crashRadial);
  crash.userData.surfaceNormal = crashFrame.normalLocal.toArray();
  const crashLocal = crashFrame.pointLocal
    .clone()
    .addScaledVector(crashFrame.normalLocal, STICK_TIP_RADIUS);
  crashLocal.applyAxisAngle(AXIS_Z, -0.10);
  const crashAnchor = crashLocal.add(new THREE.Vector3(-0.66, 2.18, -0.56));
  const rideRadial = 0.50 * 0.56;
  const rideFrame = cymbalSurfaceFrame(0.50, rideRadial);
  ride.userData.surfaceNormal = rideFrame.normalLocal.toArray();
  const rideLocal = rideFrame.pointLocal
    .clone()
    .addScaledVector(rideFrame.normalLocal, STICK_TIP_RADIUS);
  rideLocal.applyAxisAngle(AXIS_Z, 0.08);
  const rideAnchor = rideLocal.add(new THREE.Vector3(0.88, 2.16, -0.42));
  hitAnchors.set('drums.crash', crashAnchor);
  hitAnchors.set('drums.ride', rideAnchor);
  playableSurfaces.set('drums.crash', {
    componentId: 'drums.crash',
    kind: 'cymbal',
    meshName: 'drums.crash.dish',
    pitch: 49,
    side: 'player-top',
    anchor: crashAnchor.toArray(),
  });
  playableSurfaces.set('drums.ride', {
    componentId: 'drums.ride',
    kind: 'cymbal',
    meshName: 'drums.ride.dish',
    pitch: 51,
    side: 'player-top',
    anchor: rideAnchor.toArray(),
  });

  // Keep target anchors on the actual animated cymbal surfaces. The score
  // pose is evaluated from these root-local points, so a cymbal sway must
  // update the point before a stick path is solved for that frame.
  const cymbalAnchorLocal = new Map<string, THREE.Vector3>([
    [
      'drums.hihat',
      hihatSurfacePoint
        .clone()
        .addScaledVector(hihatFrame.normalLocal, STICK_TIP_RADIUS),
    ],
    [
      'drums.crash',
      crashFrame.pointLocal
        .clone()
        .addScaledVector(crashFrame.normalLocal, STICK_TIP_RADIUS),
    ],
    [
      'drums.ride',
      rideFrame.pointLocal
        .clone()
        .addScaledVector(rideFrame.normalLocal, STICK_TIP_RADIUS),
    ],
  ]);
  const cymbalRestRotation = new Map(
    [...cymbals].map(([id, object]) => [id, object.rotation.z]),
  );

  // Effects use the actual rendered target objects and their local surface
  // frames. This keeps a cymbal's sway in the ring transform without reading
  // or mutating the canonical score anchors used by stick mechanics.
  const impactSurfaces = new Map<string, DrumImpactSurface>([
    [
      'drums.kick',
      {
        id: 'drums.kick',
        object: root.getObjectByName('drums.kick.head.negative')!,
        pointLocal: new THREE.Vector3(0, -0.009, 0),
        normalLocal: new THREE.Vector3(0, -1, 0),
        radius: 0.67 * 0.94,
        offset: 0.0018,
      },
    ],
    ...(['drums.snare', 'drums.tom', 'drums.floortom'] as const).map((id) => [
      id,
      {
        id,
        object: root.getObjectByName(`${id}.head.positive`)!,
        pointLocal: new THREE.Vector3(0, 0.009, 0),
        normalLocal: new THREE.Vector3(0, 1, 0),
        radius: ({
          'drums.snare': 0.34,
          'drums.tom': 0.36,
          'drums.floortom': 0.38,
        } as Record<typeof id, number>)[id] * 0.94,
        offset: 0.0018,
      },
    ] as const),
    [
      'drums.hihat',
      {
        id: 'drums.hihat',
        object: hihat,
        pointLocal: hihatSurfacePoint,
        normalLocal: hihatFrame.normalLocal,
        radius: 0.34,
        offset: 0.0018,
      },
    ],
    [
      'drums.crash',
      {
        id: 'drums.crash',
        object: crash,
        pointLocal: crashFrame.pointLocal,
        normalLocal: crashFrame.normalLocal,
        radius: 0.48,
        offset: 0.0018,
      },
    ],
    [
      'drums.ride',
      {
        id: 'drums.ride',
        object: ride,
        pointLocal: rideFrame.pointLocal,
        normalLocal: rideFrame.normalLocal,
        radius: 0.50,
        offset: 0.0018,
      },
    ],
  ]);
  const impactEffects = createDrumImpactEffects(root, impactSurfaces);

  const syncCymbalMechanics = (
    timeSeconds: number,
    notes: readonly NoteEvent[],
    reducedMotion: boolean,
  ): void => {
    const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
    for (const [id, object] of cymbals) {
      let event: NoteEvent | undefined;
      for (const note of notes) {
        if (
          note.instrumentId === 'drums' &&
          note.componentId === id &&
          note.onsetSeconds <= time &&
          (!event || note.onsetSeconds > event.onsetSeconds)
        ) {
          event = note;
        }
      }
      const age = event ? time - event.onsetSeconds : Number.POSITIVE_INFINITY;
      const sway = reducedMotion
        ? 0
        : event && age < 2
          ? Math.sin(age * 35) * Math.exp(-age * 4) * 0.05 * event.velocity
          : 0;
      object.rotation.z = (cymbalRestRotation.get(id) ?? 0) + sway;

      const localAnchor = cymbalAnchorLocal.get(id);
      const anchor = hitAnchors.get(id);
      if (!localAnchor || !anchor) continue;
      const worldAnchor = object.localToWorld(localAnchor.clone());
      const rootAnchor = root.worldToLocal(worldAnchor);
      anchor.copy(rootAnchor);
      const surface = playableSurfaces.get(id);
      if (surface) surface.anchor = rootAnchor.toArray();
    }
  };

  const kickBeaterContact: KickBeaterContact = {
    restRotationX: -0.40,
    contactRotationX: 0.14,
  };
  // The pivot sits behind the rear membrane. At contactRotationX the actual
  // capsule vertex reaches the rear batter head tangent; the shaft never
  // starts on the audience face.
  const kickBeater = addKickBeater(
    root,
    [0.10, 0.12, -0.3136],
    kickBeaterContact,
    chrome,
    rubber,
  );
  components.set('drums.kick.beater', kickBeater);
  const pedalHinge = new THREE.Vector3(...(kickPedal.userData.hinge as [number, number, number]));
  rodBetween(
    root,
    pedalHinge,
    new THREE.Vector3(0.10, 0.12, -0.319),
    0.012,
    chrome,
    'drums.kick.pedal.linkage',
    10,
  );

  const leftRestTip = new THREE.Vector3(-1.12, 1.42, -0.34);
  const rightRestTip = new THREE.Vector3(-0.78, 1.42, -0.34);
  const leftStick = createStick(root, 'left', wood, leftRestTip);
  const rightStick = createStick(root, 'right', wood, rightRestTip);
  sticks.set('left', leftStick);
  sticks.set('right', rightStick);
  components.set('drums.stick.left', leftStick);
  components.set('drums.stick.right', rightStick);

  const stool = addDrummerStool(root, chrome, rubber, upholstery);
  components.set('drums.stool', stool);

  root.userData.componentMap = components;
  root.userData.hitAnchors = hitAnchors;
  root.userData.sticks = sticks;
  root.userData.cymbals = cymbals;
  root.userData.kickBeater = kickBeater;
  root.userData.kickBeaterContact = kickBeaterContact;
  root.userData.playableSurfaces = playableSurfaces;
  // The rack tom is the only shell crossed by a dense authored hand return
  // in the score. Keep its measured local envelope beside the model so the
  // mechanics route can clear the real shell without moving the kit.
  const drumMotionObstacles: readonly DrumMotionObstacle[] = [
    {
      id: 'drums.tom.shell',
      center: tom.center.toArray() as [number, number, number],
      radius: tom.radius * 0.965,
      minY: tom.center.y - tom.depth * 0.5,
      maxY: tom.center.y + tom.depth * 0.5,
      clearance: STICK_TIP_RADIUS + 0.004,
    },
    {
      id: 'drums.crash.dish',
      center: crash.position.toArray() as [number, number, number],
      radius: Number(crash.userData.radius),
      minY: crash.position.y - 0.024,
      maxY: crash.position.y + 0.095,
      clearance: STICK_TIP_RADIUS + 0.004,
      normalLocal: crashFrame.normalLocal.toArray() as [number, number, number],
    },
  ];
  root.userData.drumMotionObstacles = drumMotionObstacles;
  root.userData.drumImpactSurfaces = impactSurfaces;
  root.userData.drumImpactEffects = impactEffects;
  root.userData.drumImpactEffectPoolSize = impactEffects.maxPoolSize;
  root.userData.mechanicsRestTips = {
    left: leftRestTip.toArray(),
    right: rightRestTip.toArray(),
  };
  root.userData.dimensions = { width: 3.36, height: 2.43, depth: 2.6 };
  root.userData.componentCounts = {
    playableSurfaces: DRUM_PLAYABLE_SURFACES.length,
    membranes: 4,
    cymbalGroups: 3,
    cymbalDiscs: 4,
    stands: 5,
    pedals: 2,
    sticks: 2,
  };
  root.userData.materials = {
    lacquer,
    lacquerEdge,
    head,
    brass,
    brassDark,
    chrome,
    chromeDark,
    wood,
    rubber,
    rubberEdge,
    upholstery,
  };

  const mechanicsHost: DrumMechanicsHost = {
    root,
    hitAnchors,
    sticks,
    kickBeater,
  };
  const applyMechanics = (
    timeSeconds: number,
    notes: readonly NoteEvent[],
    reducedMotion = false,
  ): void => {
    syncCymbalMechanics(timeSeconds, notes, reducedMotion);
    applyDrumMechanics(
      mechanicsHost,
      timeSeconds,
      notes,
      reducedMotion,
      kickBeaterContact,
    );
    impactEffects.apply(timeSeconds, notes, reducedMotion);
  };
  root.userData.applyMechanics = applyMechanics;

  return {
    root,
    components,
    hitAnchors,
    sticks,
    kickBeater,
    cymbals,
    applyMechanics,
    kickBeaterContact,
    impactEffects,
  };
}

export default createDrumsModel;
