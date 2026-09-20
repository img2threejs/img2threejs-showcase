import * as THREE from 'three';

import {
  addBodyBinding,
  addCylinderBetween,
  addFrontCylinder,
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

export const GUITAR_SCALE_LENGTH = 0.68;
export const GUITAR_NUT_Y = 1.075;
export const GUITAR_BRIDGE_Y = 0.305;
export const GUITAR_TARGET_HEIGHT = 1.25;
export const GUITAR_FRET_COUNT = 24;
export const GUITAR_TUNING_MIDI = [40, 45, 50, 55, 59, 64] as const;

/** The admitted image describes a single cutaway, oxblood solid-body profile. */
export const GUITAR_BODY_PROFILE: readonly (readonly [number, number])[] = [
  // The x/y stations are traced from the admitted front reference after the
  // fixed camera fit.  The upper bout is deliberately narrow, the right
  // cutaway is a single continuous concavity, and the lower bout opens only
  // after the waist instead of becoming a symmetric slab.
  [-0.055, 0.67],
  [-0.12, 0.65],
  [-0.154, 0.63],
  [-0.171, 0.602],
  [-0.177, 0.574],
  [-0.172, 0.545],
  [-0.163, 0.517],
  [-0.151, 0.489],
  [-0.147, 0.460],
  [-0.158, 0.431],
  [-0.180, 0.403],
  [-0.199, 0.375],
  [-0.219, 0.346],
  [-0.232, 0.318],
  [-0.240, 0.290],
  [-0.243, 0.261],
  [-0.242, 0.232],
  [-0.237, 0.205],
  [-0.227, 0.176],
  [-0.210, 0.147],
  [-0.198, 0.119],
  [-0.185, 0.085],
  [-0.150, 0.050],
  [-0.085, 0.025],
  [0.0, 0.012],
  [0.085, 0.025],
  [0.150, 0.050],
  [0.185, 0.085],
  [0.198, 0.119],
  [0.210, 0.147],
  [0.227, 0.176],
  [0.237, 0.205],
  [0.242, 0.232],
  [0.243, 0.261],
  [0.240, 0.290],
  [0.232, 0.318],
  [0.219, 0.346],
  [0.199, 0.375],
  [0.180, 0.403],
  [0.135, 0.431],
  [0.131, 0.460],
  [0.140, 0.489],
  [0.154, 0.517],
  [0.164, 0.545],
  [0.166, 0.574],
  [0.149, 0.602],
  [0.047, 0.63],
  [0.060, 0.65],
  [0.055, 0.67],
];

const GUITAR_STRING_OFFSETS = [-0.0225, -0.0135, -0.0045, 0.0045, 0.0135, 0.0225];
const GUITAR_STRING_RADII = [0.0018, 0.00155, 0.0013, 0.0011, 0.0009, 0.00075];
const GUITAR_INLAY_FRETS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
const GUITAR_PICK_Y = 0.515;

function guitarStringPath(index: number): readonly THREE.Vector3[] {
  const x = GUITAR_STRING_OFFSETS[index] ?? 0;
  return [
    new THREE.Vector3(x, GUITAR_BRIDGE_Y, 0.091),
    new THREE.Vector3(x, 0.59, 0.082),
    new THREE.Vector3(x, GUITAR_NUT_Y, 0.079),
    new THREE.Vector3(x, 1.19, 0.045),
  ];
}

function pointOnCurveAtY(curve: THREE.CatmullRomCurve3, targetY: number): THREE.Vector3 {
  // The authored string paths are monotonic in Y.  Arc-length lookup keeps
  // fret caps and pick pivots on the same sampled curve that TubeGeometry
  // renders, instead of approximating the curved Z response with a straight
  // line between bridge and nut.
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const middle = (low + high) * 0.5;
    if (curve.getPointAt(middle).y < targetY) low = middle;
    else high = middle;
  }
  return curve.getPointAt((low + high) * 0.5);
}

