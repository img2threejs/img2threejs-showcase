import * as THREE from 'three';
import { createMeasuredProp, type IslandPropRole as ModelRole } from './measured/props';
import type { SurfaceEvidence } from './measured/surfaceCodec';
import type { Viewer } from '../../scene';
import { buildOceanPlane, buildFoamRing, installWetBeach } from './ocean';
import { correctCampfireModel, createCampfireVfx } from './campfire';
import { createPalmWind, type PalmWind } from './palmWind';
import type { TropicalEnvironment } from './environment';
import { mountWaterInteraction } from './waterInteraction';
import { ShoreResponse, type ShoreMotion } from './shoreResponse';
import { createRockDrops } from './rockDrops';
import { createGrass } from './grass';
import { createShrubs } from './shrubs';
import { createChimneySmoke, type ChimneySmoke } from './chimneySmoke';
import { BuoyantBody, sampleWaveLoad, type WaveContact, type WaveLoad } from './waveForces';

/**
 * Code-only diorama reconstructed from a single oblique composition reference
 * (`public/references/tropical-island.webp`). Ten prop surfaces are force-measured
 * from the archived Tripo references and decoded from committed TypeScript.
 * Source textures are sampled offline into vertex colour; no model or image-map
 * asset is loaded by the scene. Terrain, water, vegetation and effects are authored
 * Three.js geometry and shaders.
 *
 * Reference admission gate verdict: the overview failed strict foreground isolation
 * (foregroundCoverage=0.9974), so the source is treated as a *composition reference*, not an
 * object pixel-fidelity target. Local measurements (cabin orientation, dock direction, rock
 * placements) are inferred from that composition, not asserted as measured quantities.
 *
 * Build returns the complete selectable assembly synchronously. Measured surface
 * modules load with this route's code, not through a second asset-loading lifecycle.
 */

const FRIENDLY_NAME: Record<ModelRole, string> = {
  house: 'Cabin',
  palm: 'Palm',
  dock: 'Dock',
  boat: 'Boat',
  rocks: 'Gray shoreline boulders',
  redRock: 'Red rock island',
  crate: 'Crate',
  barrel: 'Barrel',
  campfire: 'Campfire',
  lamp: 'Lamp',
};


// ---------- helpers -------------------------------------------------------------------------------

function setShadowFlags(root: THREE.Object3D, cast = true, receive = true): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = cast;
    object.receiveShadow = receive;
  });
}

function normaliseToHeight(model: THREE.Object3D, targetHeight: number, yaw = 0): THREE.Vector3 {
  if (yaw !== 0) model.rotation.y += yaw;
  model.updateMatrixWorld(true);
  const initial = new THREE.Box3().setFromObject(model);
  const startSize = initial.getSize(new THREE.Vector3());
  const factor = targetHeight / Math.max(startSize.y, 0.001);
  model.scale.multiplyScalar(factor);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.y -= bounds.min.y;
  model.position.z -= center.z;
  model.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
}

// ---------- colour palette --------------------------------------------------

const PALETTE = {
  sand: new THREE.Color(0xf3dfa8),
  sandShadow: new THREE.Color(0xe1c68d),
  grass: new THREE.Color(0x8cae3c),
  grassDeep: new THREE.Color(0x5f8e2d),
  waterDeep: new THREE.Color(0x08739e),
  waterShelf: new THREE.Color(0x46c6bd),
  foam: new THREE.Color(0xfdfdfd),
  sky: new THREE.Color(0xbfe4ee),
  hullWarm: new THREE.Color(0x7d4f30),
  rockGray: new THREE.Color(0x808a8f),
  rockWarm: new THREE.Color(0xc9684b),
  chimney: new THREE.Color(0x9a9c98),
} as const;

// ---------- deterministic pseudo noise --------------------------------------

function hash2(x: number, y: number, seed = 0.137): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + seed * 19.19) * 43758.5453;
  return v - Math.floor(v);
}

function smoothStep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, cell = 1): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = smooth(gx - x0);
  const ty = smooth(gy - y0);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

// ---------- terrain ------------------------------------------------------

interface IslandShape {
  silhouetteAt: (theta: number) => number;
  heightAt: (x: number, z: number) => number;
}

function buildIslandShape(): IslandShape {
  // Sixteen radial samples; the same coastline drives terrain, water depth and foam.
  const samples = [
    1.05, 1.18, 1.28, 1.22, 1.06, 0.92, 0.86, 0.92,
    1.06, 1.16, 1.18, 1.06, 0.94, 0.86, 0.88, 0.96,
  ];
  const silhouetteAt = (theta: number): number => {
      const t = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const indexF = (t / (Math.PI * 2)) * samples.length;
      const i0 = Math.floor(indexF) % samples.length;
      const i1 = (i0 + 1) % samples.length;
      const frac = indexF - Math.floor(indexF);
      const r0 = samples[i0]!;
      const r1 = samples[i1]!;
      return 4 * (r0 + (r1 - r0) * smooth(frac));
  };
  return {
    silhouetteAt,
    heightAt: (x: number, z: number): number => {
      const q = Math.hypot(x, z / 0.85) / silhouetteAt(Math.atan2(z / 0.85, x));
      const relief = (valueNoise(x, z, 0.6) - 0.5) * 0.055 * (1 - smoothStep(0.85, 1, q));
      return 0.54 - 0.38 * smoothStep(0.52, 0.84, q)
        - 0.16 * smoothStep(0.88, 1, q) - 0.55 * smoothStep(1, 1.18, q) + relief;
    },
  };
}

