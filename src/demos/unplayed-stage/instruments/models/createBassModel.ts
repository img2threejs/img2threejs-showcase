import * as THREE from 'three';

import {
  addBodyBinding,
  addCylinderBetween,
  addFrontCylinder,
  addFrontDot,
  addGrainLine,
  createLathedKnob,
  createProfileMesh,
  createRoundedBox,
  createTrianglePick,
} from './instrumentGeometry';
import {
  createProceduralPhysicalMaterial,
  createProceduralStandardMaterial,
} from '../../materials/proceduralMaterials';
import {
  addComponent,
  createVibratingString,
  setShadowFlags,
  setStringVibration,
  type ProceduralStringModel,
} from './stringGeometry';

export const BASS_SCALE_LENGTH = 0.8;
export const BASS_NUT_Y = 1.225;
// The admitted portrait places the bridge low in the lower bout; keeping this
// as a named anchor also makes every string and saddle share the same measured
// endpoint.
export const BASS_BRIDGE_Y = 0.165;
export const BASS_TARGET_HEIGHT = 1.4;
export const BASS_FRET_COUNT = 24;
export const BASS_TUNING_MIDI = [28, 33, 38, 43] as const;

/** A distinct asymmetric double-cut solid-body profile, sized in metres. */
export const BASS_BODY_PROFILE: readonly (readonly [number, number])[] = [
  // Stations follow the asymmetrical double-cut silhouette in the reference:
  // a long left horn, a shorter low right horn, narrow upper waist, and a
  // broad but low lower bout.  The inner horn edges remain explicit so the
  // two cutaways do not collapse into a triangular slab.
  [-0.052, 0.600],
  [-0.080, 0.640],
  [-0.120, 0.700],
  [-0.155, 0.760],
  [-0.188, 0.810],
  [-0.198, 0.835],
  [-0.204, 0.800],
  [-0.207, 0.764],
  [-0.198, 0.732],
  [-0.192, 0.700],
  [-0.184, 0.669],
  [-0.171, 0.636],
  [-0.156, 0.604],
  [-0.145, 0.573],
  [-0.134, 0.541],
  [-0.127, 0.508],
  [-0.128, 0.476],
  [-0.135, 0.445],
  [-0.163, 0.380],
  [-0.177, 0.349],
  [-0.189, 0.316],
  [-0.197, 0.284],
  [-0.198, 0.252],
  [-0.192, 0.221],
  [-0.179, 0.188],
  [-0.168, 0.156],
  [-0.164, 0.125],
  [-0.150, 0.090],
  [-0.100, 0.055],
  [-0.030, 0.035],
  [0.040, 0.035],
  [0.110, 0.055],
  [0.160, 0.090],
  [0.196, 0.125],
  [0.206, 0.156],
  [0.221, 0.188],
  [0.229, 0.221],
  [0.228, 0.252],
  [0.221, 0.284],
  [0.209, 0.316],
  [0.193, 0.349],
  [0.174, 0.380],
  [0.156, 0.445],
  [0.163, 0.476],
  [0.174, 0.508],
  [0.183, 0.541],
  [0.185, 0.573],
  [0.184, 0.588],
  [0.176, 0.604],
  [0.160, 0.618],
  [0.140, 0.626],
  [0.120, 0.622],
  [0.102, 0.606],
  [0.089, 0.580],
  [0.076, 0.550],
  [0.061, 0.530],
  [0.050, 0.550],
  [0.040, 0.575],
  [0.030, 0.600],
];

const BASS_STRING_OFFSETS = [-0.025, -0.0083, 0.0083, 0.025];
const BASS_STRING_RADII = [0.0025, 0.00205, 0.0017, 0.0014];
const BASS_INLAY_FRETS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
const BASS_PICK_Y = 0.525;

