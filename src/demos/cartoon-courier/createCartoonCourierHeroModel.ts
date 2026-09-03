import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export type CartoonCourierAction = 'idle' | 'wave' | 'walk';

export type CartoonCourierOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
};

type ActionController = {
  actions: ReadonlyArray<{ id: CartoonCourierAction; label: string; loop: boolean }>;
  readonly active: CartoonCourierAction;
  play: (name: CartoonCourierAction) => void;
  stop: () => void;
  update: (dt: number) => void;
  subscribe: (listener: (active: CartoonCourierAction) => void) => () => void;
};

const palette = {
  skin: 0xde9b6c,
  skinLight: 0xf4b689,
  blush: 0xc97359,
  hair: 0x2a1810,
  hairLight: 0x68432d,
  hairShadow: 0x160c08,
  eyeWhite: 0xf8f0de,
  iris: 0xb16714,
  pupil: 0x21120b,
  shirt: 0xe0d3b5,
  shirtShadow: 0xbfae8f,
  jacket: 0x375853,
  jacketLight: 0x53756c,
  piping: 0xd1a05b,
  scarf: 0x9f421d,
  scarfLight: 0xc55b2a,
  pants: 0x362f2a,
  pantsLight: 0x52453b,
  leatherDark: 0x492b1b,
  leatherTan: 0x97632f,
  leatherLight: 0xbc8441,
  brass: 0xae772b,
  rubber: 0x281f19,
};

function mat(
  color: number,
  roughness: number,
  options: Partial<THREE.MeshPhysicalMaterialParameters> = {},
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness: 0,
    clearcoat: 0.04,
    clearcoatRoughness: 0.62,
    ...options,
  });
}

function rounded(width = 1, height = 1, depth = 1, radius = 0.12): RoundedBoxGeometry {
  return new RoundedBoxGeometry(width, height, depth, 5, radius);
}