interface BeachSample {
  y: number;
  color: THREE.Color;
  onGrass: boolean;
  onSand: boolean;
}

interface BeachMesh {
  mesh: THREE.Mesh;
  colors: Float32Array;
  positions: Float32Array;
  sampleAt: (x: number, z: number) => BeachSample;
}

function buildBeachMesh(shape: IslandShape): BeachMesh {
  const radial = 48;
  const angular = 128;
  const sampleAt = (x: number, z: number): BeachSample => {
    const theta = Math.atan2(z / 0.85, x);
    const q = Math.hypot(x, z / 0.85) / shape.silhouetteAt(theta);
    const y = shape.heightAt(x, z);
    const grassEdge = q + (valueNoise(x + 8, z, 0.45) - 0.5) * 0.055;
    const color = PALETTE.grass.clone().lerp(PALETTE.grassDeep, valueNoise(x, z, 0.35) * 0.35);
    color.lerp(PALETTE.sand, smoothStep(0.75, 0.82, grassEdge));
    color.lerp(PALETTE.sandShadow, smoothStep(0.91, 1.18, q) * 0.35);
    return { y, color, onGrass: q < 0.78, onSand: q >= 0.78 && q < 1 };
  };
  const count = 1 + radial * (angular + 1);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const indices = new Uint16Array(angular * (1 + 2 * (radial - 1)) * 3);
  const writeVertex = (i: number, x: number, z: number): void => {
    const sample = sampleAt(x, z);
    positions.set([x, sample.y, z], i * 3);
    sample.color.toArray(colors, i * 3);
  };
  writeVertex(0, 0, 0);
  for (let r = 1; r <= radial; r += 1) {
    for (let a = 0; a <= angular; a += 1) {
      const theta = a / angular * Math.PI * 2;
      const radius = shape.silhouetteAt(theta) * r / radial * 1.18;
      writeVertex(1 + (r - 1) * (angular + 1) + a, Math.cos(theta) * radius, Math.sin(theta) * radius * 0.85);
    }
  }
  let cursor = 0;
  for (let a = 0; a < angular; a += 1) {
    indices.set([0, 2 + a, 1 + a], cursor);
    cursor += 3;
  }
  for (let r = 0; r < radial - 1; r += 1) {
    for (let a = 0; a < angular; a += 1) {
      const i = 1 + r * (angular + 1) + a;
      const j = i + angular + 1;
      indices.set([i, i + 1, j, i + 1, j + 1, j], cursor);
      cursor += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 }));
  mesh.name = 'Beach terrain';
  mesh.receiveShadow = true;
  return { mesh, colors, positions, sampleAt };
}


// ---------- path mask -----------------------------------------------------

function paintPathMask(
  colors: Float32Array,
  positions: Float32Array,
  pathSamples: ReadonlyArray<{ x: number; z: number; radius: number }>,
): void {
  for (let i = 0; i < colors.length / 3; i += 1) {
    const x = positions[i * 3]!;
    const z = positions[i * 3 + 2]!;
    if (positions[i * 3 + 1]! < 0.12) continue;
    let distance = Infinity;
    for (let j = 1; j < pathSamples.length; j += 1) {
      const a = pathSamples[j - 1]!;
      const b = pathSamples[j]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
      const width = a.radius + (b.radius - a.radius) * t;
      distance = Math.min(distance, Math.hypot(x - a.x - dx * t, z - a.z - dz * t) / width);
    }
    const blend = 1 - smoothStep(0.65, 1.15, distance);
    colors[i * 3] += (PALETTE.sand.r * 0.88 - colors[i * 3]!) * blend;
    colors[i * 3 + 1] += (PALETTE.sand.g * 0.8 - colors[i * 3 + 1]!) * blend;
    colors[i * 3 + 2] += (PALETTE.sand.b * 0.7 - colors[i * 3 + 2]!) * blend;
  }
}


function scatterPebbles(
  root: THREE.Group,
  sampleAt: (x: number, z: number) => BeachSample,
): void {
  const mat = new THREE.MeshStandardMaterial({ color: 0xbcb6a8, roughness: 0.9, metalness: 0 });
  const pebbleGeometry = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 30; i += 1) {
    const t = (i * 1.7) % (Math.PI * 2);
    const r = 3.0 + ((i * 19) % 70) / 70 * 1.1;
    const x = Math.cos(t) * r;
    const z = Math.sin(t) * r;
    const sample = sampleAt(x, z);
    if (!sample.onSand) continue;
    const size = 0.05 + ((i * 7) % 9) / 90;
    const pebble = new THREE.Mesh(pebbleGeometry, mat);
    pebble.scale.setScalar(size);
    pebble.position.set(x, sample.y + size * 0.4, z);
    pebble.rotation.set(((i * 11) % 13) / 7, ((i * 17) % 23) / 9, ((i * 19) % 29) / 11);
    pebble.castShadow = true;
    pebble.receiveShadow = true;
    root.add(pebble);
  }
}