function bassStringPath(index: number): readonly THREE.Vector3[] {
  const x = BASS_STRING_OFFSETS[index] ?? 0;
  return [
    new THREE.Vector3(x, BASS_BRIDGE_Y, 0.109),
    new THREE.Vector3(x, 0.66, 0.094),
    new THREE.Vector3(x, BASS_NUT_Y, 0.09),
    new THREE.Vector3(x, 1.35, 0.052),
  ];
}

function pointOnCurveAtY(curve: THREE.CatmullRomCurve3, targetY: number): THREE.Vector3 {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const middle = (low + high) * 0.5;
    if (curve.getPointAt(middle).y < targetY) low = middle;
    else high = middle;
  }
  return curve.getPointAt((low + high) * 0.5);
}

interface BassMaterials {
  readonly body: THREE.MeshPhysicalMaterial;
  readonly bodySide: THREE.MeshPhysicalMaterial;
  readonly bodyEdge: THREE.MeshStandardMaterial;
  readonly wood: THREE.MeshPhysicalMaterial;
  readonly fretboard: THREE.MeshStandardMaterial;
  readonly metal: THREE.MeshPhysicalMaterial;
  readonly pickup: THREE.MeshStandardMaterial;
  readonly pickupPole: THREE.MeshStandardMaterial;
  readonly inlay: THREE.MeshStandardMaterial;
  readonly knob: THREE.MeshPhysicalMaterial;
  readonly pick: THREE.MeshStandardMaterial;
  readonly stand: THREE.MeshStandardMaterial;
  readonly rubber: THREE.MeshStandardMaterial;
}

function createMaterials(): BassMaterials {
  return {
    body: createProceduralPhysicalMaterial({
      materialId: 'bass.body.walnut-lacquer', kind: 'wood', color: '#4d2818', roughness: 0.27, metalness: 0,
      seed: 311, mapRepeat: [2, 1], normalStrength: 0.24,
      options: { clearcoat: 0.38, clearcoatRoughness: 0.15, envMapIntensity: 1.15 },
    }),
    bodySide: createProceduralPhysicalMaterial({
      materialId: 'bass.body.walnut-lacquer.side', kind: 'lacquer', color: '#351b12', roughness: 0.29, metalness: 0,
      seed: 313, mapRepeat: [1, 1], normalStrength: 0.06,
      options: { clearcoat: 0.34, clearcoatRoughness: 0.17, envMapIntensity: 1.05 },
    }),
    bodyEdge: createProceduralStandardMaterial({
      materialId: 'bass.body.edge', kind: 'wood-dark', color: '#3c2116', roughness: 0.3, metalness: 0.02,
      seed: 315, mapRepeat: [2, 1], normalStrength: 0.16,
    }),
    wood: createProceduralPhysicalMaterial({
      materialId: 'bass.wood', kind: 'wood', color: '#3b2118', roughness: 0.34, metalness: 0,
      seed: 317, mapRepeat: [2, 1], normalStrength: 0.46,
      options: { clearcoat: 0.2, clearcoatRoughness: 0.18 },
    }),
    fretboard: createProceduralStandardMaterial({
      materialId: 'bass.fretboard', kind: 'rosewood', color: '#30221f', roughness: 0.39, metalness: 0.02,
      seed: 331, mapRepeat: [1, 4], normalStrength: 0.35,
    }),
    metal: createProceduralPhysicalMaterial({
      materialId: 'bass.metal', kind: 'chrome', color: '#b6b7b2', roughness: 0.2, metalness: 0.93,
      seed: 337, mapRepeat: [4, 2], normalStrength: 0.16,
      options: { envMapIntensity: 1.3 },
    }),
    pickup: createProceduralStandardMaterial({
      materialId: 'bass.pickup', kind: 'pickup', color: '#151619', roughness: 0.37, metalness: 0.32,
      seed: 347, mapRepeat: [4, 2], normalStrength: 0.20,
    }),
    pickupPole: createProceduralPhysicalMaterial({
      materialId: 'bass.pickup.pole', kind: 'metal', color: '#85867f', roughness: 0.27, metalness: 0.86,
      seed: 349, mapRepeat: [5, 2], normalStrength: 0.15,
    }),
    inlay: createProceduralStandardMaterial({
      materialId: 'bass.inlay', kind: 'ivory', color: '#d9d1bb', roughness: 0.28, metalness: 0.02,
      seed: 353, mapRepeat: [2, 4], normalStrength: 0.22,
    }),
    knob: createProceduralPhysicalMaterial({
      materialId: 'bass.control.knob', kind: 'ebonized', color: '#16171a', roughness: 0.34, metalness: 0.24,
      seed: 359, mapRepeat: [3, 3], normalStrength: 0.22,
      options: { clearcoat: 0.18, clearcoatRoughness: 0.2 },
    }),
    pick: createProceduralStandardMaterial({
      materialId: 'bass.pick', kind: 'pick', color: '#1b1717', roughness: 0.36, metalness: 0.05,
      seed: 367, mapRepeat: [2, 2], normalStrength: 0.22,
      options: { side: THREE.DoubleSide },
    }),
    stand: createProceduralStandardMaterial({
      materialId: 'bass.stand', kind: 'chrome-dark', color: '#111217', roughness: 0.4, metalness: 0.72,
      seed: 373, mapRepeat: [4, 2], normalStrength: 0.17,
    }),
    rubber: createProceduralStandardMaterial({
      materialId: 'bass.rubber', kind: 'rubber', color: '#070708', roughness: 0.78, metalness: 0,
      seed: 379, mapRepeat: [3, 3], normalStrength: 0.48,
    }),
  };
}