export function createCartoonCourierHeroModel(
  options: CartoonCourierOptions = {},
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Cartoon_Courier_Root';
  root.rotation.y = -0.035;
  root.userData.semanticManifest = [
    'Hair_Crown', 'Eye_L', 'Eye_R', 'Jacket_Shell', 'Scarf_Wrap',
    'Satchel', 'Boot_L', 'Boot_R',
  ];

  const nodes: Record<string, THREE.Object3D> = {};
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, THREE.Object3D> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const materials = {
    skin: mat(palette.skin, 0.62, { sheen: 0.16, sheenColor: new THREE.Color(palette.skinLight) }),
    skinLight: mat(palette.skinLight, 0.6, { sheen: 0.14, sheenColor: new THREE.Color(palette.skinLight) }),
    blush: mat(palette.blush, 0.7),
    hair: mat(palette.hair, 0.42, {
      sheen: 0.58,
      sheenRoughness: 0.34,
      sheenColor: new THREE.Color(palette.hairLight),
      specularIntensity: 0.55,
    }),
    hairLight: mat(palette.hairLight, 0.48, { sheen: 0.42, sheenRoughness: 0.38 }),
    eyeWhite: mat(palette.eyeWhite, 0.2, { clearcoat: 0.78, clearcoatRoughness: 0.12 }),
    iris: mat(palette.iris, 0.22, { clearcoat: 0.82, clearcoatRoughness: 0.1 }),
    pupil: mat(palette.pupil, 0.18, { clearcoat: 0.9, clearcoatRoughness: 0.08 }),
    shirt: mat(palette.shirt, 0.88, { sheen: 0.42, sheenRoughness: 0.82 }),
    jacket: mat(palette.jacket, 0.83, { sheen: 0.6, sheenRoughness: 0.76 }),
    jacketLight: mat(palette.jacketLight, 0.84, { sheen: 0.5, sheenRoughness: 0.8 }),
    piping: mat(palette.piping, 0.72),
    scarf: mat(palette.scarf, 0.86, { sheen: 0.68, sheenRoughness: 0.78 }),
    scarfLight: mat(palette.scarfLight, 0.82, { sheen: 0.6, sheenRoughness: 0.74 }),
    pants: mat(palette.pants, 0.9, { sheen: 0.22, sheenRoughness: 0.9 }),
    pantsLight: mat(palette.pantsLight, 0.88),
    leatherDark: mat(palette.leatherDark, 0.58, { clearcoat: 0.13, clearcoatRoughness: 0.52 }),
    leatherTan: mat(palette.leatherTan, 0.55, { clearcoat: 0.15, clearcoatRoughness: 0.48 }),
    leatherLight: mat(palette.leatherLight, 0.58, { clearcoat: 0.12, clearcoatRoughness: 0.52 }),
    brass: mat(palette.brass, 0.3, { metalness: 0.72, clearcoat: 0.22, clearcoatRoughness: 0.2 }),
    rubber: mat(palette.rubber, 0.94),
  };

  const registerNode = (name: string, parent: THREE.Object3D, position: [number, number, number]) => {
    const group = new THREE.Group();
    group.name = name;
    group.position.set(...position);
    group.userData.semanticPart = true;
    parent.add(group);
    nodes[name] = group;
    destructionGroups[name] = [group];
    return group;
  };

  const add = (
    parent: THREE.Object3D,
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number] = [0, 0, 0],
    rotation: [number, number, number] = [0, 0, 0],
    scale: [number, number, number] = [1, 1, 1],
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.scale.set(...scale);
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.userData.semanticPart = true;
    parent.add(mesh);
    meshes[name] = mesh;
    destructionGroups[name] = [mesh];
    return mesh;
  };

  const body = registerNode('Body', root, [0, 0, 0]);
  const pelvis = registerNode('Pelvis', body, [0, 1.52, 0]);
  add(pelvis, 'Pelvis_Core', new THREE.SphereGeometry(0.5, 32, 20), materials.pants, [0, 0, 0], [0, 0, 0], [0.49, 0.32, 0.34]);
  add(pelvis, 'Hip_Fold', rounded(0.46, 0.035, 0.025, 0.012), materials.pantsLight, [0, 0.13, 0.2]);

  const torso = registerNode('Torso', pelvis, [0, 0.44, 0]);
  add(torso, 'Shirt_Core', new THREE.CapsuleGeometry(0.32, 0.47, 8, 24), materials.shirt, [0, 0.22, 0], [0, 0, 0], [1.05, 1, 0.72]);
  add(torso, 'Jacket_Shell', rounded(0.7, 0.55, 0.12, 0.05), materials.jacket, [0, 0.28, 0.24]);
  add(torso, 'Jacket_Open_Left', rounded(0.24, 0.58, 0.09, 0.04), materials.jacketLight, [0.21, 0.27, 0.315], [0, 0.08, -0.08]);
  add(torso, 'Jacket_Open_Right', rounded(0.24, 0.58, 0.09, 0.04), materials.jacketLight, [-0.21, 0.27, 0.315], [0, -0.08, 0.08]);
  add(torso, 'Jacket_Hem', rounded(0.64, 0.035, 0.03, 0.012), materials.piping, [0, 0.015, 0.33]);
  add(torso, 'Jacket_Piping_L', new THREE.CapsuleGeometry(0.014, 0.47, 4, 10), materials.piping, [0.095, 0.28, 0.37], [0, 0, -0.08]);
  add(torso, 'Jacket_Piping_R', new THREE.CapsuleGeometry(0.014, 0.47, 4, 10), materials.piping, [-0.095, 0.28, 0.37], [0, 0, 0.08]);

  for (let i = 0; i < 3; i += 1) {
    const y = 0.42 - i * 0.15;
    add(torso, `Shirt_Toggle_${i + 1}`, rounded(0.1, 0.035, 0.035, 0.012), materials.leatherDark, [0, y, 0.405]);
  }

  const belt = registerNode('Belt', pelvis, [0, 0.16, 0.02]);
  add(belt, 'Belt_Strap', rounded(0.72, 0.1, 0.42, 0.035), materials.leatherDark);
  add(belt, 'Belt_Buckle', new THREE.TorusGeometry(0.07, 0.016, 6, 4), materials.brass, [0.04, 0, 0.225], [0, 0, Math.PI / 4], [1.2, 0.85, 1]);

  const neck = registerNode('Neck', torso, [0, 0.75, 0]);
  add(neck, 'Neck_Core', new THREE.CylinderGeometry(0.11, 0.13, 0.24, 24), materials.skin, [0, 0.02, 0]);
  add(neck, 'Scarf_Wrap', new THREE.TorusGeometry(0.17, 0.075, 10, 32), materials.scarf, [0, -0.02, 0.01], [Math.PI / 2, 0, 0], [1.08, 0.92, 1]);
  add(neck, 'Scarf_Fold', new THREE.TorusGeometry(0.17, 0.025, 7, 32), materials.scarfLight, [0, -0.01, 0.085], [Math.PI / 2, 0, 0]);
  add(neck, 'Scarf_Tail', rounded(0.13, 0.42, 0.055, 0.025), materials.scarf, [0.18, -0.17, 0.12], [0.12, 0, -0.34]);

  const head = registerNode('Head', neck, [0, 0.4, 0.015]);
  add(head, 'Head_Core', new THREE.SphereGeometry(0.5, 48, 32), materials.skin, [0, 0, 0], [0, 0, 0], [0.86, 0.96, 0.76]);
  add(head, 'Ear_L', new THREE.SphereGeometry(0.5, 20, 12), materials.skin, [0.43, -0.02, 0], [0, 0, -0.12], [0.12, 0.21, 0.08]);
  add(head, 'Ear_R', new THREE.SphereGeometry(0.5, 20, 12), materials.skin, [-0.43, -0.02, 0], [0, 0, 0.12], [0.12, 0.21, 0.08]);

  for (const side of [-1, 1] as const) {
    const suffix = side > 0 ? 'L' : 'R';
    const x = side * 0.16;
    add(head, `Eye_${suffix}`, new THREE.SphereGeometry(0.5, 32, 20), materials.eyeWhite, [x, 0.015, 0.36], [0, 0, 0], [0.19, 0.215, 0.038]);
    add(head, `Iris_${suffix}`, new THREE.SphereGeometry(0.5, 24, 16), materials.iris, [x + side * 0.01, 0.005, 0.391], [0, 0, 0], [0.09, 0.12, 0.018]);
    add(head, `Pupil_${suffix}`, new THREE.SphereGeometry(0.5, 20, 12), materials.pupil, [x + side * 0.012, 0.005, 0.402], [0, 0, 0], [0.043, 0.07, 0.009]);
    add(head, `Catchlight_${suffix}`, new THREE.SphereGeometry(0.5, 12, 8), materials.eyeWhite, [x - 0.018, 0.055, 0.412], [0, 0, 0], [0.018, 0.026, 0.006]);
    add(head, `Brow_${suffix}`, new THREE.CapsuleGeometry(0.018, 0.13, 5, 10), materials.hair, [x, 0.22, 0.365], [0, 0, Math.PI / 2 + side * 0.13]);
    add(head, `Blush_${suffix}`, new THREE.SphereGeometry(0.5, 20, 12), materials.blush, [side * 0.28, -0.14, 0.35], [0, 0, 0], [0.085, 0.035, 0.012]);
  }
  add(head, 'Nose', new THREE.SphereGeometry(0.5, 20, 14), materials.skinLight, [0, -0.095, 0.43], [0, 0, 0], [0.05, 0.065, 0.045]);
  add(head, 'Mouth', new THREE.TorusGeometry(0.065, 0.009, 6, 18, Math.PI), materials.blush, [0, -0.225, 0.39], [0, 0, Math.PI]);

  const hair = registerNode('Hair_Crown', head, [0, 0.18, -0.005]);
  add(hair, 'Hair_Scalp', new THREE.SphereGeometry(0.5, 40, 24), materials.hair, [0, 0.07, -0.04], [0, 0, 0], [0.98, 0.82, 0.84]);
  const crownLocks: Array<[string, [number, number, number], [number, number, number], [number, number, number]]> = [
    ['Hair_Lock_Center', [0.02, 0.39, 0.05], [0.08, 0, -0.08], [0.19, 0.42, 0.17]],
    ['Hair_Lock_Sweep_1', [-0.13, 0.41, 0.04], [0.02, 0, 0.42], [0.18, 0.48, 0.16]],
    ['Hair_Lock_Sweep_2', [-0.29, 0.34, 0.01], [-0.05, 0, 0.68], [0.17, 0.43, 0.15]],
    ['Hair_Lock_Left', [0.22, 0.34, 0], [0.03, 0, -0.48], [0.16, 0.4, 0.15]],
    ['Hair_Lock_Rear', [0.34, 0.22, -0.08], [0.1, 0, -0.75], [0.15, 0.34, 0.16]],
  ];
  for (const [name, position, rotation, scale] of crownLocks) {
    add(hair, name, new THREE.SphereGeometry(0.5, 24, 16), materials.hairLight, position, rotation, scale);
  }
  const sweptTips: Array<[[number, number, number], number, [number, number, number]]> = [
    [[-0.31, 0.34, -0.015], 0.82, [0.17, 0.34, 0.14]],
    [[-0.14, 0.43, 0.0], 0.46, [0.18, 0.38, 0.15]],
    [[0.05, 0.47, 0.0], 0.08, [0.17, 0.37, 0.15]],
    [[0.25, 0.38, -0.02], -0.52, [0.16, 0.32, 0.14]],
  ];
  sweptTips.forEach(([position, rz, scale], index) => {
    add(hair, `Hair_Swept_Tip_${index + 1}`, new THREE.ConeGeometry(0.5, 1, 12, 3), materials.hairLight, position, [0, 0, rz], scale);
  });
  const bangs = [
    [-0.26, 0.035, 0.31, 0.72],
    [-0.1, 0.06, 0.36, 0.38],
    [0.075, 0.085, 0.38, -0.18],
    [0.24, 0.045, 0.32, -0.58],
  ];
  bangs.forEach(([x, y, z, rz], index) => {
    add(hair, `Hair_Bang_${index + 1}`, new THREE.SphereGeometry(0.5, 20, 12), materials.hair, [x, y, z], [0, 0, rz], [0.16, 0.27, 0.11]);
  });

  const buildArm = (side: -1 | 1) => {
    const suffix = side > 0 ? 'L' : 'R';
    const shoulder = registerNode(`Shoulder_${suffix}`, torso, [side * 0.43, 0.56, 0.015]);
    shoulder.rotation.z = side * -0.1;
    const upper = registerNode(`UpperArm_${suffix}`, shoulder, [0, 0, 0]);
    add(upper, `Jacket_Sleeve_${suffix}`, new THREE.CapsuleGeometry(0.095, 0.34, 8, 18), materials.jacket, [0, -0.24, 0], [0, 0, 0], [1, 1, 0.92]);
    add(upper, `Sleeve_Cuff_${suffix}`, new THREE.TorusGeometry(0.105, 0.035, 8, 24), materials.shirt, [0, -0.45, 0], [Math.PI / 2, 0, 0]);
    const elbow = registerNode(`Elbow_${suffix}`, upper, [0, -0.48, 0]);
    elbow.rotation.z = side * 0.11;
    add(elbow, `Forearm_${suffix}`, new THREE.CapsuleGeometry(0.072, 0.32, 8, 18), materials.skin, [0, -0.22, 0]);
    const wrist = registerNode(`Wrist_${suffix}`, elbow, [0, -0.46, 0]);
    add(wrist, `Glove_${suffix}`, rounded(0.16, 0.19, 0.12, 0.04), materials.leatherDark, [0, -0.08, 0.01]);
    add(wrist, `Hand_${suffix}`, new THREE.SphereGeometry(0.5, 20, 14), materials.skin, [0, -0.18, 0.015], [0, 0, 0], [0.1, 0.13, 0.065]);
    const socket = registerNode(`Hand_Socket_${suffix}`, wrist, [0, -0.25, 0]);
    sockets[`hand-${suffix.toLowerCase()}`] = socket;
    colliders[`hand-${suffix.toLowerCase()}`] = meshes[`Hand_${suffix}`];
    return { shoulder, elbow, wrist };
  };
  const armL = buildArm(1);
  const armR = buildArm(-1);

  const buildLeg = (side: -1 | 1) => {
    const suffix = side > 0 ? 'L' : 'R';
    const hip = registerNode(`Hip_${suffix}`, pelvis, [side * 0.17, -0.13, 0]);
    hip.rotation.z = side * -0.035;
    add(hip, `Thigh_${suffix}`, new THREE.CapsuleGeometry(0.13, 0.42, 8, 20), materials.pants, [0, -0.29, 0]);
    const knee = registerNode(`Knee_${suffix}`, hip, [0, -0.58, 0]);
    add(knee, `Shin_${suffix}`, new THREE.CapsuleGeometry(0.105, 0.42, 8, 20), materials.pants, [0, -0.29, 0]);
    add(knee, `Pants_Seam_${suffix}`, new THREE.CapsuleGeometry(0.012, 0.36, 4, 10), materials.pantsLight, [side * 0.075, -0.29, 0.09]);
    if (side > 0) add(knee, 'Cargo_Pocket', rounded(0.17, 0.22, 0.055, 0.025), materials.pantsLight, [0.12, -0.18, 0.04]);
    const ankle = registerNode(`Ankle_${suffix}`, knee, [0, -0.58, 0.035]);
    add(ankle, `Boot_${suffix}`, rounded(0.32, 0.45, 0.4, 0.075), materials.leatherTan, [0, -0.1, 0.1], [0.02, 0, 0]);
    add(ankle, `Boot_Toe_${suffix}`, new THREE.SphereGeometry(0.5, 28, 16), materials.leatherLight, [0, -0.25, 0.28], [0, 0, 0], [0.21, 0.16, 0.34]);
    add(ankle, `Boot_Cuff_${suffix}`, new THREE.TorusGeometry(0.17, 0.035, 8, 24), materials.leatherDark, [0, 0.11, 0.09], [Math.PI / 2, 0, 0], [1, 1.18, 1]);
    add(ankle, `Boot_Strap_${suffix}`, rounded(0.37, 0.055, 0.48, 0.02), materials.leatherDark, [0, -0.1, 0.12], [0.08, 0, side * 0.04]);
    add(ankle, `Boot_Buckle_${suffix}`, new THREE.TorusGeometry(0.045, 0.012, 6, 4), materials.brass, [side * 0.12, -0.09, 0.39], [0, 0, Math.PI / 4]);
    add(ankle, `Sole_${suffix}`, rounded(0.39, 0.085, 0.58, 0.025), materials.rubber, [0, -0.39, 0.13]);
    const footSocket = registerNode(`Foot_Socket_${suffix}`, ankle, [0, -0.43, 0.15]);
    sockets[`foot-${suffix.toLowerCase()}`] = footSocket;
    colliders[`foot-${suffix.toLowerCase()}`] = meshes[`Sole_${suffix}`];
    return { hip, knee, ankle };
  };
  const legL = buildLeg(1);
  const legR = buildLeg(-1);

  const strap = registerNode('Crossbody_Strap', torso, [0, 0.26, 0.39]);
  add(strap, 'Crossbody_Leather', rounded(0.07, 0.94, 0.035, 0.015), materials.leatherDark, [0, -0.03, 0], [0, 0, -0.5]);
  const satchel = registerNode('Satchel', pelvis, [0.53, -0.18, 0.08]);
  add(satchel, 'Satchel_Body', rounded(0.38, 0.48, 0.18, 0.055), materials.leatherDark, [0, 0, 0.02], [0, -0.1, 0.04]);
  add(satchel, 'Satchel_Flap', rounded(0.4, 0.22, 0.08, 0.04), materials.leatherTan, [0, 0.14, 0.13], [0.06, 0, 0]);
  add(satchel, 'Satchel_Buckle', new THREE.TorusGeometry(0.05, 0.013, 6, 4), materials.brass, [0, 0.1, 0.19], [0, 0, Math.PI / 4]);

  const listeners = new Set<(active: CartoonCourierAction) => void>();
  let active: CartoonCourierAction = 'idle';
  let elapsed = 0;
  const controller: ActionController = {
    actions: [
      { id: 'idle', label: 'Explorer idle', loop: true },
      { id: 'wave', label: 'Friendly wave', loop: true },
      { id: 'walk', label: 'Walking preview', loop: true },
    ],
    get active() { return active; },
    play(name) {
      active = name;
      elapsed = 0;
      listeners.forEach((listener) => listener(active));
    },
    stop() { this.play('idle'); },
    update(dt) {
      elapsed += Math.min(dt, 0.05);
      const breath = Math.sin(elapsed * 2.1);
      torso.position.y = 0.44 + breath * 0.008;
      head.rotation.z = breath * 0.012;
      hair.rotation.z = -breath * 0.006;
      if (active === 'wave') {
        armR.shoulder.rotation.z = 2.45;
        armR.elbow.rotation.z = -1.15 + Math.sin(elapsed * 5.5) * 0.22;
        armR.wrist.rotation.z = Math.sin(elapsed * 7) * 0.18;
      } else {
        armR.shoulder.rotation.z = 0.1 + breath * 0.015;
        armR.elbow.rotation.z = -0.11;
        armR.wrist.rotation.z = 0;
      }
      if (active === 'walk') {
        const stride = Math.sin(elapsed * 4.2) * 0.45;
        legL.hip.rotation.x = stride;
        legR.hip.rotation.x = -stride;
        armL.shoulder.rotation.x = -stride * 0.7;
        armR.shoulder.rotation.x = stride * 0.7;
      } else {
        legL.hip.rotation.x = 0;
        legR.hip.rotation.x = 0;
        armL.shoulder.rotation.x = 0;
        armR.shoulder.rotation.x = 0;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  root.userData.sculptRuntime = {
    nodes,
    meshes,
    sockets,
    colliders,
    destructionGroups,
    animationController: controller,
  };
  root.userData.tick = (dt: number) => controller.update(dt);
  root.userData.triangleBudget = 120000;
  root.userData.referenceFidelity = 'single-view stylized reconstruction; rear and depth are inferred';
  root.userData.actions = ['idle', 'wave', 'walk'];
  controller.play('idle');
  return root;
}

export function createCartoonCourierHeroLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'Cartoon_Courier_LookDev';
  const hemi = new THREE.HemisphereLight(0xffead0, 0x4a3a3c, 1.15);
  lights.add(hemi);
  const key = new THREE.DirectionalLight(0xffd4a3, 3.2);
  key.position.set(-4.5, 7.5, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 6;
  lights.add(key);
  const fill = new THREE.DirectionalLight(0x9fc7d7, 0.8);
  fill.position.set(4, 3, 4.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xffb66f, 1.55);
  rim.position.set(2.5, 5, -5);
  lights.add(rim);
  return lights;
}
