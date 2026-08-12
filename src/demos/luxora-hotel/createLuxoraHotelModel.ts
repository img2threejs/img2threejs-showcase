import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export interface HotelRuntime {
  parts: Map<string, THREE.Group>;
  setExplode: (amount: number) => void;
  setLighting: (profile: HotelLightingProfile) => void;
  getRoomLights: () => HotelRoomLight[];
  setRoomLight: (roomId: string, enabled: boolean) => void;
  setAllRoomLights: (enabled: boolean) => void;
  resetMaterials: () => void;
}

export interface HotelRoomLight {
  id: string;
  label: string;
  floor: number;
  elevation: "Front" | "Rear";
  enabled: boolean;
}

interface RoomLightEntry extends HotelRoomLight {
  glass: THREE.MeshPhysicalMaterial;
  glow: THREE.MeshStandardMaterial;
  bulbs: THREE.MeshStandardMaterial[];
}

export interface HotelLightingProfile {
  timeOfDay: number;
  daylight: number;
  twilight: number;
  night: number;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const normalized = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

export function getHotelLightingProfile(timeOfDay: number): HotelLightingProfile {
  const normalizedTime = ((timeOfDay % 24) + 24) % 24;
  const solarHeight = Math.sin(((normalizedTime - 6) / 12) * Math.PI);
  const daylight = smoothstep(0.04, 0.26, Math.max(0, solarHeight));
  const twilight = 1 - smoothstep(0.035, 0.3, Math.abs(solarHeight));
  return {
    timeOfDay: normalizedTime,
    daylight,
    twilight,
    night: 1 - daylight,
  };
}

const palette = {
  concrete: 0xbcb1ad,
  concreteLight: 0xcdbeb6,
  concreteDark: 0x7d7779,
  charcoal: 0x3d3939,
  charcoalDeep: 0x2b292b,
  gold: 0xffd978,
  amber: 0xffaa45,
  deck: 0x846247,
  asphalt: 0x3e3b3c,
  paving: 0x777173,
  water: 0x078ab5,
  waterDeep: 0x075f7e,
  grass: 0x365f19,
  hedge: 0x315c14,
  hedgeLight: 0x507d1f,
  trunk: 0x64442f,
  white: 0xd9cec7,
};

function seeded(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeMaterials() {
  const concrete = new THREE.MeshStandardMaterial({ color: palette.concrete, roughness: 0.82 });
  const concreteLight = new THREE.MeshStandardMaterial({ color: palette.concreteLight, roughness: 0.8 });
  const concreteDark = new THREE.MeshStandardMaterial({ color: palette.concreteDark, roughness: 0.84 });
  const charcoal = new THREE.MeshStandardMaterial({ color: palette.charcoal, roughness: 0.58, metalness: 0.04 });
  const charcoalDeep = new THREE.MeshStandardMaterial({ color: palette.charcoalDeep, roughness: 0.62, metalness: 0.05 });
  const asphalt = new THREE.MeshStandardMaterial({ color: palette.asphalt, roughness: 0.9 });
  const paving = new THREE.MeshStandardMaterial({ color: palette.paving, roughness: 0.86 });
  const deck = new THREE.MeshStandardMaterial({ color: palette.deck, roughness: 0.78 });
  const warmGlass = new THREE.MeshPhysicalMaterial({
    color: 0xa56c35,
    roughness: 0.1,
    metalness: 0,
    transmission: 0.22,
    transparent: true,
    opacity: 0.58,
    emissive: palette.amber,
    emissiveIntensity: 0.46,
  });
  const interiorGlow = new THREE.MeshStandardMaterial({
    color: 0xd99b4f,
    emissive: 0xbe6b24,
    emissiveIntensity: 0.45,
    roughness: 0.72,
  });
  const curtain = new THREE.MeshStandardMaterial({ color: 0xc4ab8b, roughness: 0.86 });
  const darkGlass = new THREE.MeshPhysicalMaterial({
    color: 0x1d252b,
    roughness: 0.16,
    metalness: 0.05,
    transmission: 0.18,
    transparent: true,
    opacity: 0.9,
  });
  const water = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(0x13b8d6) },
      uDeep: { value: new THREE.Color(0x056f9c) },
      uSun: { value: new THREE.Color(0xe4f7ff) },
      uRipples: { value: [new THREE.Vector4(-99, -99, -99, 0), new THREE.Vector4(-99, -99, -99, 0), new THREE.Vector4(-99, -99, -99, 0)] },
    },
    vertexShader: `
      uniform float uTime;
      uniform vec4 uRipples[3];
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vUv = uv;
        vec3 transformed = position;
        float wave = sin(position.x * 2.4 + uTime * 0.75) * 0.012;
        wave += cos(position.y * 3.2 - uTime * 0.55) * 0.009;
        for (int i = 0; i < 3; i++) {
          float age = uTime - uRipples[i].z;
          float distanceToTap = distance(position.xy, uRipples[i].xy);
          if (age > 0.0 && age < 2.8) {
            wave += sin(distanceToTap * 16.0 - age * 7.0) * exp(-age * 1.45) * exp(-distanceToTap * 1.25) * 0.12 * uRipples[i].w;
          }
        }
        transformed.z += wave;
        vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uSun;
      uniform vec4 uRipples[3];
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        float ripples = sin(vUv.x * 16.0 + vUv.y * 11.0 + uTime * 0.75) * 0.5 + 0.5;
        vec3 viewDir = normalize(vViewPosition);
        float fresnel = pow(1.0 - max(dot(normalize(vNormal), viewDir), 0.0), 3.2);
        float highlight = smoothstep(0.88, 1.0, ripples) * 0.2 + fresnel * 0.4;
        vec3 waterColor = mix(uDeep, uShallow, 0.38 + ripples * 0.2);
        gl_FragColor = vec4(mix(waterColor, uSun, highlight), 1.0);
      }
    `,
    side: THREE.FrontSide,
    depthWrite: true,
    depthTest: true,
  });
  const waterDeep = new THREE.MeshStandardMaterial({ color: palette.waterDeep, roughness: 0.42 });
  const grass = new THREE.MeshStandardMaterial({ color: palette.grass, roughness: 0.95, flatShading: true });
  const hedge = new THREE.MeshStandardMaterial({ color: palette.hedge, roughness: 0.95, flatShading: true });
  const hedgeLight = new THREE.MeshStandardMaterial({ color: palette.hedgeLight, roughness: 0.95, flatShading: true });
  const trunk = new THREE.MeshStandardMaterial({ color: palette.trunk, roughness: 0.92, flatShading: true });
  const gold = new THREE.MeshStandardMaterial({
    color: palette.gold,
    emissive: palette.gold,
    emissiveIntensity: 1.8,
    roughness: 0.3,
  });
  const lamp = new THREE.MeshStandardMaterial({
    color: 0xffd58d,
    emissive: 0xffb85c,
    emissiveIntensity: 2.4,
    roughness: 0.28,
  });
  const white = new THREE.MeshStandardMaterial({ color: palette.white, roughness: 0.74 });
  return {
    concrete,
    concreteLight,
    concreteDark,
    charcoal,
    charcoalDeep,
    asphalt,
    paving,
    deck,
    warmGlass,
    interiorGlow,
    curtain,
    darkGlass,
    water,
    waterDeep,
    grass,
    hedge,
    hedgeLight,
    trunk,
    gold,
    lamp,
    white,
  };
}

type HotelMaterials = ReturnType<typeof makeMaterials>;

// Repeated architectural pieces share GPU geometry. This keeps model creation and
// memory pressure low while leaving each mesh independently selectable.
const boxGeometryCache = new Map<string, THREE.BufferGeometry>();
const cylinderGeometryCache = new Map<string, THREE.BufferGeometry>();

