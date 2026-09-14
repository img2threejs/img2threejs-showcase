import * as THREE from 'three';

/**
 * A small authored detail layer for the force-measured Ocean guitar.
 *
 * The measured surface is one indexed mesh with no full-length string parts.
 * This module therefore adds six low-cost tubes in the measured mesh's raw
 * coordinate frame: x is depth, y runs bridge-to-nut, and z is lateral.
 */

const STRING_COUNT = 6;
const STATIONS = 48;
const RADIAL_SEGMENTS = 8;
const RING_STRIDE = RADIAL_SEGMENTS + 1;
const RING_COUNT = STATIONS + 1;
const RING_VERTEX_COUNT = RING_COUNT * RING_STRIDE;
const BRIDGE_CAP_INDEX = RING_VERTEX_COUNT;
const NUT_CAP_INDEX = RING_VERTEX_COUNT + 1;
const VERTEX_COUNT = RING_VERTEX_COUNT + 2;

// The source's central bridge and nut surfaces measure at x≈0.0647 and
// x≈0.0363 respectively. Centreline clearance keeps a tube's lower half
// seated against the measured surface without hiding its visible highlight.
const BRIDGE_X = 0.0668;
const NUT_X = 0.0381;
const BRIDGE_Y = -0.32;
const NUT_Y = 0.33;
// Narrow source components at y≈−0.20 sit at z≈±0.032. Interpolating from
// this measured neck span to the nut gives a close overlay through the pickup
// area while keeping the endpoint fan restrained.
const BRIDGE_SPREAD = 0.036;
const NUT_SPREAD = 0.0175;
const PATH_SAG = 0.0095;

// Low E to high E: a restrained but readable thickness hierarchy in the
// source's normalized hero-prop scale.
const RADII = new Float32Array([0.0008, 0.00072, 0.00064, 0.00056, 0.00048, 0.00042]);
const PLUCK_AMPLITUDES = new Float32Array([0.0030, 0.0027, 0.0024, 0.0021, 0.0017, 0.0013]);
const PLUCK_FREQUENCIES = new Float32Array([6.1, 6.7, 7.3, 7.9, 8.5, 9.1]);
const DAMPING = new Float32Array([3.05, 3.15, 3.25, 3.35, 3.45, 3.55]);
const STRING_OFFSETS = new Float32Array([-1, -0.6, -0.2, 0.2, 0.6, 1]);
const MAX_STRENGTH = 2;

const TWO_PI = Math.PI * 2;
const POSITION_STRIDE = 3;
const UV_STRIDE = 2;
const RING_INDEX_COUNT = STATIONS * RADIAL_SEGMENTS * 6;
const CAP_INDEX_COUNT = RADIAL_SEGMENTS * 6;
const INDEX_COUNT = RING_INDEX_COUNT + CAP_INDEX_COUNT;

export interface GuitarStringEndpoint {
  readonly bridge: readonly [number, number, number];
  readonly nut: readonly [number, number, number];
}

export interface GuitarStringInspection {
  readonly enabled: boolean;
  readonly disposed: boolean;
  readonly groupName: string;
  readonly meshCount: number;
  readonly stringCount: number;
  readonly names: readonly string[];
  readonly endpoints: readonly GuitarStringEndpoint[];
  readonly restBounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly endpointErrorMax: number;
  readonly motion: {
    readonly activeCount: number;
    readonly maxDisplacement: number;
    readonly displacementByString: readonly number[];
  };
}

export interface GuitarStringsController {
  readonly group: THREE.Group;
  update(delta: number): void;
  /** Trigger all strings, or one zero-based string index, with optional strength. */
  strum(stringIndex?: number, strength?: number): void;
  /** Read motion state without allocating an inspection snapshot. */
  hasActiveMotion(): boolean;
  /** Enable or freeze the motion layer. Strings stay visible when disabled. */
  setEnabled(enabled: boolean): void;
  inspect(): GuitarStringInspection;
  dispose(): void;
}

type StringState = {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly position: THREE.BufferAttribute;
  readonly endpoint: GuitarStringEndpoint;
  readonly restMin: [number, number, number];
  readonly restMax: [number, number, number];
  age: number;
  phase: number;
  strength: number;
  displacement: number;
  active: boolean;
};

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_STRENGTH, Math.max(0, value));
}