function bassFretY(fret: number): number {
  return BASS_NUT_Y - BASS_SCALE_LENGTH * (1 - 2 ** (-Math.max(0, fret) / 12));
}

function addBassPickup(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: BassMaterials,
  pickupIndex: number,
  y: number,
): void {
  const plate = createRoundedBox(
    [0.205, 0.068, 0.015],
    [0, y, 0.083],
    materials.pickup,
    `bass.pickup.${pickupIndex}.plate`,
    0.008,
  );
  root.add(plate);
  addComponent(components, plate, `bass.pickup.${pickupIndex}`);
  for (let pole = 0; pole < BASS_STRING_OFFSETS.length; pole += 1) {
    const polePiece = addFrontCylinder(
      root,
      0.0033,
      0.008,
      [BASS_STRING_OFFSETS[pole], y, 0.095],
      materials.pickupPole,
      `bass.pickup.${pickupIndex}.pole.${pole}`,
      10,
    );
    addComponent(components, polePiece, `bass.pickup.${pickupIndex}.pole.${pole}`);
  }
  for (const x of [-0.087, 0.087]) {
    for (const dy of [-0.023, 0.023]) {
      addFrontCylinder(
        root,
        0.0022,
        0.006,
        [x, y + dy, 0.094],
        materials.metal,
        `bass.pickup.${pickupIndex}.screw`,
        8,
      );
    }
  }
}