function tagMesh(mesh: THREE.Mesh, parent: THREE.Group, name: string) {
  mesh.name = name;
  mesh.userData.partId = parent.userData.partId;
  mesh.userData.explodeWithParent = true;
  // Small detail meshes (rails, lamps, mullions, planters) do not need their own
  // shadow-map draw call. Larger structural boxes opt back in below.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

function box(
  parent: THREE.Group,
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
  rotation: [number, number, number] = [0, 0, 0],
  bevel = 0,
) {
  const geometryKey = `${bevel}|${size.join("|")}`;
  let geometry = boxGeometryCache.get(geometryKey);
  if (!geometry) {
    geometry = bevel > 0
      ? new RoundedBoxGeometry(size[0], size[1], size[2], 1, bevel)
      : new THREE.BoxGeometry(size[0], size[1], size[2]);
    boxGeometryCache.set(geometryKey, geometry);
  }
  const mesh = tagMesh(new THREE.Mesh(geometry, material), parent, name);
  const volume = size[0] * size[1] * size[2];
  mesh.castShadow = volume > 1.25 && !name.includes("glass") && !name.includes("water");
  mesh.receiveShadow = volume > 0.65;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  parent.add(mesh);
  return mesh;
}

function cylinder(
  parent: THREE.Group,
  name: string,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  position: [number, number, number],
  material: THREE.Material,
  segments = 8,
) {
  const geometryKey = `${radiusTop}|${radiusBottom}|${height}|${segments}`;
  let geometry = cylinderGeometryCache.get(geometryKey);
  if (!geometry) {
    geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
    cylinderGeometryCache.set(geometryKey, geometry);
  }
  const mesh = tagMesh(
    new THREE.Mesh(geometry, material),
    parent,
    name,
  );
  mesh.castShadow = Math.max(radiusTop, radiusBottom) * height > 0.55;
  mesh.receiveShadow = height > 0.8;
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function part(root: THREE.Group, parts: Map<string, THREE.Group>, id: string, center: THREE.Vector3) {
  const group = new THREE.Group();
  group.name = id;
  group.userData.partId = id;
  group.userData.explodeCenter = center.clone();
  group.userData.basePosition = group.position.clone();
  parts.set(id, group);
  root.add(group);
  return group;
}

function windowModule(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  balcony: boolean,
) {
  const frameDepth = 0.11;
  box(parent, `${name}-recess`, [width + 0.32, height + 0.28, 0.18], [x, y, z - 0.08], materials.charcoalDeep);
  box(parent, `${name}-glass`, [width, height, 0.08], [x, y, z + 0.04], materials.warmGlass);
  box(parent, `${name}-mullion-v`, [0.07, height, frameDepth], [x, y, z + 0.11], materials.charcoalDeep);
  box(parent, `${name}-mullion-h`, [width, 0.06, frameDepth], [x, y - height * 0.08, z + 0.11], materials.charcoalDeep);
  box(parent, `${name}-frame-top`, [width + 0.1, 0.09, frameDepth], [x, y + height / 2, z + 0.11], materials.charcoalDeep);
  box(parent, `${name}-frame-bottom`, [width + 0.1, 0.09, frameDepth], [x, y - height / 2, z + 0.11], materials.charcoalDeep);
  box(parent, `${name}-frame-left`, [0.09, height, frameDepth], [x - width / 2, y, z + 0.11], materials.charcoalDeep);
  box(parent, `${name}-frame-right`, [0.09, height, frameDepth], [x + width / 2, y, z + 0.11], materials.charcoalDeep);

  if (!balcony) return;
  const slabZ = z + 0.82;
  box(parent, `${name}-balcony-slab`, [width + 0.9, 0.18, 1.62], [x, y - height / 2 - 0.18, slabZ], materials.concreteDark, [0, 0, 0], 0.04);
  const railY = y - height / 2 + 0.32;
  box(parent, `${name}-rail-top`, [width + 0.72, 0.07, 0.07], [x, railY + 0.45, z + 1.55], materials.charcoalDeep);
  box(parent, `${name}-rail-mid`, [width + 0.72, 0.055, 0.055], [x, railY + 0.12, z + 1.55], materials.charcoalDeep);
  for (let index = -2; index <= 2; index += 1) {
    box(parent, `${name}-rail-post-${index}`, [0.055, 0.86, 0.055], [x + index * (width + 0.55) / 4, railY + 0.05, z + 1.55], materials.charcoalDeep);
  }
  box(parent, `${name}-rail-side-l`, [0.055, 0.82, 1.42], [x - (width + 0.35) / 2, railY + 0.05, z + 0.85], materials.charcoalDeep);
  box(parent, `${name}-rail-side-r`, [0.055, 0.82, 1.42], [x + (width + 0.35) / 2, railY + 0.05, z + 0.85], materials.charcoalDeep);

  for (const side of [-1, 1]) {
    const planterX = x + side * (width * 0.37);
    box(parent, `${name}-planter-${side}`, [0.38, 0.32, 0.38], [planterX, railY - 0.26, z + 0.75], materials.charcoalDeep, [0, 0, 0], 0.04);
    const shrub = tagMesh(
      new THREE.Mesh(new THREE.IcosahedronGeometry(0.25, 0), side < 0 ? materials.hedge : materials.hedgeLight),
      parent,
      `${name}-shrub-${side}`,
    );
    shrub.position.set(planterX, railY + 0.03, z + 0.75);
    shrub.scale.set(0.8, 1.25, 0.8);
    parent.add(shrub);
  }
}

function framedGlazing(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  divided: boolean,
  facing: 1 | -1 = 1,
  glassMaterial: THREE.MeshPhysicalMaterial = materials.warmGlass,
) {
  const frameDepth = 0.12;
  box(parent, `${name}-recess`, [width + 0.24, height + 0.24, 0.16], [x, y, z - facing * 0.07], materials.charcoalDeep, [0, 0, 0], 0.025);
  box(parent, `${name}-glass`, [width, height, 0.07], [x, y, z + facing * 0.035], glassMaterial);
  box(parent, `${name}-frame-top`, [width + 0.1, 0.09, frameDepth], [x, y + height / 2, z + facing * 0.105], materials.charcoalDeep);
  box(parent, `${name}-frame-bottom`, [width + 0.1, 0.09, frameDepth], [x, y - height / 2, z + facing * 0.105], materials.charcoalDeep);
  box(parent, `${name}-frame-left`, [0.09, height, frameDepth], [x - width / 2, y, z + facing * 0.105], materials.charcoalDeep);
  box(parent, `${name}-frame-right`, [0.09, height, frameDepth], [x + width / 2, y, z + facing * 0.105], materials.charcoalDeep);
  if (divided) box(parent, `${name}-center-divider`, [0.075, height, frameDepth], [x, y, z + facing * 0.105], materials.charcoalDeep);
}

function addBalconyPlanter(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
  scale = 1,
) {
  box(parent, `${name}-pot`, [0.54 * scale, 0.34 * scale, 0.46 * scale], [x, y, z], materials.charcoalDeep, [0, 0, 0], 0.035);
  const clusters: Array<[number, number, number, number]> = [
    [0, 0.33, 0, 0.26],
    [-0.13, 0.25, 0.05, 0.17],
    [0.14, 0.24, -0.04, 0.16],
  ];
  clusters.forEach(([dx, dy, dz, radius], index) => {
    const shrub = tagMesh(
      new THREE.Mesh(new THREE.IcosahedronGeometry(radius * scale, 1), index === 1 ? materials.hedgeLight : materials.hedge),
      parent,
      `${name}-foliage-${index}`,
    );
    shrub.position.set(x + dx * scale, y + dy * scale, z + dz * scale);
    shrub.scale.set(0.9, 1.16, 0.9);
    parent.add(shrub);
  });
}

function roomFront(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
  facing: 1 | -1 = 1,
): RoomLightEntry {
  // One room composition is shared by both elevations: a narrow core-side window,
  // a real masonry pier, and a wide two-panel slider behind one full-width balcony.
  const outerSide = Math.sign(x) || 1;
  const roomWidth = 4.6;
  const glazingHeight = 1.66;
  const floorY = y - glazingHeight / 2 - 0.18;
  const narrowX = x - outerSide * 1.62;
  const sliderX = x + outerSide * 0.58;
  // This 0.64-unit gap is intentionally left as exposed wall: it is the distinct
  // pier shown between the narrow window and the sliding door in the reference.
  const innerSconceX = x - outerSide * 1.0;
  const outerSconceX = x + outerSide * 2.08;
  const roomGlass = materials.warmGlass.clone();
  const roomGlow = materials.interiorGlow.clone();
  const roomBulbs = [materials.lamp.clone(), materials.lamp.clone()];
  framedGlazing(parent, materials, `${name}-narrow-window`, narrowX, y, z, 0.7, glazingHeight, false, facing, roomGlass);
  framedGlazing(parent, materials, `${name}-sliding-door`, sliderX, y, z, 2.46, glazingHeight, true, facing, roomGlass);

  // Interior glow and offset curtain panels create depth through the glass rather than a flat amber fill.
  box(parent, `${name}-interior-glow`, [2.26, 1.43, 0.025], [sliderX, y, z - facing * 0.04], roomGlow);
  for (const offset of [-0.92, -0.68, 0.68, 0.92]) {
    box(parent, `${name}-curtain-${offset}`, [0.16, 1.42, 0.025], [sliderX + offset, y, z - facing * 0.075], materials.curtain);
  }
  box(parent, `${name}-interior-bed`, [0.92, 0.18, 0.32], [sliderX + outerSide * 0.22, y - 0.36, z - facing * 0.13], materials.white, [0, 0, 0], 0.025);
  box(parent, `${name}-narrow-interior`, [0.5, 1.43, 0.025], [narrowX, y, z - facing * 0.04], roomGlow);
  box(parent, `${name}-narrow-curtain`, [0.13, 1.42, 0.025], [narrowX - outerSide * 0.17, y, z - facing * 0.075], materials.curtain);

  // Both fixtures sit on solid facade, never on a glazing frame.
  if (facing > 0) {
    addSconce(parent, materials, `${name}-pier-sconce`, innerSconceX, y + 0.06, z + 0.18, roomBulbs[0]);
    addSconce(parent, materials, `${name}-outer-wall-sconce`, outerSconceX, y + 0.06, z + 0.18, roomBulbs[1]);
  } else {
    addRearSconce(parent, materials, `${name}-pier-sconce`, innerSconceX, y + 0.06, z - 0.18, roomBulbs[0]);
    addRearSconce(parent, materials, `${name}-outer-wall-sconce`, outerSconceX, y + 0.06, z - 0.18, roomBulbs[1]);
  }

  box(parent, `${name}-balcony-slab`, [roomWidth, 0.14, 1.3], [x, floorY, z + facing * 0.7], materials.concreteLight, [0, 0, 0], 0.025);
  const railZ = z + facing * 1.28;
  const railTopY = floorY + 0.74;
  box(parent, `${name}-rail-top`, [roomWidth, 0.04, 0.04], [x, railTopY, railZ], materials.charcoalDeep);
  box(parent, `${name}-rail-base`, [roomWidth, 0.03, 0.03], [x, floorY + 0.1, railZ], materials.charcoalDeep);
  for (const offset of [-roomWidth / 2, -0.72, 0.72, roomWidth / 2]) {
    box(parent, `${name}-rail-post-${offset}`, [0.04, 0.72, 0.04], [x + offset, floorY + 0.4, railZ], materials.charcoalDeep);
  }
  for (const side of [-1, 1]) {
    const endX = x + side * roomWidth / 2;
    box(parent, `${name}-rail-return-${side}`, [0.04, 0.72, 1.26], [endX, floorY + 0.4, z + facing * 0.68], materials.charcoalDeep);
    box(parent, `${name}-rail-return-top-${side}`, [0.04, 0.04, 1.26], [endX, railTopY, z + facing * 0.68], materials.charcoalDeep);
  }

  for (const side of [-1, 1]) {
    const planterX = x + side * outerSide * 1.78;
    addBalconyPlanter(parent, materials, `${name}-planter-${side}`, planterX, floorY + 0.25, z + facing * 1.0, side < 0 ? 1.06 : 0.9);
  }

  return {
    id: name,
    label: name,
    floor: 0,
    elevation: facing > 0 ? "Front" : "Rear",
    enabled: true,
    glass: roomGlass,
    glow: roomGlow,
    bulbs: roomBulbs,
  };
}

function sideWindow(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
  facing: 1 | -1 = 1,
  glassMaterial: THREE.MeshPhysicalMaterial = materials.warmGlass,
) {
  box(parent, `${name}-recess`, [0.2, 1.9, 0.98], [x - facing * 0.04, y, z], materials.charcoalDeep, [0, 0, 0], 0.025);
  box(parent, `${name}-glass`, [0.09, 1.58, 0.68], [x + facing * 0.08, y, z], glassMaterial);
  box(parent, `${name}-mullion-v`, [0.11, 1.58, 0.055], [x + facing * 0.145, y, z], materials.charcoalDeep);
  box(parent, `${name}-sill`, [0.11, 0.08, 0.78], [x + facing * 0.15, y - 0.83, z], materials.charcoalDeep);
}

function sidePassageGlazing(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  z: number,
  facing: 1 | -1,
  glassMaterial: THREE.MeshPhysicalMaterial,
) {
  // A full-height central strip makes the side elevation read as a circulation
  // passage rather than two unrelated stacks of bedroom windows.
  const y = 8.7;
  const height = 9.2;
  const width = 0.86;
  const depth = 0.11;
  box(parent, `${name}-recess`, [0.22, height + 0.28, width + 0.22], [x - facing * 0.035, y, z], materials.charcoalDeep, [0, 0, 0], 0.025);
  box(parent, `${name}-glass`, [0.09, height, width], [x + facing * 0.085, y, z], glassMaterial);
  box(parent, `${name}-frame-front`, [depth, height + 0.12, 0.09], [x + facing * 0.14, y, z + width / 2], materials.charcoalDeep);
  box(parent, `${name}-frame-back`, [depth, height + 0.12, 0.09], [x + facing * 0.14, y, z - width / 2], materials.charcoalDeep);
  box(parent, `${name}-frame-top`, [depth, 0.09, width + 0.1], [x + facing * 0.14, y + height / 2, z], materials.charcoalDeep);
  box(parent, `${name}-frame-bottom`, [depth, 0.09, width + 0.1], [x + facing * 0.14, y - height / 2, z], materials.charcoalDeep);
  for (const floorY of [6.2, 8.65, 11.1]) {
    box(parent, `${name}-floor-mullion-${floorY}`, [depth, 0.075, width + 0.02], [x + facing * 0.14, floorY, z], materials.charcoalDeep);
  }
}

function addFixtureLight(
  parent: THREE.Group,
  name: string,
  position: [number, number, number],
  nightIntensity: number,
  distance: number,
  dayRatio = 0.035,
) {
  const light = new THREE.PointLight(0xffb85c, nightIntensity, distance, 2.1);
  light.name = `${name}-light`;
  light.position.set(...position);
  light.userData.dayIntensity = nightIntensity * dayRatio;
  light.userData.nightIntensity = nightIntensity;
  light.userData.twilightBoost = nightIntensity * 0.16;
  parent.add(light);
  return light;
}

function addSconce(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
  lampMaterial: THREE.MeshStandardMaterial = materials.lamp,
) {
  box(parent, `${name}-back`, [0.16, 0.34, 0.12], [x, y, z], materials.charcoalDeep, [0, 0, 0], 0.03);
  box(parent, `${name}-lamp`, [0.095, 0.2, 0.09], [x, y, z + 0.08], lampMaterial, [0, 0, 0], 0.025);
  // The bulb itself is emissive and remains tied to the time-of-day profile.
  // Facade sconces deliberately do not create individual point lights: dozens of
  // local lights are disproportionately expensive in a forward-rendered scene.
}

function addSideSconce(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
  facing: 1 | -1,
) {
  box(parent, `${name}-back`, [0.12, 0.34, 0.16], [x + facing * 0.02, y, z], materials.charcoalDeep, [0, 0, 0], 0.025);
  box(parent, `${name}-lamp`, [0.09, 0.2, 0.095], [x + facing * 0.1, y, z], materials.lamp, [0, 0, 0], 0.025);
}

function makeSignTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 768;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#ffdf83";
  context.fillStyle = "#ffe094";
  context.shadowColor = "rgba(255, 177, 58, 0.62)";
  context.shadowBlur = 18;
  context.lineWidth = 18;
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(390, 190);
  context.lineTo(350, 78);
  context.lineTo(462, 145);
  context.lineTo(512, 46);
  context.lineTo(565, 145);
  context.lineTo(675, 78);
  context.lineTo(635, 190);
  context.closePath();
  context.stroke();
  context.font = "600 126px Arial, sans-serif";
  context.textAlign = "center";
  context.letterSpacing = "11px";
  context.fillText("LUXORA", 512, 405);
  context.font = "600 70px Arial, sans-serif";
  context.letterSpacing = "18px";
  context.fillText("HOTEL", 512, 520);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function addHotelTower(
  root: THREE.Group,
  parts: Map<string, THREE.Group>,
  materials: HotelMaterials,
  roomLights: Map<string, RoomLightEntry>,
  sidePassageGlasses: THREE.MeshPhysicalMaterial[],
) {
  const tower = part(root, parts, "hotel-tower", new THREE.Vector3(0, 8, -2.1));
  box(tower, "tower-main-volume", [13.6, 13.8, 7.7], [0, 8.05, -2.35], materials.concrete, [0, 0, 0], 0.08);
  box(tower, "tower-ground-podium", [15.2, 3.0, 8.8], [0.2, 2.25, -1.75], materials.concreteLight, [0, 0, 0], 0.08);
  box(tower, "tower-roof-band", [14.05, 0.42, 8.08], [0, 14.72, -2.35], materials.charcoalDeep);
  box(tower, "tower-roof-cap", [13.85, 1.18, 7.88], [0, 15.15, -2.35], materials.concreteLight, [0, 0, 0], 0.06);
  box(tower, "tower-roof-inset", [11.95, 0.12, 6.1], [0, 15.76, -2.35], materials.charcoal);
  box(tower, "tower-central-spine", [3.55, 12.65, 0.64], [0, 8.85, 1.82], materials.charcoalDeep, [0, 0, 0], 0.05);
  box(tower, "tower-sign-panel", [4.35, 3.0, 0.24], [0, 13.5, 2.23], materials.charcoalDeep, [0, 0, 0], 0.05);

  const signTexture = makeSignTexture();
  const signMaterial = new THREE.MeshBasicMaterial({ map: signTexture, transparent: true, toneMapped: false });
  const sign = tagMesh(new THREE.Mesh(new THREE.PlaneGeometry(3.75, 2.35), signMaterial), tower, "luxora-crown-and-sign");
  sign.position.set(0, 13.55, 2.37);
  tower.add(sign);

  const floorHeights = [5.0, 7.45, 9.9, 12.35];
  floorHeights.forEach((height, floorIndex) => {
    const leftRoom = roomFront(tower, materials, `left-wing-floor-${floorIndex + 1}`, -4.35, height, 1.62);
    const rightRoom = roomFront(tower, materials, `right-wing-floor-${floorIndex + 1}`, 4.35, height, 1.62);
    roomLights.set(leftRoom.id, { ...leftRoom, label: "Front L", floor: floorIndex + 1 });
    roomLights.set(rightRoom.id, { ...rightRoom, label: "Front R", floor: floorIndex + 1 });
  });

  [4.8, 7.45, 10.1].forEach((height, index) => {
    windowModule(tower, materials, `central-window-${index + 1}`, 0, height, 2.18, 2.65, 1.8, false);
  });

  const eastPassageGlass = materials.warmGlass.clone();
  const westPassageGlass = materials.warmGlass.clone();
  sidePassageGlasses.push(eastPassageGlass, westPassageGlass);
  sidePassageGlazing(tower, materials, "east-side-passage", 6.86, -2.35, 1, eastPassageGlass);
  sidePassageGlazing(tower, materials, "west-side-passage", -6.86, -2.35, -1, westPassageGlass);
  addSideSconce(tower, materials, "east-pool-wall-bulb", 6.92, 3.28, 0.35, 1);
  addSideSconce(tower, materials, "west-podium-wall-bulb", -6.92, 3.28, 0.35, -1);

  for (const side of [-1, 1]) {
    box(tower, `lobby-glass-${side}`, [3.4, 2.35, 0.12], [side * 3.65, 2.15, 2.67], materials.warmGlass);
    for (let index = -1; index <= 1; index += 1) {
      box(tower, `lobby-mullion-${side}-${index}`, [0.075, 2.35, 0.16], [side * 3.65 + index * 1.08, 2.15, 2.77], materials.charcoalDeep);
    }
  }
  box(tower, "lobby-transom", [11.0, 0.08, 0.17], [0, 2.25, 2.78], materials.charcoalDeep);

  const roof = part(root, parts, "roof-system", new THREE.Vector3(0, 15.8, -2.4));
  box(roof, "roof-plant-room", [2.85, 1.8, 2.5], [1.3, 16.65, -2.75], materials.charcoal, [0, 0, 0], 0.04);
  box(roof, "roof-plant-opening", [1.8, 0.14, 1.45], [1.3, 17.58, -2.75], materials.charcoalDeep);
  box(roof, "roof-vent-stack", [1.2, 1.25, 1.0], [-1.3, 16.35, -1.45], materials.charcoalDeep);
  box(roof, "roof-vent-slot", [0.7, 0.32, 0.18], [-1.3, 16.55, -0.91], materials.charcoal);
}

function addRearSconce(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
  lampMaterial: THREE.MeshStandardMaterial = materials.lamp,
) {
  box(parent, `${name}-back`, [0.15, 0.32, 0.12], [x, y, z], materials.charcoalDeep, [0, 0, 0], 0.02);
  box(parent, `${name}-lamp`, [0.085, 0.18, 0.09], [x, y, z - 0.08], lampMaterial, [0, 0, 0], 0.02);
  // See addSconce: the visible bulb provides the local glow without an expensive
  // point-light wash or a diffuse hotspot across the facade.
}

function addRearLouver(parent: THREE.Group, materials: HotelMaterials, name: string, x: number, y: number, z: number, width: number, height: number) {
  box(parent, `${name}-recess`, [width + 0.12, height + 0.12, 0.08], [x, y, z], materials.charcoalDeep);
  const slatCount = 5;
  for (let index = 0; index < slatCount; index += 1) {
    const sy = y - height / 2 + 0.15 + index * (height - 0.3) / (slatCount - 1);
    box(parent, `${name}-slat-${index}`, [width - 0.1, 0.045, 0.08], [x, sy, z - 0.07], materials.charcoal);
  }
}

function rearCoreModule(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  y: number,
  z: number,
): RoomLightEntry {
  // The rear centre is circulation, not a third balcony room: a compact inset
  // window is flanked by louvered stairwell vents on every floor.
  const glass = materials.warmGlass.clone();
  const glow = materials.interiorGlow.clone();
  const bulbs = [materials.lamp.clone(), materials.lamp.clone()];
  framedGlazing(parent, materials, `${name}-passage-window`, 0, y, z, 1.58, 1.62, true, -1, glass);
  box(parent, `${name}-interior-glow`, [1.42, 1.4, 0.025], [0, y, z + 0.04], glow);
  // Keep interior furniture entirely behind the glow plane. The former deep
  // landing volume intersected it and produced visible depth-buffer flicker.
  box(parent, `${name}-passage-landing`, [1.16, 0.14, 0.07], [0, y - 0.37, z + 0.22], materials.white, [0, 0, 0], 0.02);
  // Each louver is centred inside its dedicated pale service bar. Keeping the
  // louver narrower than the bar provides the even left/right reveal visible
  // in the reference rather than making it look attached to the pier edge.
  for (const x of [-1.78, 1.78]) {
    addRearLouver(parent, materials, `${name}-stair-vent-${x}`, x, y, z - 0.06, 0.52, 1.22);
  }
  addRearSconce(parent, materials, `${name}-left-sconce`, -1.1, y + 0.04, z - 0.18, bulbs[0]);
  addRearSconce(parent, materials, `${name}-right-sconce`, 1.1, y + 0.04, z - 0.18, bulbs[1]);
  return {
    id: name,
    label: name,
    floor: 0,
    elevation: "Rear",
    enabled: true,
    glass,
    glow,
    bulbs,
  };
}

function rearBalconyRoom(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  y: number,
  z: number,
): RoomLightEntry {
  // Rear bedrooms are intentionally simpler than the front: one broad inset
  // window behind a shallow balcony, matching the reference elevation.
  const glass = materials.warmGlass.clone();
  const glow = materials.interiorGlow.clone();
  const bulbs = [materials.lamp.clone(), materials.lamp.clone()];
  const width = 2.72;
  const floorY = y - 1.02;
  framedGlazing(parent, materials, `${name}-wide-window`, x, y, z, width, 1.62, true, -1, glass);
  box(parent, `${name}-interior-glow`, [2.5, 1.4, 0.025], [x, y, z + 0.04], glow);
  box(parent, `${name}-interior-table`, [1.22, 0.14, 0.07], [x, y - 0.34, z + 0.22], materials.white, [0, 0, 0], 0.02);
  box(parent, `${name}-curtain-left`, [0.16, 1.42, 0.025], [x - 1.02, y, z + 0.075], materials.curtain);
  box(parent, `${name}-curtain-right`, [0.16, 1.42, 0.025], [x + 1.02, y, z + 0.075], materials.curtain);
  addRearSconce(parent, materials, `${name}-inner-sconce`, x + (x < 0 ? 1.72 : -1.72), y + 0.04, z - 0.18, bulbs[0]);
  addRearSconce(parent, materials, `${name}-outer-sconce`, x + (x < 0 ? -1.72 : 1.72), y + 0.04, z - 0.18, bulbs[1]);

  box(parent, `${name}-balcony-slab`, [3.82, 0.14, 0.9], [x, floorY, z - 0.52], materials.concreteLight, [0, 0, 0], 0.025);
  box(parent, `${name}-rail-top`, [3.62, 0.045, 0.045], [x, floorY + 0.76, z - 0.9], materials.charcoalDeep);
  box(parent, `${name}-rail-base`, [3.62, 0.035, 0.035], [x, floorY + 0.12, z - 0.9], materials.charcoalDeep);
  for (const offset of [-1.81, -0.58, 0.58, 1.81]) {
    box(parent, `${name}-rail-post-${offset}`, [0.045, 0.7, 0.045], [x + offset, floorY + 0.42, z - 0.9], materials.charcoalDeep);
  }
  for (const side of [-1, 1]) {
    box(parent, `${name}-rail-return-${side}`, [0.045, 0.7, 0.72], [x + side * 1.81, floorY + 0.42, z - 0.55], materials.charcoalDeep);
    addBalconyPlanter(parent, materials, `${name}-planter-${side}`, x + side * 1.42, floorY + 0.27, z - 0.7, 0.72);
  }
  return { id: name, label: name, floor: 0, elevation: "Rear", enabled: true, glass, glow, bulbs };
}

function addRearFacade(
  root: THREE.Group,
  parts: Map<string, THREE.Group>,
  materials: HotelMaterials,
  roomLights: Map<string, RoomLightEntry>,
) {
  const rear = part(root, parts, "rear-facade-system", new THREE.Vector3(0, 8, -6.6));
  const rearZ = -6.3;
  // Two matching balcony room stacks frame a purpose-built stair/passage core.
  // This preserves the front room language while matching the reference rear's
  // stronger symmetric service and ventilation structure.
  const rearFloorHeights = [5.0, 7.45, 9.9, 12.35];
  rearFloorHeights.forEach((height, floorIndex) => {
    const leftRoom = rearBalconyRoom(rear, materials, `rear-floor-${floorIndex + 1}-west`, -4.45, height, rearZ);
    const coreRoom = rearCoreModule(rear, materials, `rear-floor-${floorIndex + 1}-core`, height, rearZ);
    const rightRoom = rearBalconyRoom(rear, materials, `rear-floor-${floorIndex + 1}-east`, 4.45, height, rearZ);
    roomLights.set(leftRoom.id, { ...leftRoom, label: "Rear 1", floor: floorIndex + 1 });
    roomLights.set(coreRoom.id, { ...coreRoom, label: "Rear 2", floor: floorIndex + 1 });
    roomLights.set(rightRoom.id, { ...rightRoom, label: "Rear 3", floor: floorIndex + 1 });
  });

  box(rear, "rear-core-west-service-bar", [1.12, 10.4, 0.22], [-1.78, 8.7, rearZ + 0.05], materials.concreteLight, [0, 0, 0], 0.025);
  box(rear, "rear-core-east-service-bar", [1.12, 10.4, 0.22], [1.78, 8.7, rearZ + 0.05], materials.concreteLight, [0, 0, 0], 0.025);

  const service = part(root, parts, "rear-service-floor", new THREE.Vector3(0, 2.1, -6.6));
  // The reference's service plinth is graphite, not black; sky bounce keeps it
  // readable on the shaded rear while preserving its contrast with the facade.
  box(service, "rear-service-cladding", [13.9, 3.2, 0.34], [0, 2.28, -6.38], materials.charcoal, [0, 0, 0], 0.035);
  box(service, "rear-service-cap", [14.0, 0.26, 0.52], [0, 3.78, -6.44], materials.charcoal);
  for (const [x, width] of [[-5.15, 0.9], [-3.25, 0.82], [2.7, 0.82], [5.2, 0.88]] as Array<[number, number]>) {
    box(service, `rear-service-door-${x}-frame`, [width + 0.12, 1.82, 0.1], [x, 1.95, -6.58], materials.charcoal);
    box(service, `rear-service-door-${x}`, [width, 1.68, 0.07], [x, 1.95, -6.65], materials.charcoal);
    addRearSconce(service, materials, `rear-service-sconce-${x}`, x + width * 0.78, 2.08, -6.72);
  }
  addRearLouver(service, materials, "rear-service-louver-left", -1.55, 1.86, -6.65, 0.58, 0.58);
  addRearLouver(service, materials, "rear-service-louver-right", 4.05, 1.85, -6.65, 0.58, 0.58);

  box(service, "rear-generator", [1.45, 1.1, 0.62], [1.35, 1.4, -6.77], materials.concreteDark, [0, 0, 0], 0.05);
  addRearLouver(service, materials, "rear-generator-louver", 1.35, 1.45, -7.1, 0.92, 0.58);
  for (const x of [-0.95, -0.1, 0.75]) {
    box(service, `rear-ac-unit-${x}`, [0.68, 0.64, 0.52], [x, 1.25, -7.4], materials.concreteDark, [0, 0, 0], 0.04);
    const fan = tagMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.035, 12), materials.charcoal), service, `rear-ac-fan-${x}`);
    fan.rotation.x = Math.PI / 2;
    fan.position.set(x, 1.25, -7.1);
    service.add(fan);
  }
  box(service, "rear-utility-cabinet", [0.96, 1.08, 0.58], [4.1, 1.42, -6.77], materials.concreteDark, [0, 0, 0], 0.04);
  addRearLouver(service, materials, "rear-utility-louver", 4.1, 1.48, -7.1, 0.58, 0.62);

  const ladderX = -4.15;
  for (const side of [-1, 1]) box(service, `rear-ladder-rail-${side}`, [0.06, 3.15, 0.06], [ladderX + side * 0.28, 3.05, -6.78], materials.charcoal);
  for (let index = 0; index < 10; index += 1) box(service, `rear-ladder-rung-${index}`, [0.58, 0.045, 0.055], [ladderX, 1.7 + index * 0.29, -6.82], materials.charcoal);

  box(service, "rear-terrace-paving", [4.15, 0.12, 2.45], [-5.15, 0.88, -8.15], materials.deck);
  for (const [x, z, angle] of [[-5.85, -8.28, 0.14], [-4.45, -8.25, -0.16]] as Array<[number, number, number]>) {
    box(service, `rear-lounger-${x}`, [0.62, 0.15, 1.3], [x, 1.1, z], materials.concreteLight, [angle, 0, 0], 0.035);
  }
  cylinder(service, "rear-cafe-table", 0.42, 0.42, 0.1, [-3.75, 1.35, -8.25], materials.deck, 10);
  cylinder(service, "rear-cafe-table-leg", 0.06, 0.06, 0.5, [-3.75, 1.08, -8.25], materials.charcoalDeep, 8);
}

