/** Vertical entry over clear, deep sea. Admission reserves the rotating
 *  boulder's footprint; submerged motion remains driven by the live fluid. */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { OceanPlane } from './ocean';
import { createEntrySplashes, type EntrySplash } from './entrySplash';
import { stepWaterEntry, GRAVITY as G, type EntryBody, type EntryStep, type EntryWater } from './waterEntryDynamics';
import { createMeteorTrails, type MeteorTrail } from './meteorTrail';
import { createEntrySteams, type EntrySteam } from './entrySteam';

const RADIUS = 0.72;
const FALL = 4;
const ENTRY_SPEED = 12;
const POOL = 5;
const PHYSICS_STEP = 1 / 240;
/** Enough resting and instantaneous depth to contain the whole boulder. */
const FOOTPRINT_CLEARANCE = 0.15;
const ADMISSION_PAD = 0.5;
const SIM_EXTENT = 100;
type WaterMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;

function noise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  let result = 0;
  for (let k = 0; k < 8; k++) {
    const a = k & 1, b = (k >> 1) & 1, c = (k >> 2) & 1;
    const h = Math.sin((ix + a) * 127.1 + (iy + b) * 311.7 + (iz + c) * 74.7 + seed) * 43758.5453;
    result += (2 * (h - Math.floor(h)) - 1) * (a ? sx : 1 - sx) * (b ? sy : 1 - sy) * (c ? sz : 1 - sz);
  }
  return result;
}