interface GuitarMaterials {
  readonly body: THREE.MeshPhysicalMaterial;
  readonly bodySide: THREE.MeshPhysicalMaterial;
  readonly bodyBinding: THREE.MeshStandardMaterial;
  readonly wood: THREE.MeshPhysicalMaterial;
  readonly fretboard: THREE.MeshStandardMaterial;
  readonly metal: THREE.MeshPhysicalMaterial;
  readonly pickupFrame: THREE.MeshStandardMaterial;
  readonly pickupCover: THREE.MeshStandardMaterial;
  readonly inlay: THREE.MeshStandardMaterial;
  readonly amber: THREE.MeshPhysicalMaterial;
  readonly pick: THREE.MeshStandardMaterial;
  readonly stand: THREE.MeshStandardMaterial;
  readonly rubber: THREE.MeshStandardMaterial;
}

function createMaterials(): GuitarMaterials {
  return {
    body: createProceduralPhysicalMaterial({
      materialId: 'guitar.body.red-lacquer', kind: 'red-lacquer', color: '#43070d', roughness: 0.2, metalness: 0,
      seed: 211, mapRepeat: [2, 1], normalStrength: 0.22,
      options: { clearcoat: 0.86, clearcoatRoughness: 0.08, envMapIntensity: 1.2 },
    }),
    bodySide: createProceduralPhysicalMaterial({
      materialId: 'guitar.body.red-lacquer.side', kind: 'lacquer', color: '#32060c', roughness: 0.22, metalness: 0,
      seed: 213, mapRepeat: [1, 1], normalStrength: 0.06,
      options: { clearcoat: 0.82, clearcoatRoughness: 0.09, envMapIntensity: 1.05 },
    }),
    bodyBinding: createProceduralStandardMaterial({
      materialId: 'guitar.body.binding', kind: 'binding', color: '#d4c09f', roughness: 0.27, metalness: 0.04,
      seed: 223, mapRepeat: [2, 2], normalStrength: 0.18,
    }),
    wood: createProceduralPhysicalMaterial({
      materialId: 'guitar.wood', kind: 'wood-dark', color: '#3e241d', roughness: 0.32, metalness: 0,
      seed: 227, mapRepeat: [2, 1], normalStrength: 0.42,
      options: { clearcoat: 0.2, clearcoatRoughness: 0.18 },
    }),
    fretboard: createProceduralStandardMaterial({
      materialId: 'guitar.fretboard', kind: 'rosewood', color: '#38231f', roughness: 0.37, metalness: 0.02,
      seed: 229, mapRepeat: [1, 4], normalStrength: 0.34,
    }),
    metal: createProceduralPhysicalMaterial({
      materialId: 'guitar.metal', kind: 'chrome', color: '#b6b7b2', roughness: 0.2, metalness: 0.92,
      seed: 233, mapRepeat: [4, 2], normalStrength: 0.16,
      options: { envMapIntensity: 1.35 },
    }),
    pickupFrame: createProceduralStandardMaterial({
      materialId: 'guitar.pickup.frame', kind: 'binding', color: '#cfbd9e', roughness: 0.31, metalness: 0.05,
      seed: 239, mapRepeat: [3, 2], normalStrength: 0.16,
    }),
    pickupCover: createProceduralStandardMaterial({
      materialId: 'guitar.pickup.cover', kind: 'metal', color: '#d5d5cf', roughness: 0.25, metalness: 0.75,
      seed: 241, mapRepeat: [5, 2], normalStrength: 0.14,
    }),
    inlay: createProceduralStandardMaterial({
      materialId: 'guitar.inlay', kind: 'ivory', color: '#e6dbc3', roughness: 0.25, metalness: 0.02,
      seed: 251, mapRepeat: [2, 4], normalStrength: 0.24,
    }),
    amber: createProceduralPhysicalMaterial({
      materialId: 'guitar.control.amber', kind: 'amber', color: '#b46312', roughness: 0.23, metalness: 0,
      seed: 257, mapRepeat: [3, 3], normalStrength: 0.22,
      options: { clearcoat: 0.35, clearcoatRoughness: 0.12 },
    }),
    pick: createProceduralStandardMaterial({
      materialId: 'guitar.pick', kind: 'pick', color: '#3b1113', roughness: 0.33, metalness: 0.05,
      seed: 263, mapRepeat: [2, 2], normalStrength: 0.22,
      options: { side: THREE.DoubleSide },
    }),
    stand: createProceduralStandardMaterial({
      materialId: 'guitar.stand', kind: 'chrome-dark', color: '#111217', roughness: 0.4, metalness: 0.72,
      seed: 269, mapRepeat: [4, 2], normalStrength: 0.17,
    }),
    rubber: createProceduralStandardMaterial({
      materialId: 'guitar.rubber', kind: 'rubber', color: '#070708', roughness: 0.78, metalness: 0,
      seed: 271, mapRepeat: [3, 3], normalStrength: 0.48,
    }),
  };
}