function addWrappedSideWindows(
  parts: Map<string, THREE.Group>,
  materials: HotelMaterials,
  roomLights: Map<string, RoomLightEntry>,
) {
  const tower = parts.get("hotel-tower");
  if (!tower) return;
  const floorHeights = [5.0, 7.45, 9.9, 12.35];
  floorHeights.forEach((height, floorIndex) => {
    const floor = floorIndex + 1;
    const frontLeft = roomLights.get(`left-wing-floor-${floor}`);
    const frontRight = roomLights.get(`right-wing-floor-${floor}`);
    const rearWest = roomLights.get(`rear-floor-${floor}-west`);
    const rearEast = roomLights.get(`rear-floor-${floor}-east`);
    if (!frontLeft || !frontRight || !rearWest || !rearEast) return;

    // Each side wraps its nearest window to the adjacent facade's room. This
    // avoids mirroring the front pair onto both sides and makes every switch
    // correspond to its physically neighbouring side window.
    sideWindow(tower, materials, `west-side-front-${floor}`, -6.86, height, -0.55, -1, frontLeft.glass);
    sideWindow(tower, materials, `west-side-rear-${floor}`, -6.86, height, -4.15, -1, rearWest.glass);
    sideWindow(tower, materials, `east-side-front-${floor}`, 6.86, height, -0.55, 1, frontRight.glass);
    sideWindow(tower, materials, `east-side-rear-${floor}`, 6.86, height, -4.15, 1, rearEast.glass);
  });
}