function scatterStarfish(
  root: THREE.Group,
  sampleAt: (x: number, z: number) => BeachSample,
): void {
  const mat = new THREE.MeshStandardMaterial({ color: 0xc14b30, roughness: 0.6, metalness: 0 });
  const starShape = new THREE.Shape();
  starShape.moveTo(0, 0.18);
  starShape.lineTo(0.05, 0.05);
  starShape.lineTo(0.18, 0.05);
  starShape.lineTo(0.07, -0.04);
  starShape.lineTo(0.11, -0.18);
  starShape.lineTo(0, -0.1);
  starShape.lineTo(-0.11, -0.18);
  starShape.lineTo(-0.07, -0.04);
  starShape.lineTo(-0.18, 0.05);
  starShape.lineTo(-0.05, 0.05);
  starShape.closePath();
  const geom = new THREE.ExtrudeGeometry(starShape, { depth: 0.04, bevelEnabled: false });
  geom.rotateX(-Math.PI / 2);
  const x = -0.4, z = 2.9;
  const sample = sampleAt(x, z);
  const star = new THREE.Mesh(geom, mat);
  star.position.set(x, sample.y + 0.025, z);
  star.rotation.y = 0.4;
  star.castShadow = true;
  star.receiveShadow = true;
  star.name = 'Foreground starfish';
  root.add(star);
}

// ---------- overview chimney addition --------------------------------------

function buildChimney(sampleAt: (x: number, z: number) => BeachSample, x: number, z: number): THREE.Group {
  const sample = sampleAt(x, z);
  const chimney = new THREE.Group();
  chimney.name = 'Chimney';
  const stoneMat = new THREE.MeshStandardMaterial({ color: PALETTE.chimney, roughness: 0.95, metalness: 0 });
  const wallGeometry = new THREE.BoxGeometry(0.045, 0.75, 0.24);
  for (const sign of [-1, 1]) {
    const side = new THREE.Mesh(wallGeometry, stoneMat);
    side.position.set(sign * 0.0875, 0.375, 0);
    chimney.add(side);
    const front = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.75, 0.045), stoneMat);
    front.position.set(0, 0.375, sign * 0.0975);
    chimney.add(front);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.04), stoneMat);
    rim.position.set(0, 0.75, sign * 0.13);
    chimney.add(rim);
    const rimSide = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.22), stoneMat);
    rimSide.position.set(sign * 0.12, 0.75, 0);
    chimney.add(rimSide);
  }
  const soot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.02, 0.15),
    new THREE.MeshStandardMaterial({ color: 0x252423, roughness: 1 }));
  soot.position.y = 0.57;
  chimney.add(soot);
  setShadowFlags(chimney);
  chimney.position.set(x, sample.y, z);
  return chimney;
}

// ---------- prop placement -------------------------------------------------

interface PropSet {
  cabin: THREE.Group | null;
  chimney: THREE.Group | null;
  palms: THREE.Group[];
  dock: THREE.Group | null;
  boat: THREE.Group | null;
  rocks: THREE.Group | null;
  redRock: THREE.Group | null;
  campfire: THREE.Group | null;
  crate: THREE.Group | null;
  barrel: THREE.Group | null;
  lamp: THREE.Group | null;
}

const INITIAL_PROP_SET: PropSet = {
  cabin: null,
  chimney: null,
  palms: [],
  dock: null,
  boat: null,
  rocks: null,
  redRock: null,
  campfire: null,
  crate: null,
  barrel: null,
  lamp: null,
};


function placePropInto(
  set: PropSet,
  role: ModelRole,
  asset: THREE.Group,
  placement: { x: number; z: number; y: number; yaw: number; height: number; receive?: boolean },
): THREE.Group {
  const placementGroup = new THREE.Group();
  placementGroup.name = FRIENDLY_NAME[role] ?? role;
  const cloned = asset.clone(true);
  normaliseToHeight(cloned, placement.height, 0);
  const wrapper = new THREE.Group();
  wrapper.add(cloned);
  wrapper.rotation.y = placement.yaw;
  placementGroup.add(wrapper);
  placementGroup.position.set(placement.x, placement.y, placement.z);
  setShadowFlags(placementGroup, true, placement.receive ?? true);
  switch (role) {
    case 'house':
      set.cabin = placementGroup;
      break;
    case 'palm':
      set.palms.push(placementGroup);
      break;
    case 'dock':
      set.dock = placementGroup;
      break;
    case 'boat':
      set.boat = placementGroup;
      break;
    case 'rocks':
      set.rocks = placementGroup;
      break;
    case 'redRock':
      set.redRock = placementGroup;
      break;
    case 'campfire':
      set.campfire = placementGroup;
      break;
    case 'crate':
      set.crate = placementGroup;
      break;
    case 'barrel':
      set.barrel = placementGroup;
      break;
    case 'lamp':
      set.lamp = placementGroup;
      break;
  }
  return placementGroup;
}