function makeStringGeometry(
  stringIndex: number,
): { geometry: THREE.BufferGeometry; position: THREE.BufferAttribute; endpoint: GuitarStringEndpoint; min: [number, number, number]; max: [number, number, number] } {
  const radius = RADII[stringIndex];
  const lateral = STRING_OFFSETS[stringIndex];
  const bridgeZ = lateral * BRIDGE_SPREAD;
  const nutZ = lateral * NUT_SPREAD;
  const dx = NUT_X - BRIDGE_X;
  const dy = NUT_Y - BRIDGE_Y;
  const dz = nutZ - bridgeZ;
  const tangentLength = Math.hypot(dx, dy, dz);
  const tx = dx / tangentLength;
  const ty = dy / tangentLength;
  const tz = dz / tangentLength;

  // Project the raw +z lateral axis onto the tube's normal plane. This keeps
  // the pluck visible from the front while remaining orthogonal to the
  // slightly sloped bridge-to-nut path.
  let nx = -tx * tz;
  let ny = -ty * tz;
  let nz = 1 - tz * tz;
  const normalLength = Math.hypot(nx, ny, nz);
  nx /= normalLength;
  ny /= normalLength;
  nz /= normalLength;
  // binormal = tangent × normal
  const bx = ty * nz - tz * ny;
  const by = tz * nx - tx * nz;
  const bz = tx * ny - ty * nx;

  const positions = new Float32Array(VERTEX_COUNT * POSITION_STRIDE);
  const normals = new Float32Array(VERTEX_COUNT * POSITION_STRIDE);
  const uvs = new Float32Array(VERTEX_COUNT * UV_STRIDE);
  const indices = new Uint32Array(INDEX_COUNT);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const includeBounds = (x: number, y: number, z: number): void => {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  };

  for (let station = 0; station < RING_COUNT; station += 1) {
    const t = station / STATIONS;
    const cx = pathX(t, dx);
    const cy = BRIDGE_Y + dy * t;
    const cz = bridgeZ + dz * t;
    // Explicit zeroes make the pinned endpoints byte-stable, rather than
    // relying on Math.sin(Math.PI)'s small floating-point residue.
    for (let radial = 0; radial <= RADIAL_SEGMENTS; radial += 1) {
      const theta = (radial / RADIAL_SEGMENTS) * TWO_PI;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const ringVertex = station * RING_STRIDE + radial;
      const positionOffset = ringVertex * POSITION_STRIDE;
      const offsetX = (nx * cos + bx * sin) * radius;
      const offsetY = (ny * cos + by * sin) * radius;
      const offsetZ = (nz * cos + bz * sin) * radius;
      positions[positionOffset] = cx + offsetX;
      positions[positionOffset + 1] = cy + offsetY;
      positions[positionOffset + 2] = cz + offsetZ;
      normals[positionOffset] = nx * cos + bx * sin;
      normals[positionOffset + 1] = ny * cos + by * sin;
      normals[positionOffset + 2] = nz * cos + bz * sin;
      const uvOffset = ringVertex * UV_STRIDE;
      uvs[uvOffset] = radial / RADIAL_SEGMENTS;
      uvs[uvOffset + 1] = t;
      includeBounds(positions[positionOffset], positions[positionOffset + 1], positions[positionOffset + 2]);
    }
  }

  positions[BRIDGE_CAP_INDEX * POSITION_STRIDE] = BRIDGE_X;
  positions[BRIDGE_CAP_INDEX * POSITION_STRIDE + 1] = BRIDGE_Y;
  positions[BRIDGE_CAP_INDEX * POSITION_STRIDE + 2] = bridgeZ;
  normals[BRIDGE_CAP_INDEX * POSITION_STRIDE] = -tx;
  normals[BRIDGE_CAP_INDEX * POSITION_STRIDE + 1] = -ty;
  normals[BRIDGE_CAP_INDEX * POSITION_STRIDE + 2] = -tz;
  uvs[BRIDGE_CAP_INDEX * UV_STRIDE] = 0.5;
  uvs[BRIDGE_CAP_INDEX * UV_STRIDE + 1] = 0;
  includeBounds(BRIDGE_X, BRIDGE_Y, bridgeZ);

  positions[NUT_CAP_INDEX * POSITION_STRIDE] = NUT_X;
  positions[NUT_CAP_INDEX * POSITION_STRIDE + 1] = NUT_Y;
  positions[NUT_CAP_INDEX * POSITION_STRIDE + 2] = nutZ;
  normals[NUT_CAP_INDEX * POSITION_STRIDE] = tx;
  normals[NUT_CAP_INDEX * POSITION_STRIDE + 1] = ty;
  normals[NUT_CAP_INDEX * POSITION_STRIDE + 2] = tz;
  uvs[NUT_CAP_INDEX * UV_STRIDE] = 0.5;
  uvs[NUT_CAP_INDEX * UV_STRIDE + 1] = 1;
  includeBounds(NUT_X, NUT_Y, nutZ);

  let indexOffset = 0;
  for (let station = 0; station < STATIONS; station += 1) {
    const current = station * RING_STRIDE;
    const next = (station + 1) * RING_STRIDE;
    for (let radial = 0; radial < RADIAL_SEGMENTS; radial += 1) {
      const a = current + radial;
      const b = current + radial + 1;
      const c = next + radial;
      const d = next + radial + 1;
      // Winding follows the outward radial normal along bridge -> nut.
      indices[indexOffset++] = a;
      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;
      indices[indexOffset++] = d;
      indices[indexOffset++] = c;
    }
  }
  for (let radial = 0; radial < RADIAL_SEGMENTS; radial += 1) {
    const start = radial;
    const startNext = radial + 1;
    indices[indexOffset++] = BRIDGE_CAP_INDEX;
    indices[indexOffset++] = startNext;
    indices[indexOffset++] = start;

    const end = STATIONS * RING_STRIDE + radial;
    const endNext = end + 1;
    indices[indexOffset++] = NUT_CAP_INDEX;
    indices[indexOffset++] = end;
    indices[indexOffset++] = endNext;
  }

  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, POSITION_STRIDE);
  position.setUsage(THREE.DynamicDrawUsage);
  const normal = new THREE.BufferAttribute(normals, POSITION_STRIDE);
  normal.setUsage(THREE.StaticDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('normal', normal);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, UV_STRIDE));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // Culling must include the maximum possible damped pluck excursion at the
  // public strength limit, rather than only the default strength of one.
  const maximumExcursion = PLUCK_AMPLITUDES[stringIndex] * MAX_STRENGTH;
  geometry.boundingBox?.expandByScalar(maximumExcursion);
  if (geometry.boundingSphere) geometry.boundingSphere.radius += maximumExcursion;

  return {
    geometry,
    position,
    endpoint: {
      bridge: [BRIDGE_X, BRIDGE_Y, bridgeZ],
      nut: [NUT_X, NUT_Y, nutZ],
    },
    min,
    max,
  };
}