function addEntrance(root: THREE.Group, parts: Map<string, THREE.Group>, materials: HotelMaterials) {
  const entrance = part(root, parts, "entrance-system", new THREE.Vector3(-3.7, 2.2, 5.2));
  // The front arrival sequence is stepped from the parking court to the lobby,
  // rather than reading as one flat slab.
  box(entrance, "porte-cochere-roof", [8.3, 0.48, 5.25], [-3.65, 3.65, 5.0], materials.charcoalDeep, [0, 0, 0], 0.08);
  box(entrance, "porte-cochere-inset", [7.45, 0.16, 4.45], [-3.65, 3.92, 5.0], materials.charcoal);
  box(entrance, "porte-cochere-fascia", [8.48, 0.24, 5.38], [-3.65, 3.48, 5.0], materials.charcoal);
  for (const x of [-6.95, -0.35]) {
    for (const z of [3.55, 6.8]) {
      box(entrance, `canopy-column-${x}-${z}`, [0.56, 3.15, 0.56], [x, 2.0, z], materials.concreteLight, [0, 0, 0], 0.055);
      addSconce(entrance, materials, `column-sconce-${x}-${z}`, x + (x < -3 ? 0.3 : -0.3), 2.25, z + 0.3);
    }
  }
  box(entrance, "entry-step-low", [7.7, 0.16, 1.05], [-3.65, 0.88, 5.02], materials.concreteLight, [0, 0, 0], 0.025);
  box(entrance, "entry-step-middle", [7.0, 0.17, 0.96], [-3.65, 1.03, 4.54], materials.concreteLight, [0, 0, 0], 0.025);
  box(entrance, "entry-step-upper", [6.25, 0.18, 0.9], [-3.65, 1.2, 4.07], materials.concreteLight, [0, 0, 0], 0.025);
  // Recessed lobby modules: one entrance door between two distinct glass bays,
  // rather than a single continuous amber plane.
  box(entrance, "entry-lobby-recess", [5.75, 2.72, 0.18], [-3.1, 2.15, 2.66], materials.charcoalDeep, [0, 0, 0], 0.025);
  box(entrance, "entry-lobby-left-glazing", [1.9, 2.34, 0.1], [-4.55, 2.13, 2.79], materials.warmGlass);
  box(entrance, "entry-lobby-right-glazing", [1.7, 2.34, 0.1], [-1.55, 2.13, 2.79], materials.warmGlass);
  box(entrance, "entry-lobby-left-mullion", [0.07, 2.36, 0.16], [-4.55, 2.13, 2.87], materials.charcoalDeep);
  box(entrance, "entry-lobby-right-mullion", [0.07, 2.36, 0.16], [-1.55, 2.13, 2.87], materials.charcoalDeep);
  box(entrance, "entry-door-frame", [1.65, 2.65, 0.18], [-3.1, 2.12, 2.87], materials.charcoalDeep);
  box(entrance, "entry-door-glass", [1.43, 2.43, 0.1], [-3.1, 2.12, 2.98], materials.warmGlass);
  box(entrance, "entry-lobby-sill", [5.72, 0.16, 0.24], [-3.1, 0.98, 2.76], materials.charcoal);

  // The reference wraps the active ground floor around the pool side. These
  // storefront planes make that corner read as a lobby/cafe, not blank podium.
  box(entrance, "hospitality-front-recess", [6.35, 2.58, 0.19], [3.65, 2.1, 2.63], materials.charcoalDeep, [0, 0, 0], 0.025);
  box(entrance, "hospitality-front-band", [6.72, 0.42, 0.82], [3.65, 3.35, 2.43], materials.charcoalDeep);
  for (const [index, x] of [1.55, 3.65, 5.75].entries()) {
    box(entrance, `hospitality-front-glazing-${index}`, [1.78, 2.28, 0.1], [x, 2.07, 2.78], materials.warmGlass);
    box(entrance, `hospitality-front-mullion-${index}`, [0.075, 2.34, 0.17], [x, 2.07, 2.88], materials.charcoalDeep);
  }
  box(entrance, "hospitality-front-sill", [6.32, 0.17, 0.24], [3.65, 0.98, 2.76], materials.charcoal);
  for (const x of [1.5, 5.95]) addSconce(entrance, materials, `hospitality-front-sconce-${x}`, x, 2.22, 2.91);
  box(entrance, "hospitality-side-recess", [0.2, 2.58, 4.1], [6.72, 2.1, 0.35], materials.charcoalDeep, [0, 0, 0], 0.025);
  box(entrance, "hospitality-side-band", [0.92, 0.42, 4.42], [6.5, 3.35, 0.35], materials.charcoalDeep);
  for (const [index, z] of [-0.9, 0.35, 1.6].entries()) {
    box(entrance, `hospitality-side-glazing-${index}`, [0.1, 2.28, 1.05], [6.84, 2.07, z], materials.warmGlass);
    box(entrance, `hospitality-side-mullion-${index}`, [0.17, 2.34, 0.075], [6.93, 2.07, z], materials.charcoalDeep);
  }
  box(entrance, "hospitality-side-sill", [0.24, 0.17, 4.05], [6.84, 0.98, 0.35], materials.charcoal);
  addSideSconce(entrance, materials, "hospitality-side-bulb", 6.97, 2.22, -1.6, 1);
}