// ---------- log benches ---------------------------------------------------

function buildLogBenches(sampleAt: (x: number, z: number) => BeachSample, x: number, z: number): THREE.Group {
  const sample = sampleAt(x, z);
  const group = new THREE.Group();
  group.name = 'Log benches';
  const logMat = new THREE.MeshStandardMaterial({
    color: PALETTE.hullWarm.clone().multiplyScalar(0.85),
    roughness: 0.95,
    metalness: 0,
  });
  const logGeometry = new THREE.CylinderGeometry(0.09, 0.1, 0.85, 8);
  for (let i = 0; i < 4; i += 1) {
    const log = new THREE.Mesh(logGeometry, logMat);
    log.castShadow = true;
    log.receiveShadow = true;
    const a = (i / 4) * Math.PI * 2;
    const dx = Math.cos(a) * 0.8, dz = Math.sin(a) * 0.8;
    log.position.set(dx, sampleAt(x + dx, z + dz).y - sample.y + 0.095, dz);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = Math.PI / 2 - a;
    log.userData.explodeWithParent = false;
    group.add(log);
  }
  group.position.set(x, sample.y, z);
  return group;
}


// ---------- lantern glass and nighttime light -------------------------------

function installLanternGlow(placement: THREE.Group, night: THREE.IUniform<number>): THREE.PointLight {
  const light = new THREE.PointLight(0xffb864, 0.08, 4.5, 2);
  let lightOwner: THREE.Mesh | undefined;
  placement.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const mesh = object;
    const geometry = mesh.geometry;
    const evidence = geometry.userData.surfaceEvidence as SurfaceEvidence;
    if (!evidence?.glassBounds) return;
    const glassBounds = new THREE.Box3(
      new THREE.Vector3().fromArray(evidence.glassBounds.min),
      new THREE.Vector3().fromArray(evidence.glassBounds.max),
    );
    const center = glassBounds.getCenter(new THREE.Vector3());
    const halfSize = glassBounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = materials.map((source) => {
      const material = source.clone() as THREE.MeshStandardMaterial;
      if (!lightOwner) {
        lightOwner = mesh;
        light.position.copy(center);
      }
      const previousCompile = source.onBeforeCompile;
      material.onBeforeCompile = (shader, renderer): void => {
        previousCompile.call(material, shader, renderer);
        shader.uniforms.islandLampNight = night;
        shader.uniforms.islandLampCenter = { value: center };
        shader.uniforms.islandLampHalfSize = { value: halfSize };
        shader.vertexShader = 'varying vec3 lampPosition;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
          #include <begin_vertex>
          lampPosition = position;
        `);
        shader.fragmentShader = `
          uniform float islandLampNight;
          uniform vec3 islandLampCenter;
          uniform vec3 islandLampHalfSize;
          varying vec3 lampPosition;
        ` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
          #include <emissivemap_fragment>
          vec3 p = (lampPosition - islandLampCenter) / islandLampHalfSize;
          float enclosure = 1.0 - smoothstep(1.0, 1.08, max(abs(p.x), abs(p.z)));
          float core = exp(-3.0 * (p.y * p.y + min(p.x * p.x, p.z * p.z)));
          float glass = smoothstep(0.45, 0.72, diffuseColor.r)
            * smoothstep(0.12, 0.3, diffuseColor.g)
            * (1.0 - smoothstep(0.025, 0.1, diffuseColor.b))
            * (1.0 - smoothstep(0.65, 1.0, abs(p.y))) * enclosure;
          totalEmissiveRadiance += vec3(1.6, 0.65, 0.08) * glass * core * islandLampNight;
        `);
      };
      material.customProgramCacheKey = () => 'tropical-lantern-measured-glass-v3';
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!;
  });
  if (!lightOwner) throw new Error('Lamp asset has no measurable glass enclosure');
  lightOwner.add(light);
  return light;
}

// ---------- assembly -------------------------------------------------------

const PATH_SAMPLES: ReadonlyArray<{ x: number; z: number; radius: number }> = [
  { x: -1.5, z: -2.6, radius: 0.23 },
  { x: -1.65, z: -1.4, radius: 0.25 },
  { x: -1.45, z: -0.4, radius: 0.25 },
  { x: -0.9, z: 0.75, radius: 0.3 },
  { x: 0.15, z: 1.35, radius: 0.3 },
  { x: 1.3, z: 1.9, radius: 0.28 },
  { x: 2.3, z: 2.7, radius: 0.3 },
];

interface PropSlot {
  x: number;
  z: number;
  y: number;
  yaw: number;
  height: number;
  snapToGround?: boolean;
}

