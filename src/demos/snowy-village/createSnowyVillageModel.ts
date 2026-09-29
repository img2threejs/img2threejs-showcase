import * as THREE from 'three';
import { createSnowyVillageFireVfx, type SnowyVillageFireVfx } from './snowyVillageFireVfx';
import { createSnowyVillageSmokeVfx, type SnowyVillageSmokeVfx } from './snowyVillageSmokeVfx';
import { createSnowyVillageSnowfallVfx, type SnowyVillageSnowfallVfx } from './snowyVillageSnowfallVfx';
import { createNativeAnimationClips, createNativeModel, type NativeModel } from './native/constructors';
import { prewarmNativeCore, preloadNativeCampfire, type NativeCoreRole, type PreparedNativeRole } from './native/prewarm';

interface AnimationChoice {
  id: string;
  label: string;
  loop: boolean;
}
interface GatePassageMeasurement {
  worldToLocal: THREE.Matrix4;
  frameBounds: THREE.Box3;
  lowPivot: THREE.Group;
  highPivot: THREE.Group;
  lowHingeX: number;
  highHingeX: number;
  lowLeafSpan: number;
  highLeafSpan: number;
  halfExtents: THREE.Vector3;
  clearance: number;
}

const ACTIONS: readonly AnimationChoice[] = [
  { id: 'idle', label: 'Idle', loop: true },
  { id: 'walk', label: 'Walk', loop: true },
  { id: 'run', label: 'Run', loop: true },
  { id: 'boxing', label: 'Boxing', loop: false },
];

const ACTION_BY_ID: Record<string, AnimationChoice> = {
  idle: ACTIONS[0],
  walk: ACTIONS[1],
  run: ACTIONS[2],
  boxing: ACTIONS[3],
};

const GAME_KEY_CODES: Record<string, true> = {
  KeyW: true,
  KeyA: true,
  KeyS: true,
  KeyD: true,
  ShiftLeft: true,
  ShiftRight: true,
  Space: true,
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  KeyE: true,
  KeyM: true,
  KeyF: true,
  Digit1: true,
  Digit2: true,
  Digit3: true,
};
const SNOWY_VILLAGE_CHARACTER_HEIGHT = 1.15;
const SNOW_GROUND_SIZE = 300;
const SNOW_GROUND_SEGMENTS = 384;
type CoreAssets = Readonly<Record<NativeCoreRole, PreparedNativeRole>>;
let coreAssetsPromise: Promise<CoreAssets> | undefined;
const pendingSceneMounts = new Set<Promise<void>>();

/** Await the shared native data load and any scene mount already requested by the viewer. */
export function prewarmSnowyVillage(): Promise<void> {
  coreAssetsPromise ??= prewarmNativeCore();
  const mounts = [...pendingSceneMounts];
  return Promise.all([coreAssetsPromise, ...mounts]).then(() => undefined);
}

function setShadowFlags(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
}
function placeSnowProp(
  root: THREE.Group,
  model: THREE.Object3D,
  name: string,
  x: number,
  y: number,
  z: number,
): THREE.Group {
  const placement = new THREE.Group();
  placement.name = name;
  placement.position.set(x, y, z);
  placement.add(model);
  root.add(placement);
  return placement;
}

function normalizeToHeight(model: THREE.Object3D, targetHeight: number, yaw = 0): THREE.Vector3 {
  model.rotation.y += yaw;
  model.updateMatrixWorld(true);
  const initial = new THREE.Box3().setFromObject(model);
  model.scale.multiplyScalar(targetHeight / Math.max(initial.getSize(new THREE.Vector3()).y, 0.001));
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.y -= bounds.min.y;
  model.position.z -= center.z;
  model.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
}

function removeBlackArmArtifact(model: THREE.Object3D): number {
  let removed = 0;
  model.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    const geometry = object.geometry;
    const index = geometry.index;
    const position = geometry.getAttribute('position');
    const skinIndex = geometry.getAttribute('skinIndex');
    const skinWeight = geometry.getAttribute('skinWeight');
    const neutral = object.skeleton.bones.findIndex((bone) => bone.name === 'neutral_bone');
    const hand = object.skeleton.bones.findIndex((bone) => bone.name === 'R_Hand');
    if (!index || !position || !skinIndex || !skinWeight || geometry.groups.length || neutral < 0 || hand < 0) return;
    const weight = (vertex: number, bone: number): number => {
      let sum = 0;
      for (let slot = 0; slot < 4; slot += 1) if (skinIndex.getComponent(vertex, slot) === bone) sum += skinWeight.getComponent(vertex, slot);
      return sum;
    };
    const keep: number[] = [];
    for (let offset = 0; offset + 2 < index.count; offset += 3) {
      const a = index.getX(offset), b = index.getX(offset + 1), c = index.getX(offset + 2);
      const centerX = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
      const centerY = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
      const centerZ = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
      const artifact = [a, b, c].some((vertex) => weight(vertex, neutral) >= 0.99)
        && [a, b, c].some((vertex) => weight(vertex, hand) >= 0.5)
        && centerX >= -0.03 && centerX <= 0.07 && centerY >= 0.57 && centerY <= 0.64 && centerZ >= 0.28 && centerZ <= 0.36;
      if (artifact) removed += 1; else keep.push(a, b, c);
    }
    geometry.setIndex(keep);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  });
  if (removed !== 9) throw new Error('Expected 9 stray right-arm triangles, removed ' + removed);
  return removed;
}

const GATE_LEAF_PARTS = new Set(['hyper3d_part_19','hyper3d_part_23','hyper3d_part_27','hyper3d_part_43','hyper3d_part_50','hyper3d_part_124','hyper3d_part_171','hyper3d_part_188','hyper3d_part_189','hyper3d_part_190','hyper3d_part_191','hyper3d_part_192','hyper3d_part_193','hyper3d_part_194','hyper3d_part_195','hyper3d_part_196','hyper3d_part_200','hyper3d_part_201','hyper3d_part_219','hyper3d_part_224','hyper3d_part_235']);

function sourceNode(model: NativeModel, asset: PreparedNativeRole, name: string): THREE.Object3D {
  const node = asset.asset.effective.nodes.find((entry) => entry.name === name);
  const object = node ? model.objects.get(node.sourceIndex as number) : undefined;
  if (!object) throw new Error('Native gate is missing node ' + name);
  return object;
}

function findFirstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let result: THREE.Mesh | null = null;
  root.traverse((object) => { if (!result && object instanceof THREE.Mesh) result = object; });
  return result;
}