function addBassBridge(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: BassMaterials,
): void {
  const bridge = createRoundedBox(
    [0.235, 0.083, 0.021],
    [0, BASS_BRIDGE_Y, 0.086],
    materials.metal,
    'bass.bridge',
    0.008,
  );
  root.add(bridge);
  addComponent(components, bridge, 'bass.bridge');

  // Four independent saddle blocks are deliberately separate geometry. This
  // keeps the bass bridge visually and semantically distinct from the guitar's
  // six-saddle bridge.
  for (let index = 0; index < BASS_STRING_OFFSETS.length; index += 1) {
    const x = BASS_STRING_OFFSETS[index];
    const saddle = createRoundedBox(
      [0.037, 0.06, 0.026],
      [x, BASS_BRIDGE_Y + 0.002, 0.101],
      materials.metal,
      `bass.bridge.saddle.${index}`,
      0.005,
    );
    root.add(saddle);
    addComponent(components, saddle, `bass.bridge.saddle.${index}`);
    const spring = createRoundedBox(
      [0.012, 0.033, 0.008],
      [x, BASS_BRIDGE_Y - 0.013, 0.112],
      materials.bodyEdge,
      `bass.bridge.saddle.${index}.spring`,
      0.002,
    );
    root.add(spring);
  }

  // The four strings are intentionally kept close to the fretboard centerline
  // by the authored spec.  Narrow front slots preserve the four separate
  // saddle read at the performance camera while leaving each saddle object
  // independently addressable in the component map.
  for (let index = 0; index < BASS_STRING_OFFSETS.length - 1; index += 1) {
    const x = (BASS_STRING_OFFSETS[index] + BASS_STRING_OFFSETS[index + 1]) * 0.5;
    const slot = createRoundedBox(
      [0.0018, 0.052, 0.003],
      [x, BASS_BRIDGE_Y + 0.002, 0.118],
      materials.bodyEdge,
      `bass.bridge.saddle-slot.${index}`,
      0.0004,
    );
    root.add(slot);
  }
}

function addBassTuners(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: BassMaterials,
): void {
  const ys = [1.285, 1.355];
  let index = 0;
  for (const side of [-1, 1]) {
    for (const y of ys) {
      const tuner = new THREE.Group();
      tuner.name = `bass.tuner.${index}`;
      tuner.position.set(side * 0.095, y, 0.015);
      root.add(tuner);
      addComponent(components, tuner, `bass.tuner.${index}`);
      addFrontCylinder(tuner, 0.011, 0.01, [0, 0, 0.023], materials.metal, `bass.tuner.${index}.post`, 12);
      const paddle = createRoundedBox(
        [0.045, 0.025, 0.014],
        [side * 0.03, 0, 0.022],
        materials.metal,
        `bass.tuner.${index}.paddle`,
        0.009,
      );
      tuner.add(paddle);
      addCylinderBetween(
        tuner,
        new THREE.Vector3(0, 0, 0.004),
        new THREE.Vector3(0, 0, 0.027),
        0.0045,
        materials.metal,
        `bass.tuner.${index}.post-shaft`,
        8,
      );
      index += 1;
    }
  }
}

function addBassStand(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: BassMaterials,
): void {
  const stand = new THREE.Group();
  stand.name = 'bass.stand';
  root.add(stand);
  addComponent(components, stand, 'bass.stand');
  for (const side of [-1, 1]) {
    const x = side * 0.245;
    addCylinderBetween(
      stand,
      new THREE.Vector3(x, 0.025, -0.105),
      new THREE.Vector3(x, 0.025, 0.18),
      0.015,
      materials.stand,
      `bass.stand.base.${side}.rail`,
      10,
    );
    addCylinderBetween(
      stand,
      new THREE.Vector3(x, 0.04, 0.015),
      new THREE.Vector3(side * 0.18, 0.34, 0.028),
      0.015,
      materials.stand,
      `bass.stand.cradle.${side}`,
      10,
    );
    addCylinderBetween(
      stand,
      new THREE.Vector3(x, 0.025, -0.112),
      new THREE.Vector3(x, 0.025, -0.165),
      0.028,
      materials.rubber,
      `bass.stand.rubber-foot.${side}.front`,
      12,
    );
    addCylinderBetween(
      stand,
      new THREE.Vector3(x, 0.025, 0.182),
      new THREE.Vector3(x, 0.025, 0.235),
      0.028,
      materials.rubber,
      `bass.stand.rubber-foot.${side}.back`,
      12,
    );
  }
  addCylinderBetween(
    stand,
    new THREE.Vector3(-0.245, 0.025, 0.18),
    new THREE.Vector3(0.245, 0.025, 0.18),
    0.013,
    materials.stand,
    'bass.stand.crossbar',
    10,
  );
}