const PROP_SLOTS: Record<ModelRole, PropSlot> = {
  house: { x: 0, z: -0.65, y: 0, yaw: Math.PI, height: 2.15 },
  palm: { x: -2.6, z: -1.5, y: 0, yaw: -0.4, height: 3.6 },
  dock: { x: 3.4, z: 3.4, y: -0.35, yaw: 1.0, height: 0.9 },
  boat: { x: 5.3, z: 4.55, y: -0.12, yaw: Math.PI - 0.45, height: 0.52 },
  rocks: { x: -2.8, z: 1.3, y: 0, yaw: 0.4, height: 1.0 },
  redRock: { x: 6.3, z: -4.5, y: -0.08, yaw: 0.3, height: 1.9 },
  campfire: { x: -1.5, z: 1.75, y: 0, yaw: 0, height: 0.6 },
  crate: { x: -1.3, z: 0.05, y: 0, yaw: 0.2, height: 0.42 },
  barrel: { x: 1.36, z: 0.45, y: 0, yaw: 0.3, height: 0.52 },
  lamp: { x: 1.9, z: 2.3, y: 0, yaw: 0, height: 1.15 },
};

const PALM_SLOTS: ReadonlyArray<{ x: number; z: number; yaw: number }> = [
  { x: -2.6, z: -1.3, yaw: -0.4 },
  { x: -1.0, z: -2.4, yaw: 0.5 },
  { x: 1.6, z: -1.7, yaw: -0.7 },
  { x: 2.5, z: 0.4, yaw: 0.9 },
];