function createSnowGround(root: THREE.Group): void {
  const noiseHash = (x: number, z: number): number => {
    const value = Math.sin(x * 127.1 + z * 311.7 + 19.19) * 43758.5453123;
    return value - Math.floor(value);
  };
  const smoothNoise = (value: number): number => value * value * (3 - 2 * value);
  const valueNoise = (x: number, z: number, cellSize: number): number => {
    const gx = x / cellSize;
    const gz = z / cellSize;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const tx = smoothNoise(gx - x0);
    const tz = smoothNoise(gz - z0);
    const top = noiseHash(x0, z0) + (noiseHash(x0 + 1, z0) - noiseHash(x0, z0)) * tx;
    const bottom = noiseHash(x0, z0 + 1) + (noiseHash(x0 + 1, z0 + 1) - noiseHash(x0, z0 + 1)) * tx;
    return top + (bottom - top) * tz;
  };
  const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

  const textureSize = 512;
  const groundSize = SNOW_GROUND_SIZE;
  const colorCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  const roughnessCanvas = document.createElement('canvas');
  colorCanvas.width = textureSize;
  colorCanvas.height = textureSize;
  bumpCanvas.width = textureSize;
  bumpCanvas.height = textureSize;
  roughnessCanvas.width = textureSize;
  roughnessCanvas.height = textureSize;
  const colorContext = colorCanvas.getContext('2d');
  const bumpContext = bumpCanvas.getContext('2d');
  const roughnessContext = roughnessCanvas.getContext('2d');
  if (colorContext && bumpContext && roughnessContext) {
    const colorImage = colorContext.createImageData(textureSize, textureSize);
    const bumpImage = bumpContext.createImageData(textureSize, textureSize);
    const roughnessImage = roughnessContext.createImageData(textureSize, textureSize);
    for (let y = 0; y < textureSize; y += 1) {
      for (let x = 0; x < textureSize; x += 1) {
        const worldX = (x / (textureSize - 1)) * groundSize - groundSize / 2;
        const worldZ = (y / (textureSize - 1)) * groundSize - groundSize / 2;
        const broad = valueNoise(worldX, worldZ, 5.5);
        const medium = valueNoise(worldX + 8.1, worldZ - 5.4, 1.6);
        const fine = valueNoise(worldX - 2.7, worldZ + 9.3, 0.38);
        const shade = (broad - 0.5) * 42 + (medium - 0.5) * 18 + (fine - 0.5) * 6;
        const coolShadow = Math.max(0, 0.5 - broad);
        const offset = (y * textureSize + x) * 4;
        colorImage.data[offset] = clampByte(235 + shade - coolShadow * 14);
        colorImage.data[offset + 1] = clampByte(236 + shade - coolShadow * 8);
        colorImage.data[offset + 2] = clampByte(248 + shade + coolShadow * 12);
        colorImage.data[offset + 3] = 255;
        const bump = clampByte(128 + (broad - 0.5) * 18 + (medium - 0.5) * 42 + (fine - 0.5) * 24);
        bumpImage.data[offset] = bump;
        bumpImage.data[offset + 1] = bump;
        bumpImage.data[offset + 2] = bump;
        bumpImage.data[offset + 3] = 255;
        const roughness = clampByte((0.94 + medium * 0.045 + fine * 0.015) * 255);
        roughnessImage.data[offset] = roughness;
        roughnessImage.data[offset + 1] = roughness;
        roughnessImage.data[offset + 2] = roughness;
        roughnessImage.data[offset + 3] = 255;
      }
    }
    colorContext.putImageData(colorImage, 0, 0);
    bumpContext.putImageData(bumpImage, 0, 0);
    roughnessContext.putImageData(roughnessImage, 0, 0);
  }

  const colorMap = new THREE.CanvasTexture(colorCanvas);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.colorSpace = THREE.NoColorSpace;
  const roughnessMap = new THREE.CanvasTexture(roughnessCanvas);
  roughnessMap.colorSpace = THREE.NoColorSpace;

  const smoothStep = (edge0: number, edge1: number, value: number): number => {
    const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const groundGeometry = new THREE.PlaneGeometry(groundSize, groundSize, SNOW_GROUND_SEGMENTS, SNOW_GROUND_SEGMENTS);
  const terrain = groundGeometry.getAttribute('position') as THREE.BufferAttribute;
  for (let index = 0; index < terrain.count; index += 1) {
    const x = terrain.getX(index);
    const z = -terrain.getY(index);
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const snowWeight = smoothStep(6.3, 11.5, edge);
    const edgeBlend = smoothStep(22, 30, edge);
    const edgeFade = 1 - edgeBlend;
    const broad = valueNoise(x, z, 5.2);
    const medium = valueNoise(x + 3.7, z - 5.6, 1.8);
    const fine = valueNoise(x - 4.3, z + 8.2, 0.8);
    const rolling = (broad - 0.5) * 0.24 + (medium - 0.5) * 0.08 + (fine - 0.5) * 0.025;
    const distant = valueNoise(x + 17.3, z - 11.7, 13);
    const distantSecondary = valueNoise(x - 13.1, z + 4.6, 8.5);
    const broadDrift = (distant - 0.5) * 0.66 + (distantSecondary - 0.5) * 0.24;
    const outerSnow = snowWeight * Math.max(0.04, 0.2 + broadDrift + rolling) * edgeFade;
    const boundaryDrop = 0.14 * edgeBlend;
    terrain.setZ(index, 0.025 + outerSnow - boundaryDrop);
  }
  terrain.needsUpdate = true;
  groundGeometry.computeVertexNormals();
  groundGeometry.computeBoundingBox();
  groundGeometry.computeBoundingSphere();

  const ground = new THREE.Mesh(
    groundGeometry,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: colorMap,
      bumpMap,
      bumpScale: 0.055,
      roughnessMap,
      roughness: 0.98,
      metalness: 0,
    }),
  );
  ground.name = 'continuous sculpted snow blanket';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.025;
  ground.receiveShadow = true;
  root.add(ground);

  const farGround = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 320),
    new THREE.MeshStandardMaterial({ color: 0xf1f0f8, roughness: 1, metalness: 0 }),
  );
  farGround.name = 'fog-blended distant snowfield';
  farGround.rotation.x = -Math.PI / 2;
  farGround.position.y = -0.16;
  farGround.receiveShadow = false;
  root.add(farGround);

  const driftSegments = 40;
  const driftRings = [
    { radius: 0.24, height: 0.34 },
    { radius: 0.46, height: 0.32 },
    { radius: 0.68, height: 0.25 },
    { radius: 0.84, height: 0.17 },
    { radius: 0.94, height: 0.095 },
    { radius: 1, height: 0.035 },
    { radius: 1, height: -0.085 },
  ];
  const driftPositions = [0, 0.34, 0];
  const driftUvs = [0.5, 0.5];
  for (const [ringIndex, ring] of driftRings.entries()) {
    for (let segment = 0; segment < driftSegments; segment += 1) {
      const angle = (segment / driftSegments) * Math.PI * 2;
      const edgeScale = 1 + Math.sin(angle * 3 + ringIndex * 0.17) * 0.08
        + Math.sin(angle * 7 + 1.1) * 0.045
        + Math.sin(angle * 11 - 0.6) * 0.018;
      const x = Math.cos(angle) * ring.radius * edgeScale;
      const z = Math.sin(angle) * ring.radius * edgeScale;
      const y = ring.height + Math.sin(angle * 5 - 0.7) * ring.radius * 0.015;
      driftPositions.push(x, y, z);
      driftUvs.push(0.5 + x * 0.5, 0.5 + z * 0.5);
    }
  }
  const driftIndices: number[] = [];
  for (let segment = 0; segment < driftSegments; segment += 1) {
    const next = (segment + 1) % driftSegments;
    driftIndices.push(0, 1 + next, 1 + segment);
  }
  for (let ringIndex = 0; ringIndex < driftRings.length - 1; ringIndex += 1) {
    const inner = 1 + ringIndex * driftSegments;
    const outer = inner + driftSegments;
    for (let segment = 0; segment < driftSegments; segment += 1) {
      const next = (segment + 1) % driftSegments;
      const a = inner + segment;
      const b = inner + next;
      const c = outer + segment;
      const d = outer + next;
      driftIndices.push(a, b, c, b, d, c);
    }
  }
  const driftGeometry = new THREE.BufferGeometry();
  driftGeometry.setAttribute('position', new THREE.Float32BufferAttribute(driftPositions, 3));
  driftGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(driftUvs, 2));
  driftGeometry.setIndex(driftIndices);
  driftGeometry.computeVertexNormals();
  driftGeometry.computeBoundingBox();
  driftGeometry.computeBoundingSphere();

  const driftMaterial = new THREE.MeshStandardMaterial({ color: 0xd2daf0, roughness: 0.99, metalness: 0 });
  const driftTransforms: Array<[number, number, number, number, number, number, number]> = [
    [-8.4, 0, -8.4, 1.55, 1.45, 1.55, -0.2],
    [8.4, 0, -8.4, 1.55, 1.45, 1.55, 0.35],
    [8.4, 0, 8.4, 1.55, 1.45, 1.55, -0.45],
    [-8.4, 0, 8.4, 1.55, 1.45, 1.55, 0.18],
  ];
  const drifts = new THREE.InstancedMesh(driftGeometry, driftMaterial, driftTransforms.length);
  const transform = new THREE.Object3D();
  for (let index = 0; index < driftTransforms.length; index += 1) {
    const [x, y, z, sx, sy, sz, yaw] = driftTransforms[index];
    transform.position.set(x, y, z);
    transform.rotation.set(0, yaw, 0);
    transform.scale.set(sx, sy, sz);
    transform.updateMatrix();
    drifts.setMatrixAt(index, transform.matrix);
  }
  drifts.name = 'thick irregular snow drifts';
  drifts.castShadow = true;
  drifts.receiveShadow = true;
  drifts.instanceMatrix.needsUpdate = true;

  const capCount = 4;
  const driftCaps = new THREE.InstancedMesh(
    driftGeometry,
    new THREE.MeshStandardMaterial({ color: 0xf8f7ff, roughness: 1, metalness: 0 }),
    capCount,
  );
  for (let index = 0; index < capCount; index += 1) {
    const [x, y, z, sx, sy, sz, yaw] = driftTransforms[index];
    transform.position.set(x + sx * 0.14, y + 0.28, z - sz * 0.12);
    transform.rotation.set(0, yaw + 0.55, 0);
    transform.scale.set(sx * 0.52, sy * 0.72, sz * 0.56);
    transform.updateMatrix();
    driftCaps.setMatrixAt(index, transform.matrix);
  }
  driftCaps.name = 'upper snow drift layers';
  driftCaps.castShadow = true;
  driftCaps.receiveShadow = true;
  driftCaps.instanceMatrix.needsUpdate = true;
  root.add(drifts, driftCaps);

}
function createFootprintGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.17);
  shape.quadraticCurveTo(-0.075, -0.16, -0.078, -0.07);
  shape.lineTo(-0.09, 0.065);
  shape.quadraticCurveTo(-0.095, 0.15, -0.045, 0.19);
  shape.quadraticCurveTo(0, 0.225, 0.045, 0.19);
  shape.quadraticCurveTo(0.095, 0.15, 0.09, 0.065);
  shape.lineTo(0.078, -0.07);
  shape.quadraticCurveTo(0.075, -0.16, 0, -0.17);
  const outline = shape.extractPoints(12).shape;
  if (outline.length > 1 && outline[0].distanceToSquared(outline[outline.length - 1]) < 1e-10) {
    outline.pop();
  }
  const signedArea = outline.reduce((area, point, index) => {
    const next = outline[(index + 1) % outline.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0);
  const layers = [
    { scale: 0.28, height: -0.013 },
    { scale: 0.55, height: -0.009 },
    { scale: 0.82, height: -0.002 },
    { scale: 1, height: 0.008 },
    { scale: 1.14, height: 0.015 },
  ];
  const positions = [0, -0.014, 0];
  for (const layer of layers) {
    for (const point of outline) positions.push(point.x * layer.scale, layer.height, point.y * layer.scale);
  }
  const indices: number[] = [];
  const pointCount = outline.length;
  const firstRing = 1;
  for (let point = 0; point < pointCount; point += 1) {
    const next = (point + 1) % pointCount;
    if (signedArea > 0) indices.push(0, firstRing + next, firstRing + point);
    else indices.push(0, firstRing + point, firstRing + next);
  }
  for (let layer = 0; layer < layers.length - 1; layer += 1) {
    const inner = firstRing + layer * pointCount;
    const outer = inner + pointCount;
    for (let point = 0; point < pointCount; point += 1) {
      const next = (point + 1) % pointCount;
      const a = inner + point;
      const b = inner + next;
      const c = outer + point;
      const d = outer + next;
      if (signedArea > 0) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
export interface SnowyVillageTimeOfDayController {
  readonly currentTime: number;
  readonly targetTime: number;
  setTime(time: number): void;
}

export interface SnowyVillageCampfireState {
  readonly assetStatus: 'loading' | 'ready' | 'unavailable';
  readonly available: boolean;
  readonly active: boolean;
  readonly message: string;
  readonly error?: unknown;
}

export interface SnowyVillageCampfireController {
  readonly state: SnowyVillageCampfireState;
  cast(): boolean;
  subscribe(listener: (state: SnowyVillageCampfireState) => void): () => void;
}

type SnowyVillageInnerGlow = THREE.Sprite | THREE.Mesh;

interface SnowyVillageEmitter {
  light: THREE.PointLight;
  intensity: number;
  glow: THREE.Sprite;
  glowOpacity: number;
  innerGlow: SnowyVillageInnerGlow | null;
  innerGlowOpacity: number;
}

interface SnowyVillageLightingController {
  time: number;
  targetTime: number;
  hemisphere: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  emitters: SnowyVillageEmitter[];
  background: THREE.CanvasTexture | null;
  fog: THREE.Fog | null;
  setTime(time: number): void;
  registerEmitter(
    light: THREE.PointLight,
    intensity: number,
    glow: THREE.Sprite,
    glowOpacity: number,
    innerGlow: SnowyVillageInnerGlow | null,
    innerGlowOpacity: number,
  ): void;
  tick(delta: number): void;
}

const NIGHT_SKY = new THREE.Color(0x0a1020);
const DUSK_SKY = new THREE.Color(0xbfc3e1);
const DAY_SKY = new THREE.Color(0xcbd9e8);
const NIGHT_GROUND = new THREE.Color(0x0c131f);
const DUSK_GROUND = new THREE.Color(0xddd5e7);
const DAY_GROUND = new THREE.Color(0xc8d2df);
const NIGHT_BACKGROUND = [new THREE.Color(0x0e1727), new THREE.Color(0x05080f)];
const DUSK_BACKGROUND = [new THREE.Color(0xbfc3e1), new THREE.Color(0xa5b0ce)];
const DAY_BACKGROUND = [new THREE.Color(0xcbdcf0), new THREE.Color(0xa9bad0)];
function isCampfireNight(time: number): boolean {
  const hour = wrapDayTime(time);
  return hour >= 19 || hour < 5;
}
const SKY_COLOR = new THREE.Color();
const GROUND_COLOR = new THREE.Color();
const BACKGROUND_INNER = new THREE.Color();
const BACKGROUND_OUTER = new THREE.Color();
const SUN_WARM = new THREE.Color(0xffe5bd);
const SUN_DAY = new THREE.Color(0xffd796);
const SUN_DUSK = new THREE.Color(0xd8cfff);
const NIGHT_HEMISPHERE = 0.08;
const DUSK_HEMISPHERE = 0.35;
const DAY_HEMISPHERE = 0.62;

function wrapDayTime(time: number): number {
  return THREE.MathUtils.euclideanModulo(time, 24);
}
function lampFactorForTime(time: number): number {
  const hour = wrapDayTime(time);
  if (hour >= 19 || hour < 5) return 1;
  if (hour >= 18) return hour - 18;
  if (hour >= 5 && hour < 6) return 6 - hour;
  return 0;
}

function updateGradient(texture: THREE.CanvasTexture, inner: THREE.Color, outer: THREE.Color): void {
  const canvas = texture.image as HTMLCanvasElement;
  const context = canvas.getContext('2d');
  if (!context) return;
  const size = canvas.width;
  const gradient = context.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.5, size * 0.72);
  gradient.addColorStop(0, '#' + inner.getHexString());
  gradient.addColorStop(1, '#' + outer.getHexString());
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  texture.needsUpdate = true;
}

function createLampGlow(name: string, color: number, size: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,0.72)');
    gradient.addColorStop(0.18, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.14)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    color,
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = name;
  sprite.scale.set(size, size, 1);
  return sprite;
}
function createLampPaneGlow(name: string, color: number, width: number, height: number): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  const radial = createLampGlow(name + ' texture', color, Math.max(width, height));
  const spriteMaterial = radial.material;
  const material = new THREE.MeshBasicMaterial({
    color,
    map: spriteMaterial.map,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  spriteMaterial.dispose();
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  pane.name = name;
  pane.scale.set(width, height, 1);
  return pane;
}

function attachLampEmitter(
  parent: THREE.Object3D,
  lighting: SnowyVillageLightingController,
  name: string,
  position: THREE.Vector3,
  color: number,
  intensity: number,
  distance: number,
  glowSize: number,
  glowOpacity: number,
  innerGlowSize: number = 0,
  innerGlowOpacity: number = 0.9,
  innerGlowAspect: number = 0.65,
  innerGlowMode: 'sprite' | 'pane' = 'sprite',
  pointLightPosition?: THREE.Vector3,
): void {
  const light = new THREE.PointLight(color, intensity, distance, 2);
  light.name = name + ' light';
  light.position.copy(pointLightPosition ?? position);
  light.castShadow = false;
  parent.add(light);
  const glow = createLampGlow(name + ' radial glow', color, glowSize);
  glow.position.copy(position);
  glow.visible = glowOpacity > 0;
  parent.add(glow);
  const innerGlow: SnowyVillageInnerGlow | null = innerGlowSize > 0
    ? innerGlowMode === 'pane'
      ? createLampPaneGlow(name + ' inner pane VFX', color, innerGlowSize * innerGlowAspect, innerGlowSize)
      : createLampGlow(name + ' inner flame VFX', color, innerGlowSize)
    : null;
  if (innerGlow) {
    innerGlow.position.copy(position);
    if (innerGlow instanceof THREE.Sprite) {
      innerGlow.scale.set(innerGlowSize * innerGlowAspect, innerGlowSize, 1);
    } else {
      innerGlow.scale.set(innerGlowSize * innerGlowAspect, innerGlowSize, innerGlowSize * innerGlowAspect);
    }
    const innerMaterial = innerGlow.material as THREE.SpriteMaterial | THREE.MeshBasicMaterial;
    innerMaterial.depthTest = false;
    innerMaterial.toneMapped = false;
    innerMaterial.depthWrite = false;
    innerGlow.renderOrder = 1;
    parent.add(innerGlow);
  }
  lighting.registerEmitter(light, intensity, glow, glowOpacity, innerGlow, innerGlow ? innerGlowOpacity : 0);
}

function applySnowyVillageLighting(controller: SnowyVillageLightingController, time: number): void {
  const hour = wrapDayTime(time);
  const daylight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
  const twilight = Math.exp(-(Math.min(Math.abs(hour - 18), Math.abs(hour - 6)) ** 2) / 0.5);
  SKY_COLOR.copy(NIGHT_SKY).lerp(DAY_SKY, daylight).lerp(DUSK_SKY, twilight);
  GROUND_COLOR.copy(NIGHT_GROUND).lerp(DAY_GROUND, daylight).lerp(DUSK_GROUND, twilight);
  controller.hemisphere.color.copy(SKY_COLOR);
  controller.hemisphere.groundColor.copy(GROUND_COLOR);
  controller.hemisphere.intensity = THREE.MathUtils.lerp(NIGHT_HEMISPHERE, DAY_HEMISPHERE, daylight);
  controller.hemisphere.intensity = THREE.MathUtils.lerp(controller.hemisphere.intensity, DUSK_HEMISPHERE, twilight);
  controller.sun.intensity = THREE.MathUtils.lerp(0.015, 1.15, daylight);
  controller.sun.intensity = THREE.MathUtils.lerp(controller.sun.intensity, 0.18, twilight);
  controller.sun.castShadow = controller.sun.intensity > 0.05;
  controller.sun.color.copy(SUN_WARM).lerp(SUN_DAY, daylight).lerp(SUN_DUSK, twilight);
  controller.sun.position.set(-5 * Math.cos((hour / 24) * Math.PI * 2), 9, 6)
    .multiplyScalar(16)
    .add(controller.sun.target.position);
  const environment = THREE.MathUtils.lerp(0.03, 0.4, daylight);
  controller.sun.userData.environmentIntensity = THREE.MathUtils.lerp(environment, 0.1, twilight);
  const lampFactor = lampFactorForTime(hour);
  for (const emitter of controller.emitters) {
    emitter.light.intensity = emitter.intensity * lampFactor;
    (emitter.glow.material as THREE.SpriteMaterial).opacity = emitter.glowOpacity * lampFactor;
    if (emitter.innerGlow) {
      (emitter.innerGlow.material as THREE.SpriteMaterial | THREE.MeshBasicMaterial).opacity = emitter.innerGlowOpacity * lampFactor;
    }
  }
  if (controller.background) {
    BACKGROUND_INNER.copy(NIGHT_BACKGROUND[0]).lerp(DAY_BACKGROUND[0], daylight).lerp(DUSK_BACKGROUND[0], twilight);
    BACKGROUND_OUTER.copy(NIGHT_BACKGROUND[1]).lerp(DAY_BACKGROUND[1], daylight).lerp(DUSK_BACKGROUND[1], twilight);
    updateGradient(controller.background, BACKGROUND_INNER, BACKGROUND_OUTER);
    controller.fog?.color.copy(BACKGROUND_OUTER);
  }
}

export function installSnowyVillageLights(scene: THREE.Scene): void {
  const hemisphere = new THREE.HemisphereLight(0xbfc3e1, 0xddd5e7, DUSK_HEMISPHERE);
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight(0xffe5bd, 0.75);
  sun.position.set(-5, 9, 6);
  sun.castShadow = true;
  // A compact light-space volume keeps shadow texels dense and avoids a 320-unit shimmer grid.
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -16;
  sun.shadow.camera.right = 16;
  sun.shadow.camera.top = 16;
  sun.shadow.camera.bottom = -16;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 256;
  sun.shadow.bias = -0.0001;
  sun.shadow.normalBias = 0.005;
  sun.shadow.radius = 0.5;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  sun.target.position.set(0.8, 2.1, -0.9);
  scene.add(sun.target);
  const fogColor = scene.background instanceof THREE.Color ? scene.background : BACKGROUND_OUTER;
  const fog = scene.background === null ? null : new THREE.Fog(fogColor, 22, 88);
  if (fog) scene.fog = fog;
  const controller: SnowyVillageLightingController = {
    time: 18,
    targetTime: 18,
    hemisphere,
    sun,
    emitters: [],
    background: scene.background instanceof THREE.CanvasTexture ? scene.background : null,
    fog,
    setTime(time): void { this.targetTime = wrapDayTime(time); },
    registerEmitter(light, intensity, glow, glowOpacity, innerGlow, innerGlowOpacity): void {
      this.emitters.push({ light, intensity, glow, glowOpacity, innerGlow, innerGlowOpacity });
      const factor = lampFactorForTime(this.targetTime);
      light.intensity = intensity * factor;
      (glow.material as THREE.SpriteMaterial).opacity = glowOpacity * factor;
      if (innerGlow) (innerGlow.material as THREE.SpriteMaterial | THREE.MeshBasicMaterial).opacity = innerGlowOpacity * factor;
    },
    tick(delta): void {
      const difference = THREE.MathUtils.euclideanModulo(this.targetTime - this.time + 12, 24) - 12;
      if (Math.abs(difference) <= 0.001) {
        if (this.time !== this.targetTime) {
          this.time = this.targetTime;
          applySnowyVillageLighting(this, this.time);
          scene.environmentIntensity = this.sun.userData.environmentIntensity as number;
        }
        return;
      }
      this.time = wrapDayTime(this.time + difference * (1 - Math.exp(-Math.max(0, delta) * 5)));
      applySnowyVillageLighting(this, this.time);
      scene.environmentIntensity = this.sun.userData.environmentIntensity as number;
    },
  };
  (scene.userData as { snowyVillageLighting?: SnowyVillageLightingController }).snowyVillageLighting = controller;
  applySnowyVillageLighting(controller, 18);
  scene.environmentIntensity = sun.userData.environmentIntensity as number;
}

export function createSnowyVillageModel(scene: THREE.Scene): THREE.Group {
  const lighting = (scene.userData as { snowyVillageLighting?: SnowyVillageLightingController }).snowyVillageLighting;
  if (!lighting) throw new Error('Snowy village lighting must be installed before its model');
  let coreAssets!: CoreAssets;
  const ownedModels: NativeModel[] = [];
  const adapterGeometries: THREE.BufferGeometry[] = [];
  const buildModel = (role: NativeCoreRole): NativeModel => {
    const prepared = coreAssets[role];
    const model = createNativeModel(prepared.asset, prepared.images);
    ownedModels.push(model);
    setShadowFlags(model.root);
    return model;
  };
  let campfirePrepared: PreparedNativeRole | null = null;
  let campfireAssetStatus: SnowyVillageCampfireState['assetStatus'] = 'loading';
  let campfireAssetError = '';
  let campfireAssetFailure: unknown;
  const root = new THREE.Group();
  root.name = 'snowy-village-playable-scene';
  const shadowReceiver = scene.children.find((child) =>
    child instanceof THREE.Mesh && child.material instanceof THREE.ShadowMaterial,
  ) as THREE.Mesh | undefined;
  const shadowReceiverInitialVisible = shadowReceiver?.visible ?? false;
  const shadowReceiverInitialPosition = shadowReceiver?.position.clone() ?? null;
  const shadowReceiverInitialScale = shadowReceiver?.scale.clone() ?? null;
  const shadowReceiverInitialOpacity = shadowReceiver && shadowReceiver.material instanceof THREE.ShadowMaterial
    ? shadowReceiver.material.opacity
    : null;
  for (const child of scene.children) {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.ShadowMaterial) {
      child.visible = false;
    }
  }
  const groundRoot = new THREE.Group();
  groundRoot.name = 'snowy-village-snow-terrain';
  createSnowGround(groundRoot);
  scene.add(groundRoot);

  const keys = new Set<string>();
  const listeners = new Set<(active: string) => void>();
  const characterRoot = new THREE.Group();
  characterRoot.name = 'player-character';
  characterRoot.position.set(-0.65, 0, 2.05);
  characterRoot.rotation.y = Math.PI;
  root.add(characterRoot);
  if (shadowReceiver) {
    const geometry = shadowReceiver.geometry as THREE.PlaneGeometry;
    const receiverSize = 2048;
    shadowReceiver.scale.set(receiverSize / geometry.parameters.width, receiverSize / geometry.parameters.height, 1);
    shadowReceiver.position.set(0, 0.005, 0);
    (shadowReceiver.material as THREE.ShadowMaterial).opacity = 0.22;
    shadowReceiver.visible = true;
  }

  const houseRoot = new THREE.Group();
  houseRoot.name = 'movable-house';
  houseRoot.position.set(0.8, 0, -0.9);
  root.add(houseRoot);

  let characterVisual: THREE.Group | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let currentAction: THREE.AnimationAction | null = null;
  let currentActionId = 'idle';
  let manualActionId: string | null = null;
  let clips: Record<string, THREE.AnimationClip> = {};
  let gateLeftPivot: THREE.Group | null = null;
  let gateRightPivot: THREE.Group | null = null;
  let gatePlacement: THREE.Group | null = null;
  let gateOpen = false;
  let houseMoveMode = false;
  let disposed = false;
  let hud: HTMLDivElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let lightingControl: HTMLDivElement | null = null;
  let lightingControlObserver: ResizeObserver | null = null;
  let houseLightControl: HTMLDivElement | null = null;
  let campfireControl: HTMLDivElement | null = null;
  let campfireButton: HTMLButtonElement | null = null;
  let campfireStatus: HTMLOutputElement | null = null;
  let unsubscribeCampfire: (() => void) | null = null;
  let host: HTMLElement | null = null;
  let hostPosition = '';
  const PLAYER_HALF_EXTENT = 0.17;
  const PLAYER_HEIGHT = SNOWY_VILLAGE_CHARACTER_HEIGHT;
  const PLAYER_STEP_HEIGHT = 0.18;
  const GATE_PASSAGE_CLEARANCE = 0.04;
  const FIRE_SCALE = 0.25;
  const FIRE_HALF_EXTENT = 0.38;
  const fireListeners = new Set<(state: SnowyVillageCampfireState) => void>();
  let firePlacement: THREE.Group | null = null;
  let fireModel: NativeModel | null = null;
  let fireVfx: SnowyVillageFireVfx | null = null;
  let chimneySmokeVfx: SnowyVillageSmokeVfx | null = null;
  let snowfallVfx: SnowyVillageSnowfallVfx | null = null;
  let snowHouseMesh: THREE.Object3D | null = null;
  let fireBounds: THREE.Box3 | null = null;
  let fireMessage = 'Campfire is only available from 19:00 through 04:59';
  let fireNight = isCampfireNight(lighting.time);
  const campfireStatusMessage = (): string =>
    isCampfireNight(lighting.time) ? 'Campfire ready' : 'Campfire is only available from 19:00 through 04:59';
  const staticCollisionBounds: THREE.Box3[] = [];
  const staticCollisionLabels: string[] = [];
  const dynamicColliderObjects: THREE.Object3D[] = [houseRoot];
  const dynamicColliderBounds: THREE.Box3[] = [new THREE.Box3()];
  const dynamicColliderLabels: string[] = [houseRoot.name];
  const playerCollisionBounds = new THREE.Box3();
  let gatePassage: GatePassageMeasurement | null = null;
  const gatePassagePlayerCenter = new THREE.Vector3();

  const addStaticCollider = (object: THREE.Object3D): void => {
    object.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(object);
    if (!bounds.isEmpty()) {
      staticCollisionBounds.push(bounds);
      staticCollisionLabels.push(object.name || 'village prop');
    }
  };

  const addDynamicCollider = (object: THREE.Object3D): void => {
    dynamicColliderObjects.push(object);
    dynamicColliderBounds.push(new THREE.Box3());
    dynamicColliderLabels.push(object.name || 'village prop');
  };
  // Point-light shadow maps render six faces; select a stable scene light, never by player position.
  let candidatePointShadow: THREE.PointLight | null = null;
  let candidatePointShadowPriority = 0;
  let activePointShadowLight: THREE.PointLight | null = null;
  const considerPointShadow = (object: THREE.Object3D): void => {
    if (!(object instanceof THREE.PointLight) || !object.visible || object.intensity <= 0.02) return;
    const priority = object.intensity * Math.max(object.distance, 1);
    if (priority > candidatePointShadowPriority) {
      candidatePointShadow = object;
      candidatePointShadowPriority = priority;
    }
  };
  const updatePointShadowCaster = (): void => {
    candidatePointShadow = null;
    candidatePointShadowPriority = 0;
    scene.traverse(considerPointShadow);
    const selectedPointShadow = candidatePointShadow as THREE.PointLight | null;
    if (activePointShadowLight === selectedPointShadow) return;
    if (activePointShadowLight) activePointShadowLight.castShadow = false;
    activePointShadowLight = selectedPointShadow;
    if (activePointShadowLight) {
      activePointShadowLight.shadow.mapSize.set(512, 512);
      activePointShadowLight.shadow.bias = -0.0001;
      activePointShadowLight.shadow.normalBias = 0.005;
      activePointShadowLight.shadow.radius = 0.5;
      activePointShadowLight.castShadow = true;
    }
  };

  const footprintStride = 0.38;
  const footprintLifetime = 15;
  const footprintMaxRunSpeed = 2.65;
  const footprintCount = 128;
  const maxTrailFootprints = Math.ceil((footprintMaxRunSpeed * footprintLifetime) / footprintStride);
  if (footprintCount <= maxTrailFootprints) {
    throw new Error('Footprint pool must cover the full visible run trail');
  }
  const footprintSnowColor = new THREE.Color(0xeaf1ff);
  const footprintImprintColor = new THREE.Color(0x75839a).lerp(footprintSnowColor, 0.52);
  const footprintColor = new THREE.Color();
  const footprintTimes = new Float64Array(footprintCount);
  footprintTimes.fill(-1);
  const footprintGeometry = createFootprintGeometry();
  const footprintMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.99, metalness: 0 });
  const footprints = new THREE.InstancedMesh(footprintGeometry, footprintMaterial, footprintCount);
  footprints.name = 'grounded pressed-snow footprints';
  footprints.frustumCulled = false;
  footprints.castShadow = true;
  footprints.receiveShadow = true;
  const footprintTransform = new THREE.Object3D();
  const hiddenFootprintScale = new THREE.Vector3(0, 0, 0);
  for (let index = 0; index < footprintCount; index += 1) {
    footprintTransform.scale.copy(hiddenFootprintScale);
    footprintTransform.updateMatrix();
    footprints.setMatrixAt(index, footprintTransform.matrix);
    footprints.setColorAt(index, footprintSnowColor);
  }
  footprints.instanceMatrix.needsUpdate = true;
  if (footprints.instanceColor) footprints.instanceColor.needsUpdate = true;
  root.add(footprints);
  let nextFootprint = 0;
  let leftFoot = true;
  let distanceSinceFootprint = 0;

  const refreshDynamicColliders = (): void => {
    for (let index = 0; index < dynamicColliderObjects.length; index += 1) {
      const object = dynamicColliderObjects[index];
      object.updateWorldMatrix(true, true);
      dynamicColliderBounds[index].setFromObject(object);
    }
  };
  const fitsOpenGatePassage = (x: number, z: number, bottom: number, top: number): boolean => {
    const passage = gatePassage;
    if (!gateOpen || !passage) return false;
    gatePassagePlayerCenter.set(x, (bottom + top) * 0.5, z).applyMatrix4(passage.worldToLocal);
    const lowerTipX = passage.lowHingeX + passage.lowLeafSpan * Math.cos(Math.abs(passage.lowPivot.rotation.y));
    const upperTipX = passage.highHingeX - passage.highLeafSpan * Math.cos(Math.abs(passage.highPivot.rotation.y));
    const minCenterX = lowerTipX + passage.halfExtents.x + passage.clearance;
    const maxCenterX = upperTipX - passage.halfExtents.x - passage.clearance;
    if (minCenterX > maxCenterX) return false;
    const leafSweepDepth = Math.max(passage.lowLeafSpan, passage.highLeafSpan)
      * Math.sin(Math.max(Math.abs(passage.lowPivot.rotation.y), Math.abs(passage.highPivot.rotation.y)));
    const center = gatePassagePlayerCenter;
    const half = passage.halfExtents;
    return center.x >= minCenterX && center.x <= maxCenterX
      && center.y - half.y >= passage.frameBounds.min.y - passage.clearance
      && center.y + half.y <= passage.frameBounds.max.y + passage.clearance
      && center.z + half.z >= passage.frameBounds.min.z - leafSweepDepth - passage.clearance
      && center.z - half.z <= passage.frameBounds.max.z + leafSweepDepth + passage.clearance;
  };

  const collidesAt = (x: number, z: number): boolean => {
    const bottom = characterRoot.position.y;
    const top = bottom + PLAYER_HEIGHT;
    playerCollisionBounds.min.set(x - PLAYER_HALF_EXTENT, bottom, z - PLAYER_HALF_EXTENT);
    playerCollisionBounds.max.set(x + PLAYER_HALF_EXTENT, top, z + PLAYER_HALF_EXTENT);
    const canUseOpenGateGap = fitsOpenGatePassage(x, z, bottom, top);
    for (let index = 0; index < staticCollisionBounds.length; index += 1) {
      if (canUseOpenGateGap && staticCollisionLabels[index] === 'snow gate frame') continue;
      const bounds = staticCollisionBounds[index];
      if (bounds.max.y <= bottom + PLAYER_STEP_HEIGHT || bounds.min.y >= top) continue;
      if (playerCollisionBounds.intersectsBox(bounds)) return true;
    }
    for (let index = 0; index < dynamicColliderBounds.length; index += 1) {
      const object = dynamicColliderObjects[index];
      if (canUseOpenGateGap && (object === gateLeftPivot || object === gateRightPivot)) continue;
      const bounds = dynamicColliderBounds[index];
      if (bounds.max.y <= bottom + PLAYER_STEP_HEIGHT || bounds.min.y >= top) continue;
      if (playerCollisionBounds.intersectsBox(bounds)) return true;
    }
    if (fireBounds && playerCollisionBounds.intersectsBox(fireBounds)) return true;
    return false;
  };
  const campfireState = (): SnowyVillageCampfireState => ({
    assetStatus: campfireAssetStatus,
    available: !disposed && isCampfireNight(lighting.time) && campfireAssetStatus === 'ready',
    active: firePlacement !== null,
    error: campfireAssetFailure,
    message: campfireAssetStatus === 'unavailable' ? campfireAssetError : campfireAssetStatus === 'loading' ? 'Campfire loading' : fireMessage,
  });
  const notifyFire = (): void => {
    if (disposed) return;
    const state = campfireState();
    fireListeners.forEach((listener) => listener(state));
  };
  const removeFire = (): void => {
    if (!firePlacement) return;
    fireVfx?.dispose();
    fireVfx = null;
    root.remove(firePlacement);
    fireModel?.ownership.dispose();
    fireModel = null;
    firePlacement = null;
    fireBounds = null;
  };
  const fireController: SnowyVillageCampfireController = {
    get state(): SnowyVillageCampfireState { return campfireState(); },
    subscribe(listener): () => void {
      fireListeners.add(listener);
      listener(campfireState());
      return () => fireListeners.delete(listener);
    },
    cast(): boolean {
      if (disposed) return false;
      if (campfireAssetStatus !== 'ready' || !campfirePrepared) { fireMessage = campfireAssetError || 'Campfire loading'; notifyFire(); return false; }
      if (!isCampfireNight(lighting.time)) { fireMessage = campfireStatusMessage(); notifyFire(); return false; }
      const distance = 1.25;
      const x = characterRoot.position.x + Math.sin(characterRoot.rotation.y) * distance;
      const z = characterRoot.position.z + Math.cos(characterRoot.rotation.y) * distance;
      const proposed = new THREE.Box3(
        new THREE.Vector3(x - FIRE_HALF_EXTENT, 0, z - FIRE_HALF_EXTENT),
        new THREE.Vector3(x + FIRE_HALF_EXTENT, 0.6, z + FIRE_HALF_EXTENT),
      );
      let blocked = Math.abs(x) + FIRE_HALF_EXTENT > 5.8 || Math.abs(z) + FIRE_HALF_EXTENT > 5.8
        ? 'scene boundary' : '';
      const overlaps = (bounds: THREE.Box3): boolean =>
        bounds.min.x < proposed.max.x && bounds.max.x > proposed.min.x
        && bounds.min.z < proposed.max.z && bounds.max.z > proposed.min.z;
      if (!blocked) {
        const player = new THREE.Box3(
          new THREE.Vector3(characterRoot.position.x - PLAYER_HALF_EXTENT, 0, characterRoot.position.z - PLAYER_HALF_EXTENT),
          new THREE.Vector3(characterRoot.position.x + PLAYER_HALF_EXTENT, PLAYER_HEIGHT, characterRoot.position.z + PLAYER_HALF_EXTENT),
        );
        if (overlaps(player)) blocked = 'player';
      }
      const staticBlock = staticCollisionBounds.findIndex(overlaps);
      if (!blocked && staticBlock >= 0) blocked = staticCollisionLabels[staticBlock] || 'village prop';
      refreshDynamicColliders();
      const dynamicBlock = dynamicColliderBounds.findIndex(overlaps);
      if (!blocked && dynamicBlock >= 0) blocked = dynamicColliderLabels[dynamicBlock] || 'village prop';
      if (blocked) {
        fireMessage = 'Cannot place campfire: blocked by ' + blocked;
        notifyFire();
        return false;
      }
      const model = createNativeModel(campfirePrepared.asset, campfirePrepared.images);
      for (const name of ['hyper3d_part_8','hyper3d_part_41']) {
        const node = campfirePrepared.asset.effective.nodes.find((entry) => entry.name === name);
        const object = node ? model.objects.get(node.sourceIndex as number) : undefined;
        if (object) object.visible = false;
      }
      normalizeToHeight(model.root, 1.2);
      setShadowFlags(model.root);
      const placement = new THREE.Group();
      placement.name = 'active campfire placement';
      placement.position.set(x, 0, z);
      placement.add(model.root);
      placement.scale.setScalar(FIRE_SCALE);
      removeFire();
      fireModel = model;
      firePlacement = placement;
      fireBounds = proposed;
      root.add(placement);
      fireVfx = createSnowyVillageFireVfx(placement);
      fireMessage = 'Campfire placed';
      notifyFire();
      return true;
    },
  };
  const notify = (): void => listeners.forEach((listener) => listener(currentActionId));

  const playAction = (id: string): void => {
    const definition = ACTION_BY_ID[id];
    const clip = clips[id];
    if (!definition) return;
    if (!clip || !mixer) return;
    if (currentActionId === id && currentAction?.isRunning()) return;
    const next = mixer.clipAction(clip);
    if (next !== currentAction) {
      currentAction?.fadeOut(0.16);
      next.reset();
      next.setLoop(definition.loop ? THREE.LoopRepeat : THREE.LoopOnce, definition.loop ? Infinity : 1);
      next.clampWhenFinished = !definition.loop;
      next.fadeIn(0.16).play();
      currentAction = next;
    }
    currentActionId = id;
    notify();
  };

  const timeOfDayController: SnowyVillageTimeOfDayController = {
    get currentTime(): number { return lighting.time; },
    get targetTime(): number { return lighting.targetTime; },
    setTime(time: number): void { lighting.setTime(time); },
  };

  const animationController = {
    actions: ACTIONS,
    get active(): string { return currentActionId; },
    play(id: string): void {
      if (!ACTION_BY_ID[id]) return;
      manualActionId = id === 'idle' ? null : id;
      playAction(id);
    },
    stop(): void {
      manualActionId = null;
      playAction('idle');
    },
    subscribe(listener: (active: string) => void): () => void {
      listeners.add(listener);
      listener(currentActionId);
      return () => listeners.delete(listener);
    },
  };

  const updateHud = (message?: string): void => {
    if (!hud) return;
    hud.textContent = message ?? (houseMoveMode
      ? 'House mode · Arrows move house · M return to character · 1 walk · 2 run · 3 box'
      : 'WASD / arrows move · Shift run · 1 walk · 2 run · 3 box · E gate · M house');
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('button, a, input, textarea, select')) return;
    if (!GAME_KEY_CODES[event.code]) return;
    event.preventDefault();
    if (event.repeat) return;
    if (event.code === 'KeyF') { fireController.cast(); return; }

    if (event.code === 'KeyE') {
      if (!gatePlacement || !gateLeftPivot || !gateRightPivot) return;
      root.updateMatrixWorld(true);
      const gateWorld = gatePlacement.getWorldPosition(new THREE.Vector3());
      const playerWorld = characterRoot.getWorldPosition(new THREE.Vector3());
      if (playerWorld.distanceTo(gateWorld) <= 3.4) {
        gateOpen = !gateOpen;
        updateHud(gateOpen ? 'Gate open · E to close' : 'Gate closed · E to open');
      } else {
        updateHud('Move closer to the gate · E to open');
      }
      return;
    }
    if (event.code === 'KeyM') {
      houseMoveMode = !houseMoveMode;
      updateHud();
      return;
    }
    if (event.code === 'Digit3') { animationController.play('boxing'); return; }
    if (event.code === 'Space') return;
    manualActionId = null;
    keys.add(event.code);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  const clearKeys = (): void => keys.clear();
  const onCanvasPointerDown = (): void => canvas?.focus();
  const isCapture = /[?&]capture=1\b/.test(window.location.hash)
    || new URLSearchParams(window.location.search).get('capture') === '1';
  const mountHouseLightTuner = (): void => {
    if (isCapture || !host || houseLightControl || disposed) return;
    const emitters = lighting.emitters.filter((emitter) => emitter.light.name.startsWith('warm house ') || emitter.light.name.endsWith(' gate lantern light'));
    if (emitters.length === 0) return;

    const selector = document.createElement('select');
    const positionFor = (emitter: (typeof emitters)[number]): THREE.Vector3 =>
      (emitter.innerGlow ?? emitter.glow).position;
    const labelFor = (emitter: (typeof emitters)[number]): string => emitter.light.name.replace(/ light$/, '');
    const selectedEmitter = (): (typeof emitters)[number] => emitters[Number(selector.value)] ?? emitters[0];
    const formatPosition = (position: THREE.Vector3): string =>
      [position.x, position.y, position.z].map((value) => value.toFixed(3)).join(', ');

    const panel = document.createElement('div');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'House and gate light position tuning');
    Object.assign(panel.style, {
      position: 'absolute',
      top: '138px',
      right: '14px',
      zIndex: '6',
      display: 'grid',
      gap: '7px',
      width: 'min(280px, calc(100% - 28px))',
      maxHeight: 'calc(100% - 152px)',
      overflowY: 'auto',
      boxSizing: 'border-box',
      padding: '10px 12px',
      borderRadius: '12px',
      background: 'rgba(20, 25, 38, 0.9)',
      color: '#f7f9ff',
      font: '600 12px/1.4 system-ui, sans-serif',
      backdropFilter: 'blur(8px)',
    });

    const title = document.createElement('strong');
    title.textContent = 'House & gate light positions';
    const note = document.createElement('small');
    note.textContent = 'House lights have no visible dots. House XYZ are house-local; gate XYZ are gate-local.';
    selector.setAttribute('aria-label', 'House or gate light to tune');
    Object.assign(selector.style, {
      width: '100%',
      padding: '5px 7px',
      borderRadius: '6px',
      color: '#f7f9ff',
      background: '#252d40',
      border: '1px solid rgba(255,255,255,0.24)',
    });
    emitters.forEach((emitter, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = labelFor(emitter);
      selector.appendChild(option);
    });

    const sliderRows: Array<{ axis: 'x' | 'y' | 'z'; input: HTMLInputElement; output: HTMLOutputElement }> = [];
    for (const axis of ['x', 'y', 'z'] as const) {
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'grid',
        gridTemplateColumns: '16px minmax(60px, 1fr) 48px',
        gap: '7px',
        alignItems: 'center',
      });
      const axisName = document.createElement('span');
      axisName.textContent = axis.toUpperCase();
      const input = document.createElement('input');
      input.type = 'range';
      input.min = axis === 'y' ? '0' : '-3';
      input.max = axis === 'y' ? '4.2' : '3';
      input.step = '0.01';
      input.setAttribute('aria-label', axis.toUpperCase() + ' position in house-local coordinates');
      input.style.width = '100%';
      const output = document.createElement('output');
      output.style.textAlign = 'right';
      row.append(axisName, input, output);
      panel.appendChild(row);
      sliderRows.push({ axis, input, output });
    }

    const parameters = document.createElement('pre');
    parameters.setAttribute('aria-label', 'House and gate light position parameters');
    Object.assign(parameters.style, {
      margin: '2px 0 0',
      paddingTop: '6px',
      borderTop: '1px solid rgba(255,255,255,0.18)',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      font: '500 10px/1.45 ui-monospace, SFMono-Regular, monospace',
    });
    const updateParameters = (): void => {
      parameters.textContent = emitters.map((emitter) =>
        labelFor(emitter) + ' [' + (emitter.light.name.includes('gate lantern') ? 'gate-local' : 'house-local') + ']\n  glow [' + formatPosition(positionFor(emitter)) + ']\n  point [' + formatPosition(emitter.light.position) + ']'
      ).join('\n');
    };
    const syncSliders = (): void => {
      const position = positionFor(selectedEmitter());
      sliderRows.forEach(({ axis, input, output }) => {
        input.value = position[axis].toFixed(2);
        output.value = position[axis].toFixed(3);
      });
      updateParameters();
    };
    selector.addEventListener('change', syncSliders);
    sliderRows.forEach(({ axis, input, output }) => {
      input.addEventListener('input', () => {
        const emitter = selectedEmitter();
        const visualPosition = positionFor(emitter);
        const next = Number(input.value);
        const delta = next - visualPosition[axis];
        visualPosition[axis] = next;
        emitter.glow.position[axis] = next;
        emitter.light.position[axis] += delta;
        output.value = next.toFixed(3);
        updateParameters();
      });
    });

    panel.prepend(title, note, selector);
    panel.appendChild(parameters);
    houseLightControl = panel;
    panel.hidden = true;
    panel.style.display = 'none';
    host.appendChild(panel);
    syncSliders();
  };
  if (!isCapture) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearKeys);
    host = document.querySelector<HTMLElement>('.demo-canvas-mount, #game-canvas');
    canvas = host?.querySelector('canvas') ?? null;
    if (canvas) {
      canvas.tabIndex = 0;
      canvas.addEventListener('pointerdown', onCanvasPointerDown);
    }
    if (host) {
      hostPosition = host.style.position;
      host.style.position = 'relative';
      hud = document.createElement('div');
      hud.className = 'snowy-village-controls';
      hud.setAttribute('role', 'note');
      updateHud();
      Object.assign(hud.style, {
        position: 'relative',
        width: '100%',
        maxWidth: '100%',
        margin: '0',
        padding: '9px 0 0',
        borderTop: '1px solid rgba(255,255,255,0.14)',
        borderRadius: '0',
        background: 'transparent',
        color: 'rgba(247,249,255,0.78)',
        font: '500 11px/1.5 system-ui, sans-serif',
        pointerEvents: 'none',
      });
      campfireControl = document.createElement('div');
      Object.assign(campfireControl.style, {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        width: '100%',
        maxWidth: '100%',
        margin: '0',
        padding: '8px 0 0',
        borderTop: '1px solid rgba(255,255,255,0.14)',
        background: 'transparent',
        color: '#f7f9ff',
        font: '500 11px/1.4 system-ui, sans-serif',
      });
      campfireButton = document.createElement('button');
      campfireButton.type = 'button';
      campfireButton.className = 'snowy-village-fire-button';
      campfireButton.textContent = 'Place fire (F)';
      campfireButton.hidden = true;
      Object.assign(campfireButton.style, {
        flex: '0 0 auto',
        border: '1px solid rgba(255,255,255,0.22)',
        borderRadius: '999px',
        padding: '8px 12px',
        background: 'linear-gradient(135deg, #f2c27e, #d99247)',
        color: '#25190f',
        font: '700 11px/1 system-ui, sans-serif',
        boxShadow: '0 3px 10px rgba(0,0,0,0.24)',
        cursor: 'pointer',
        transition: 'filter 180ms ease, transform 180ms ease',
      });
      campfireButton.addEventListener('click', fireController.cast);
      campfireStatus = document.createElement('output');
      campfireStatus.setAttribute('role', 'status');
      campfireStatus.setAttribute('aria-live', 'polite');
      Object.assign(campfireStatus.style, {
        flex: '1 1 120px',
        minWidth: '0',
        color: 'rgba(247,249,255,0.82)',
        font: '500 11px/1.4 system-ui, sans-serif',
      });
      campfireControl.append(campfireButton, campfireStatus);
      lightingControl = document.createElement('div');
      Object.assign(lightingControl.style, {
        position: 'absolute',
        top: '14px',
        right: '14px',
        zIndex: '5',
        display: 'grid',
        gap: '8px',
        width: 'min(310px, calc(100% - 28px))',
        maxHeight: 'calc(100% - 28px)',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '14px 16px',
        borderRadius: '16px',
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(20,25,38,0.86)',
        color: '#f7f9ff',
        font: '600 12px/1.4 system-ui, sans-serif',
        boxShadow: '0 16px 42px rgba(0,0,0,0.30)',
        backdropFilter: 'blur(12px)',
      });
      const timeLabel = document.createElement('label');
      timeLabel.textContent = 'Time of day';
      timeLabel.style.display = 'block';
      const timeValue = document.createElement('output');
      Object.assign(timeValue.style, {
        float: 'right',
        color: '#f2c27e',
        font: '700 12px/1.2 ui-monospace, SFMono-Regular, monospace',
        fontVariantNumeric: 'tabular-nums',
      });
      const timeSlider = document.createElement('input');
      timeSlider.type = 'range';
      timeSlider.className = 'snowy-village-time-slider';
      timeSlider.min = '0';
      timeSlider.max = '24';
      timeSlider.step = '0.25';
      timeSlider.value = '18';
      timeSlider.setAttribute('aria-label', 'Time of day');
      timeSlider.style.width = '100%';
      const updateSliderProgress = (time: number): void => {
        timeSlider.style.setProperty('--time-progress', (time / 24 * 100) + '%');
      };
      timeSlider.addEventListener('input', () => {
        const time = Number(timeSlider.value);
        lighting.setTime(time);
        updateSliderProgress(time);
        const hour = Math.floor(time) % 24;
        const minute = Math.round((time - Math.floor(time)) * 60);
        timeValue.value = time === 24 ? '24:00' : String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
        timeSlider.setAttribute('aria-valuetext', timeValue.value);
      });
      timeLabel.append(timeValue, document.createElement('br'), timeSlider);
      lightingControl.append(timeLabel, hud, campfireControl);
      host.appendChild(lightingControl);
      const alignLightingControlToCanvas = (): void => {
        if (!host || !canvas || !lightingControl) return;
        const unusedWidth = host.getBoundingClientRect().right - canvas.getBoundingClientRect().right;
        lightingControl.style.right = Math.max(14, unusedWidth + 14) + 'px';
      };
      alignLightingControlToCanvas();
      lightingControlObserver = new ResizeObserver(alignLightingControlToCanvas);
      lightingControlObserver.observe(host);
      if (canvas) lightingControlObserver.observe(canvas);
      timeValue.value = '18:00';
      timeSlider.setAttribute('aria-valuetext', timeValue.value);
      updateSliderProgress(Number(timeSlider.value));
    }
  }

  root.userData.sculptRuntime = {
    animationController,
    timeOfDayController,
    campfireController: fireController,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (activePointShadowLight) activePointShadowLight.castShadow = false;
      if (shadowReceiver && shadowReceiverInitialPosition && shadowReceiverInitialScale) {
        shadowReceiver.position.copy(shadowReceiverInitialPosition);
        shadowReceiver.scale.copy(shadowReceiverInitialScale);
        if (shadowReceiverInitialOpacity !== null && shadowReceiver.material instanceof THREE.ShadowMaterial) {
          shadowReceiver.material.opacity = shadowReceiverInitialOpacity;
        }
        shadowReceiver.visible = shadowReceiverInitialVisible;
      }
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearKeys);
      canvas?.removeEventListener('pointerdown', onCanvasPointerDown);
      hud?.remove();
      unsubscribeCampfire?.();
      unsubscribeCampfire = null;
      campfireButton?.removeEventListener('click', fireController.cast);
      campfireControl?.remove();
      campfireControl = null;
      campfireButton = null;
      campfireStatus = null;
      lightingControl?.remove();
      houseLightControl?.remove();
      houseLightControl = null;
      lightingControlObserver?.disconnect();
      lightingControlObserver = null;
      if (host) host.style.position = hostPosition;
      mixer?.stopAllAction();
      if (mixer && characterVisual) mixer.uncacheRoot(characterVisual);
      removeFire();
      chimneySmokeVfx?.dispose();
      chimneySmokeVfx = null;
      snowfallVfx?.dispose();
      snowfallVfx = null;
      adapterGeometries.forEach((geometry) => geometry.dispose());
      ownedModels.forEach((model) => model.ownership.dispose());
      snowHouseMesh = null;
      fireListeners.clear();
      listeners.clear();
    },
  };
  root.userData.tick = (delta: number, elapsed: number): void => {
    const dt = Math.min(0.05, Math.max(0, delta));
    lighting.tick(dt);
    const nextFireNight = isCampfireNight(lighting.time);
    if (nextFireNight !== fireNight) {
      fireNight = nextFireNight;
      if (!fireNight) {
        removeFire();
      }
      fireMessage = campfireStatusMessage();
      notifyFire();
    }
    fireVfx?.update(dt, elapsed, lighting.time);
    chimneySmokeVfx?.update(dt, elapsed, 1);
    const gateSwing = gateOpen ? 1.15 : 0;
    if (gateLeftPivot) {
      gateLeftPivot.rotation.y = THREE.MathUtils.damp(gateLeftPivot.rotation.y, gateSwing, 6, dt);
    }
    if (gateRightPivot) {
      gateRightPivot.rotation.y = THREE.MathUtils.damp(gateRightPivot.rotation.y, -gateSwing, 6, dt);
    }
    refreshDynamicColliders();

    let acceptedDx = 0;
    let acceptedDz = 0;
    if (houseMoveMode) {
      const step = 1.25 * dt;
      const previousHouseX = houseRoot.position.x;
      const previousHouseZ = houseRoot.position.z;
      houseRoot.position.x = THREE.MathUtils.clamp(
        houseRoot.position.x + (keys.has('ArrowRight') ? step : 0) - (keys.has('ArrowLeft') ? step : 0),
        -4.7,
        4.7,
      );
      houseRoot.position.z = THREE.MathUtils.clamp(
        houseRoot.position.z + (keys.has('ArrowDown') ? step : 0) - (keys.has('ArrowUp') ? step : 0),
        -4.6,
        4.6,
      );
      if (fireBounds) {
        houseRoot.updateWorldMatrix(true, true);
        if (new THREE.Box3().setFromObject(houseRoot).intersectsBox(fireBounds)) {
          houseRoot.position.x = previousHouseX;
          houseRoot.position.z = previousHouseZ;
        }
      }
    } else {
      const x = ((keys.has('KeyD') || keys.has('ArrowRight')) ? 1 : 0)
        - ((keys.has('KeyA') || keys.has('ArrowLeft')) ? 1 : 0);
      const z = ((keys.has('KeyS') || keys.has('ArrowDown')) ? 1 : 0)
        - ((keys.has('KeyW') || keys.has('ArrowUp')) ? 1 : 0);
      const length = Math.hypot(x, z);
      if (length > 0) {
        const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 2.65 : 1.55;
        const nextX = THREE.MathUtils.clamp(characterRoot.position.x + x / length * speed * dt, -5.8, 5.8);
        const nextZ = THREE.MathUtils.clamp(characterRoot.position.z + z / length * speed * dt, -5.8, 5.8);
        const currentX = characterRoot.position.x;
        const currentZ = characterRoot.position.z;
        let resolvedX = currentX;
        let resolvedZ = currentZ;
        if (!collidesAt(nextX, nextZ)) {
          resolvedX = nextX;
          resolvedZ = nextZ;
        } else {
          if (!collidesAt(nextX, currentZ)) resolvedX = nextX;
          if (!collidesAt(resolvedX, nextZ)) resolvedZ = nextZ;
        }
        characterRoot.position.x = resolvedX;
        characterRoot.position.z = resolvedZ;
        acceptedDx = resolvedX - currentX;
        acceptedDz = resolvedZ - currentZ;
        characterRoot.rotation.y = Math.atan2(x, z);
        if (!manualActionId) playAction(keys.has('ShiftLeft') || keys.has('ShiftRight') ? 'run' : 'walk');
      } else if (!manualActionId) {
        playAction('idle');
      }
    }


    let footprintMatricesChanged = false;
    let footprintColorsChanged = false;
    for (let index = 0; index < footprintCount; index += 1) {
      const stampedAt = footprintTimes[index];
      if (stampedAt < 0) continue;
      const age = Math.max(0, elapsed - stampedAt);
      if (age >= footprintLifetime) {
        footprintTransform.position.set(0, 0, 0);
        footprintTransform.rotation.set(0, 0, 0);
        footprintTransform.scale.copy(hiddenFootprintScale);
        footprintTransform.updateMatrix();
        footprints.setMatrixAt(index, footprintTransform.matrix);
        footprintTimes[index] = -1;
        footprints.setColorAt(index, footprintSnowColor);
        footprintMatricesChanged = true;
        footprintColorsChanged = true;
      } else {
        footprintColor.copy(footprintImprintColor).lerp(footprintSnowColor, age / footprintLifetime);
        footprints.setColorAt(index, footprintColor);
        footprintColorsChanged = true;
      }
    }
    if (footprintMatricesChanged) footprints.instanceMatrix.needsUpdate = true;
    if (footprintColorsChanged && footprints.instanceColor) footprints.instanceColor.needsUpdate = true;
    const acceptedDistance = Math.hypot(acceptedDx, acceptedDz);
    const groundedGait = !houseMoveMode
      && characterRoot.position.y <= 0.025
      && (currentActionId === 'walk' || currentActionId === 'run');
    if (groundedGait && acceptedDistance > 0.001) {
      distanceSinceFootprint += acceptedDistance;
      if (distanceSinceFootprint >= footprintStride) {
        distanceSinceFootprint %= footprintStride;
        const directionX = acceptedDx / acceptedDistance;
        const directionZ = acceptedDz / acceptedDistance;
        const side = leftFoot ? 0.075 : -0.075;
        footprintTransform.position.set(
          characterRoot.position.x + directionZ * side - directionX * 0.075,
          0.018,
          characterRoot.position.z - directionX * side - directionZ * 0.075,
        );
        footprintTransform.rotation.set(0, Math.atan2(-directionX, -directionZ), 0);
        footprintTransform.scale.set(1, 1, 1);
        footprintTransform.updateMatrix();
        footprints.setMatrixAt(nextFootprint, footprintTransform.matrix);
        footprints.setColorAt(nextFootprint, footprintImprintColor);
        footprintTimes[nextFootprint] = elapsed;
        footprints.instanceMatrix.needsUpdate = true;
        nextFootprint = (nextFootprint + 1) % footprintCount;
        leftFoot = !leftFoot;
      }
    } else {
      distanceSinceFootprint = 0;
    }
    mixer?.update(dt);
    refreshDynamicColliders();
    snowfallVfx?.update(dt, elapsed, staticCollisionBounds, dynamicColliderBounds, snowHouseMesh, fireBounds);
    updatePointShadowCaster();
  };

  const mountNativeScene = async (): Promise<void> => {
    coreAssets = await (coreAssetsPromise ??= prewarmNativeCore());
    if (disposed) return;
    const houseModel = buildModel('house');
  const houseSize = normalizeToHeight(houseModel.root, 4.1, -Math.PI / 2);
  houseRoot.add(houseModel.root);
  snowHouseMesh = houseModel.root;
  chimneySmokeVfx = createSnowyVillageSmokeVfx(houseRoot, new THREE.Vector3(0.672, 4.18, -1.012), {
    particleCount: 24, lifetime: [3.8, 5.5], riseSpeed: [0.65, 1.0], spread: 0.8, size: [0.55, 1.25], opacity: 0.35, color: 0x80868d,
  });

  const gateModel = buildModel('gate');
  normalizeToHeight(gateModel.root, 2.65, -Math.PI / 2);
  const gateParts = new Map([...GATE_LEAF_PARTS].map((name) => [name, sourceNode(gateModel, coreAssets.gate, name)]));
  const leftEdge = gateParts.get('hyper3d_part_23')!;
  const rightEdge = gateParts.get('hyper3d_part_27')!;
  const panelNode = gateParts.get('hyper3d_part_19')!;
  gateModel.root.updateMatrixWorld(true);
  const gateInverse = gateModel.root.matrixWorld.clone().invert();
  const localBounds = (object: THREE.Object3D): THREE.Box3 => new THREE.Box3().setFromObject(object).applyMatrix4(gateInverse);
  const seamX = localBounds(panelNode).getCenter(new THREE.Vector3()).x;
  const leftPivot = new THREE.Group(); leftPivot.name = 'left gate leaf hinge'; leftPivot.position.x = localBounds(leftEdge).min.x;
  const rightPivot = new THREE.Group(); rightPivot.name = 'right gate leaf hinge'; rightPivot.position.x = localBounds(rightEdge).max.x;
  gateLeftPivot = leftPivot; gateRightPivot = rightPivot;
  gateModel.root.add(leftPivot, rightPivot); gateModel.root.updateMatrixWorld(true);
  for (const [name, part] of gateParts) {
    if (name === 'hyper3d_part_19') continue;
    const center = localBounds(part).getCenter(new THREE.Vector3());
    (center.x < seamX ? leftPivot : rightPivot).attach(part);
  }
  const panelMesh = findFirstMesh(panelNode);
  if (!panelMesh) throw new Error('Native gate panel node has no mesh child');
  const panelParent = panelMesh.parent;
  if (!panelParent) throw new Error('Native gate panel mesh has no parent');
  const panelGeometry = panelMesh.geometry;
  const position = panelGeometry.getAttribute('position'), normal = panelGeometry.getAttribute('normal'), uv = panelGeometry.getAttribute('uv');
  if (!normal || !uv) throw new Error('Native gate panel requires POSITION, NORMAL and TEXCOORD_0');
  const panelToGate = gateInverse.clone().multiply(panelMesh.matrixWorld);
  const halves: [number[], number[], number[]][] = [[[],[],[]],[[],[],[]]];
  const index = panelGeometry.index, count = index?.count ?? position.count;
  for (let offset = 0; offset + 2 < count; offset += 3) {
    const ids = [index ? index.getX(offset) : offset,index ? index.getX(offset + 1) : offset + 1,index ? index.getX(offset + 2) : offset + 2];
    const centerX = ids.reduce((sum,id) => sum + new THREE.Vector3().fromBufferAttribute(position,id).applyMatrix4(panelToGate).x,0) / 3;
    const attributes = halves[centerX < seamX ? 0 : 1];
    for (const id of ids) { attributes[0].push(position.getX(id),position.getY(id),position.getZ(id)); attributes[1].push(normal.getX(id),normal.getY(id),normal.getZ(id)); attributes[2].push(uv.getX(id),uv.getY(id)); }
  }
  if (!halves[0][0].length || !halves[1][0].length) throw new Error('Native gate panel did not split into two leaves');
  const leaves: Array<[string, THREE.Group, [number[], number[], number[]]]> = [['left',leftPivot,halves[0]],['right',rightPivot,halves[1]]];
  for (const [side,pivot,attributes] of leaves) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(attributes[0],3)); geometry.setAttribute('normal',new THREE.Float32BufferAttribute(attributes[1],3)); geometry.setAttribute('uv',new THREE.Float32BufferAttribute(attributes[2],2));
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const leaf = panelMesh.clone();
    leaf.geometry = geometry;
    leaf.name = 'hyper3d_part_19-' + side + '-leaf';
    panelParent.add(leaf);
    pivot.attach(leaf);
    adapterGeometries.push(geometry);
  }
  panelMesh.visible = false;
  gateModel.root.updateMatrixWorld(true);
  const gateFrameLocalBounds = localBounds(gateModel.root);
  gatePlacement = placeSnowProp(root, gateModel.root, 'snow gate placement', -3.45, 0, 3.1);
  const gateMount = gatePlacement as unknown as THREE.Group;
  attachLampEmitter(gateMount, lighting, 'west gate lantern', new THREE.Vector3(-0.210, 1.050, 1.310), 0xffb85e, 1.55, 5.2, 1.7, 0.28, 0.22);
  attachLampEmitter(gateMount, lighting, 'east gate lantern', new THREE.Vector3(-0.160, 1.220, -1.600), 0xffb85e, 1.55, 5.2, 1.7, 0.28, 0.22);
  addDynamicCollider(leftPivot); addDynamicCollider(rightPivot);
  root.updateMatrixWorld(true); gateModel.root.updateWorldMatrix(true, true);
  const gateWorldScale = gateModel.root.getWorldScale(new THREE.Vector3());
  const lowPivot = leftPivot.position.x <= rightPivot.position.x ? leftPivot : rightPivot;
  const highPivot = lowPivot === leftPivot ? rightPivot : leftPivot;
  gatePassage = {
    worldToLocal: gateModel.root.matrixWorld.clone().invert(),
    frameBounds: gateFrameLocalBounds,
    lowPivot,
    highPivot,
    lowHingeX: lowPivot.position.x,
    highHingeX: highPivot.position.x,
    lowLeafSpan: Math.abs(seamX - lowPivot.position.x),
    highLeafSpan: Math.abs(highPivot.position.x - seamX),
    halfExtents: new THREE.Vector3(
      PLAYER_HALF_EXTENT / Math.abs(gateWorldScale.x),
      PLAYER_HEIGHT / (2 * Math.abs(gateWorldScale.y)),
      PLAYER_HALF_EXTENT / Math.abs(gateWorldScale.z),
    ),
    clearance: GATE_PASSAGE_CLEARANCE / Math.min(Math.abs(gateWorldScale.x), Math.abs(gateWorldScale.z)),
  };
  for (const part of gateModel.root.children) {
    if (part === leftPivot || part === rightPivot || part === panelNode) continue;
    const bounds = new THREE.Box3().setFromObject(part);
    if (!bounds.isEmpty() && bounds.max.y > PLAYER_STEP_HEIGHT && bounds.min.y < PLAYER_HEIGHT) { staticCollisionBounds.push(bounds); staticCollisionLabels.push('snow gate frame'); }
  }

  const westTree = buildModel('tree'); normalizeToHeight(westTree.root, 4.15);
  addStaticCollider(placeSnowProp(root, westTree.root, 'west snow tree placement', -4.55, 0, -1.6));
  const eastTree = buildModel('tree'); normalizeToHeight(eastTree.root, 3.05);
  addStaticCollider(placeSnowProp(root, eastTree.root, 'east snow tree placement', 4.3, 0, 1.5));
  const rockPlaces: Array<[number, number, number]> = [[-5.15,0,0.2],[-4.2,0,-4.1],[4.25,0,-3.8]];
  for (const [index, [x,y,z]] of rockPlaces.entries()) {
    const rock = buildModel('rock'); normalizeToHeight(rock.root, index === 0 ? 1.45 : 0.95);
    addStaticCollider(placeSnowProp(root, rock.root, 'snow rock placement ' + (index + 1), x, y, z));
  }
  const characterModel = buildModel('character');
  removeBlackArmArtifact(characterModel.root); normalizeToHeight(characterModel.root, 1.15, -Math.PI / 2);
  characterVisual = characterModel.root; characterRoot.add(characterVisual); mixer = new THREE.AnimationMixer(characterVisual);
  clips = Object.fromEntries((['idle','walk','run','boxing'] as const).map((role) => {
    const clip = createNativeAnimationClips(coreAssets[role].asset)[0];
    if (!clip) throw new Error('Native ' + role + ' has no animation clip');
    clip.name = role;
    clip.tracks = clip.tracks.filter((track) => !((track.name.startsWith('Hip.') || track.name.startsWith('Root.') || track.name.includes('.Hip.') || track.name.includes('.Root.')) && track.name.endsWith('.position')));
    return [role, clip];
  })) as Record<string, THREE.AnimationClip>;
  mixer.addEventListener('finished', (event) => {
    if (!event || typeof event !== 'object' || !('action' in event)) return;
    const action = event.action;
    if (action instanceof THREE.AnimationAction && action === currentAction && currentActionId === 'boxing') { manualActionId = null; playAction('idle'); }
  });
  playAction('idle');

  attachLampEmitter(houseRoot, lighting, 'warm house lantern', new THREE.Vector3(-1.05, 1.42, houseSize.z * 0.38), 0xffb354, 3.4, 10.5, 0, 0, 0, 0, 0.5, 'pane');
  attachLampEmitter(houseRoot, lighting, 'warm house upper window', new THREE.Vector3(0, 2.45, houseSize.z * 0.49), 0xffcb78, 2.0, 8.5, 0, 0, 0, 0.9, 0.82, 'pane', new THREE.Vector3(0, 2.45, houseSize.z * 0.36));
  attachLampEmitter(houseRoot, lighting, 'warm house left window', new THREE.Vector3(-1.75, 1.4, houseSize.z * 0.49), 0xffc577, 1.35, 8.0, 0, 0, 0, 0.68, 0.82, 'pane', new THREE.Vector3(-1.75, 1.4, houseSize.z * 0.36));
  attachLampEmitter(houseRoot, lighting, 'warm house right window', new THREE.Vector3(1.4, 1.4, houseSize.z * 0.49), 0xffc577, 1.35, 8.0, 0, 0, 0, 0.68, 0.82, 'pane', new THREE.Vector3(1.4, 1.4, houseSize.z * 0.36));
  attachLampEmitter(houseRoot, lighting, 'warm house dormer window', new THREE.Vector3(-1.2, 2.9, houseSize.z * 0.34), 0xffc577, 1.15, 7.0, 0, 0, 0, 0.68, 0.82, 'pane', new THREE.Vector3(-1.2, 2.9, houseSize.z * 0.26));
  attachLampEmitter(houseRoot, lighting, 'warm house door glass', new THREE.Vector3(0, 1.55, houseSize.z * 0.49), 0xffd080, 1.5, 8.0, 0, 0, 0, 0.58, 0.82, 'pane', new THREE.Vector3(0, 1.55, houseSize.z * 0.36));
  mountHouseLightTuner();
  root.updateMatrixWorld(true);
  refreshDynamicColliders();
  snowfallVfx = createSnowyVillageSnowfallVfx(root);
  fireMessage = campfireStatusMessage();

  };
  scene.add(root);
  if (campfireButton && campfireStatus) {
    unsubscribeCampfire = fireController.subscribe((state) => {
      if (!campfireButton || !campfireStatus) return;
      campfireButton.hidden = !state.available;
      campfireButton.disabled = !state.available;
      campfireStatus.value = state.message;
    });
  }
  const mountPromise = mountNativeScene();
  pendingSceneMounts.add(mountPromise);
  void mountPromise.then(() => pendingSceneMounts.delete(mountPromise), (error: unknown) => {
    pendingSceneMounts.delete(mountPromise);
    if (!disposed) console.error('Snowy village native scene failed to mount', error);
  });
  void preloadNativeCampfire().then((prepared) => {
    if (disposed) return;
    campfirePrepared = prepared;
    campfireAssetStatus = 'ready';
    fireMessage = campfireStatusMessage();
    notifyFire();
  }).catch((error: unknown) => {
    if (disposed) return;
    campfireAssetStatus = 'unavailable';
    campfireAssetFailure = error;
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
    campfireAssetError = error instanceof Error ? error.message + (cause instanceof Error ? ': ' + cause.message : cause ? ': ' + String(cause) : '') : String(error);
    fireMessage = campfireAssetError;
    notifyFire();
  });
  return root;
}