function addBassNeckAndHead(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: BassMaterials,
): void {
  const neck = createProfileMesh(
    [
      [-0.054, 0.63],
      [0.054, 0.63],
      [0.031, 1.235],
      [-0.031, 1.235],
    ],
    0.064,
    materials.wood,
    'bass.neck-wood',
    0.005,
  );
  root.add(neck);
  addComponent(components, neck, 'bass.neck-wood');

  const fretboard = createProfileMesh(
    [
      [-0.043, 0.66],
      [0.043, 0.66],
      [0.026, 1.225],
      [-0.026, 1.225],
    ],
    0.021,
    materials.fretboard,
    'bass.fretboard',
    0.002,
  );
  fretboard.position.z = 0.042;
  root.add(fretboard);
  addComponent(components, fretboard, 'bass.fretboard');
  for (const side of [-1, 1]) {
    const binding = createRoundedBox(
      [0.003, 0.575, 0.004],
      [side * 0.044, 0.94, 0.059],
      materials.bodyEdge,
      `bass.fretboard.binding.${side}`,
      0.001,
    );
    root.add(binding);
  }

  const headstock = createProfileMesh(
    [
      [-0.032, 1.21],
      [-0.105, 1.25],
      [-0.115, 1.35],
      [-0.09, 1.39],
      [-0.035, 1.40],
      [0, 1.385],
      [0.035, 1.40],
      [0.09, 1.39],
      [0.115, 1.35],
      [0.105, 1.25],
      [0.032, 1.21],
    ],
    0.055,
    materials.wood,
    'bass.headstock',
    0.006,
  );
  root.add(headstock);
  addComponent(components, headstock, 'bass.headstock');

  const nut = createRoundedBox(
    [0.076, 0.013, 0.01],
    [0, BASS_NUT_Y, 0.077],
    materials.inlay,
    'bass.nut',
    0.002,
  );
  root.add(nut);
  addComponent(components, nut, 'bass.nut');
  addBassTuners(root, components, materials);
}

function addBassFrets(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: BassMaterials,
): void {
  for (let fret = 1; fret <= BASS_FRET_COUNT; fret += 1) {
    const y = bassFretY(fret);
    const width = THREE.MathUtils.lerp(0.081, 0.051, fret / BASS_FRET_COUNT);
    const rail = createRoundedBox(
      [width, 0.004, 0.004],
      [0, y, 0.069],
      materials.metal,
      `bass.fret.${fret}`,
      0.001,
    );
    root.add(rail);
    addComponent(components, rail, `bass.fret.${fret}`);
  }
  for (const fret of BASS_INLAY_FRETS) {
    const y = (bassFretY(fret - 1) + bassFretY(fret)) * 0.5;
    if (fret === 12 || fret === 24) {
      for (const x of [-0.012, 0.012]) {
        const dot = addFrontDot(root, [x, y, 0.081], 0.005, materials.inlay, `bass.fret-inlay.${fret}.${x}`);
        addComponent(components, dot, `bass.fret-inlay.${fret}.${x}`);
      }
    } else {
      const dot = addFrontDot(root, [0, y, 0.081], 0.005, materials.inlay, `bass.fret-inlay.${fret}`);
      addComponent(components, dot, `bass.fret-inlay.${fret}`);
    }
  }
}