function addSite(root: THREE.Group, parts: Map<string, THREE.Group>, materials: HotelMaterials) {
  const site = part(root, parts, "site", new THREE.Vector3(0, 0.2, 0));
  // Extend the site toward the camera so the parking court sits in front of
  // the pool hedge instead of forcing the cars through the planting.
  box(site, "site-base", [29.0, 0.65, 25.8], [0, 0, 0.8], materials.charcoalDeep);
  box(site, "site-upper-plinth", [28.0, 0.42, 24.8], [0, 0.48, 0.8], materials.paving);
  box(site, "parking-asphalt", [16.0, 0.12, 7.9], [0.25, 0.74, 9.3], materials.asphalt);
  box(site, "arrival-drive", [8.9, 0.13, 8.5], [-5.45, 0.75, 4.0], materials.asphalt);
  box(site, "front-walk", [26.0, 0.14, 1.5], [0, 0.77, 13.35], materials.paving);
  box(site, "lobby-paving", [10.2, 0.14, 5.6], [-2.55, 0.77, 4.45], materials.concreteLight);
  // Three generous front-facing bays match the reference better than a dense lot.
  for (let index = 0; index < 4; index += 1) {
    const x = -7.75 + index * 4.1;
    box(site, `parking-line-${index}`, [0.1, 0.025, 6.0], [x, 0.83, 9.3], materials.white);
  }
  for (let index = 0; index < 3; index += 1) {
    const x = -5.7 + index * 4.1;
    box(site, `parking-wheel-stop-${index}`, [1.05, 0.09, 0.18], [x, 0.9, 8.72], materials.concreteLight, [0, 0, 0], 0.02);
  }
  box(site, "parking-stop-line", [12.6, 0.025, 0.08], [-1.6, 0.83, 8.34], materials.white);

  const perimeter = part(root, parts, "perimeter-system", new THREE.Vector3(0, 0.8, 0));
  box(perimeter, "rear-wall", [27.0, 0.86, 0.45], [0, 1.05, -10.6], materials.charcoal);
  box(perimeter, "west-wall", [0.45, 0.86, 23.2], [-13.25, 1.05, 1.1], materials.charcoal);
  box(perimeter, "east-wall", [0.45, 0.86, 23.2], [13.25, 1.05, 1.1], materials.charcoal);
  box(perimeter, "front-wall-left", [3.0, 0.86, 0.45], [-11.7, 1.05, 12.72], materials.charcoal);
  box(perimeter, "front-wall-right", [4.8, 0.86, 0.45], [10.85, 1.05, 12.72], materials.charcoal);

  const pierPositions: Array<[number, number]> = [];
  for (let x = -12.9; x <= 12.9; x += 4.3) pierPositions.push([x, -10.55]);
  for (let z = -8.5; z <= 8.5; z += 4.25) pierPositions.push([-13.2, z], [13.2, z]);
  pierPositions.push([-12.9, 12.7], [8.5, 12.7], [13.0, 12.7]);
  pierPositions.forEach(([x, z], index) => {
    box(perimeter, `perimeter-pier-${index}`, [0.62, 1.45, 0.62], [x, 1.33, z], materials.concreteLight, [0, 0, 0], 0.04);
    box(perimeter, `perimeter-lamp-${index}`, [0.24, 0.3, 0.24], [x, 2.14, z], materials.lamp, [0, 0, 0], 0.04);
  });

  const sign = part(root, parts, "signage-system", new THREE.Vector3(-10.7, 2, 7.2));
  box(sign, "monument-sign-base", [4.2, 0.28, 1.1], [-10.5, 0.94, 7.45], materials.charcoalDeep);
  box(sign, "monument-sign-panel", [3.65, 2.05, 0.32], [-10.5, 2.0, 7.45], materials.charcoal, [0, 0, 0], 0.06);
  const signTexture = makeSignTexture();
  const signMaterial = new THREE.MeshBasicMaterial({ map: signTexture, transparent: true, toneMapped: false });
  const face = tagMesh(new THREE.Mesh(new THREE.PlaneGeometry(3.15, 1.7), signMaterial), sign, "monument-luxora-sign");
  face.position.set(-10.5, 2.0, 7.63);
  sign.add(face);
}