function guitarFretY(fret: number): number {
  return GUITAR_NUT_Y - GUITAR_SCALE_LENGTH * (1 - 2 ** (-Math.max(0, fret) / 12));
}

function addGuitarPickup(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: GuitarMaterials,
  pickupIndex: number,
  y: number,
): void {
  const frame = createRoundedBox(
    [0.19, 0.071, 0.014],
    [0, y, 0.071],
    materials.pickupFrame,
    `guitar.pickup.${pickupIndex}.frame`,
    0.006,
  );
  root.add(frame);
  addComponent(components, frame, `guitar.pickup.${pickupIndex}`);

  const cover = createRoundedBox(
    [0.14, 0.043, 0.009],
    [0, y, 0.082],
    materials.pickupCover,
    `guitar.pickup.${pickupIndex}.cover`,
    0.004,
  );
  root.add(cover);

  for (let pole = 0; pole < 6; pole += 1) {
    const x = GUITAR_STRING_OFFSETS[pole];
    const polePiece = addFrontCylinder(
      root,
      0.0028,
      0.009,
      [x, y, 0.089],
      materials.metal,
      `guitar.pickup.${pickupIndex}.pole.${pole}`,
      10,
    );
    addComponent(
      components,
      polePiece,
      `guitar.pickup.${pickupIndex}.pole.${pole}`,
    );
  }

  // Small screw heads make the cream frame read as a mounted hardware part.
  for (const x of [-0.081, 0.081]) {
    for (const dy of [-0.025, 0.025]) {
      addFrontCylinder(
        root,
        0.0023,
        0.006,
        [x, y + dy, 0.084],
        materials.metal,
        `guitar.pickup.${pickupIndex}.screw`,
        8,
      );
    }
  }
}

function addGuitarBridge(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: GuitarMaterials,
): void {
  const bridge = createRoundedBox(
    [0.255, 0.042, 0.016],
    [0, GUITAR_BRIDGE_Y, 0.073],
    materials.metal,
    'guitar.bridge',
    0.006,
  );
  root.add(bridge);
  addComponent(components, bridge, 'guitar.bridge');
  for (let index = 0; index < 6; index += 1) {
    const x = GUITAR_STRING_OFFSETS[index];
    const saddle = createRoundedBox(
      [0.027, 0.031, 0.019],
      [x, GUITAR_BRIDGE_Y + 0.003, 0.087],
      materials.metal,
      `guitar.bridge.saddle.${index}`,
      0.004,
    );
    root.add(saddle);
    addComponent(components, saddle, `guitar.bridge.saddle.${index}`);
  }

  // The reference bridge reads as six adjacent saddles.  The authored string
  // spacing is intentionally compact, so add five shallow dark slot reliefs
  // across the front edge to keep those separate blocks legible at the wide
  // performance camera without changing their count or attachment points.
  for (let index = 0; index < 5; index += 1) {
    const x = (GUITAR_STRING_OFFSETS[index] + GUITAR_STRING_OFFSETS[index + 1]) * 0.5;
    const slot = createRoundedBox(
      [0.0022, 0.030, 0.0025],
      [x, GUITAR_BRIDGE_Y + 0.003, 0.099],
      materials.fretboard,
      `guitar.bridge.saddle-slot.${index}`,
      0.0005,
    );
    // Add after the saddle components so the relief remains in front of the
    // overlapping procedural blocks in neutral and grazing light.
    root.add(slot);
  }

  const tailpiece = createRoundedBox(
    [0.23, 0.038, 0.024],
    [0, 0.23, 0.074],
    materials.metal,
    'guitar.tailpiece',
    0.009,
  );
  root.add(tailpiece);
  addComponent(components, tailpiece, 'guitar.tailpiece');
  for (const x of [-0.097, 0.097]) {
    addFrontCylinder(root, 0.015, 0.026, [x, 0.23, 0.086], materials.metal, 'guitar.tailpiece.anchor', 12);
  }
}