function addBassBodyDetails(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: BassMaterials,
): void {
  const binding = addBodyBinding(
    root,
    BASS_BODY_PROFILE,
    0.078,
    0.004,
    materials.bodyEdge,
    'bass.body-edge-binding',
  );
  addComponent(components, binding, 'bass.body-edge-binding');

  const grain = new THREE.LineBasicMaterial({
    color: '#7b4b2e',
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  });
  // Keep the authored grain inside the lower body footprint.  The long horn
  // edges are intentionally left to the lacquer shading so these helper
  // lines cannot become detached foreground blobs in the fixed review shot.
  for (let column = 0; column < 9; column += 1) {
    const x = -0.152 + (column / 8) * 0.304;
    const points: THREE.Vector3[] = [];
    for (let step = 0; step <= 18; step += 1) {
      const y = 0.145 + (step / 18) * 0.40;
      points.push(new THREE.Vector3(x + Math.sin(step * 0.68 + column) * 0.004, y, 0.079));
    }
    addGrainLine(root, points, grain, `bass.body.grain.${column}`);
  }

  addBassPickup(root, components, materials, 0, 0.390);
  addBassPickup(root, components, materials, 1, 0.280);
  addBassBridge(root, components, materials);

  const knobPositions: readonly (readonly [number, number])[] = [
    [0.18, 0.39],
    [0.225, 0.32],
    [0.18, 0.25],
    [0.225, 0.20],
  ];
  knobPositions.forEach(([x, y], index) => {
    const knob = createLathedKnob(
      materials.knob,
      `bass.control.${index}`,
      0.021,
      0.019,
      materials.metal,
    );
    knob.position.set(x, y, 0.099);
    root.add(knob);
    addComponent(components, knob, `bass.control.${index}`);
  });
  for (const [index, y] of [0.105, 0.69].entries()) {
    const button = addFrontCylinder(root, 0.008, 0.015, [0, y, 0.077], materials.metal, `bass.strap-button.${index}`, 12);
    addComponent(components, button, `bass.strap-button.${index}`);
  }
}

function addBassInteractionParts(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  strings: THREE.Object3D[],
  fretActuators: THREE.Object3D[],
  picks: THREE.Object3D[],
  materials: BassMaterials,
): void {
  for (let index = 0; index < BASS_STRING_OFFSETS.length; index += 1) {
    const x = BASS_STRING_OFFSETS[index];
    const path = bassStringPath(index);
    const string = createVibratingString(
      `bass.string.${index}`,
      path,
      BASS_STRING_RADII[index],
      materials.metal,
      128,
      5,
    );
    root.add(string);
    addComponent(components, string, `bass.string.${index}`);
    strings.push(string);

    const actuator = new THREE.Group();
    actuator.name = `bass.fret-actuator.${index}`;
    addFrontCylinder(
      actuator,
      0.007,
      0.008,
      [0, 0, 0],
      materials.metal,
      `bass.fret-actuator.${index}.cap`,
      10,
    );
    actuator.position.copy(pointOnCurveAtY(
      new THREE.CatmullRomCurve3(path.map((point) => point.clone()), false, 'centripetal', 0.5),
      bassFretY(0),
    ));
    root.add(actuator);
    addComponent(components, actuator, `bass.fret-actuator.${index}`);
    fretActuators.push(actuator);

    const pick = new THREE.Group();
    pick.name = `bass.pick.${index}`;
    const pickPoint = pointOnCurveAtY(
      new THREE.CatmullRomCurve3(path.map((point) => point.clone()), false, 'centripetal', 0.5),
      BASS_PICK_Y,
    );
    pick.position.set(x, BASS_PICK_Y, pickPoint.z + 0.001);
    // The performance rig drives this pivot around local Z; keep the axis
    // discoverable for score adapters and inspection tools.
    pick.userData.pluckAxis = 'Z';
    pick.userData.pluckAxisVector = [0, 0, 1];
    pick.add(createTrianglePick(materials.pick, `bass.pick.${index}.tip`));
    root.add(pick);
    addComponent(components, pick, `bass.pick.${index}`);
    picks.push(pick);
  }
}

/**
 * Build the four-string bass as a separate procedural hierarchy. Its longer
 * scale, asymmetric double-cut body, four pole pickup layout, four tuners,
 * four knobs and four-saddle bridge are authored independently of the guitar.
 */