function addPool(root: THREE.Group, parts: Map<string, THREE.Group>, materials: HotelMaterials) {
  // Kept to the right/front of the hotel, with a usable hospitality strip between
  // the facade and water rather than placing the pool directly against the rooms.
  const pool = part(root, parts, "pool-terrace", new THREE.Vector3(8.3, 0.7, 4.65));
  box(pool, "pool-deck", [9.4, 0.22, 7.8], [8.3, 0.82, 4.55], materials.deck);
  box(pool, "pool-side-paving-strip", [2.3, 0.14, 6.7], [4.9, 0.98, 4.15], materials.concreteLight);
  box(pool, "pool-basin", [6.3, 0.62, 3.8], [8.3, 0.68, 4.75], materials.waterDeep);
  const water = tagMesh(new THREE.Mesh(new THREE.PlaneGeometry(5.25, 2.75, 18, 12), materials.water), pool, "pool-water-surface");
  water.rotation.x = -Math.PI / 2;
  water.position.set(8.3, 1.035, 4.75);
  water.castShadow = false;
  water.receiveShadow = true;
  pool.add(water);
  water.userData.isWater = true;
  for (const [name, size, position] of [
    ["pool-coping-front", [6.6, 0.16, 0.28], [8.3, 1.13, 6.76]],
    ["pool-coping-back", [6.6, 0.16, 0.28], [8.3, 1.13, 2.74]],
    ["pool-coping-left", [0.28, 0.16, 4.2], [5.15, 1.13, 4.75]],
    ["pool-coping-right", [0.28, 0.16, 4.2], [11.45, 1.13, 4.75]],
  ] as Array<[string, [number, number, number], [number, number, number]]>) {
    box(pool, name, size, position, materials.concreteLight);
  }
  for (const [index, width, y, z] of [[0, 1.65, 0.94, 7.45], [1, 1.35, 1.04, 7.12], [2, 1.05, 1.12, 6.84]] as Array<[number, number, number, number]>) {
    box(pool, `pool-entry-step-${index}`, [width, 0.12, 0.45], [11.05, y, z], materials.concreteLight, [0, 0, 0], 0.02);
  }

  const furniture = part(root, parts, "terrace-furniture", new THREE.Vector3(9.5, 1.5, 5.8));
  [[10.45, 7.55], [8.85, 7.55], [7.25, 7.55], [11.85, 2.1], [11.85, 3.6]].forEach(([x, z], index) => {
    box(furniture, `lounger-seat-${index}`, [0.75, 0.18, 1.55], [x, 1.25, z], materials.concreteLight, [-0.08, 0, 0], 0.04);
    box(furniture, `lounger-back-${index}`, [0.75, 0.16, 1.05], [x, 1.63, z - 0.9], materials.concreteLight, [-0.72, 0, 0], 0.04);
    box(furniture, `lounger-frame-${index}`, [0.62, 0.12, 1.7], [x, 1.08, z], materials.charcoalDeep);
  });

  [[5.0, 6.8], [6.35, 1.3]].forEach(([x, z], index) => {
    cylinder(furniture, `umbrella-pole-${index}`, 0.055, 0.055, 2.1, [x, 2.0, z], materials.charcoalDeep, 8);
    const canopy = tagMesh(
      new THREE.Mesh(new THREE.ConeGeometry(1.2, 0.32, 10, 1, true), materials.concreteLight),
      furniture,
      `umbrella-canopy-${index}`,
    );
    canopy.position.set(x, 3.05, z);
    furniture.add(canopy);
    cylinder(furniture, `umbrella-table-${index}`, 0.48, 0.48, 0.12, [x, 1.45, z], materials.deck, 10);
  });

  [[4.35, 2.0], [5.75, 2.0], [4.35, 4.15]].forEach(([x, z], index) => {
    cylinder(furniture, `cafe-table-${index}`, 0.48, 0.48, 0.1, [x, 1.45, z], materials.deck, 8);
    cylinder(furniture, `cafe-table-leg-${index}`, 0.07, 0.07, 0.65, [x, 1.1, z], materials.charcoalDeep, 8);
    for (const side of [-1, 1]) {
      box(furniture, `cafe-chair-${index}-${side}`, [0.52, 0.12, 0.52], [x + side * 0.82, 1.18, z], materials.deck, [0, 0, 0], 0.035);
      box(furniture, `cafe-chair-back-${index}-${side}`, [0.52, 0.72, 0.1], [x + side * 0.82, 1.55, z + side * 0.22], materials.deck, [0, 0, 0], 0.035);
    }
  });
}