function boulder(seed: number): THREE.BufferGeometry {
  const raw = new THREE.IcosahedronGeometry(RADIUS, 3);
  raw.deleteAttribute('uv');
  raw.deleteAttribute('normal');
  const geometry = mergeVertices(raw);
  raw.dispose();
  const p = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const broad = noise(x * 2, y * 2, z * 2, seed);
    const fine = noise(x * 9, y * 9, z * 9, seed + 17);
    const scale = 1 + 0.23 * broad + 0.055 * fine;
    p.setXYZ(i, x * scale, y * scale * 0.88, z * scale * 1.06);
    const mineral = 0.58 + 0.20 * broad + 0.14 * fine;
    colors[i * 3] = mineral;
    colors[i * 3 + 1] = mineral * 0.92;
    colors[i * 3 + 2] = mineral * 0.84;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

function flightDistance(age: number): number {
  return ENTRY_SPEED * age + 0.5 * G * age * age;
}

interface Slot {
  state: 0 | 1 | 2;
  born: number; startY: number; previousAge: number; integratedAge: number;
  bottom: number; top: number; contactCentre: number; flightAge: number;
  wetLevel: number; resting: number;
  axis: THREE.Vector3; initialRotation: THREE.Quaternion;
  rock: WaterMesh; meteor: MeteorTrail; splash: EntrySplash; steam: EntrySteam;
  body: EntryBody; water: EntryWater; step: EntryStep;
  launchX: number; launchZ: number;
}

export interface RockDrops {
  readonly group: THREE.Group;
  canDrop(x: number, z: number): boolean;
  drop(x: number, z: number, reducedMotion?: boolean): boolean;
  /** Advance body/parcel physics at the ocean's current CFL-substep clock. */
  advance(): void;
  /** Update visible effects once per render frame; cancel if motion is reduced. */
  render(reducedMotion?: boolean): void;
  dispose(): void;
}

/** Rendering stays in Three.js; the numeric body/field exchange is explicit. */
export function createRockDrops(
  ocean: OceanPlane,
  solidRoot: THREE.Object3D,
  terrain: THREE.Object3D,
): RockDrops {
  const group = new THREE.Group();
  group.name = 'Rock drops';
  group.userData.isRuntimeEffect = true;
  group.userData.isPointerTransparent = true;
  ocean.mesh.add(group);
  const seaMaterial = ocean.mesh.material as THREE.MeshPhysicalMaterial;
  const splashes = createEntrySplashes(ocean);
  const meteors = createMeteorTrails(POOL, RADIUS, ENTRY_SPEED, G);
  const steams = createEntrySteams(POOL);
  const surface = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const spinAxis = new THREE.Vector3();
  const volume = 4 / 3 * Math.PI * RADIUS ** 3;
  const mass = 2650 * volume;
  const slots: Slot[] = [];
  let disposed = false;
  const simulation = ocean.simulation;
  const axis = simulation.axis;
  const cellWidths = simulation.cellWidths;
  const size = simulation.size;
  const depth = simulation.depth;
  const bed = simulation.bed;

  for (let i = 0; i < POOL; i++) {
    const rock = new THREE.Mesh(boulder(i * 9.13 + 2.7), new THREE.MeshPhysicalMaterial({
      color: 0x777773, vertexColors: true, roughness: 0.85,
      transparent: true, envMap: seaMaterial.envMap, envMapIntensity: 0.35,
    }));
    rock.material.onBeforeCompile = (shader): void => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMeteorLocal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMeteorLocal = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vMeteorLocal;
          float meteorHash(vec3 p) {
            return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
          }
          float meteorNoise(vec3 p) {
            vec3 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(meteorHash(i), meteorHash(i + vec3(1,0,0)), f.x),
                           mix(meteorHash(i + vec3(0,1,0)), meteorHash(i + vec3(1,1,0)), f.x), f.y),
                       mix(mix(meteorHash(i + vec3(0,0,1)), meteorHash(i + vec3(1,0,1)), f.x),
                           mix(meteorHash(i + vec3(0,1,1)), meteorHash(i + vec3(1,1,1)), f.x), f.y), f.z);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float crust = meteorNoise(vMeteorLocal * 7.0);
          float fissure = 1.0 - smoothstep(0.018, 0.065, abs(crust - 0.5));
          float heatMask = smoothstep(0.25, 0.7, meteorNoise(vMeteorLocal * 3.0 + 17.0));
          totalEmissiveRadiance *= 0.015 + fissure * heatMask * 2.5;
          diffuseColor.rgb *= 0.45 + 0.55 * smoothstep(0.2, 0.8, crust);`);
    };
    rock.material.customProgramCacheKey = (): string => 'meteor-crust-v1';
    rock.name = 'Falling rock';
    rock.castShadow = true;
    rock.visible = false;
    rock.frustumCulled = false;
    rock.userData.isRuntimeEffect = true;
    rock.userData.isPointerTransparent = true;
    const meteor = meteors.trails[i]!;
    const splash = splashes.create(rock);
    const steam = steams.steams[i]!;
    group.add(rock, meteor.group, splash.group, steam.group);
    slots.push({
      state: 0, born: 0, startY: 0, previousAge: 0, integratedAge: 0,
      bottom: 0, top: 0, contactCentre: 0, flightAge: 0, wetLevel: 0, resting: 0,
      axis: new THREE.Vector3(Math.sin(i + 1), 0.4, Math.cos(i + 1)).normalize(),
      initialRotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.71, i * 1.37, i * 0.43)),
      rock, meteor, splash, steam, launchX: 0, launchZ: 0,
      body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0,
        radius: RADIUS, mass, volume, inertia: 0.4 * mass * RADIUS * RADIUS, submergedVolume: 0 },
      water: { height: 0, depth: 0, bed: 0, slopeX: 0, slopeZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0 },
      step: { impulseX: 0, impulseY: 0, impulseZ: 0, work: 0, displacedVolume: 0, submerged: 0, normalSpeed: 0, grounded: false },
    });
  }
  // Enclose every rotated vertex about the pivot, including off-centre geometry.
  let footprintRadius = RADIUS;
  for (const slot of slots) {
    const sphere = slot.rock.geometry.boundingSphere;
    if (!sphere) continue;
    const candidate = sphere.radius + sphere.center.length();
    if (candidate > footprintRadius) footprintRadius = candidate;
  }
  const collisionRadius = footprintRadius + ADMISSION_PAD;
  const requiredDepth = 2 * footprintRadius + FOOTPRINT_CLEARANCE;

  const seaY = (x: number, z: number): number => {
    ocean.sampleSurface(x, z, surface);
    return surface.x;
  };
  const bounds = (slot: Slot, quaternion: THREE.Quaternion): void => {
    const { x, y, z, w } = quaternion;
    const m10 = 2 * (x * y + w * z);
    const m11 = 1 - 2 * (x * x + z * z);
    const m12 = 2 * (y * z - w * x);
    const p = slot.rock.geometry.getAttribute('position').array;
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const ry = m10 * p[i]! + m11 * p[i + 1]! + m12 * p[i + 2]!;
      if (ry < low) low = ry;
      if (ry > high) high = ry;
    }
    slot.bottom = low; slot.top = high;
  };
  const pose = (slot: Slot, age: number): void => {
    rotation.setFromAxisAngle(slot.axis, age * 0.9).multiply(slot.initialRotation);
    bounds(slot, rotation);
  };
  const cancel = (slot: Slot, refund = true): void => {
    slot.state = 0;
    slot.rock.visible = false;
    slot.splash.reset(refund);
    slot.meteor.hide();
    slot.steam.hide();
    slot.rock.material.emissiveIntensity = 0;
  };

  const bracketAxis = (value: number, ax: Float32Array): number => {
    const n = ax.length;
    if (value <= ax[0]!) return 0;
    if (value >= ax[n - 1]!) return n - 2;
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (ax[mid]! <= value) lo = mid; else hi = mid;
    }
    return lo;
  };

  const propBox = new THREE.Box3();
  const oceanInv = new THREE.Matrix4();
  const meshMatrix = new THREE.Matrix4();
  const clearanceSquared = collisionRadius * collisionRadius;
  let queryX = 0, queryZ = 0;

  const solidOverlaps = (object: THREE.Object3D): boolean => {
    if (!object.visible || object === ocean.mesh || object === terrain
      || object.name === 'Shoreline foam ring'
      || object.userData.isRuntimeEffect || object.userData.isHighlight) return false;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      const instanced = mesh as THREE.InstancedMesh;
      let box: THREE.Box3 | null;
      if (instanced.isInstancedMesh) {
        instanced.computeBoundingBox();
        box = instanced.boundingBox;
      } else {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        box = mesh.geometry.boundingBox;
      }
      // Only this mesh's geometry: attached smoke/highlights are not solid.
      if (box && !box.isEmpty()) {
        meshMatrix.multiplyMatrices(oceanInv, mesh.matrixWorld);
        propBox.copy(box).applyMatrix4(meshMatrix);
        const dx = Math.max(propBox.min.x - queryX, 0, queryX - propBox.max.x);
        const dz = Math.max(propBox.min.z - queryZ, 0, queryZ - propBox.max.z);
        if (dx * dx + dz * dz <= clearanceSquared) return true;
      }
    }
    for (const child of object.children) if (solidOverlaps(child)) return true;
    return false;
  };

  const discClearsDepth = (x: number, z: number): boolean => {
    const x0 = bracketAxis(x - collisionRadius, axis);
    const x1 = Math.min(size - 1, bracketAxis(x + collisionRadius, axis) + 1);
    const z0 = bracketAxis(z - collisionRadius, axis);
    const z1 = Math.min(size - 1, bracketAxis(z + collisionRadius, axis) + 1);
    for (let zi = z0; zi <= z1; zi++) {
      const dz = Math.max(0, Math.abs(axis[zi]! - z) - cellWidths[zi]! * 0.5);
      for (let xi = x0; xi <= x1; xi++) {
        const dx = Math.max(0, Math.abs(axis[xi]! - x) - cellWidths[xi]! * 0.5);
        if (dx * dx + dz * dz > clearanceSquared) continue;
        const i = zi * size + xi;
        if (!(-bed[i]! >= requiredDepth && depth[i]! >= requiredDepth)) return false;
      }
    }
    return true;
  };

  const canDrop = (x: number, z: number): boolean => {
    if (disposed || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (Math.abs(x) + collisionRadius > SIM_EXTENT
      || Math.abs(z) + collisionRadius > SIM_EXTENT) return false;
    let available = false;
    for (const slot of slots) {
      if (slot.state === 0) { available = true; continue; }
      const dx = x - slot.body.x, dz = z - slot.body.z;
      if (dx * dx + dz * dz <= 4 * clearanceSquared) return false;
    }
    if (!available || !discClearsDepth(x, z)) return false;
    // Refresh at hover/admission, not per frame: late mounts and moved parents
    // must affect the same predicate used by click and keyboard input.
    solidRoot.updateWorldMatrix(true, true);
    ocean.mesh.updateWorldMatrix(true, false);
    oceanInv.copy(ocean.mesh.matrixWorld).invert();
    queryX = x; queryZ = z;
    return !solidOverlaps(solidRoot);
  };

  const drop = (x: number, z: number, reducedMotion = false): boolean => {
    if (disposed) return false;
    if (!canDrop(x, z)) return false;
    if (reducedMotion) {
      ocean.acknowledge(x, z);
      return true;
    }
    let slot: Slot | undefined;
    for (const candidate of slots) {
      if (candidate.state === 0) { slot = candidate; break; }
    }
    if (!slot) return false;
    pose(slot, 0);
    const clickedSea = seaY(x, z);
    slot.born = ocean.uniforms.islandTime.value;
    slot.previousAge = 0;
    slot.launchX = x;
    slot.launchZ = z;
    slot.body.x = x;
    slot.body.z = z;
    slot.startY = clickedSea + FALL - slot.bottom;
    slot.state = 1;
    slot.flightAge = 0;
    slot.meteor.reset(slot.launchX, slot.startY, slot.launchZ, 0, 0);
    slot.meteor.tick(0, slot.startY, clickedSea, Math.min(1, seaMaterial.envMapIntensity / 0.8));
    slot.rock.position.set(slot.launchX, slot.startY, slot.launchZ);
    slot.rock.quaternion.copy(rotation);
    slot.rock.material.color.setHex(0x777773);
    slot.rock.material.roughness = 0.85;
    slot.rock.material.opacity = 1;
    slot.rock.material.emissive.setHex(0xff4a0c);
    slot.rock.material.emissiveIntensity = 0.95;
    slot.rock.visible = true;
    slot.integratedAge = slot.resting = 0;
    slot.splash.reset(false);
    slot.steam.hide();
    return true;
  };

  const beginEntry = (slot: Slot, age: number, clock: number): void => {
    const tA = slot.previousAge, tB = age;
    let lo = tA, hi = tB;
    // The field and launch coordinates stay fixed throughout this bisection.
    const sea = seaY(slot.launchX, slot.launchZ);
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5;
      pose(slot, mid);
      const rockBottom = slot.startY - flightDistance(mid) + slot.bottom;
      if (rockBottom <= sea) hi = mid; else lo = mid;
    }
    const contactAge = (lo + hi) * 0.5;
    pose(slot, contactAge);
    const body = slot.body;
    body.x = slot.launchX;
    body.y = slot.startY - flightDistance(contactAge);
    body.z = slot.launchZ;
    body.vx = 0; body.vy = -ENTRY_SPEED - G * contactAge; body.vz = 0;
    body.wx = slot.axis.x * 0.9; body.wy = slot.axis.y * 0.9; body.wz = slot.axis.z * 0.9;
    body.submergedVolume = 0;
    slot.rock.position.set(body.x, body.y, body.z);
    slot.rock.quaternion.copy(rotation);
    slot.contactCentre = body.y;
    slot.rock.material.emissiveIntensity = 0;
    slot.flightAge = contactAge;
    slot.meteor.quench(contactAge);
    slot.born = clock - (age - contactAge);
    slot.state = 2;
    slot.integratedAge = 0;
    slot.wetLevel = sea;
    slot.splash.begin(body.x, body.z, RADIUS);
    slot.steam.begin(body.x, slot.wetLevel, body.z, RADIUS);
  };

  const integrate = (slot: Slot, age: number): void => {
    const body = slot.body, water = slot.water, step = slot.step;
    while (slot.integratedAge < age - 1e-9) {
      const dt = Math.min(PHYSICS_STEP, age - slot.integratedAge);
      ocean.simulation.sampleKinematics(body.x, body.z, water);
      // beginEntry or the preceding substep already bounded this quaternion.
      stepWaterEntry(body, water, slot.bottom, slot.top, dt, step);
      spinAxis.set(body.wx, body.wy, body.wz);
      const spin = spinAxis.length();
      if (spin > 1e-9) {
        rotation.setFromAxisAngle(spinAxis.multiplyScalar(1 / spin), spin * dt);
        slot.rock.quaternion.premultiply(rotation).normalize();
      }
      bounds(slot, slot.rock.quaternion);
      if (step.grounded) body.y = Math.max(body.y, water.bed - slot.bottom);
      slot.rock.position.set(body.x, body.y, body.z);
      slot.splash.advance(dt);
      slot.splash.feed(body, step, water);
      const below = Math.max(0, water.height - (body.y + slot.top));
      const work = Math.max(0, step.work - slot.splash.allocatedWork + slot.splash.waveCredit);
      ocean.simulation.coupleBody(body.x, body.z, RADIUS + below * 0.5,
        step.displacedVolume, step.impulseX - slot.splash.impulseX,
        step.impulseZ - slot.splash.impulseZ, work * Math.exp(-below / RADIUS));
      slot.resting = slot.splash.finished && slot.steam.finished && step.grounded
        && Math.hypot(body.vx, body.vy, body.vz) < 0.08 ? slot.resting + dt : 0;
      slot.integratedAge += dt;
    }
  };

  const advance = (): void => {
    if (disposed) return;
    const clock = ocean.uniforms.islandTime.value;
    for (const slot of slots) {
      if (slot.state === 0) continue;
      if (slot.state === 1) {
        const age = Math.max(0, clock - slot.born);
        pose(slot, age);
        const centre = slot.startY - flightDistance(age);
        slot.rock.position.x = slot.launchX;
        slot.rock.position.z = slot.launchZ;
        const water = seaY(slot.launchX, slot.launchZ);
        if (centre + slot.bottom <= water && age > slot.previousAge) {
          beginEntry(slot, age, clock);
        } else {
          slot.rock.position.y = centre;
          slot.rock.quaternion.copy(rotation);
          slot.previousAge = age;
        }
      }
      if (slot.state === 2) integrate(slot, Math.max(0, clock - slot.born));
    }
  };

  const render = (reducedMotion = false): void => {
    if (disposed) return;
    const clock = ocean.uniforms.islandTime.value;
    const daylight = Math.min(1, seaMaterial.envMapIntensity / 0.8);
    let cancelled = false;
    for (const slot of slots) {
      if (slot.state === 0) continue;
      if (reducedMotion) { cancel(slot); cancelled = true; continue; }
      const age = Math.max(0, clock - slot.born);
      if (slot.state === 1) {
        slot.meteor.tick(age, slot.rock.position.y, seaY(slot.launchX, slot.launchZ), daylight);
        continue;
      }
      const water = seaY(slot.body.x, slot.body.z);
      slot.meteor.tick(slot.flightAge + age, slot.contactCentre, Math.max(slot.wetLevel, water), daylight);
      slot.steam.tick(age, daylight);
      slot.splash.render();
      const submergence = water - (slot.body.y + slot.top);
      const settledFade = slot.splash.finished && slot.steam.finished
        ? THREE.MathUtils.clamp((slot.resting - 0.5) * 2, 0, 1) : 0;
      slot.rock.material.opacity = (1 - THREE.MathUtils.clamp(submergence / (RADIUS * 0.65), 0, 1)) * (1 - settledFade);
      slot.rock.visible = slot.rock.material.opacity > 0.001;
      const wet = 1 - Math.exp(-age * 4);
      slot.rock.material.color.setHex(0x777773).multiplyScalar(1 - wet * 0.33);
      slot.rock.material.roughness = 0.85 - wet * 0.25;
      if (slot.splash.finished && slot.steam.finished && slot.resting > 1) cancel(slot, false);
    }
    if (cancelled) ocean.sync();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    group.removeFromParent();
    for (const slot of slots) {
      slot.rock.geometry.dispose(); slot.rock.material.dispose();
      slot.splash.dispose();
    }
    splashes.dispose();
    meteors.dispose();
    steams.dispose();
    slots.length = 0;
  };
  return { group, canDrop, drop, advance, render, dispose };
}