export function createBassModel(): ProceduralStringModel {
  const root = new THREE.Group();
  root.name = 'bass.procedural';
  root.userData.instrumentId = 'bass';
  root.userData.assetSource = 'procedural';
  root.userData.targetHeight = BASS_TARGET_HEIGHT;
  root.userData.sculptRuntime = {
    schemaVersion: '2.1',
    targetId: 'walnut-double-cut-four-string-electric-bass',
    sourceImage: 'references/genimage/bass-v1.png',
    coordinateFrame: { up: '+Y', front: '+Z', units: 'metres' },
    dimensions: { width: 0.58, height: BASS_TARGET_HEIGHT, depth: 0.18 },
    referencePbr: {
      status: 'reference-derived',
      threshold: 0.7,
      materials: ['walnut', 'fretboard', 'metal', 'pickup', 'rubber'],
    },
    action: {
      strings: 4,
      fretActuators: 4,
      picks: 4,
      fretRange: [0, 24],
      stringVibrationAxis: 'Z',
      pickPluckAxis: 'Z',
    },
  };
  root.userData.componentCounts = {
    strings: 4,
    frets: 24,
    tuners: 4,
    pickups: 2,
    bridgeSaddles: 4,
    controls: 4,
  };
  root.userData.tuningMidi = [...BASS_TUNING_MIDI];

  const materials = createMaterials();
  const components = new Map<string, THREE.Object3D>();
  const stringCurves = BASS_STRING_OFFSETS.map(
    (_, index) => new THREE.CatmullRomCurve3(
      bassStringPath(index).map((point) => point.clone()),
      false,
      'centripetal',
      0.5,
    ),
  );
  addComponent(components, root, 'bass.root');
  // Match the generic root key exposed by the piano and drum factories while
  // retaining the bass-qualified key for semantic inspection.
  components.set('root', root);

  const body = createProfileMesh(
    BASS_BODY_PROFILE,
    0.15,
    materials.body,
      'bass.body-shell',
      0.014,
      true,
      materials.bodySide,
  );
  root.add(body);
  addComponent(components, body, 'bass.body-shell');
  addBassBodyDetails(root, components, materials);
  addBassNeckAndHead(root, components, materials);
  addBassFrets(root, components, materials);
  addBassStand(root, components, materials);

  const strings: THREE.Object3D[] = [];
  const fretActuators: THREE.Object3D[] = [];
  const picks: THREE.Object3D[] = [];
  addBassInteractionParts(root, components, strings, fretActuators, picks, materials);

  setShadowFlags(root);
  root.userData.components = components;
  root.userData.componentMap = components;
  root.userData.strings = strings;
  root.userData.fretActuators = fretActuators;
  root.userData.picks = picks;
  root.userData.dimensions = { width: 0.58, height: BASS_TARGET_HEIGHT, depth: 0.18 };
  root.userData.coordinateFrame = { front: '+Z', up: '+Y', units: 'metres' };
  root.userData.performanceBudget = {
    targetTriangles: 60000,
    maxDrawCalls: 100,
    perFrameGeometryRebuild: false,
    preallocatedStringBuffers: true,
  };
  root.userData.materials = materials;
  return {
    root,
    components,
    strings,
    fretActuators,
    picks,
    fretPosition(stringIndex: number, fret: number): THREE.Vector3 {
      const safeIndex = THREE.MathUtils.clamp(
        Math.round(stringIndex),
        0,
        BASS_STRING_OFFSETS.length - 1,
      );
      const safeFret = THREE.MathUtils.clamp(
        Number.isFinite(fret) ? fret : 0,
        0,
        BASS_FRET_COUNT,
      );
      return pointOnCurveAtY(stringCurves[safeIndex], bassFretY(safeFret));
    },
    setStringVibration(stringIndex: number, amplitude: number, phase: number): void {
      const string = strings[Math.round(stringIndex)];
      if (string) setStringVibration(string, amplitude, phase);
    },
  };
}

export default createBassModel;