function addHedge(parent: THREE.Group, materials: HotelMaterials, name: string, x: number, z: number, width: number, depth: number) {
  box(parent, `${name}-bed`, [width + 0.34, 0.24, depth + 0.34], [x, 0.94, z], materials.charcoalDeep, [0, 0, 0], 0.05);
  const count = Math.max(1, Math.floor(width / 0.8));
  for (let index = 0; index < count; index += 1) {
    const px = x - width / 2 + (index + 0.5) * width / count;
    box(parent, `${name}-hedge-${index}`, [width / count + 0.04, 0.58, depth], [px, 1.28, z], index % 3 === 0 ? materials.hedgeLight : materials.hedge, [0, 0, 0], 0.08);
  }
}

function addConifer(parent: THREE.Group, materials: HotelMaterials, name: string, x: number, z: number, scale: number) {
  cylinder(parent, `${name}-trunk`, 0.11 * scale, 0.16 * scale, 1.4 * scale, [x, 1.42 * scale, z], materials.trunk, 6);
  for (let index = 0; index < 3; index += 1) {
    const crown = tagMesh(
      new THREE.Mesh(new THREE.ConeGeometry((0.95 - index * 0.17) * scale, 1.8 * scale, 7), index === 1 ? materials.hedgeLight : materials.hedge),
      parent,
      `${name}-crown-${index}`,
    );
    crown.position.set(x, (2.05 + index * 0.75) * scale, z);
    parent.add(crown);
  }
}

function addDeciduous(parent: THREE.Group, materials: HotelMaterials, name: string, x: number, z: number, scale: number, seed: number) {
  const random = seeded(seed);
  cylinder(parent, `${name}-trunk`, 0.23 * scale, 0.33 * scale, 3.0 * scale, [x, 2.15 * scale, z], materials.trunk, 7);
  for (let index = 0; index < 3; index += 1) {
    const angle = (index / 3) * Math.PI * 2 + 0.4;
    const branch = cylinder(parent, `${name}-branch-${index}`, 0.1 * scale, 0.16 * scale, 1.7 * scale, [x + Math.cos(angle) * 0.45 * scale, 3.6 * scale, z + Math.sin(angle) * 0.45 * scale], materials.trunk, 6);
    branch.rotation.z = Math.cos(angle) * 0.52;
    branch.rotation.x = Math.sin(angle) * 0.52;
  }
  const clusters = [
    [0, 4.5, 0, 1.35],
    [-0.95, 3.9, 0.18, 0.9],
    [0.95, 3.95, -0.1, 0.92],
    [0.2, 4.55, 0.9, 0.82],
  ];
  clusters.forEach(([dx, dy, dz, radius], index) => {
    const crown = tagMesh(
      new THREE.Mesh(new THREE.IcosahedronGeometry(radius * scale, 1), index % 2 ? materials.hedgeLight : materials.hedge),
      parent,
      `${name}-canopy-${index}`,
    );
    crown.position.set(x + dx * scale, dy * scale, z + dz * scale);
    crown.rotation.set(random(), random(), random());
    crown.scale.set(1 + random() * 0.12, 0.95 + random() * 0.2, 0.9 + random() * 0.15);
    parent.add(crown);
  });
}

function addLandscape(root: THREE.Group, parts: Map<string, THREE.Group>, materials: HotelMaterials) {
  const landscape = part(root, parts, "landscape", new THREE.Vector3(0, 2.5, 0));
  box(landscape, "rear-grass-strip", [25.8, 0.22, 2.0], [0, 0.82, -9.3], materials.grass);
  box(landscape, "west-grass-strip", [2.0, 0.22, 17.0], [-12.0, 0.82, -0.8], materials.grass);
  box(landscape, "east-grass-strip", [2.0, 0.22, 17.0], [12.0, 0.82, -0.8], materials.grass);
  addHedge(landscape, materials, "pool-east-hedge", 12.0, 3.5, 1.1, 8.2);
  addHedge(landscape, materials, "pool-rear-hedge", 8.0, -0.55, 7.4, 0.9);
  addHedge(landscape, materials, "pool-front-hedge", 8.25, 8.02, 7.6, 0.78);
  addHedge(landscape, materials, "entry-planter", -5.1, 1.45, 5.5, 0.8);
  addHedge(landscape, materials, "arrival-island", -0.6, 6.92, 2.3, 1.05);
  addHedge(landscape, materials, "front-planter", -9.35, 10.35, 2.8, 0.72);
  addHedge(landscape, materials, "sign-planter", -10.5, 8.45, 4.5, 0.9);
  addDeciduous(landscape, materials, "west-tree", -10.8, -2.0, 1.12, 20);
  addDeciduous(landscape, materials, "east-tree", 11.0, -5.8, 0.98, 41);
  addDeciduous(landscape, materials, "pool-corner-tree", 11.4, 7.2, 0.72, 99);
  addConifer(landscape, materials, "rear-east-conifer", 9.7, -8.3, 1.18);
  addConifer(landscape, materials, "west-conifer-a", -11.4, 3.0, 0.72);
  addConifer(landscape, materials, "west-conifer-b", -9.6, 4.5, 0.62);
  addConifer(landscape, materials, "entry-conifer", -0.2, 7.1, 0.58);
  addConifer(landscape, materials, "pool-conifer", 3.65, 7.6, 0.46);
}