function addGuitarTuners(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: GuitarMaterials,
): void {
  const ys = [1.105, 1.155, 1.205];
  let index = 0;
  for (const side of [-1, 1]) {
    for (const y of ys) {
      const tuner = new THREE.Group();
      tuner.name = `guitar.tuner.${index}`;
      tuner.position.set(side * 0.072, y, 0.02);
      root.add(tuner);
      addComponent(components, tuner, `guitar.tuner.${index}`);
      addFrontCylinder(tuner, 0.010, 0.010, [0, 0, 0.02], materials.metal, `guitar.tuner.${index}.post`, 12);
      const paddle = createRoundedBox(
        [0.038, 0.022, 0.013],
        [side * 0.025, 0, 0.02],
        materials.metal,
        `guitar.tuner.${index}.paddle`,
        0.008,
      );
      tuner.add(paddle);
      addCylinderBetween(
        tuner,
        new THREE.Vector3(0, 0, 0.005),
        new THREE.Vector3(0, 0, 0.025),
        0.004,
        materials.metal,
        `guitar.tuner.${index}.post-shaft`,
        8,
      );
      index += 1;
    }
  }
}

function addGuitarStand(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: GuitarMaterials,
): void {
  const stand = new THREE.Group();
  stand.name = 'guitar.stand';
  root.add(stand);
  addComponent(components, stand, 'guitar.stand');

  for (const side of [-1, 1]) {
    const x = side * 0.205;
    addCylinderBetween(
      stand,
      new THREE.Vector3(x, 0.022, -0.095),
      new THREE.Vector3(x, 0.022, 0.17),
      0.014,
      materials.stand,
      `guitar.stand.base.${side}.rail`,
      10,
    );
    addCylinderBetween(
      stand,
      new THREE.Vector3(x, 0.035, 0.015),
      new THREE.Vector3(side * 0.16, 0.29, 0.025),
      0.014,
      materials.stand,
      `guitar.stand.cradle.${side}`,
      10,
    );
    addCylinderBetween(
      stand,
      new THREE.Vector3(x, 0.022, -0.102),
      new THREE.Vector3(x, 0.022, -0.15),
      0.025,
      materials.rubber,
      `guitar.stand.rubber-foot.${side}.front`,
      12,
    );
    addCylinderBetween(
      stand,
      new THREE.Vector3(x, 0.022, 0.172),
      new THREE.Vector3(x, 0.022, 0.22),
      0.025,
      materials.rubber,
      `guitar.stand.rubber-foot.${side}.back`,
      12,
    );
  }
  addCylinderBetween(
    stand,
    new THREE.Vector3(-0.205, 0.022, 0.17),
    new THREE.Vector3(0.205, 0.022, 0.17),
    0.012,
    materials.stand,
    'guitar.stand.crossbar',
    10,
  );
}