export function createTropicalIslandModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Tropical Island';
  let disposed = false;
  let environment: TropicalEnvironment | undefined;
  let environmentElapsed = 0;
  let removeInteraction: (() => void) | undefined;
  const palmWind: PalmWind[] = [];
  const chimneySmoke: ChimneySmoke[] = [];
  let boatBody: BuoyantBody | undefined;
  let boatNode: THREE.Object3D | undefined;
  const boatRestPosition = new THREE.Vector3();
  const boatRestRotation = new THREE.Quaternion();
  const lanternNight = { value: 0 };
  let lanternLight: THREE.PointLight | undefined;

  const shape = buildIslandShape();
  const beach = buildBeachMesh(shape);
  root.add(beach.mesh);

  paintPathMask(beach.colors, beach.positions, PATH_SAMPLES);
  (beach.mesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

  const ocean = buildOceanPlane(shape);
  root.userData.stageOcean = ocean.mesh;
  Object.defineProperty(root.userData, 'ocean', { value: ocean });
  const rockDrops = createRockDrops(ocean, root, beach.mesh);
  Object.defineProperty(root.userData, 'rockDrops', { value: rockDrops });
  const shoreResponse = new ShoreResponse(ocean.simulation);
  Object.defineProperty(root.userData, 'shoreResponse', { value: shoreResponse });
  const shoreMotion: ShoreMotion = { x: 0, z: 0, velocityX: 0, velocityZ: 0 };
  const shoreBodies: Array<{
    node: THREE.Object3D; x: number; z: number; tilt: number; sensitivity: number;
    rotation: THREE.Quaternion; y: number; baseY: number; mass: number;
    width: number; height: number; yaw: number; angleX: number; angleZ: number;
    velocityX: number; velocityZ: number; influence: number;
  }> = [];
  const registerShoreBody = (node: THREE.Object3D, x: number, z: number, tilt: number,
    mass = 25, width = 0.45, height = 0.6, baseY = beach.sampleAt(x, z).y, yaw = 0): void => {
    shoreBodies.push({ node, x, z, tilt, sensitivity: 100, rotation: node.quaternion.clone(),
      y: node.position.y, baseY: baseY - ocean.mesh.position.y, mass, width, height, yaw,
      angleX: 0, angleZ: 0, velocityX: 0, velocityZ: 0, influence: 0 });
  };
  // Local support deformation leaves native placement/explode transforms alone.
  const registerProp = (placement: THREE.Group, tilt: number, mass = 25): void => {
    const size = new THREE.Box3().setFromObject(placement).getSize(new THREE.Vector3());
    const palm = placement.name.startsWith('Palm');
    const width = palm ? 0.18 : Math.max(0.1, Math.min(size.y, Math.max(size.x, size.z)));
    const wrapper = placement.children[0]!;
    registerShoreBody(wrapper, placement.position.x, placement.position.z, tilt,
      mass, width, size.y, placement.position.y, wrapper.rotation.y + placement.rotation.y);
  };
  const waveContact: WaveContact = {
    x: 0, z: 0, baseY: 0, width: 0, height: 0, normalX: 0, normalZ: 0, velocityX: 0, velocityZ: 0,
  };
  const waveLoad: WaveLoad = { forceX: 0, forceZ: 0, pressure: 0, immersion: 0, influence: 0, breaking: 0 };
  const shoreRotation = new THREE.Euler(), shoreQuaternion = new THREE.Quaternion();
  Object.defineProperty(root.userData, 'waveBodies', { value: shoreBodies });
  let previousShoreTime = 0;
  let fireDousingActive = false, fireQuietTime = 0;
  installWetBeach(beach.mesh, ocean.uniforms);

  const foam = buildFoamRing(shape, ocean.uniforms);
  root.add(foam);

  const vegetationSample = (x: number, z: number): BeachSample => {
    const sample = beach.sampleAt(x, z);
    let excluded = Math.abs(x) < 1.15 && z > -1.85 && z < 0.7;
    excluded ||= Math.hypot(x - PROP_SLOTS.campfire.x, z - PROP_SLOTS.campfire.z) < 1.15;
    for (let i = 1; !excluded && i < PATH_SAMPLES.length; i += 1) {
      const a = PATH_SAMPLES[i - 1]!, b = PATH_SAMPLES[i]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
      excluded = Math.hypot(x - a.x - t * dx, z - a.z - t * dz) < a.radius + t * (b.radius - a.radius) + 0.12;
    }
    for (const role of ['crate', 'barrel', 'lamp'] as const) {
      const slot = PROP_SLOTS[role];
      excluded ||= Math.hypot(x - slot.x, z - slot.z) < slot.height * 0.6;
    }
    if (excluded) sample.onGrass = sample.onSand = false;
    return sample;
  };
  const shrubs = createShrubs(vegetationSample);
  const grass = createGrass(vegetationSample);
  const pebbles = new THREE.Group();
  pebbles.name = 'Beach pebbles';
  scatterPebbles(pebbles, beach.sampleAt);
  root.add(shrubs.group, grass.group, pebbles);
  for (const cluster of shrubs.group.children) {
    registerShoreBody(cluster, cluster.position.x, cluster.position.z, 0.22, 1.5, 0.2, 0.55);
  }
  for (const tuft of grass.group.children) {
    registerShoreBody(tuft, tuft.position.x, tuft.position.z, 0.35, 0.035, 0.04, 0.25);
  }
  scatterStarfish(root, beach.sampleAt);

  const propSet: PropSet = { ...INITIAL_PROP_SET, palms: [] };
  const benches = buildLogBenches(beach.sampleAt, PROP_SLOTS.campfire.x, PROP_SLOTS.campfire.z);
  root.add(benches);
  for (const bench of benches.children) {
    registerShoreBody(bench, benches.position.x + bench.position.x,
      benches.position.z + bench.position.z, 0.08);
  }

  const fireVfx = createCampfireVfx();
  Object.defineProperty(root.userData, 'campfireVfx', { value: fireVfx });
  fireVfx.group.position.set(PROP_SLOTS.campfire.x,
    beach.sampleAt(PROP_SLOTS.campfire.x, PROP_SLOTS.campfire.z).y, PROP_SLOTS.campfire.z);
  root.add(fireVfx.group);

  {
    const assets = new Map<ModelRole, THREE.Group>();
    for (const role of Object.keys(FRIENDLY_NAME) as ModelRole[]) {
      const asset = createMeasuredProp(role);
      // Retain friendly scene-level selection groups. Original source names and
      // transforms remain in the measured manifest rather than extra inspector parts.
      asset.traverse((object) => {
        object.name = '';
        if (object instanceof THREE.Mesh) {
          object.userData.explodeWithParent = false;
          object.castShadow = object.receiveShadow = true;
        }
      });
      assets.set(role, asset);
    }

    const surfaceY = (slot: PropSlot): number =>
      slot.snapToGround === false ? slot.y : beach.sampleAt(slot.x, slot.z).y;

    const cabinAsset = assets.get('house');
    if (cabinAsset) {
      const slot = PROP_SLOTS.house;
      const placement = placePropInto(propSet, 'house', cabinAsset, {
        x: slot.x,
        z: slot.z,
        y: surfaceY(slot),
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      root.add(placement);
      const chimney = buildChimney(beach.sampleAt, slot.x - 0.4, slot.z - 0.1);
      chimney.name = 'Chimney 1';
      chimney.position.y += slot.height * 0.72;
      const rearChimney = chimney.clone(true);
      rearChimney.name = 'Chimney 2';
      rearChimney.scale.setScalar(0.7);
      rearChimney.position.set(slot.x + 0.4,
        beach.sampleAt(slot.x + 0.4, slot.z - 0.6).y + slot.height * 0.78, slot.z - 0.6);
      root.add(chimney, rearChimney);
      propSet.chimney = chimney;
      // The house and its chimneys are fixed foundations: never register wave rocking.
      for (const stack of [chimney, rearChimney]) {
        const smoke = createChimneySmoke(1.37 + chimneySmoke.length * 7.13);
        smoke.group.position.y = 0.80;
        stack.add(smoke.group);
        // Inspector isolation hides retained meshes, not their container groups.
        stack.getObjectByProperty('isMesh', true)!.attach(smoke.group);
        chimneySmoke.push(smoke);
      }
    }

    const palmAsset = assets.get('palm');
    if (palmAsset) {
      for (const palmSlot of PALM_SLOTS) {
        const placement = placePropInto(propSet, 'palm', palmAsset, {
          x: palmSlot.x,
          z: palmSlot.z,
          y: beach.sampleAt(palmSlot.x, palmSlot.z).y,
          yaw: palmSlot.yaw,
          height: PROP_SLOTS.palm.height,
          receive: true,
        });
        root.add(placement);
        placement.name = `Palm ${propSet.palms.length}`;
        palmWind.push(createPalmWind(placement, (propSet.palms.length - 1) * 2.1));
        const support = new THREE.Group();
        for (const child of [...placement.children]) support.add(child);
        placement.add(support);
        registerProp(placement, 0.12, 85);
      }
    }

    const dockAsset = assets.get('dock');
    if (dockAsset) {
      const slot = PROP_SLOTS.dock;
      const placement = placePropInto(propSet, 'dock', dockAsset, {
        x: slot.x,
        z: slot.z,
        y: slot.y,
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      root.add(placement);
      registerProp(placement, 0.055, 240);
    }

    const boatAsset = assets.get('boat');
    if (boatAsset) {
      const slot = PROP_SLOTS.boat;
      const placement = placePropInto(propSet, 'boat', boatAsset, {
        x: slot.x,
        z: slot.z,
        y: slot.y,
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      root.add(placement);
      boatNode = placement.children[0]!;
      boatRestPosition.copy(boatNode.position);
      boatRestRotation.copy(boatNode.quaternion);
      boatBody = new BuoyantBody(ocean.simulation, {
        x: slot.x, z: slot.z, yaw: slot.yaw, halfLength: 0.85, halfWidth: 0.30,
        draft: 0.12, mass: 110, mooring: 110,
      });
      Object.defineProperty(placement.userData, 'buoyancy', { value: boatBody });
    }

    const rocksAsset = assets.get('rocks');
    if (rocksAsset) {
      const slot = PROP_SLOTS.rocks;
      const placement = placePropInto(propSet, 'rocks', rocksAsset, {
        x: slot.x,
        z: slot.z,
        y: surfaceY(slot),
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      root.add(placement);
      const clusters = [
        { x: -3.2, z: -0.8, height: 0.8 },
        { x: 3.3, z: 0.9, height: 0.8 },
        { x: -4.4, z: 2.9, height: 1.1 },
        { x: -4.6, z: 4.0, height: 0.55 },
      ];
      for (let i = 0; i < clusters.length; i += 1) {
        const cluster = clusters[i]!;
        const offshore = i >= 2;
        const rocks = placePropInto(propSet, 'rocks', rocksAsset, {
          ...cluster, y: offshore ? -0.17 : beach.sampleAt(cluster.x, cluster.z).y,
          yaw: i * 1.7, receive: true,
        });
        rocks.name = offshore ? `Offshore rocks ${i - 1}` : `Shore rocks ${i + 1}`;
        root.add(rocks);
      }
    }

    const redRockAsset = assets.get('redRock');
    if (redRockAsset) {
      const slot = PROP_SLOTS.redRock;
      const placement = placePropInto(propSet, 'redRock', redRockAsset, {
        x: slot.x,
        z: slot.z,
        y: slot.y,
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      root.add(placement);
    }

    const campfireAsset = assets.get('campfire');
    if (campfireAsset) {
      const slot = PROP_SLOTS.campfire;
      const placement = placePropInto(propSet, 'campfire', campfireAsset, {
        x: slot.x,
        z: slot.z,
        y: surfaceY(slot),
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      const correction = correctCampfireModel(placement);
      placement.userData.fireCorrection = correction;
      fireVfx.group.position.y = placement.position.y + correction.emitterY;
      root.add(placement);
      // Keep flame volume, smoke, sparks and light with the fire during isolation/explosion.
      placement.getObjectByProperty('isMesh', true)!.attach(fireVfx.group);
      registerProp(placement, 0.09);
    }

    const crateAsset = assets.get('crate');
    if (crateAsset) {
      const slot = PROP_SLOTS.crate;
      const placement = placePropInto(propSet, 'crate', crateAsset, {
        x: slot.x,
        z: slot.z,
        y: surfaceY(slot),
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      const secondCrate = placement.clone(true);
      secondCrate.name = 'Crate 2';
      secondCrate.position.z += 0.55;
      secondCrate.position.y = beach.sampleAt(secondCrate.position.x, secondCrate.position.z).y;
      secondCrate.rotation.y = -0.2;
      root.add(placement, secondCrate);
      registerProp(placement, 0.10);
      registerProp(secondCrate, 0.10);
    }

    const barrelAsset = assets.get('barrel');
    if (barrelAsset) {
      const slot = PROP_SLOTS.barrel;
      const placement = placePropInto(propSet, 'barrel', barrelAsset, {
        x: slot.x,
        z: slot.z,
        y: surfaceY(slot),
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      root.add(placement);
      registerProp(placement, 0.12);
    }

    const lampAsset = assets.get('lamp');
    if (lampAsset) {
      const slot = PROP_SLOTS.lamp;
      const placement = placePropInto(propSet, 'lamp', lampAsset, {
        x: slot.x,
        z: slot.z,
        y: surfaceY(slot),
        yaw: slot.yaw,
        height: slot.height,
        receive: true,
      });
      root.add(placement);
      lanternLight = installLanternGlow(placement, lanternNight);
      registerProp(placement, 0.16);
    }
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    removeInteraction?.();
    rockDrops.dispose();
    for (const smoke of chimneySmoke) smoke.dispose();
    shrubs.dispose();
    grass.dispose();
    ocean.dispose();
    fireVfx.dispose();
    for (const wind of palmWind) wind.dispose();
    environment?.dispose();
  };
  root.userData.dispose = dispose;
  root.userData.mountViewerInteraction = (viewer: Viewer): (() => void) => {
    environment = viewer.scene.userData.tropicalEnvironment as TropicalEnvironment | undefined;
    root.userData.tropicalEnvironment = environment;
    removeInteraction = mountWaterInteraction(viewer, root, ocean, fireVfx,
      (x, z) => { rockDrops.drop(x, z, reduceMotion.matches); }, rockDrops.canDrop);
    return dispose;
  };
  root.userData.tick = (_dt: number, elapsed: number): void => {
    if (disposed) return;
    const reduced = reduceMotion.matches;
    if (!reduced) environmentElapsed = elapsed;
    environment?.tick(environmentElapsed);
    const daylight = environment?.daylight ?? 1;
    ocean.uniforms.islandDaylight.value = daylight;
    (ocean.mesh.material as THREE.MeshPhysicalMaterial).envMapIntensity = 0.08 + daylight * 0.72;
    ocean.tick(elapsed, reduced);
    rockDrops.tick(reduced);
    const shoreTime = ocean.uniforms.islandTime.value;
    const shoreDt = shoreTime - previousShoreTime;
    previousShoreTime = shoreTime;
    if (!reduced && shoreDt > 0) {
      const fireLoad = shoreResponse.advance(shoreDt, PROP_SLOTS.campfire);
      for (const body of shoreBodies) {
        shoreResponse.sample(body.x, body.z, shoreMotion);
        waveContact.x = body.x;
        waveContact.z = body.z;
        waveContact.baseY = body.baseY;
        waveContact.width = body.width;
        waveContact.height = body.height;
        let forceX = 0, forceZ = 0;
        body.influence = 0;
        for (let face = 0; face < 4; face += 1) {
          const angle = body.yaw + face * Math.PI / 2;
          waveContact.normalX = Math.cos(angle);
          waveContact.normalZ = Math.sin(angle);
          sampleWaveLoad(ocean.simulation, waveContact, waveLoad);
          forceX += waveLoad.forceX;
          forceZ += waveLoad.forceZ;
          body.influence = Math.max(body.influence, waveLoad.influence);
        }
        const restoringMoment = body.mass * 9.81 * body.width * 0.5;
        const targetX = body.tilt * Math.tanh(shoreMotion.z * body.sensitivity
          + forceZ * body.height * 0.5 / restoringMoment);
        const targetZ = -body.tilt * Math.tanh(shoreMotion.x * body.sensitivity
          + forceX * body.height * 0.5 / restoringMoment);
        const frequency = 2.2 * Math.sqrt(9.81 / Math.max(0.2, body.height));
        let remaining = shoreDt;
        while (remaining > 0) {
          const dt = Math.min(remaining, 1 / 120);
          const damping = Math.exp(-1.4 * frequency * dt);
          body.velocityX = (body.velocityX + (targetX - body.angleX) * frequency * frequency * dt) * damping;
          body.velocityZ = (body.velocityZ + (targetZ - body.angleZ) * frequency * frequency * dt) * damping;
          body.angleX += body.velocityX * dt;
          body.angleZ += body.velocityZ * dt;
          remaining -= dt;
        }
        shoreRotation.set(body.angleX, 0, body.angleZ);
        shoreQuaternion.setFromEuler(shoreRotation);
        body.node.quaternion.copy(body.rotation).premultiply(shoreQuaternion);
        body.node.position.y = body.y;
      }
      // A propagated large shore shock/spray episode quenches the flame once.
      // Clicking during its tail does not immediately undo the user's relight.
      if (fireLoad > 0.0005 && !fireDousingActive) {
        fireVfx.extinguish();
        fireDousingActive = true;
        fireQuietTime = 0;
      } else if (fireDousingActive) {
        fireQuietTime = fireLoad < 0.0002 ? fireQuietTime + shoreDt : 0;
        if (fireQuietTime > 0.6) fireDousingActive = false;
      }
    }
    fireVfx.tick(elapsed, 1 - daylight, reduced);
    lanternNight.value = 1 - daylight;
    if (lanternLight) lanternLight.intensity = 0.08 + (1 - daylight) * 1.9;
    if (boatBody && boatNode) {
      boatBody.advance(shoreDt, reduced);
      const pose = boatBody.state;
      boatNode.position.set(boatRestPosition.x + pose.surgeX, boatRestPosition.y + pose.heave,
        boatRestPosition.z + pose.surgeZ);
      shoreRotation.set(pose.pitch, 0, pose.roll);
      shoreQuaternion.setFromEuler(shoreRotation);
      boatNode.quaternion.copy(boatRestRotation).multiply(shoreQuaternion);
    }
    for (const smoke of chimneySmoke) smoke.tick(elapsed, daylight, reduced);
    shrubs.tick(elapsed, reduced, daylight);
    grass.tick(elapsed, reduced, daylight);
    for (const wind of palmWind) wind.tick(elapsed, reduced);
  };

  return root;
}