function addCar(
  parent: THREE.Group,
  materials: HotelMaterials,
  name: string,
  x: number,
  z: number,
  color: number,
  rotationY: number,
) {
  const group = new THREE.Group();
  group.name = name;
  group.userData.partId = parent.userData.partId;
  group.position.set(x, 0.93, z);
  group.rotation.y = rotationY;
  parent.add(group);
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.2 });
  box(group, `${name}-body`, [2.35, 0.52, 1.12], [0, 0.32, 0], paint, [0, 0, 0], 0.14);
  box(group, `${name}-cabin`, [1.35, 0.56, 0.98], [-0.12, 0.77, 0], materials.darkGlass, [0, 0, 0], 0.12);
  box(group, `${name}-front-window`, [0.1, 0.4, 0.78], [0.6, 0.77, 0], materials.darkGlass, [0, 0, -0.14]);
  for (const dx of [-0.75, 0.72]) {
    for (const dz of [-0.57, 0.57]) {
      const wheel = tagMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.15, 10), materials.charcoalDeep), group, `${name}-wheel-${dx}-${dz}`);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(dx, 0.16, dz);
      group.add(wheel);
    }
  }
  box(group, `${name}-headlight-l`, [0.09, 0.16, 0.2], [1.19, 0.35, -0.35], materials.lamp);
  box(group, `${name}-headlight-r`, [0.09, 0.16, 0.2], [1.19, 0.35, 0.35], materials.lamp);
}

function addParking(root: THREE.Group, parts: Map<string, THREE.Group>, materials: HotelMaterials) {
  const parking = part(root, parts, "parking-system", new THREE.Vector3(-2.5, 1.2, 8.2));
  addCar(parking, materials, "silver-car", -1.6, 10.15, 0xc7c8c9, -Math.PI / 2);
  addCar(parking, materials, "charcoal-car", 5.7, 10.25, 0x252932, -Math.PI / 2);
}

function addWarmLights(root: THREE.Group, parts: Map<string, THREE.Group>, materials: HotelMaterials) {
  const lights = part(root, parts, "lighting-system", new THREE.Vector3(0, 3, 2));
  // A single interior lobby pool gives the entrance depth. Exterior fixtures are
  // visible emissive bulbs, avoiding the artificial wall hotspots from broad
  // point-light washes.
  addFixtureLight(lights, "lobby-warm", [-2.4, 3.0, 3.4], 22, 8, 0.08);
  box(lights, "lobby-light-marker", [0.02, 0.02, 0.02], [0, -10, 0], materials.lamp);
}

export function createLuxoraHotelModel() {
  const materials = makeMaterials();
  const root = new THREE.Group();
  root.name = "luxora-hotel-root";
  const parts = new Map<string, THREE.Group>();
  const roomLights = new Map<string, RoomLightEntry>();
  const sidePassageGlasses: THREE.MeshPhysicalMaterial[] = [];

  addSite(root, parts, materials);
  addHotelTower(root, parts, materials, roomLights, sidePassageGlasses);
  addRearFacade(root, parts, materials, roomLights);
  addWrappedSideWindows(parts, materials, roomLights);
  addEntrance(root, parts, materials);
  addPool(root, parts, materials);
  addLandscape(root, parts, materials);
  addParking(root, parts, materials);
  addWarmLights(root, parts, materials);

  const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    originalMaterials.set(object, object.material);
    object.geometry.computeBoundingSphere();
  });

  const fixtureLights: THREE.PointLight[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.PointLight) fixtureLights.push(object);
  });

  let currentLightingProfile = getHotelLightingProfile(12);
  const applyGlassLighting = (glass: THREE.MeshPhysicalMaterial, enabled: boolean, profile: HotelLightingProfile) => {
    const daylightPresence = profile.daylight * 0.3 + profile.twilight * 0.16;
    const roomPresence = (enabled ? 1 : 0) * Math.max(daylightPresence, profile.night);
    glass.emissiveIntensity = THREE.MathUtils.lerp(0.008, 0.74, roomPresence);
    glass.color.lerpColors(new THREE.Color(0x4a4038), new THREE.Color(0xe0a04e), roomPresence);
    glass.opacity = THREE.MathUtils.lerp(0.22, 0.72, roomPresence);
  };
  const applyRoomLight = (room: RoomLightEntry, profile: HotelLightingProfile) => {
    // A switched-on room still has a perceptible warm interior in daylight. The
    // effect is deliberately weaker than at night, but it must not disappear
    // entirely behind the scene's daylight exposure.
    const enabled = room.enabled ? 1 : 0;
    const daylightPresence = profile.daylight * 0.3 + profile.twilight * 0.16;
    const roomPresence = enabled * Math.max(daylightPresence, profile.night);
    room.glow.emissiveIntensity = THREE.MathUtils.lerp(0.006, 0.78, roomPresence);
    room.glow.color.lerpColors(new THREE.Color(0x443a32), new THREE.Color(0xd99b4f), roomPresence);
    applyGlassLighting(room.glass, Boolean(enabled), profile);
    room.bulbs.forEach((bulb) => {
      bulb.emissiveIntensity = THREE.MathUtils.lerp(0.002, 2.4, roomPresence);
      bulb.color.lerpColors(new THREE.Color(0x28221c), new THREE.Color(0xffb85c), roomPresence);
    });
  };

  const setLighting = (profile: HotelLightingProfile) => {
    currentLightingProfile = profile;
    const nightBlend = profile.night;
    materials.lamp.emissiveIntensity = THREE.MathUtils.lerp(0.08, 2.4, nightBlend);
    materials.gold.emissiveIntensity = THREE.MathUtils.lerp(0.8, 2.7, nightBlend);
    materials.interiorGlow.emissiveIntensity = THREE.MathUtils.lerp(0.08, 0.72, nightBlend);
    materials.interiorGlow.color.lerpColors(new THREE.Color(0xb7ada1), new THREE.Color(0xd99b4f), nightBlend);
    materials.warmGlass.emissiveIntensity = THREE.MathUtils.lerp(0.1, 0.7, nightBlend);
    materials.warmGlass.opacity = THREE.MathUtils.lerp(0.38, 0.72, nightBlend);
    fixtureLights.forEach((light) => {
      const dayIntensity = Number(light.userData.dayIntensity ?? 0);
      const nightIntensity = Number(light.userData.nightIntensity ?? 0);
      const twilightBoost = Number(light.userData.twilightBoost ?? 0);
      light.intensity = dayIntensity * profile.daylight + nightIntensity * nightBlend + twilightBoost * profile.twilight;
    });
    roomLights.forEach((room) => applyRoomLight(room, profile));
    const passageEnabled = Array.from(roomLights.values()).some((room) => room.enabled);
    sidePassageGlasses.forEach((glass) => applyGlassLighting(glass, passageEnabled, profile));
    root.userData.lightingProfile = { ...profile };
  };

  const runtime: HotelRuntime = {
    parts,
    setExplode(amount: number) {
      const clamped = THREE.MathUtils.clamp(amount, 0, 1);
      parts.forEach((group) => {
        const base = group.userData.basePosition as THREE.Vector3;
        const center = group.userData.explodeCenter as THREE.Vector3;
        group.position.copy(base).addScaledVector(center, clamped * 0.18);
      });
    },
    setLighting,
    getRoomLights() {
      return Array.from(roomLights.values())
        .sort((a, b) => a.floor - b.floor || a.elevation.localeCompare(b.elevation) || a.label.localeCompare(b.label))
        .map(({ id, label, floor, elevation, enabled }) => ({ id, label, floor, elevation, enabled }));
    },
    setRoomLight(roomId, enabled) {
      const room = roomLights.get(roomId);
      if (!room) return;
      room.enabled = enabled;
      applyRoomLight(room, currentLightingProfile);
    },
    setAllRoomLights(enabled) {
      roomLights.forEach((room) => {
        room.enabled = enabled;
        applyRoomLight(room, currentLightingProfile);
      });
    },
    resetMaterials() {
      originalMaterials.forEach((material, mesh) => { mesh.material = material; });
    },
  };

  setLighting(getHotelLightingProfile(12));
  root.userData.sculptRuntime = runtime;
  root.userData.approximation = "Stylized low-poly reconstruction with front and rear reference views; interior layouts remain inferred.";
  root.userData.sourceComponentIds = Array.from(parts.keys());
  return root;
}