function addGuitarNeckAndHead(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: GuitarMaterials,
): void {
  const neck = createProfileMesh(
    [
      [-0.047, 0.56],
      [0.047, 0.56],
      [0.032, 1.08],
      [-0.032, 1.08],
    ],
    0.055,
    materials.wood,
    'guitar.neck-wood',
    0.004,
  );
  root.add(neck);
  addComponent(components, neck, 'guitar.neck-wood');

  const fretboard = createProfileMesh(
    [
      [-0.037, 0.585],
      [0.037, 0.585],
      [0.025, 1.075],
      [-0.025, 1.075],
    ],
    0.019,
    materials.fretboard,
    'guitar.fretboard',
    0.002,
  );
  fretboard.position.z = 0.036;
  root.add(fretboard);
  addComponent(components, fretboard, 'guitar.fretboard');

  for (const side of [-1, 1]) {
    const binding = createRoundedBox(
      [0.003, 0.49, 0.004],
      [side * 0.038, 0.83, 0.052],
      materials.bodyBinding,
      `guitar.fretboard.binding.${side}`,
      0.001,
    );
    root.add(binding);
  }

  const headstock = createProfileMesh(
    [
      [-0.032, 1.055],
      [-0.077, 1.09],
      [-0.077, 1.19],
      [-0.062, 1.225],
      [-0.027, 1.246],
      [0, 1.237],
      [0.027, 1.246],
      [0.062, 1.225],
      [0.077, 1.19],
      [0.077, 1.09],
      [0.032, 1.055],
    ],
    0.048,
    materials.wood,
    'guitar.headstock',
    0.005,
  );
  root.add(headstock);
  addComponent(components, headstock, 'guitar.headstock');

  const nut = createRoundedBox(
    [0.071, 0.012, 0.009],
    [0, GUITAR_NUT_Y, 0.068],
    materials.inlay,
    'guitar.nut',
    0.002,
  );
  root.add(nut);
  addComponent(components, nut, 'guitar.nut');
  addGuitarTuners(root, components, materials);
}

function addGuitarFrets(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: GuitarMaterials,
): void {
  for (let fret = 1; fret <= GUITAR_FRET_COUNT; fret += 1) {
    const y = guitarFretY(fret);
    const width = THREE.MathUtils.lerp(0.071, 0.051, fret / GUITAR_FRET_COUNT);
    const rail = createRoundedBox(
      [width, 0.0035, 0.004],
      [0, y, 0.061],
      materials.metal,
      `guitar.fret.${fret}`,
      0.001,
    );
    root.add(rail);
    addComponent(components, rail, `guitar.fret.${fret}`);
  }

  for (const fret of GUITAR_INLAY_FRETS) {
    const y = (guitarFretY(fret - 1) + guitarFretY(fret)) * 0.5;
    const inlay = createRoundedBox(
      [fret === 12 || fret === 24 ? 0.028 : 0.018, 0.008, 0.0025],
      [0, y, 0.069],
      materials.inlay,
      `guitar.fret-inlay.${fret}`,
      0.002,
    );
    root.add(inlay);
    addComponent(components, inlay, `guitar.fret-inlay.${fret}`);
  }
}