function pathX(t: number, endpointDelta: number): number {
  // The measured surface bows toward the viewer through the neck. A small
  // sinusoidal correction follows the source string runs while preserving
  // the exact bridge and nut x anchors.
  return BRIDGE_X + endpointDelta * t - PATH_SAG * Math.sin(Math.PI * t);
}

/**
 * Add six addressable, independently animatable strings in `mesh`'s local
 * measured coordinate frame. The returned group is intentionally unparented;
 * the integration layer can add it directly to the measured mesh node.
 */
export function createGuitarStrings(mesh: THREE.Mesh): GuitarStringsController {
  const group = new THREE.Group();
  group.name = 'guitar-strings';
  group.userData.provenance = {
    kind: 'authored-detail-layer',
    parentMesh: mesh.name,
    frame: 'measured-mesh-local',
    sourceStreamsUnchanged: true,
    runtimeTextures: 0,
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0x8d989d,
    metalness: 0.78,
    roughness: 0.27,
    clearcoat: 0.08,
    clearcoatRoughness: 0.18,
  });
  material.name = 'string-metal-silver';

  const states: StringState[] = [];
  const stringStatesForUserData: THREE.Mesh[] = [];
  let disposed = false;
  let enabled = true;

  // These path frames are identical in construction for all strings except
  // lateral offset. Reconstructing the tiny fixed arrays once per string keeps
  // update() allocation-free and avoids any source vertex scan.
  for (let stringIndex = 0; stringIndex < STRING_COUNT; stringIndex += 1) {
    const built = makeStringGeometry(stringIndex);
    const stringMesh = new THREE.Mesh(built.geometry, material);
    stringMesh.name = `guitar-string-${stringIndex + 1}`;
    stringMesh.castShadow = true;
    stringMesh.receiveShadow = true;
    stringMesh.userData = {
      role: 'string',
      stringIndex,
      sourceFrame: 'measured-mesh-local',
      pinnedEndpoints: built.endpoint,
      radius: RADII[stringIndex],
      animation: 'damped-modal-pluck',
    };
    group.add(stringMesh);
    stringStatesForUserData.push(stringMesh);
    states.push({
      mesh: stringMesh,
      geometry: built.geometry,
      position: built.position,
      endpoint: built.endpoint,
      restMin: built.min,
      restMax: built.max,
      age: 0,
      phase: Math.PI / 2,
      strength: 0,
      displacement: 0,
      active: false,
    });
  }
  group.userData.strings = stringStatesForUserData;

  function resetString(state: StringState): void {
    const positionArray = state.position.array as Float32Array;
    // The two cap centres are the only vertices whose rest position is not
    // covered by a station ring. Resetting every ring from its static path is
    // handled by writeString below, which also restores cap centres.
    writeString(state, positionArray, 0);
    state.age = 0;
    state.phase = Math.PI / 2;
    state.strength = 0;
    state.displacement = 0;
    state.active = false;
  }

  function writeString(state: StringState, positionArray: Float32Array, displacement: number): void {
    const stringIndex = states.indexOf(state);
    const lateral = STRING_OFFSETS[stringIndex];
    const bridgeZ = lateral * BRIDGE_SPREAD;
    const nutZ = lateral * NUT_SPREAD;
    const dx = NUT_X - BRIDGE_X;
    const dy = NUT_Y - BRIDGE_Y;
    const dz = nutZ - bridgeZ;
    const tangentLength = Math.hypot(dx, dy, dz);
    const tx = dx / tangentLength;
    const ty = dy / tangentLength;
    const tz = dz / tangentLength;
    let nx = -tx * tz;
    let ny = -ty * tz;
    let nz = 1 - tz * tz;
    const normalLength = Math.hypot(nx, ny, nz);
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
    const bx = ty * nz - tz * ny;
    const by = tz * nx - tx * nz;
    const bz = tx * ny - ty * nx;
    const radius = RADII[stringIndex];
    const position = positionArray;

    for (let station = 0; station < RING_COUNT; station += 1) {
      const t = station / STATIONS;
      const cx = pathX(t, dx);
      const cy = BRIDGE_Y + dy * t;
      const cz = bridgeZ + dz * t;
      const mode = station === 0 || station === STATIONS ? 0 : Math.sin(Math.PI * t);
      const centreDisplacement = displacement * mode;
      for (let radial = 0; radial <= RADIAL_SEGMENTS; radial += 1) {
        const theta = (radial / RADIAL_SEGMENTS) * TWO_PI;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const vertexOffset = (station * RING_STRIDE + radial) * POSITION_STRIDE;
        position[vertexOffset] = cx + nx * (centreDisplacement + cos * radius) + bx * sin * radius;
        position[vertexOffset + 1] = cy + ny * (centreDisplacement + cos * radius) + by * sin * radius;
        position[vertexOffset + 2] = cz + nz * (centreDisplacement + cos * radius) + bz * sin * radius;
      }
    }
    const bridgeOffset = BRIDGE_CAP_INDEX * POSITION_STRIDE;
    position[bridgeOffset] = BRIDGE_X;
    position[bridgeOffset + 1] = BRIDGE_Y;
    position[bridgeOffset + 2] = bridgeZ;
    const nutOffset = NUT_CAP_INDEX * POSITION_STRIDE;
    position[nutOffset] = NUT_X;
    position[nutOffset + 1] = NUT_Y;
    position[nutOffset + 2] = nutZ;
  }

  group.userData.restPathStations = STATIONS;
  group.userData.mesh = mesh;

  function update(delta: number): void {
    if (disposed || !enabled || !Number.isFinite(delta) || delta <= 0) return;
    const dt = Math.min(delta, 0.1);
    for (let stringIndex = 0; stringIndex < states.length; stringIndex += 1) {
      const state = states[stringIndex];
      if (!state.active) continue;
      state.age += dt;
      state.phase += TWO_PI * PLUCK_FREQUENCIES[stringIndex] * dt;
      const envelope = Math.exp(-DAMPING[stringIndex] * state.age);
      const displacement = PLUCK_AMPLITUDES[stringIndex] * state.strength * envelope * Math.sin(state.phase);
      state.displacement = displacement;
      if (envelope < 0.0005) {
        state.active = false;
        state.displacement = 0;
        writeString(state, state.position.array as Float32Array, 0);
      } else {
        writeString(state, state.position.array as Float32Array, displacement);
      }
      state.position.needsUpdate = true;
    }
  }

  function strum(stringIndex?: number, strength = 1): void {
    if (disposed || !enabled) return;
    const clamped = clampStrength(strength);
    const first = stringIndex === undefined ? 0 : Math.max(0, Math.min(STRING_COUNT - 1, Math.trunc(stringIndex)));
    const last = stringIndex === undefined ? STRING_COUNT - 1 : first;
    for (let index = first; index <= last; index += 1) {
      const state = states[index];
      state.age = 0;
      state.phase = Math.PI / 2 + index * 0.13;
      state.strength = clamped;
      state.displacement = PLUCK_AMPLITUDES[index] * clamped * Math.sin(state.phase);
      state.active = clamped > 0;
      writeString(state, state.position.array as Float32Array, state.displacement);
      state.position.needsUpdate = true;
    }
  }

  function hasActiveMotion(): boolean {
    if (disposed) return false;
    for (const state of states) {
      if (state.active) return true;
    }
    return false;
  }

  function setEnabled(nextEnabled: boolean): void {
    if (disposed) return;
    enabled = nextEnabled;
    if (!enabled) {
      for (const state of states) resetString(state);
      states.forEach(state => { state.position.needsUpdate = true; });
    }
  }

  function inspect(): GuitarStringInspection {
    const names: string[] = [];
    const endpoints: GuitarStringEndpoint[] = [];
    const displacementByString: number[] = [];
    let activeCount = 0;
    let maxDisplacement = 0;
    let endpointErrorMax = 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const state of states) {
      names.push(state.mesh.name);
      endpoints.push({
        bridge: [...state.endpoint.bridge] as [number, number, number],
        nut: [...state.endpoint.nut] as [number, number, number],
      });
      const displacement = Math.abs(state.displacement);
      displacementByString.push(displacement);
      if (state.active) activeCount += 1;
      if (displacement > maxDisplacement) maxDisplacement = displacement;
      for (let axis = 0; axis < 3; axis += 1) {
        if (state.restMin[axis] < min[axis]) min[axis] = state.restMin[axis];
        if (state.restMax[axis] > max[axis]) max[axis] = state.restMax[axis];
      }
      const position = state.position.array as Float32Array;
      const bridgeOffset = BRIDGE_CAP_INDEX * POSITION_STRIDE;
      const nutOffset = NUT_CAP_INDEX * POSITION_STRIDE;
      for (let axis = 0; axis < 3; axis += 1) {
        // BufferGeometry stores float32 positions. Compare against the exact
        // float32 rest representation so a harmless JS-number rounding bit is
        // not reported as endpoint motion.
        endpointErrorMax = Math.max(endpointErrorMax, Math.abs(position[bridgeOffset + axis] - Math.fround(state.endpoint.bridge[axis])));
        endpointErrorMax = Math.max(endpointErrorMax, Math.abs(position[nutOffset + axis] - Math.fround(state.endpoint.nut[axis])));
      }
    }
    return {
      enabled,
      disposed,
      groupName: group.name,
      meshCount: group.children.length,
      stringCount: STRING_COUNT,
      names,
      endpoints,
      restBounds: { min, max },
      endpointErrorMax,
      motion: { activeCount, maxDisplacement, displacementByString },
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    group.remove(...states.map(state => state.mesh));
    states.forEach(state => state.geometry.dispose());
    material.dispose();
    group.userData.disposed = true;
  }

  return { group, update, strum, hasActiveMotion, setEnabled, inspect, dispose };
}