function addGuitarBodyDetails(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  materials: GuitarMaterials,
): void {
  const binding = addBodyBinding(
    root,
    GUITAR_BODY_PROFILE,
    0.06,
    0.004,
    materials.bodyBinding,
    'guitar.body-edge-binding',
  );
  addComponent(components, binding, 'guitar.body-edge-binding');

  const grain = new THREE.LineBasicMaterial({
    color: '#7b2630',
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const grainBounds: readonly (readonly [number, number])[] = [
    [-0.202, 0.160],
    [-0.224, 0.192],
    [-0.238, 0.209],
    [-0.242, 0.211],
    [-0.232, 0.198],
    [-0.201, 0.173],
    [-0.163, 0.151],
    [-0.157, 0.153],
    [-0.176, 0.166],
  ];
  for (let row = 0; row < grainBounds.length; row += 1) {
    const y = 0.105 + row * 0.058;
    const [left, right] = grainBounds[row];
    const points: THREE.Vector3[] = [];
    for (let step = 0; step <= 16; step += 1) {
      const x = left + 0.009 + (step / 16) * (right - left - 0.018);
      points.push(new THREE.Vector3(x, y + Math.sin(step * 0.75 + row) * 0.003, 0.061));
    }
    addGrainLine(root, points, grain, `guitar.body.grain.${row}`);
  }

  // The portrait places the pickup pair below the cutaway shoulder; these
  // measured anchors keep the upper pickup in the upper bout and the bridge
  // hardware centered in the lower half of the body.
  addGuitarPickup(root, components, materials, 0, 0.515);
  addGuitarPickup(root, components, materials, 1, 0.370);
  addGuitarBridge(root, components, materials);

  const knobPositions: readonly (readonly [number, number])[] = [
    [0.135, 0.31],
    [0.17, 0.27],
    [0.115, 0.21],
    [0.165, 0.17],
  ];
  knobPositions.forEach(([x, y], index) => {
    const knob = createLathedKnob(
      materials.amber,
      `guitar.control.${index}`,
      0.021,
      0.019,
      materials.inlay,
    );
    knob.position.set(x, y, 0.078);
    root.add(knob);
    addComponent(components, knob, `guitar.control.${index}`);
  });

  // Strap buttons are small but help the lower and upper silhouette read as a
  // complete instrument in orbit views.
  for (const [index, y] of [0.085, 0.655].entries()) {
    const button = addFrontCylinder(root, 0.008, 0.014, [0, y, 0.066], materials.metal, `guitar.strap-button.${index}`, 12);
    addComponent(components, button, `guitar.strap-button.${index}`);
  }
}

function addGuitarInteractionParts(
  root: THREE.Group,
  components: Map<string, THREE.Object3D>,
  strings: THREE.Object3D[],
  fretActuators: THREE.Object3D[],
  picks: THREE.Object3D[],
  materials: GuitarMaterials,
): void {
  for (let index = 0; index < GUITAR_STRING_OFFSETS.length; index += 1) {
    const x = GUITAR_STRING_OFFSETS[index];
    const path = guitarStringPath(index);
    const string = createVibratingString(
      `guitar.string.${index}`,
      path,
      GUITAR_STRING_RADII[index],
      materials.metal,
      128,
      5,
    );
    root.add(string);
    addComponent(components, string, `guitar.string.${index}`);
    strings.push(string);

    const actuator = new THREE.Group();
    actuator.name = `guitar.fret-actuator.${index}`;
    const actuatorCap = addFrontCylinder(
      actuator,
      0.006,
      0.007,
      [0, 0, 0],
      materials.metal,
      `guitar.fret-actuator.${index}.cap`,
      10,
    );
    actuatorCap.castShadow = true;
    actuator.position.copy(pointOnCurveAtY(
      new THREE.CatmullRomCurve3(path.map((point) => point.clone()), false, 'centripetal', 0.5),
      guitarFretY(0),
    ));
    root.add(actuator);
    addComponent(components, actuator, `guitar.fret-actuator.${index}`);
    fretActuators.push(actuator);

    const pick = new THREE.Group();
    pick.name = `guitar.pick.${index}`;
    const pickPoint = pointOnCurveAtY(
      new THREE.CatmullRomCurve3(path.map((point) => point.clone()), false, 'centripetal', 0.5),
      GUITAR_PICK_Y,
    );
    // The pick is a thin XY triangle; place its plane just in front of the
    // actual string centerline so the rotated onset stroke intersects the
    // rendered tube instead of hovering behind it.
    pick.position.set(x, GUITAR_PICK_Y, pickPoint.z + 0.001);
    // The controller animates the pick around its local Z axis.  Expose the
    // axis on the addressable pivot so a different performer can drive the
    // same part without knowing the factory's implementation details.
    pick.userData.pluckAxis = 'Z';
    pick.userData.pluckAxisVector = [0, 0, 1];
    pick.add(createTrianglePick(materials.pick, `guitar.pick.${index}.tip`));
    root.add(pick);
    addComponent(components, pick, `guitar.pick.${index}`);
    picks.push(pick);
  }
}

/**
 * Build the guitar as an editable Three.js hierarchy. It intentionally uses
 * procedural profiles and low-poly repeated hardware; no runtime model file
 * or vertex dump is involved.
 */
export function createGuitarModel(): ProceduralStringModel {
  const root = new THREE.Group();
  root.name = 'guitar.procedural';
  root.userData.instrumentId = 'guitar';
  root.userData.assetSource = 'procedural';
  root.userData.targetHeight = GUITAR_TARGET_HEIGHT;
  root.userData.sculptRuntime = {
    schemaVersion: '2.1',
    targetId: 'oxblood-single-cut-electric-guitar',
    sourceImage: 'references/genimage/guitar-v1.png',
    coordinateFrame: { up: '+Y', front: '+Z', units: 'metres' },
    dimensions: { width: 0.48, height: GUITAR_TARGET_HEIGHT, depth: 0.18 },
    referencePbr: {
      status: 'reference-derived',
      threshold: 0.7,
      materials: ['body-lacquer', 'wood', 'metal', 'pickup', 'rubber'],
    },
    action: {
      strings: 6,
      fretActuators: 6,
      picks: 6,
      fretRange: [0, 24],
      stringVibrationAxis: 'Z',
      pickPluckAxis: 'Z',
    },
  };
  root.userData.componentCounts = {
    strings: 6,
    frets: 24,
    tuners: 6,
    pickups: 2,
    bridgeSaddles: 6,
    controls: 4,
  };
  root.userData.tuningMidi = [...GUITAR_TUNING_MIDI];

  const materials = createMaterials();
  const components = new Map<string, THREE.Object3D>();
  const stringCurves = GUITAR_STRING_OFFSETS.map(
    (_, index) => new THREE.CatmullRomCurve3(
      guitarStringPath(index).map((point) => point.clone()),
      false,
      'centripetal',
      0.5,
    ),
  );
  addComponent(components, root, 'guitar.root');
  // Keep the generic root key used by the other instrument factories while
  // retaining the instrument-qualified key for inspection and review tools.
  components.set('root', root);

  const body = createProfileMesh(
    GUITAR_BODY_PROFILE,
    0.112,
    materials.body,
      'guitar.body-shell',
      0.012,
      true,
      materials.bodySide,
  );
  root.add(body);
  addComponent(components, body, 'guitar.body-shell');
  addGuitarBodyDetails(root, components, materials);
  addGuitarNeckAndHead(root, components, materials);
  addGuitarFrets(root, components, materials);
  addGuitarStand(root, components, materials);

  const strings: THREE.Object3D[] = [];
  const fretActuators: THREE.Object3D[] = [];
  const picks: THREE.Object3D[] = [];
  addGuitarInteractionParts(root, components, strings, fretActuators, picks, materials);

  setShadowFlags(root);
  root.userData.components = components;
  root.userData.componentMap = components;
  root.userData.strings = strings;
  root.userData.fretActuators = fretActuators;
  root.userData.picks = picks;
  root.userData.dimensions = { width: 0.48, height: GUITAR_TARGET_HEIGHT, depth: 0.18 };
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
        GUITAR_STRING_OFFSETS.length - 1,
      );
      const safeFret = THREE.MathUtils.clamp(
        Number.isFinite(fret) ? fret : 0,
        0,
        GUITAR_FRET_COUNT,
      );
      const curve = stringCurves[safeIndex];
      const point = pointOnCurveAtY(curve, guitarFretY(safeFret));
      return point;
    },
    setStringVibration(stringIndex: number, amplitude: number, phase: number): void {
      const string = strings[Math.round(stringIndex)];
      if (string) setStringVibration(string, amplitude, phase);
    },
  };
}

export default createGuitarModel;
