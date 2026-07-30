import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

type SdfVector = readonly [number, number, number];
type SdfTransform = { position?: SdfVector; translation?: SdfVector; rotation?: SdfVector; scale?: SdfVector };
type SdfPrimitive = {
  readonly id: string;
  readonly type: 'sphere' | 'capsule' | 'box' | 'cone' | 'ellipsoid';
  readonly center?: SdfVector;
  readonly radius?: number | SdfVector;
  readonly height?: number;
  readonly size?: SdfVector;
  readonly dimensions?: SdfVector;
  readonly radii?: SdfVector;
  readonly transform?: SdfTransform;
};
type SdfOperation = {
  readonly id?: string;
  readonly output?: string;
  readonly type: 'smooth-union' | 'subtract' | 'intersect';
  readonly left: string;
  readonly right: string;
  readonly radius?: number;
};
type SdfDescriptor = {
  readonly primitives: readonly SdfPrimitive[];
  readonly operations?: readonly SdfOperation[];
  readonly resolution: number;
  readonly bounds?: { readonly min: SdfVector; readonly max: SdfVector };
};
type SdfFunction = (point: THREE.Vector3) => number;

function sdfSphere(point: THREE.Vector3, radius: number): number {
  return point.length() - radius;
}

function sdfCapsule(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const y = Math.max(-halfHeight, Math.min(halfHeight, point.y));
  return point.distanceTo(new THREE.Vector3(0, y, 0)) - radius;
}

function sdfBox(point: THREE.Vector3, size: SdfVector): number {
  const q = new THREE.Vector3(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))
    .sub(new THREE.Vector3(size[0] * 0.5, size[1] * 0.5, size[2] * 0.5));
  return q.clone().max(new THREE.Vector3()).length() + Math.min(Math.max(q.x, q.y, q.z), 0);
}

function sdfCone(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const taper = radius * (1 - (point.y + halfHeight) / height);
  return Math.max(Math.hypot(point.x, point.z) - Math.max(0, taper), Math.abs(point.y) - halfHeight);
}

function sdfEllipsoid(point: THREE.Vector3, radii: SdfVector): number {
  const scaled = new THREE.Vector3(point.x / radii[0], point.y / radii[1], point.z / radii[2]);
  return (scaled.length() - 1) * Math.min(radii[0], radii[1], radii[2]);
}

function sdfRadii(primitive: SdfPrimitive): SdfVector {
  const radius = primitive.radius;
  if (primitive.radii) return primitive.radii;
  if (typeof radius === 'number') return [radius, radius, radius];
  return radius ?? [0.5, 0.5, 0.5];
}

function smin(left: number, right: number, radius: number): number {
  const blend = Math.max(radius - Math.abs(left - right), 0) / radius;
  return Math.min(left, right) - blend * blend * radius * 0.25;
}

function sdfLocalPoint(point: THREE.Vector3, primitive: SdfPrimitive): { point: THREE.Vector3; scale: number } {
  const transform = primitive.transform;
  const translation = transform?.position ?? transform?.translation ?? primitive.center ?? [0, 0, 0];
  const rotation = transform?.rotation ?? [0, 0, 0];
  const scale = transform?.scale ?? [1, 1, 1];
  const local = point.clone().sub(new THREE.Vector3(translation[0], translation[1], translation[2]));
  const inverseRotation = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]))
    .invert();
  local.applyQuaternion(inverseRotation);
  local.set(local.x / scale[0], local.y / scale[1], local.z / scale[2]);
  return { point: local, scale: Math.min(scale[0], scale[1], scale[2]) };
}

function sdfPrimitive(point: THREE.Vector3, primitive: SdfPrimitive): number {
  const local = sdfLocalPoint(point, primitive);
  let distance: number;
  switch (primitive.type) {
    case 'sphere':
      distance = sdfSphere(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5);
      break;
    case 'capsule':
      distance = sdfCapsule(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.25, primitive.height ?? 1);
      break;
    case 'box':
      distance = sdfBox(local.point, primitive.size ?? primitive.dimensions ?? [1, 1, 1]);
      break;
    case 'cone':
      distance = sdfCone(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5, primitive.height ?? 1);
      break;
    case 'ellipsoid':
      distance = sdfEllipsoid(local.point, sdfRadii(primitive));
      break;
  }
  return distance * local.scale;
}

function sdfSample(descriptor: SdfDescriptor): SdfFunction {
  const nodes = new Map<string, SdfFunction>();
  for (const primitive of descriptor.primitives) nodes.set(primitive.id, (point) => sdfPrimitive(point, primitive));
  let result = descriptor.primitives.length > 0 ? nodes.get(descriptor.primitives[0].id) : undefined;
  for (let index = 0; index < (descriptor.operations?.length ?? 0); index += 1) {
    const operation = descriptor.operations?.[index];
    if (!operation) continue;
    const left = nodes.get(operation.left);
    const right = nodes.get(operation.right);
    if (!left || !right) continue;
    let combined: SdfFunction;
    switch (operation.type) {
      case 'smooth-union':
        combined = (point) => smin(left(point), right(point), operation.radius ?? 0.1);
        break;
      case 'subtract':
        combined = (point) => Math.max(left(point), -right(point));
        break;
      case 'intersect':
        combined = (point) => Math.max(left(point), right(point));
        break;
    }
    nodes.set(operation.id ?? operation.output ?? `operation-${index}`, combined);
    result = combined;
  }
  return result ?? (() => Infinity);
}

function polygonizeSdf(descriptor: SdfDescriptor): THREE.BufferGeometry {
  const resolution = Math.max(4, Math.min(64, Math.floor(descriptor.resolution)));
  const defaultBounds: { readonly min: SdfVector; readonly max: SdfVector } = { min: [-2, -2, -2], max: [2, 2, 2] };
  const bounds = descriptor.bounds ?? defaultBounds;
  const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
  const step = new THREE.Vector3(
    (bounds.max[0] - bounds.min[0]) / resolution,
    (bounds.max[1] - bounds.min[1]) / resolution,
    (bounds.max[2] - bounds.min[2]) / resolution,
  );
  const field = new Float32Array(resolution * resolution * resolution);
  const sample = sdfSample(descriptor);
  const indexAt = (x: number, y: number, z: number): number => (z * resolution + y) * resolution + x;
  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        field[indexAt(x, y, z)] = sample(new THREE.Vector3(
          min.x + (x + 0.5) * step.x,
          min.y + (y + 0.5) * step.y,
          min.z + (z + 0.5) * step.z,
        ));
      }
    }
  }
  const positions: number[] = [];
  const indices: number[] = [];
  const vertices = new Map<string, number>();
  const vertexAt = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    const existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const vertex = positions.length / 3;
    positions.push(min.x + x * step.x, min.y + y * step.y, min.z + z * step.z);
    vertices.set(key, vertex);
    return vertex;
  };
  const addFace = (a: number, b: number, c: number, d: number): void => {
    indices.push(a, b, c, a, c, d);
  };
  const inside = (x: number, y: number, z: number): boolean => (
    x >= 0 && y >= 0 && z >= 0 && x < resolution && y < resolution && z < resolution && field[indexAt(x, y, z)] <= 0
  );
  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        if (!inside(x, y, z)) continue;
        if (!inside(x - 1, y, z)) addFace(vertexAt(x, y, z), vertexAt(x, y, z + 1), vertexAt(x, y + 1, z + 1), vertexAt(x, y + 1, z));
        if (!inside(x + 1, y, z)) addFace(vertexAt(x + 1, y, z), vertexAt(x + 1, y + 1, z), vertexAt(x + 1, y + 1, z + 1), vertexAt(x + 1, y, z + 1));
        if (!inside(x, y - 1, z)) addFace(vertexAt(x, y, z), vertexAt(x + 1, y, z), vertexAt(x + 1, y, z + 1), vertexAt(x, y, z + 1));
        if (!inside(x, y + 1, z)) addFace(vertexAt(x, y + 1, z), vertexAt(x, y + 1, z + 1), vertexAt(x + 1, y + 1, z + 1), vertexAt(x + 1, y + 1, z));
        if (!inside(x, y, z - 1)) addFace(vertexAt(x, y, z), vertexAt(x, y + 1, z), vertexAt(x + 1, y + 1, z), vertexAt(x + 1, y, z));
        if (!inside(x, y, z + 1)) addFace(vertexAt(x, y, z + 1), vertexAt(x + 1, y, z + 1), vertexAt(x + 1, y + 1, z + 1), vertexAt(x, y + 1, z + 1));
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// THREE.CapsuleGeometry duplicates every UV-seam vertex (measured: 194 boundary
// edges on the default radius/segments below) -- same benign pattern as box/
// cylinder/sphere/torus, all of which weld cleanly to 0 given a CORRECT weld.
// (A naive vertex-only mergeVertices() reports 64 'non-manifold' edges here, but
// that is a counting artifact, not a real defect: it double-counts a handful of
// near-pole triangles that become degenerate once two of their three corners
// coincide -- confirmed by replicating subdivideCatmullClark's own degenerate-
// triangle-aware vertex identity, which finds a perfectly ordinary 2-manifold.)
// A capsule is the primary shape for skinned limbs/torso (PLAN_1.5), and skinning
// weight computation is O(vertices x bones), so fewer, guaranteed-simple vertices
// is worth having regardless -- authored as a deterministic, closed-by-
// construction mesh instead: shared pole vertices, and
// the radial index taken `% radialSegments` so the seam is never a duplicate
// vertex in the first place, rather than something to weld away afterward.
// Adapted from forge/stage5_rig/emit_rig.py's buildWatertightCapsule (verified
// there: 0 boundary edges, 0 non-manifold edges, deterministic across repeated
// runs) -- ported here rather than imported because this factory and the rig
// emitter are separate generated-output surfaces with no shared runtime module;
// see forge/tests/test_primitive_watertightness.py for the measured proof, and
// coordinate with the rig owner before changing either copy independently.
function buildWatertightCapsule(
  radius: number,
  cylLength: number,
  capSegments: number,
  radialSegments: number,
  heightSegments: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const halfCyl = cylLength / 2;
  const totalSpan = 2 * (Math.PI / 2 * radius) + Math.max(0, cylLength);
  const vOf = (fromBottom: number) => (totalSpan > 0 ? fromBottom / totalSpan : 0);

  const bottomPoleIndex = positions.length / 3;
  positions.push(0, -halfCyl - radius, 0);
  uvs.push(0.5, vOf(0));

  const ringStarts: number[] = [];
  const ringV: number[] = [];
  for (let ring = 1; ring <= capSegments; ring += 1) {
    const phi = (Math.PI / 2) * (ring / capSegments);
    const y = -halfCyl - radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    const start = positions.length / 3;
    ringStarts.push(start);
    ringV.push(vOf(radius * phi));
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const theta = (radial / radialSegments) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
      uvs.push(radial / radialSegments, vOf(radius * phi));
    }
  }

  const cylinderRingStarts: number[] = [];
  if (cylLength > 0) {
    for (let step = 1; step <= heightSegments; step += 1) {
      const y = -halfCyl + (cylLength * step) / heightSegments;
      const start = positions.length / 3;
      cylinderRingStarts.push(start);
      const v = vOf(radius * (Math.PI / 2) + halfCyl + y);
      for (let radial = 0; radial < radialSegments; radial += 1) {
        const theta = (radial / radialSegments) * Math.PI * 2;
        positions.push(radius * Math.cos(theta), y, radius * Math.sin(theta));
        uvs.push(radial / radialSegments, v);
      }
    }
  }

  const topRingStarts: number[] = [];
  for (let ring = capSegments - 1; ring >= 1; ring -= 1) {
    const phi = (Math.PI / 2) * (ring / capSegments);
    const y = halfCyl + radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    const start = positions.length / 3;
    topRingStarts.push(start);
    const v = vOf(radius * (Math.PI / 2) + Math.max(0, cylLength) + radius * (Math.PI / 2 - phi));
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const theta = (radial / radialSegments) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
      uvs.push(radial / radialSegments, v);
    }
  }

  const topPoleIndex = positions.length / 3;
  positions.push(0, halfCyl + radius, 0);
  uvs.push(0.5, vOf(totalSpan));

  const firstBottomRing = ringStarts[0];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments;
    indices.push(bottomPoleIndex, firstBottomRing + radial, firstBottomRing + next);
  }

  const allRings = [...ringStarts, ...cylinderRingStarts, ...topRingStarts];
  for (let i = 0; i < allRings.length - 1; i += 1) {
    const a = allRings[i];
    const b = allRings[i + 1];
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const next = (radial + 1) % radialSegments;
      indices.push(a + radial, a + next, b + next);
      indices.push(a + radial, b + next, b + radial);
    }
  }

  const lastRing = allRings[allRings.length - 1];
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments;
    indices.push(topPoleIndex, lastRing + next, lastRing + radial);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const [red, green, blue] = hexToRgb(source);
  return new THREE.Color(red / 255, green / 255, blue / 255);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Regret Knight
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createRegretKnightModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Regret Knight";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["base"] = createSculptMaterial(
    "base",
    {"id": "base", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8A7A5F", "color": "#8A7A5F", "albedo": {"dominant": "#8A7A5F", "secondary": ["#6E614B", "#A08F70"], "samplingNotes": "Use image-observed local color zones, not a single averaged color."}, "colorVariation": {"palette": ["#8A7A5F", "#6E614B", "#A08F70"], "pattern": "mottled", "amplitude": 0.15, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.75, "variation": 0.15, "map": "independent-procedural-field", "localResponse": "higher roughness in cavities, lower roughness on worn edges"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."},
    options
  );
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"]}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 1.0, "variation": 0.0}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "opacity": {"base": 0.0}},
    options
  );
  materialMap["skin"] = createSculptMaterial(
    "skin",
    {"id": "skin", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8b98f", "color": "#e8b98f", "albedo": {"dominant": "#e8b98f", "secondary": ["#be9875"]}, "colorVariation": {"palette": ["#e8b98f", "#be9875"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.55, "variation": 0.08}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."},
    options
  );
  materialMap["hair"] = createSculptMaterial(
    "hair",
    {"id": "hair", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#171310", "color": "#171310", "albedo": {"dominant": "#171310", "secondary": ["#13100d"]}, "colorVariation": {"palette": ["#171310", "#13100d"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.42, "variation": 0.1}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."},
    options
  );
  materialMap["shirt"] = createSculptMaterial(
    "shirt",
    {"id": "shirt", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#20202a", "color": "#20202a", "albedo": {"dominant": "#20202a", "secondary": ["#1a1a22"]}, "colorVariation": {"palette": ["#20202a", "#1a1a22"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.85, "variation": 0.12}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."},
    options
  );
  materialMap["pants"] = createSculptMaterial(
    "pants",
    {"id": "pants", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#2b2d33", "color": "#2b2d33", "albedo": {"dominant": "#2b2d33", "secondary": ["#23252a"]}, "colorVariation": {"palette": ["#2b2d33", "#23252a"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.75, "variation": 0.1}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."},
    options
  );
  materialMap["shoes"] = createSculptMaterial(
    "shoes",
    {"id": "shoes", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#171512", "color": "#171512", "albedo": {"dominant": "#171512", "secondary": ["#13110f"]}, "colorVariation": {"palette": ["#171512", "#13110f"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.55, "variation": 0.08}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."},
    options
  );
  materialMap["eye"] = createSculptMaterial(
    "eye",
    {"id": "eye", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#f2eee4", "color": "#f2eee4", "albedo": {"dominant": "#f2eee4", "secondary": ["#c6c3bb"]}, "colorVariation": {"palette": ["#f2eee4", "#c6c3bb"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.2, "variation": 0.03}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."},
    options
  );
  materialMap["lips"] = createSculptMaterial(
    "lips",
    {"id": "lips", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#c98070", "color": "#c98070", "albedo": {"dominant": "#c98070", "secondary": ["#a5695c"]}, "colorVariation": {"palette": ["#c98070", "#a5695c"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.5, "variation": 0.05}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_root_0 = null;
  const endpoint_root_0 = makeAttachmentEndpoint(attachment_root_0);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Character (root)__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Character (root)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Character (root) is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Character (root)";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Character (root)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Character (root) is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const attachment_torso_1 = {"parentSocket": "root-spine", "localStart": [0.0, 0.37576, 0.0056], "localEnd": [0.0, -0.06776, 0.0], "contactType": "rigid-weld", "baseRadius": 0.1684, "endRadius": 0.19174, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_torso_1 = makeAttachmentEndpoint(attachment_torso_1);
  const node_torso_1 = new THREE.Group();
  node_torso_1.name = "Torso__pivot";
  node_torso_1.scale.set(1, 1, 1);
  if (endpoint_torso_1) {
    node_torso_1.position.copy(endpoint_torso_1.start);
    node_torso_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_torso_1.position.set(0.0, 0.3757600000000001, 0.005600000000000001);
    node_torso_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_torso_1.userData.sculptComponent = {"id": "torso", "name": "Torso", "level": "macro", "role": "shell", "importance": 1.0, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Torso is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentSocket": "root-spine", "localStart": [0.0, 0.37576, 0.0056], "localEnd": [0.0, -0.06776, 0.0], "contactType": "rigid-weld", "baseRadius": 0.1684, "endRadius": 0.19174, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.38091200000000003, "height": 0.4435200000000001, "depth": 0.40745600000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.3757600000000001, 0.005600000000000001], "rotation": [0, 0, 0], "scale": [0.38091200000000003, 0.4435200000000001, 0.40745600000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "torso", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_torso_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "torso", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["root"] ?? root).add(node_torso_1);
  nodes["torso"] = node_torso_1;
  const mesh_torso_1Geometry = endpoint_torso_1
    ? new THREE.CylinderGeometry(endpoint_torso_1.endRadius, endpoint_torso_1.baseRadius, endpoint_torso_1.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_torso_1) {
    mesh_torso_1Geometry.scale(0.38091200000000003, 0.4435200000000001, 0.40745600000000004);
  }
  const mesh_torso_1 = new THREE.Mesh(
    mesh_torso_1Geometry,
    materialMap["shirt"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_torso_1.name = "Torso";
  if (endpoint_torso_1) {
    mesh_torso_1.position.copy(endpoint_torso_1.midpoint);
    mesh_torso_1.quaternion.copy(endpoint_torso_1.quaternion);
  }
  mesh_torso_1.castShadow = options.castShadow ?? true;
  mesh_torso_1.receiveShadow = options.receiveShadow ?? true;
  mesh_torso_1.userData.sculptComponent = {"id": "torso", "name": "Torso", "level": "macro", "role": "shell", "importance": 1.0, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Torso is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentSocket": "root-spine", "localStart": [0.0, 0.37576, 0.0056], "localEnd": [0.0, -0.06776, 0.0], "contactType": "rigid-weld", "baseRadius": 0.1684, "endRadius": 0.19174, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.38091200000000003, "height": 0.4435200000000001, "depth": 0.40745600000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.3757600000000001, 0.005600000000000001], "rotation": [0, 0, 0], "scale": [0.38091200000000003, 0.4435200000000001, 0.40745600000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "torso", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_torso_1.add(mesh_torso_1);
  meshes["torso"] = mesh_torso_1;
  colliders["torso"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_torso_1);

  const attachment_neck_2 = {"parentSocket": "torso-neck-base", "localStart": [0.0, -0.0224, 0.0], "localEnd": [0.0, 0.15624, 0.0], "contactType": "rigid-weld", "baseRadius": 0.0728, "endRadius": 0.056, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_neck_2 = makeAttachmentEndpoint(attachment_neck_2);
  const node_neck_2 = new THREE.Group();
  node_neck_2.name = "Neck__pivot";
  node_neck_2.scale.set(1, 1, 1);
  if (endpoint_neck_2) {
    node_neck_2.position.copy(endpoint_neck_2.start);
    node_neck_2.rotation.set(0.0, 0.2, 0.04);
  } else {
    node_neck_2.position.set(0.0, -0.022399999999999975, 0.0);
    node_neck_2.rotation.set(0.0, 0.2, 0.04);
  }
  node_neck_2.userData.sculptComponent = {"id": "neck", "name": "Neck", "level": "meso", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Neck is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "torso", "attachment": {"parentSocket": "torso-neck-base", "localStart": [0.0, -0.0224, 0.0], "localEnd": [0.0, 0.15624, 0.0], "contactType": "rigid-weld", "baseRadius": 0.0728, "endRadius": 0.056, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.15400000000000003, "height": 0.1786399999999999, "depth": 0.15400000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.022399999999999975, 0.0], "rotation": [0.0, 0.2, 0.04], "scale": [0.15400000000000003, 0.1786399999999999, 0.15400000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_neck_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["torso"] ?? root).add(node_neck_2);
  nodes["neck"] = node_neck_2;
  const mesh_neck_2Geometry = endpoint_neck_2
    ? new THREE.CylinderGeometry(endpoint_neck_2.endRadius, endpoint_neck_2.baseRadius, endpoint_neck_2.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_neck_2) {
    mesh_neck_2Geometry.scale(0.15400000000000003, 0.1786399999999999, 0.15400000000000003);
  }
  const mesh_neck_2 = new THREE.Mesh(
    mesh_neck_2Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_neck_2.name = "Neck";
  if (endpoint_neck_2) {
    mesh_neck_2.position.copy(endpoint_neck_2.midpoint);
    mesh_neck_2.quaternion.copy(endpoint_neck_2.quaternion);
  }
  mesh_neck_2.castShadow = options.castShadow ?? true;
  mesh_neck_2.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_2.userData.sculptComponent = {"id": "neck", "name": "Neck", "level": "meso", "role": "support", "importance": 0.6, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Neck is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "torso", "attachment": {"parentSocket": "torso-neck-base", "localStart": [0.0, -0.0224, 0.0], "localEnd": [0.0, 0.15624, 0.0], "contactType": "rigid-weld", "baseRadius": 0.0728, "endRadius": 0.056, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.15400000000000003, "height": 0.1786399999999999, "depth": 0.15400000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.022399999999999975, 0.0], "rotation": [0.0, 0.2, 0.04], "scale": [0.15400000000000003, 0.1786399999999999, 0.15400000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_neck_2.add(mesh_neck_2);
  meshes["neck"] = mesh_neck_2;
  colliders["neck"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["neck"] ??= [];
  destructionGroups["neck"].push(node_neck_2);

  const attachment_pelvis_3 = null;
  const endpoint_pelvis_3 = makeAttachmentEndpoint(attachment_pelvis_3);
  const node_pelvis_3 = new THREE.Group();
  node_pelvis_3.name = "Pelvis__pivot";
  node_pelvis_3.scale.set(1, 1, 1);
  if (endpoint_pelvis_3) {
    node_pelvis_3.position.copy(endpoint_pelvis_3.start);
    node_pelvis_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pelvis_3.position.set(0.0, -0.09576000000000001, 0.0);
    node_pelvis_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_pelvis_3.userData.sculptComponent = {"id": "pelvis", "name": "Pelvis", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Pelvis is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.455392, "height": 0.12320000000000002, "depth": 0.35952000000000006, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.09576000000000001, 0.0], "rotation": [0, 0, 0], "scale": [0.455392, 0.12320000000000002, 0.35952000000000006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_pelvis_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["root"] ?? root).add(node_pelvis_3);
  nodes["pelvis"] = node_pelvis_3;
  const mesh_pelvis_3Geometry = endpoint_pelvis_3
    ? new THREE.CylinderGeometry(endpoint_pelvis_3.endRadius, endpoint_pelvis_3.baseRadius, endpoint_pelvis_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_pelvis_3) {
    mesh_pelvis_3Geometry.scale(0.455392, 0.12320000000000002, 0.35952000000000006);
  }
  const mesh_pelvis_3 = new THREE.Mesh(
    mesh_pelvis_3Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_3.name = "Pelvis";
  if (endpoint_pelvis_3) {
    mesh_pelvis_3.position.copy(endpoint_pelvis_3.midpoint);
    mesh_pelvis_3.quaternion.copy(endpoint_pelvis_3.quaternion);
  }
  mesh_pelvis_3.castShadow = options.castShadow ?? true;
  mesh_pelvis_3.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_3.userData.sculptComponent = {"id": "pelvis", "name": "Pelvis", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Pelvis is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.455392, "height": 0.12320000000000002, "depth": 0.35952000000000006, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.09576000000000001, 0.0], "rotation": [0, 0, 0], "scale": [0.455392, 0.12320000000000002, 0.35952000000000006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_pelvis_3.add(mesh_pelvis_3);
  meshes["pelvis"] = mesh_pelvis_3;
  colliders["pelvis"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_3);

  const attachment_head_4 = null;
  const endpoint_head_4 = makeAttachmentEndpoint(attachment_head_4);
  const node_head_4 = new THREE.Group();
  node_head_4.name = "Head__pivot";
  node_head_4.scale.set(1, 1, 1);
  if (endpoint_head_4) {
    node_head_4.position.copy(endpoint_head_4.start);
    node_head_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_4.position.set(0.0, 0.34663999999999995, 0.0);
    node_head_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_4.userData.sculptComponent = {"id": "head", "name": "Head", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Head is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "neck", "attachment": null, "dimensions": {"width": 0.25760000000000005, "height": 0.31360000000000005, "depth": 0.27440000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.34663999999999995, 0.0], "rotation": [0, 0, 0], "scale": [0.25760000000000005, 0.31360000000000005, 0.27440000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_head_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["neck"] ?? root).add(node_head_4);
  nodes["head"] = node_head_4;
  const mesh_head_4Geometry = endpoint_head_4
    ? new THREE.CylinderGeometry(endpoint_head_4.endRadius, endpoint_head_4.baseRadius, endpoint_head_4.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_head_4) {
    mesh_head_4Geometry.scale(0.25760000000000005, 0.31360000000000005, 0.27440000000000003);
  }
  const mesh_head_4 = new THREE.Mesh(
    mesh_head_4Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_4.name = "Head";
  if (endpoint_head_4) {
    mesh_head_4.position.copy(endpoint_head_4.midpoint);
    mesh_head_4.quaternion.copy(endpoint_head_4.quaternion);
  }
  mesh_head_4.castShadow = options.castShadow ?? true;
  mesh_head_4.receiveShadow = options.receiveShadow ?? true;
  mesh_head_4.userData.sculptComponent = {"id": "head", "name": "Head", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Head is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "neck", "attachment": null, "dimensions": {"width": 0.25760000000000005, "height": 0.31360000000000005, "depth": 0.27440000000000003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, 0.34663999999999995, 0.0], "rotation": [0, 0, 0], "scale": [0.25760000000000005, 0.31360000000000005, 0.27440000000000003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_head_4.add(mesh_head_4);
  meshes["head"] = mesh_head_4;
  colliders["head"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_4);

  const attachment_hair_5 = null;
  const endpoint_hair_5 = makeAttachmentEndpoint(attachment_hair_5);
  const node_hair_5 = new THREE.Group();
  node_hair_5.name = "Hair__pivot";
  node_hair_5.scale.set(1, 1, 1);
  if (endpoint_hair_5) {
    node_hair_5.position.copy(endpoint_hair_5.start);
    node_hair_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_5.position.set(0.0, 0.084, -0.005600000000000001);
    node_hair_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_5.userData.sculptComponent = {"id": "hair", "name": "Hair", "level": "meso", "role": "hair", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Hair is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.28, "height": 0.21840000000000004, "depth": 0.2856, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.084, -0.005600000000000001], "rotation": [0, 0, 0], "scale": [0.28, 0.21840000000000004, 0.2856]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["short, neutral stylized hairstyle"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_hair_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_5);
  nodes["hair"] = node_hair_5;
  const mesh_hair_5Geometry = endpoint_hair_5
    ? new THREE.CylinderGeometry(endpoint_hair_5.endRadius, endpoint_hair_5.baseRadius, endpoint_hair_5.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_hair_5) {
    mesh_hair_5Geometry.scale(0.28, 0.21840000000000004, 0.2856);
  }
  const mesh_hair_5 = new THREE.Mesh(
    mesh_hair_5Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_5.name = "Hair";
  if (endpoint_hair_5) {
    mesh_hair_5.position.copy(endpoint_hair_5.midpoint);
    mesh_hair_5.quaternion.copy(endpoint_hair_5.quaternion);
  }
  mesh_hair_5.castShadow = options.castShadow ?? true;
  mesh_hair_5.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_5.userData.sculptComponent = {"id": "hair", "name": "Hair", "level": "meso", "role": "hair", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Hair is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.28, "height": 0.21840000000000004, "depth": 0.2856, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.084, -0.005600000000000001], "rotation": [0, 0, 0], "scale": [0.28, 0.21840000000000004, 0.2856]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["short, neutral stylized hairstyle"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_hair_5.add(mesh_hair_5);
  meshes["hair"] = mesh_hair_5;
  colliders["hair"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair"] ??= [];
  destructionGroups["hair"].push(node_hair_5);

  const attachment_brow_l_6 = null;
  const endpoint_brow_l_6 = makeAttachmentEndpoint(attachment_brow_l_6);
  const node_brow_l_6 = new THREE.Group();
  node_brow_l_6.name = "Eyebrow L__pivot";
  node_brow_l_6.scale.set(1, 1, 1);
  if (endpoint_brow_l_6) {
    node_brow_l_6.position.copy(endpoint_brow_l_6.start);
    node_brow_l_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_brow_l_6.position.set(0.05600000000000001, 0.033600000000000005, 0.12880000000000003);
    node_brow_l_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_brow_l_6.userData.sculptComponent = {"id": "brow-l", "name": "Eyebrow L", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Eyebrow L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.011200000000000002, "depth": 0.016800000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.05600000000000001, 0.033600000000000005, 0.12880000000000003], "rotation": [0, 0, 0], "scale": [0.06160000000000001, 0.011200000000000002, 0.016800000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_brow_l_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_brow_l_6);
  nodes["brow-l"] = node_brow_l_6;
  const mesh_brow_l_6Geometry = endpoint_brow_l_6
    ? new THREE.CylinderGeometry(endpoint_brow_l_6.endRadius, endpoint_brow_l_6.baseRadius, endpoint_brow_l_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_brow_l_6) {
    mesh_brow_l_6Geometry.scale(0.06160000000000001, 0.011200000000000002, 0.016800000000000002);
  }
  const mesh_brow_l_6 = new THREE.Mesh(
    mesh_brow_l_6Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_l_6.name = "Eyebrow L";
  if (endpoint_brow_l_6) {
    mesh_brow_l_6.position.copy(endpoint_brow_l_6.midpoint);
    mesh_brow_l_6.quaternion.copy(endpoint_brow_l_6.quaternion);
  }
  mesh_brow_l_6.castShadow = options.castShadow ?? true;
  mesh_brow_l_6.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_l_6.userData.sculptComponent = {"id": "brow-l", "name": "Eyebrow L", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Eyebrow L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.011200000000000002, "depth": 0.016800000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.05600000000000001, 0.033600000000000005, 0.12880000000000003], "rotation": [0, 0, 0], "scale": [0.06160000000000001, 0.011200000000000002, 0.016800000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_brow_l_6.add(mesh_brow_l_6);
  meshes["brow-l"] = mesh_brow_l_6;
  colliders["brow-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow-l"] ??= [];
  destructionGroups["brow-l"].push(node_brow_l_6);

  const attachment_brow_r_7 = null;
  const endpoint_brow_r_7 = makeAttachmentEndpoint(attachment_brow_r_7);
  const node_brow_r_7 = new THREE.Group();
  node_brow_r_7.name = "Eyebrow R__pivot";
  node_brow_r_7.scale.set(1, 1, 1);
  if (endpoint_brow_r_7) {
    node_brow_r_7.position.copy(endpoint_brow_r_7.start);
    node_brow_r_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_brow_r_7.position.set(-0.05600000000000001, 0.033600000000000005, 0.12880000000000003);
    node_brow_r_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_brow_r_7.userData.sculptComponent = {"id": "brow-r", "name": "Eyebrow R", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Eyebrow R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.011200000000000002, "depth": 0.016800000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.05600000000000001, 0.033600000000000005, 0.12880000000000003], "rotation": [0, 0, 0], "scale": [0.06160000000000001, 0.011200000000000002, 0.016800000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_brow_r_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_brow_r_7);
  nodes["brow-r"] = node_brow_r_7;
  const mesh_brow_r_7Geometry = endpoint_brow_r_7
    ? new THREE.CylinderGeometry(endpoint_brow_r_7.endRadius, endpoint_brow_r_7.baseRadius, endpoint_brow_r_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_brow_r_7) {
    mesh_brow_r_7Geometry.scale(0.06160000000000001, 0.011200000000000002, 0.016800000000000002);
  }
  const mesh_brow_r_7 = new THREE.Mesh(
    mesh_brow_r_7Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_r_7.name = "Eyebrow R";
  if (endpoint_brow_r_7) {
    mesh_brow_r_7.position.copy(endpoint_brow_r_7.midpoint);
    mesh_brow_r_7.quaternion.copy(endpoint_brow_r_7.quaternion);
  }
  mesh_brow_r_7.castShadow = options.castShadow ?? true;
  mesh_brow_r_7.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_r_7.userData.sculptComponent = {"id": "brow-r", "name": "Eyebrow R", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Eyebrow R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.011200000000000002, "depth": 0.016800000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.05600000000000001, 0.033600000000000005, 0.12880000000000003], "rotation": [0, 0, 0], "scale": [0.06160000000000001, 0.011200000000000002, 0.016800000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_brow_r_7.add(mesh_brow_r_7);
  meshes["brow-r"] = mesh_brow_r_7;
  colliders["brow-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow-r"] ??= [];
  destructionGroups["brow-r"].push(node_brow_r_7);

  const attachment_nose_8 = null;
  const endpoint_nose_8 = makeAttachmentEndpoint(attachment_nose_8);
  const node_nose_8 = new THREE.Group();
  node_nose_8.name = "Nose__pivot";
  node_nose_8.scale.set(1, 1, 1);
  if (endpoint_nose_8) {
    node_nose_8.position.copy(endpoint_nose_8.start);
    node_nose_8.rotation.set(1.4, 0.0, 0.0);
  } else {
    node_nose_8.position.set(0.0, -0.011200000000000002, 0.14);
    node_nose_8.rotation.set(1.4, 0.0, 0.0);
  }
  node_nose_8.userData.sculptComponent = {"id": "nose", "name": "Nose", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Nose is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.039200000000000006, "height": 0.07840000000000001, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.011200000000000002, 0.14], "rotation": [1.4, 0, 0], "scale": [0.039200000000000006, 0.07840000000000001, 0.0504]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_nose_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_nose_8);
  nodes["nose"] = node_nose_8;
  const mesh_nose_8Geometry = endpoint_nose_8
    ? new THREE.CylinderGeometry(endpoint_nose_8.endRadius, endpoint_nose_8.baseRadius, endpoint_nose_8.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_nose_8) {
    mesh_nose_8Geometry.scale(0.039200000000000006, 0.07840000000000001, 0.0504);
  }
  const mesh_nose_8 = new THREE.Mesh(
    mesh_nose_8Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_8.name = "Nose";
  if (endpoint_nose_8) {
    mesh_nose_8.position.copy(endpoint_nose_8.midpoint);
    mesh_nose_8.quaternion.copy(endpoint_nose_8.quaternion);
  }
  mesh_nose_8.castShadow = options.castShadow ?? true;
  mesh_nose_8.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_8.userData.sculptComponent = {"id": "nose", "name": "Nose", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Nose is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.039200000000000006, "height": 0.07840000000000001, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.011200000000000002, 0.14], "rotation": [1.4, 0, 0], "scale": [0.039200000000000006, 0.07840000000000001, 0.0504]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "nose", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_nose_8.add(mesh_nose_8);
  meshes["nose"] = mesh_nose_8;
  colliders["nose"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["nose"] ??= [];
  destructionGroups["nose"].push(node_nose_8);

  const attachment_mouth_9 = null;
  const endpoint_mouth_9 = makeAttachmentEndpoint(attachment_mouth_9);
  const node_mouth_9 = new THREE.Group();
  node_mouth_9.name = "Mouth__pivot";
  node_mouth_9.scale.set(1, 1, 1);
  if (endpoint_mouth_9) {
    node_mouth_9.position.copy(endpoint_mouth_9.start);
    node_mouth_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mouth_9.position.set(0.0, -0.09520000000000002, 0.12880000000000003);
    node_mouth_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_mouth_9.userData.sculptComponent = {"id": "mouth", "name": "Mouth", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Mouth is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.011200000000000002, "depth": 0.014000000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.09520000000000002, 0.12880000000000003], "rotation": [0, 0, 0], "scale": [0.06720000000000001, 0.011200000000000002, 0.014000000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}}, "material": "lips", "materialLayers": ["lips"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_mouth_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}};
  (nodes["head"] ?? root).add(node_mouth_9);
  nodes["mouth"] = node_mouth_9;
  const mesh_mouth_9Geometry = endpoint_mouth_9
    ? new THREE.CylinderGeometry(endpoint_mouth_9.endRadius, endpoint_mouth_9.baseRadius, endpoint_mouth_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_mouth_9) {
    mesh_mouth_9Geometry.scale(0.06720000000000001, 0.011200000000000002, 0.014000000000000002);
  }
  const mesh_mouth_9 = new THREE.Mesh(
    mesh_mouth_9Geometry,
    materialMap["lips"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mouth_9.name = "Mouth";
  if (endpoint_mouth_9) {
    mesh_mouth_9.position.copy(endpoint_mouth_9.midpoint);
    mesh_mouth_9.quaternion.copy(endpoint_mouth_9.quaternion);
  }
  mesh_mouth_9.castShadow = options.castShadow ?? true;
  mesh_mouth_9.receiveShadow = options.receiveShadow ?? true;
  mesh_mouth_9.userData.sculptComponent = {"id": "mouth", "name": "Mouth", "level": "micro", "role": "detail", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Mouth is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.011200000000000002, "depth": 0.014000000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.09520000000000002, 0.12880000000000003], "rotation": [0, 0, 0], "scale": [0.06720000000000001, 0.011200000000000002, 0.014000000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}}, "material": "lips", "materialLayers": ["lips"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_mouth_9.add(mesh_mouth_9);
  meshes["mouth"] = mesh_mouth_9;
  colliders["mouth"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["mouth"] ??= [];
  destructionGroups["mouth"].push(node_mouth_9);

  const attachment_eye_l_10 = null;
  const endpoint_eye_l_10 = makeAttachmentEndpoint(attachment_eye_l_10);
  const node_eye_l_10 = new THREE.Group();
  node_eye_l_10.name = "Eye L__pivot";
  node_eye_l_10.scale.set(1, 1, 1);
  if (endpoint_eye_l_10) {
    node_eye_l_10.position.copy(endpoint_eye_l_10.start);
    node_eye_l_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_l_10.position.set(0.053200000000000004, 0.008400000000000001, 0.11200000000000002);
    node_eye_l_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_l_10.userData.sculptComponent = {"id": "eye-l", "name": "Eye L", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Eye L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.030800000000000004, "height": 0.030800000000000004, "depth": 0.030800000000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.053200000000000004, 0.008400000000000001, 0.11200000000000002], "rotation": [0, 0, 0], "scale": [0.030800000000000004, 0.030800000000000004, 0.030800000000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye", "materialLayers": ["eye"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_eye_l_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["head"] ?? root).add(node_eye_l_10);
  nodes["eye-l"] = node_eye_l_10;
  const mesh_eye_l_10Geometry = endpoint_eye_l_10
    ? new THREE.CylinderGeometry(endpoint_eye_l_10.endRadius, endpoint_eye_l_10.baseRadius, endpoint_eye_l_10.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_eye_l_10) {
    mesh_eye_l_10Geometry.scale(0.030800000000000004, 0.030800000000000004, 0.030800000000000004);
  }
  const mesh_eye_l_10 = new THREE.Mesh(
    mesh_eye_l_10Geometry,
    materialMap["eye"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_l_10.name = "Eye L";
  if (endpoint_eye_l_10) {
    mesh_eye_l_10.position.copy(endpoint_eye_l_10.midpoint);
    mesh_eye_l_10.quaternion.copy(endpoint_eye_l_10.quaternion);
  }
  mesh_eye_l_10.castShadow = options.castShadow ?? true;
  mesh_eye_l_10.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_l_10.userData.sculptComponent = {"id": "eye-l", "name": "Eye L", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Eye L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.030800000000000004, "height": 0.030800000000000004, "depth": 0.030800000000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.053200000000000004, 0.008400000000000001, 0.11200000000000002], "rotation": [0, 0, 0], "scale": [0.030800000000000004, 0.030800000000000004, 0.030800000000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye", "materialLayers": ["eye"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_eye_l_10.add(mesh_eye_l_10);
  meshes["eye-l"] = mesh_eye_l_10;
  colliders["eye-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_l_10);

  const attachment_eye_cavity_l_11 = null;
  const endpoint_eye_cavity_l_11 = makeAttachmentEndpoint(attachment_eye_cavity_l_11);
  const node_eye_cavity_l_11 = new THREE.Group();
  node_eye_cavity_l_11.name = "Eye cavity L__pivot";
  node_eye_cavity_l_11.scale.set(1, 1, 1);
  if (endpoint_eye_cavity_l_11) {
    node_eye_cavity_l_11.position.copy(endpoint_eye_cavity_l_11.start);
    node_eye_cavity_l_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_cavity_l_11.position.set(0.053200000000000004, 0.008400000000000001, 0.12040000000000001);
    node_eye_cavity_l_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_cavity_l_11.userData.sculptComponent = {"id": "eye-cavity-l", "name": "Eye cavity L", "level": "micro", "role": "cavity", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "The eye reads as a recessed concave cavity carved out of the head volume with a boolean subtraction (US-004), not a flat decal or shaded patch.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"type": "subtract", "left": "shell", "right": "carve"}], "resolution": 20}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0504, "height": 0.0504, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.053200000000000004, 0.008400000000000001, 0.12040000000000001], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_eye_cavity_l_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_eye_cavity_l_11);
  nodes["eye-cavity-l"] = node_eye_cavity_l_11;
  const mesh_eye_cavity_l_11Geometry = polygonizeSdf({"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"type": "subtract", "left": "shell", "right": "carve"}], "resolution": 20});
  if (!endpoint_eye_cavity_l_11) {
    mesh_eye_cavity_l_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_eye_cavity_l_11 = new THREE.Mesh(
    mesh_eye_cavity_l_11Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8b98f", "color": "#e8b98f", "albedo": {"dominant": "#e8b98f", "secondary": ["#be9875"]}, "colorVariation": {"palette": ["#e8b98f", "#be9875"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.55, "variation": 0.08}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."}, options, true)
  );
  mesh_eye_cavity_l_11.name = "Eye cavity L";
  if (endpoint_eye_cavity_l_11) {
    mesh_eye_cavity_l_11.position.copy(endpoint_eye_cavity_l_11.midpoint);
    mesh_eye_cavity_l_11.quaternion.copy(endpoint_eye_cavity_l_11.quaternion);
  }
  mesh_eye_cavity_l_11.castShadow = options.castShadow ?? true;
  mesh_eye_cavity_l_11.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_cavity_l_11.userData.sculptComponent = {"id": "eye-cavity-l", "name": "Eye cavity L", "level": "micro", "role": "cavity", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "The eye reads as a recessed concave cavity carved out of the head volume with a boolean subtraction (US-004), not a flat decal or shaded patch.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"type": "subtract", "left": "shell", "right": "carve"}], "resolution": 20}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0504, "height": 0.0504, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.053200000000000004, 0.008400000000000001, 0.12040000000000001], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_eye_cavity_l_11.add(mesh_eye_cavity_l_11);
  meshes["eye-cavity-l"] = mesh_eye_cavity_l_11;
  colliders["eye-cavity-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-cavity-l"] ??= [];
  destructionGroups["eye-cavity-l"].push(node_eye_cavity_l_11);

  const attachment_eye_r_12 = null;
  const endpoint_eye_r_12 = makeAttachmentEndpoint(attachment_eye_r_12);
  const node_eye_r_12 = new THREE.Group();
  node_eye_r_12.name = "Eye R__pivot";
  node_eye_r_12.scale.set(1, 1, 1);
  if (endpoint_eye_r_12) {
    node_eye_r_12.position.copy(endpoint_eye_r_12.start);
    node_eye_r_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_r_12.position.set(-0.053200000000000004, 0.008400000000000001, 0.11200000000000002);
    node_eye_r_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_r_12.userData.sculptComponent = {"id": "eye-r", "name": "Eye R", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Eye R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.030800000000000004, "height": 0.030800000000000004, "depth": 0.030800000000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.053200000000000004, 0.008400000000000001, 0.11200000000000002], "rotation": [0, 0, 0], "scale": [0.030800000000000004, 0.030800000000000004, 0.030800000000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye", "materialLayers": ["eye"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_eye_r_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["head"] ?? root).add(node_eye_r_12);
  nodes["eye-r"] = node_eye_r_12;
  const mesh_eye_r_12Geometry = endpoint_eye_r_12
    ? new THREE.CylinderGeometry(endpoint_eye_r_12.endRadius, endpoint_eye_r_12.baseRadius, endpoint_eye_r_12.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_eye_r_12) {
    mesh_eye_r_12Geometry.scale(0.030800000000000004, 0.030800000000000004, 0.030800000000000004);
  }
  const mesh_eye_r_12 = new THREE.Mesh(
    mesh_eye_r_12Geometry,
    materialMap["eye"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_r_12.name = "Eye R";
  if (endpoint_eye_r_12) {
    mesh_eye_r_12.position.copy(endpoint_eye_r_12.midpoint);
    mesh_eye_r_12.quaternion.copy(endpoint_eye_r_12.quaternion);
  }
  mesh_eye_r_12.castShadow = options.castShadow ?? true;
  mesh_eye_r_12.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_r_12.userData.sculptComponent = {"id": "eye-r", "name": "Eye R", "level": "micro", "role": "detail", "importance": 0.5, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Eye R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.030800000000000004, "height": 0.030800000000000004, "depth": 0.030800000000000004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.053200000000000004, 0.008400000000000001, 0.11200000000000002], "rotation": [0, 0, 0], "scale": [0.030800000000000004, 0.030800000000000004, 0.030800000000000004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye", "materialLayers": ["eye"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_eye_r_12.add(mesh_eye_r_12);
  meshes["eye-r"] = mesh_eye_r_12;
  colliders["eye-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-r"] ??= [];
  destructionGroups["eye-r"].push(node_eye_r_12);

  const attachment_eye_cavity_r_13 = null;
  const endpoint_eye_cavity_r_13 = makeAttachmentEndpoint(attachment_eye_cavity_r_13);
  const node_eye_cavity_r_13 = new THREE.Group();
  node_eye_cavity_r_13.name = "Eye cavity R__pivot";
  node_eye_cavity_r_13.scale.set(1, 1, 1);
  if (endpoint_eye_cavity_r_13) {
    node_eye_cavity_r_13.position.copy(endpoint_eye_cavity_r_13.start);
    node_eye_cavity_r_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_cavity_r_13.position.set(-0.053200000000000004, 0.008400000000000001, 0.12040000000000001);
    node_eye_cavity_r_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_cavity_r_13.userData.sculptComponent = {"id": "eye-cavity-r", "name": "Eye cavity R", "level": "micro", "role": "cavity", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "The eye reads as a recessed concave cavity carved out of the head volume with a boolean subtraction (US-004), not a flat decal or shaded patch.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"type": "subtract", "left": "shell", "right": "carve"}], "resolution": 20}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0504, "height": 0.0504, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.053200000000000004, 0.008400000000000001, 0.12040000000000001], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_eye_cavity_r_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_eye_cavity_r_13);
  nodes["eye-cavity-r"] = node_eye_cavity_r_13;
  const mesh_eye_cavity_r_13Geometry = polygonizeSdf({"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"type": "subtract", "left": "shell", "right": "carve"}], "resolution": 20});
  if (!endpoint_eye_cavity_r_13) {
    mesh_eye_cavity_r_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_eye_cavity_r_13 = new THREE.Mesh(
    mesh_eye_cavity_r_13Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "Base material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8b98f", "color": "#e8b98f", "albedo": {"dominant": "#e8b98f", "secondary": ["#be9875"]}, "colorVariation": {"palette": ["#e8b98f", "#be9875"], "pattern": "flat", "amplitude": 0.05, "heightCorrelation": 0.0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.55, "variation": 0.08}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes."}, options, true)
  );
  mesh_eye_cavity_r_13.name = "Eye cavity R";
  if (endpoint_eye_cavity_r_13) {
    mesh_eye_cavity_r_13.position.copy(endpoint_eye_cavity_r_13.midpoint);
    mesh_eye_cavity_r_13.quaternion.copy(endpoint_eye_cavity_r_13.quaternion);
  }
  mesh_eye_cavity_r_13.castShadow = options.castShadow ?? true;
  mesh_eye_cavity_r_13.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_cavity_r_13.userData.sculptComponent = {"id": "eye-cavity-r", "name": "Eye cavity R", "level": "micro", "role": "cavity", "importance": 0.4, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "The eye reads as a recessed concave cavity carved out of the head volume with a boolean subtraction (US-004), not a flat decal or shaded patch.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "shell", "type": "sphere", "center": [0.0, 0.0, 0.0], "radius": 0.0252}, {"id": "carve", "type": "sphere", "center": [0.0, 0.0, 0.0154], "radius": 0.021}], "operations": [{"type": "subtract", "left": "shell", "right": "carve"}], "resolution": 20}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.0504, "height": 0.0504, "depth": 0.0504, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.053200000000000004, 0.008400000000000001, 0.12040000000000001], "rotation": [0, 0, 0], "scale": [1.0, 1.0, 1.0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-cavity-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_eye_cavity_r_13.add(mesh_eye_cavity_r_13);
  meshes["eye-cavity-r"] = mesh_eye_cavity_r_13;
  colliders["eye-cavity-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-cavity-r"] ??= [];
  destructionGroups["eye-cavity-r"].push(node_eye_cavity_r_13);

  const attachment_upper_arm_l_14 = {"parentSocket": "torso-shoulder-l", "localStart": [0.20048, -0.0224, 0.0084], "localEnd": [0.24652, -0.24952, 0.0084], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_l_14 = makeAttachmentEndpoint(attachment_upper_arm_l_14);
  const node_upper_arm_l_14 = new THREE.Group();
  node_upper_arm_l_14.name = "Upper arm L__pivot";
  node_upper_arm_l_14.scale.set(1, 1, 1);
  if (endpoint_upper_arm_l_14) {
    node_upper_arm_l_14.position.copy(endpoint_upper_arm_l_14.start);
    node_upper_arm_l_14.rotation.set(0.05, 0.0, -0.2);
  } else {
    node_upper_arm_l_14.position.set(0.20048000000000002, -0.022399999999999975, 0.008400000000000001);
    node_upper_arm_l_14.rotation.set(0.05, 0.0, -0.2);
  }
  node_upper_arm_l_14.userData.sculptComponent = {"id": "upper-arm-l", "name": "Upper arm L", "level": "meso", "role": "arm", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Upper arm L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "torso", "attachment": {"parentSocket": "torso-shoulder-l", "localStart": [0.20048, -0.0224, 0.0084], "localEnd": [0.24652, -0.24952, 0.0084], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.08960000000000001, "height": 0.23173920000000003, "depth": 0.08960000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.20048000000000002, -0.022399999999999975, 0.008400000000000001], "rotation": [0.05, 0.0, -0.2], "scale": [0.08960000000000001, 0.23173920000000003, 0.08960000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_upper_arm_l_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["torso"] ?? root).add(node_upper_arm_l_14);
  nodes["upper-arm-l"] = node_upper_arm_l_14;
  const mesh_upper_arm_l_14Geometry = endpoint_upper_arm_l_14
    ? new THREE.CylinderGeometry(endpoint_upper_arm_l_14.endRadius, endpoint_upper_arm_l_14.baseRadius, endpoint_upper_arm_l_14.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_upper_arm_l_14) {
    mesh_upper_arm_l_14Geometry.scale(0.08960000000000001, 0.23173920000000003, 0.08960000000000001);
  }
  const mesh_upper_arm_l_14 = new THREE.Mesh(
    mesh_upper_arm_l_14Geometry,
    materialMap["shirt"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_l_14.name = "Upper arm L";
  if (endpoint_upper_arm_l_14) {
    mesh_upper_arm_l_14.position.copy(endpoint_upper_arm_l_14.midpoint);
    mesh_upper_arm_l_14.quaternion.copy(endpoint_upper_arm_l_14.quaternion);
  }
  mesh_upper_arm_l_14.castShadow = options.castShadow ?? true;
  mesh_upper_arm_l_14.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_l_14.userData.sculptComponent = {"id": "upper-arm-l", "name": "Upper arm L", "level": "meso", "role": "arm", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Upper arm L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "torso", "attachment": {"parentSocket": "torso-shoulder-l", "localStart": [0.20048, -0.0224, 0.0084], "localEnd": [0.24652, -0.24952, 0.0084], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.08960000000000001, "height": 0.23173920000000003, "depth": 0.08960000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.20048000000000002, -0.022399999999999975, 0.008400000000000001], "rotation": [0.05, 0.0, -0.2], "scale": [0.08960000000000001, 0.23173920000000003, 0.08960000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_upper_arm_l_14.add(mesh_upper_arm_l_14);
  meshes["upper-arm-l"] = mesh_upper_arm_l_14;
  colliders["upper-arm-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["upper-arm-l"] ??= [];
  destructionGroups["upper-arm-l"].push(node_upper_arm_l_14);

  const attachment_forearm_l_15 = {"parentSocket": "upper-arm-elbow-l", "localStart": [0.04604, -0.22712, 0.0], "localEnd": [0.06874, -0.41536, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_l_15 = makeAttachmentEndpoint(attachment_forearm_l_15);
  const node_forearm_l_15 = new THREE.Group();
  node_forearm_l_15.name = "Forearm L__pivot";
  node_forearm_l_15.scale.set(1, 1, 1);
  if (endpoint_forearm_l_15) {
    node_forearm_l_15.position.copy(endpoint_forearm_l_15.start);
    node_forearm_l_15.rotation.set(-0.1, 0.0, -0.18);
  } else {
    node_forearm_l_15.position.set(0.04603947178298287, -0.2271198446956671, 0.0);
    node_forearm_l_15.rotation.set(-0.1, 0.0, -0.18);
  }
  node_forearm_l_15.userData.sculptComponent = {"id": "forearm-l", "name": "Forearm L", "level": "meso", "role": "arm", "importance": 0.65, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Forearm L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "upper-arm-l", "attachment": {"parentSocket": "upper-arm-elbow-l", "localStart": [0.04604, -0.22712, 0.0], "localEnd": [0.06874, -0.41536, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0728, "height": 0.18960480000000002, "depth": 0.0728, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.04603947178298287, -0.2271198446956671, 0.0], "rotation": [-0.1, 0.0, -0.18], "scale": [0.0728, 0.18960480000000002, 0.0728]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_forearm_l_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["upper-arm-l"] ?? root).add(node_forearm_l_15);
  nodes["forearm-l"] = node_forearm_l_15;
  const mesh_forearm_l_15Geometry = endpoint_forearm_l_15
    ? new THREE.CylinderGeometry(endpoint_forearm_l_15.endRadius, endpoint_forearm_l_15.baseRadius, endpoint_forearm_l_15.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_forearm_l_15) {
    mesh_forearm_l_15Geometry.scale(0.0728, 0.18960480000000002, 0.0728);
  }
  const mesh_forearm_l_15 = new THREE.Mesh(
    mesh_forearm_l_15Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_l_15.name = "Forearm L";
  if (endpoint_forearm_l_15) {
    mesh_forearm_l_15.position.copy(endpoint_forearm_l_15.midpoint);
    mesh_forearm_l_15.quaternion.copy(endpoint_forearm_l_15.quaternion);
  }
  mesh_forearm_l_15.castShadow = options.castShadow ?? true;
  mesh_forearm_l_15.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_l_15.userData.sculptComponent = {"id": "forearm-l", "name": "Forearm L", "level": "meso", "role": "arm", "importance": 0.65, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Forearm L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "upper-arm-l", "attachment": {"parentSocket": "upper-arm-elbow-l", "localStart": [0.04604, -0.22712, 0.0], "localEnd": [0.06874, -0.41536, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0728, "height": 0.18960480000000002, "depth": 0.0728, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.04603947178298287, -0.2271198446956671, 0.0], "rotation": [-0.1, 0.0, -0.18], "scale": [0.0728, 0.18960480000000002, 0.0728]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_forearm_l_15.add(mesh_forearm_l_15);
  meshes["forearm-l"] = mesh_forearm_l_15;
  colliders["forearm-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["forearm-l"] ??= [];
  destructionGroups["forearm-l"].push(node_forearm_l_15);

  const attachment_hand_l_16 = null;
  const endpoint_hand_l_16 = makeAttachmentEndpoint(attachment_hand_l_16);
  const node_hand_l_16 = new THREE.Group();
  node_hand_l_16.name = "Hand L__pivot";
  node_hand_l_16.scale.set(1, 1, 1);
  if (endpoint_hand_l_16) {
    node_hand_l_16.position.copy(endpoint_hand_l_16.start);
    node_hand_l_16.rotation.set(0.0, 0.0, -0.18);
  } else {
    node_hand_l_16.position.set(0.028061116007117692, -0.23271910972559837, 0.0);
    node_hand_l_16.rotation.set(0.0, 0.0, -0.18);
  }
  node_hand_l_16.userData.sculptComponent = {"id": "hand-l", "name": "Hand L", "level": "meso", "role": "hand", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Hand L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "forearm-l", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.08960000000000001, "depth": 0.0364, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.028061116007117692, -0.23271910972559837, 0.0], "rotation": [0.0, 0.0, -0.18], "scale": [0.06160000000000001, 0.08960000000000001, 0.0364]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_hand_l_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["forearm-l"] ?? root).add(node_hand_l_16);
  nodes["hand-l"] = node_hand_l_16;
  const mesh_hand_l_16Geometry = endpoint_hand_l_16
    ? new THREE.CylinderGeometry(endpoint_hand_l_16.endRadius, endpoint_hand_l_16.baseRadius, endpoint_hand_l_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_hand_l_16) {
    mesh_hand_l_16Geometry.scale(0.06160000000000001, 0.08960000000000001, 0.0364);
  }
  const mesh_hand_l_16 = new THREE.Mesh(
    mesh_hand_l_16Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_l_16.name = "Hand L";
  if (endpoint_hand_l_16) {
    mesh_hand_l_16.position.copy(endpoint_hand_l_16.midpoint);
    mesh_hand_l_16.quaternion.copy(endpoint_hand_l_16.quaternion);
  }
  mesh_hand_l_16.castShadow = options.castShadow ?? true;
  mesh_hand_l_16.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_l_16.userData.sculptComponent = {"id": "hand-l", "name": "Hand L", "level": "meso", "role": "hand", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Hand L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "forearm-l", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.08960000000000001, "depth": 0.0364, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.028061116007117692, -0.23271910972559837, 0.0], "rotation": [0.0, 0.0, -0.18], "scale": [0.06160000000000001, 0.08960000000000001, 0.0364]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_hand_l_16.add(mesh_hand_l_16);
  meshes["hand-l"] = mesh_hand_l_16;
  colliders["hand-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-l"] ??= [];
  destructionGroups["hand-l"].push(node_hand_l_16);

  const attachment_upper_arm_r_17 = {"parentSocket": "torso-shoulder-r", "localStart": [-0.20048, -0.0224, 0.0084], "localEnd": [-0.24652, -0.24952, 0.0084], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_r_17 = makeAttachmentEndpoint(attachment_upper_arm_r_17);
  const node_upper_arm_r_17 = new THREE.Group();
  node_upper_arm_r_17.name = "Upper arm R__pivot";
  node_upper_arm_r_17.scale.set(1, 1, 1);
  if (endpoint_upper_arm_r_17) {
    node_upper_arm_r_17.position.copy(endpoint_upper_arm_r_17.start);
    node_upper_arm_r_17.rotation.set(-0.26, 0.05, 0.3);
  } else {
    node_upper_arm_r_17.position.set(-0.20048000000000002, -0.022399999999999975, 0.008400000000000001);
    node_upper_arm_r_17.rotation.set(-0.26, 0.05, 0.3);
  }
  node_upper_arm_r_17.userData.sculptComponent = {"id": "upper-arm-r", "name": "Upper arm R", "level": "meso", "role": "arm", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Upper arm R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "torso", "attachment": {"parentSocket": "torso-shoulder-r", "localStart": [-0.20048, -0.0224, 0.0084], "localEnd": [-0.24652, -0.24952, 0.0084], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.08960000000000001, "height": 0.23173920000000003, "depth": 0.08960000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.20048000000000002, -0.022399999999999975, 0.008400000000000001], "rotation": [-0.26, 0.05, 0.3], "scale": [0.08960000000000001, 0.23173920000000003, 0.08960000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_upper_arm_r_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["torso"] ?? root).add(node_upper_arm_r_17);
  nodes["upper-arm-r"] = node_upper_arm_r_17;
  const mesh_upper_arm_r_17Geometry = endpoint_upper_arm_r_17
    ? new THREE.CylinderGeometry(endpoint_upper_arm_r_17.endRadius, endpoint_upper_arm_r_17.baseRadius, endpoint_upper_arm_r_17.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_upper_arm_r_17) {
    mesh_upper_arm_r_17Geometry.scale(0.08960000000000001, 0.23173920000000003, 0.08960000000000001);
  }
  const mesh_upper_arm_r_17 = new THREE.Mesh(
    mesh_upper_arm_r_17Geometry,
    materialMap["shirt"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_r_17.name = "Upper arm R";
  if (endpoint_upper_arm_r_17) {
    mesh_upper_arm_r_17.position.copy(endpoint_upper_arm_r_17.midpoint);
    mesh_upper_arm_r_17.quaternion.copy(endpoint_upper_arm_r_17.quaternion);
  }
  mesh_upper_arm_r_17.castShadow = options.castShadow ?? true;
  mesh_upper_arm_r_17.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_r_17.userData.sculptComponent = {"id": "upper-arm-r", "name": "Upper arm R", "level": "meso", "role": "arm", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Upper arm R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "torso", "attachment": {"parentSocket": "torso-shoulder-r", "localStart": [-0.20048, -0.0224, 0.0084], "localEnd": [-0.24652, -0.24952, 0.0084], "contactType": "socket-joint", "baseRadius": 0.0448, "endRadius": 0.0364, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.08960000000000001, "height": 0.23173920000000003, "depth": 0.08960000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.20048000000000002, -0.022399999999999975, 0.008400000000000001], "rotation": [-0.26, 0.05, 0.3], "scale": [0.08960000000000001, 0.23173920000000003, 0.08960000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "shirt", "materialLayers": ["shirt"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_upper_arm_r_17.add(mesh_upper_arm_r_17);
  meshes["upper-arm-r"] = mesh_upper_arm_r_17;
  colliders["upper-arm-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["upper-arm-r"] ??= [];
  destructionGroups["upper-arm-r"].push(node_upper_arm_r_17);

  const attachment_forearm_r_18 = {"parentSocket": "upper-arm-elbow-r", "localStart": [-0.04604, -0.22712, 0.0], "localEnd": [-0.06874, -0.41536, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_r_18 = makeAttachmentEndpoint(attachment_forearm_r_18);
  const node_forearm_r_18 = new THREE.Group();
  node_forearm_r_18.name = "Forearm R__pivot";
  node_forearm_r_18.scale.set(1, 1, 1);
  if (endpoint_forearm_r_18) {
    node_forearm_r_18.position.copy(endpoint_forearm_r_18.start);
    node_forearm_r_18.rotation.set(-0.34, 0.0, 0.05);
  } else {
    node_forearm_r_18.position.set(-0.04603947178298287, -0.2271198446956671, 0.0);
    node_forearm_r_18.rotation.set(-0.34, 0.0, 0.05);
  }
  node_forearm_r_18.userData.sculptComponent = {"id": "forearm-r", "name": "Forearm R", "level": "meso", "role": "arm", "importance": 0.65, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Forearm R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "upper-arm-r", "attachment": {"parentSocket": "upper-arm-elbow-r", "localStart": [-0.04604, -0.22712, 0.0], "localEnd": [-0.06874, -0.41536, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0728, "height": 0.18960480000000002, "depth": 0.0728, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.04603947178298287, -0.2271198446956671, 0.0], "rotation": [-0.34, 0.0, 0.05], "scale": [0.0728, 0.18960480000000002, 0.0728]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_forearm_r_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["upper-arm-r"] ?? root).add(node_forearm_r_18);
  nodes["forearm-r"] = node_forearm_r_18;
  const mesh_forearm_r_18Geometry = endpoint_forearm_r_18
    ? new THREE.CylinderGeometry(endpoint_forearm_r_18.endRadius, endpoint_forearm_r_18.baseRadius, endpoint_forearm_r_18.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_forearm_r_18) {
    mesh_forearm_r_18Geometry.scale(0.0728, 0.18960480000000002, 0.0728);
  }
  const mesh_forearm_r_18 = new THREE.Mesh(
    mesh_forearm_r_18Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_r_18.name = "Forearm R";
  if (endpoint_forearm_r_18) {
    mesh_forearm_r_18.position.copy(endpoint_forearm_r_18.midpoint);
    mesh_forearm_r_18.quaternion.copy(endpoint_forearm_r_18.quaternion);
  }
  mesh_forearm_r_18.castShadow = options.castShadow ?? true;
  mesh_forearm_r_18.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_r_18.userData.sculptComponent = {"id": "forearm-r", "name": "Forearm R", "level": "meso", "role": "arm", "importance": 0.65, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Forearm R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "upper-arm-r", "attachment": {"parentSocket": "upper-arm-elbow-r", "localStart": [-0.04604, -0.22712, 0.0], "localEnd": [-0.06874, -0.41536, 0.0], "contactType": "hinge-joint", "baseRadius": 0.0336, "endRadius": 0.0252, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.0728, "height": 0.18960480000000002, "depth": 0.0728, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.04603947178298287, -0.2271198446956671, 0.0], "rotation": [-0.34, 0.0, 0.05], "scale": [0.0728, 0.18960480000000002, 0.0728]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_forearm_r_18.add(mesh_forearm_r_18);
  meshes["forearm-r"] = mesh_forearm_r_18;
  colliders["forearm-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["forearm-r"] ??= [];
  destructionGroups["forearm-r"].push(node_forearm_r_18);

  const attachment_hand_r_19 = null;
  const endpoint_hand_r_19 = makeAttachmentEndpoint(attachment_hand_r_19);
  const node_hand_r_19 = new THREE.Group();
  node_hand_r_19.name = "Hand R__pivot";
  node_hand_r_19.scale.set(1, 1, 1);
  if (endpoint_hand_r_19) {
    node_hand_r_19.position.copy(endpoint_hand_r_19.start);
    node_hand_r_19.rotation.set(0.0, 0.0, 0.1);
  } else {
    node_hand_r_19.position.set(-0.028061116007117692, -0.23271910972559837, 0.0);
    node_hand_r_19.rotation.set(0.0, 0.0, 0.1);
  }
  node_hand_r_19.userData.sculptComponent = {"id": "hand-r", "name": "Hand R", "level": "meso", "role": "hand", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Hand R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "forearm-r", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.08960000000000001, "depth": 0.0364, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.028061116007117692, -0.23271910972559837, 0.0], "rotation": [0.0, 0.0, 0.1], "scale": [0.06160000000000001, 0.08960000000000001, 0.0364]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_hand_r_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["forearm-r"] ?? root).add(node_hand_r_19);
  nodes["hand-r"] = node_hand_r_19;
  const mesh_hand_r_19Geometry = endpoint_hand_r_19
    ? new THREE.CylinderGeometry(endpoint_hand_r_19.endRadius, endpoint_hand_r_19.baseRadius, endpoint_hand_r_19.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_hand_r_19) {
    mesh_hand_r_19Geometry.scale(0.06160000000000001, 0.08960000000000001, 0.0364);
  }
  const mesh_hand_r_19 = new THREE.Mesh(
    mesh_hand_r_19Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_r_19.name = "Hand R";
  if (endpoint_hand_r_19) {
    mesh_hand_r_19.position.copy(endpoint_hand_r_19.midpoint);
    mesh_hand_r_19.quaternion.copy(endpoint_hand_r_19.quaternion);
  }
  mesh_hand_r_19.castShadow = options.castShadow ?? true;
  mesh_hand_r_19.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_r_19.userData.sculptComponent = {"id": "hand-r", "name": "Hand R", "level": "meso", "role": "hand", "importance": 0.55, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Hand R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "forearm-r", "attachment": null, "dimensions": {"width": 0.06160000000000001, "height": 0.08960000000000001, "depth": 0.0364, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.028061116007117692, -0.23271910972559837, 0.0], "rotation": [0.0, 0.0, 0.1], "scale": [0.06160000000000001, 0.08960000000000001, 0.0364]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_hand_r_19.add(mesh_hand_r_19);
  meshes["hand-r"] = mesh_hand_r_19;
  colliders["hand-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-r"] ??= [];
  destructionGroups["hand-r"].push(node_hand_r_19);

  const attachment_thigh_l_20 = {"parentSocket": "pelvis-hip-l", "localStart": [0.14381, -0.0476, 0.0056], "localEnd": [0.14381, -0.54979, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_l_20 = makeAttachmentEndpoint(attachment_thigh_l_20);
  const node_thigh_l_20 = new THREE.Group();
  node_thigh_l_20.name = "Thigh L__pivot";
  node_thigh_l_20.scale.set(1, 1, 1);
  if (endpoint_thigh_l_20) {
    node_thigh_l_20.position.copy(endpoint_thigh_l_20.start);
    node_thigh_l_20.rotation.set(0.0, 0.0, -0.06);
  } else {
    node_thigh_l_20.position.set(0.14380800000000002, -0.0476, 0.005600000000000001);
    node_thigh_l_20.rotation.set(0.0, 0.0, -0.06);
  }
  node_thigh_l_20.userData.sculptComponent = {"id": "thigh-l", "name": "Thigh L", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thigh L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-hip-l", "localStart": [0.14381, -0.0476, 0.0056], "localEnd": [0.14381, -0.54979, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.10640000000000001, "height": 0.5021856, "depth": 0.10640000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.14380800000000002, -0.0476, 0.005600000000000001], "rotation": [0.0, 0.0, -0.06], "scale": [0.10640000000000001, 0.5021856, 0.10640000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_thigh_l_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["pelvis"] ?? root).add(node_thigh_l_20);
  nodes["thigh-l"] = node_thigh_l_20;
  const mesh_thigh_l_20Geometry = endpoint_thigh_l_20
    ? new THREE.CylinderGeometry(endpoint_thigh_l_20.endRadius, endpoint_thigh_l_20.baseRadius, endpoint_thigh_l_20.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thigh_l_20) {
    mesh_thigh_l_20Geometry.scale(0.10640000000000001, 0.5021856, 0.10640000000000001);
  }
  const mesh_thigh_l_20 = new THREE.Mesh(
    mesh_thigh_l_20Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_l_20.name = "Thigh L";
  if (endpoint_thigh_l_20) {
    mesh_thigh_l_20.position.copy(endpoint_thigh_l_20.midpoint);
    mesh_thigh_l_20.quaternion.copy(endpoint_thigh_l_20.quaternion);
  }
  mesh_thigh_l_20.castShadow = options.castShadow ?? true;
  mesh_thigh_l_20.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_l_20.userData.sculptComponent = {"id": "thigh-l", "name": "Thigh L", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thigh L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-hip-l", "localStart": [0.14381, -0.0476, 0.0056], "localEnd": [0.14381, -0.54979, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.10640000000000001, "height": 0.5021856, "depth": 0.10640000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.14380800000000002, -0.0476, 0.005600000000000001], "rotation": [0.0, 0.0, -0.06], "scale": [0.10640000000000001, 0.5021856, 0.10640000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_thigh_l_20.add(mesh_thigh_l_20);
  meshes["thigh-l"] = mesh_thigh_l_20;
  colliders["thigh-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thigh-l"] ??= [];
  destructionGroups["thigh-l"].push(node_thigh_l_20);

  const attachment_shin_l_21 = {"parentSocket": "thigh-knee-l", "localStart": [0.0, -0.50219, 0.0], "localEnd": [0.0, -0.94752, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shin_l_21 = makeAttachmentEndpoint(attachment_shin_l_21);
  const node_shin_l_21 = new THREE.Group();
  node_shin_l_21.name = "Shin L__pivot";
  node_shin_l_21.scale.set(1, 1, 1);
  if (endpoint_shin_l_21) {
    node_shin_l_21.position.copy(endpoint_shin_l_21.start);
    node_shin_l_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shin_l_21.position.set(0.0, -0.5021856, 0.0);
    node_shin_l_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_shin_l_21.userData.sculptComponent = {"id": "shin-l", "name": "Shin L", "level": "meso", "role": "leg", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Shin L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-l", "attachment": {"parentSocket": "thigh-knee-l", "localStart": [0.0, -0.50219, 0.0], "localEnd": [0.0, -0.94752, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07840000000000001, "height": 0.44533439999999996, "depth": 0.07840000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.5021856, 0.0], "rotation": [0, 0, 0], "scale": [0.07840000000000001, 0.44533439999999996, 0.07840000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_shin_l_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["thigh-l"] ?? root).add(node_shin_l_21);
  nodes["shin-l"] = node_shin_l_21;
  const mesh_shin_l_21Geometry = endpoint_shin_l_21
    ? new THREE.CylinderGeometry(endpoint_shin_l_21.endRadius, endpoint_shin_l_21.baseRadius, endpoint_shin_l_21.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_shin_l_21) {
    mesh_shin_l_21Geometry.scale(0.07840000000000001, 0.44533439999999996, 0.07840000000000001);
  }
  const mesh_shin_l_21 = new THREE.Mesh(
    mesh_shin_l_21Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_l_21.name = "Shin L";
  if (endpoint_shin_l_21) {
    mesh_shin_l_21.position.copy(endpoint_shin_l_21.midpoint);
    mesh_shin_l_21.quaternion.copy(endpoint_shin_l_21.quaternion);
  }
  mesh_shin_l_21.castShadow = options.castShadow ?? true;
  mesh_shin_l_21.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_l_21.userData.sculptComponent = {"id": "shin-l", "name": "Shin L", "level": "meso", "role": "leg", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Shin L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-l", "attachment": {"parentSocket": "thigh-knee-l", "localStart": [0.0, -0.50219, 0.0], "localEnd": [0.0, -0.94752, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07840000000000001, "height": 0.44533439999999996, "depth": 0.07840000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.5021856, 0.0], "rotation": [0, 0, 0], "scale": [0.07840000000000001, 0.44533439999999996, 0.07840000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_shin_l_21.add(mesh_shin_l_21);
  meshes["shin-l"] = mesh_shin_l_21;
  colliders["shin-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["shin-l"] ??= [];
  destructionGroups["shin-l"].push(node_shin_l_21);

  const attachment_foot_l_22 = null;
  const endpoint_foot_l_22 = makeAttachmentEndpoint(attachment_foot_l_22);
  const node_foot_l_22 = new THREE.Group();
  node_foot_l_22.name = "Foot L__pivot";
  node_foot_l_22.scale.set(1, 1, 1);
  if (endpoint_foot_l_22) {
    node_foot_l_22.position.copy(endpoint_foot_l_22.start);
    node_foot_l_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foot_l_22.position.set(0.0, -0.45933440000000003, 0.039200000000000006);
    node_foot_l_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_foot_l_22.userData.sculptComponent = {"id": "foot-l", "name": "Foot L", "level": "meso", "role": "foot", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Foot L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shin-l", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.044800000000000006, "depth": 0.12320000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.45933440000000003, 0.039200000000000006], "rotation": [0, 0, 0], "scale": [0.06720000000000001, 0.044800000000000006, 0.12320000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "shoes", "materialLayers": ["shoes"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_foot_l_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}};
  (nodes["shin-l"] ?? root).add(node_foot_l_22);
  nodes["foot-l"] = node_foot_l_22;
  const mesh_foot_l_22Geometry = endpoint_foot_l_22
    ? new THREE.CylinderGeometry(endpoint_foot_l_22.endRadius, endpoint_foot_l_22.baseRadius, endpoint_foot_l_22.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_foot_l_22) {
    mesh_foot_l_22Geometry.scale(0.06720000000000001, 0.044800000000000006, 0.12320000000000002);
  }
  const mesh_foot_l_22 = new THREE.Mesh(
    mesh_foot_l_22Geometry,
    materialMap["shoes"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_l_22.name = "Foot L";
  if (endpoint_foot_l_22) {
    mesh_foot_l_22.position.copy(endpoint_foot_l_22.midpoint);
    mesh_foot_l_22.quaternion.copy(endpoint_foot_l_22.quaternion);
  }
  mesh_foot_l_22.castShadow = options.castShadow ?? true;
  mesh_foot_l_22.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_l_22.userData.sculptComponent = {"id": "foot-l", "name": "Foot L", "level": "meso", "role": "foot", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Foot L is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shin-l", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.044800000000000006, "depth": 0.12320000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.45933440000000003, 0.039200000000000006], "rotation": [0, 0, 0], "scale": [0.06720000000000001, 0.044800000000000006, 0.12320000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "shoes", "materialLayers": ["shoes"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_foot_l_22.add(mesh_foot_l_22);
  meshes["foot-l"] = mesh_foot_l_22;
  colliders["foot-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["foot-l"] ??= [];
  destructionGroups["foot-l"].push(node_foot_l_22);

  const attachment_thigh_r_23 = {"parentSocket": "pelvis-hip-r", "localStart": [-0.14381, -0.0476, 0.0056], "localEnd": [-0.14381, -0.54979, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_r_23 = makeAttachmentEndpoint(attachment_thigh_r_23);
  const node_thigh_r_23 = new THREE.Group();
  node_thigh_r_23.name = "Thigh R__pivot";
  node_thigh_r_23.scale.set(1, 1, 1);
  if (endpoint_thigh_r_23) {
    node_thigh_r_23.position.copy(endpoint_thigh_r_23.start);
    node_thigh_r_23.rotation.set(0.1, 0.14, 0.05);
  } else {
    node_thigh_r_23.position.set(-0.14380800000000002, -0.0476, 0.005600000000000001);
    node_thigh_r_23.rotation.set(0.1, 0.14, 0.05);
  }
  node_thigh_r_23.userData.sculptComponent = {"id": "thigh-r", "name": "Thigh R", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thigh R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-hip-r", "localStart": [-0.14381, -0.0476, 0.0056], "localEnd": [-0.14381, -0.54979, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.10640000000000001, "height": 0.5021856, "depth": 0.10640000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.14380800000000002, -0.0476, 0.005600000000000001], "rotation": [0.1, 0.14, 0.05], "scale": [0.10640000000000001, 0.5021856, 0.10640000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_thigh_r_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["pelvis"] ?? root).add(node_thigh_r_23);
  nodes["thigh-r"] = node_thigh_r_23;
  const mesh_thigh_r_23Geometry = endpoint_thigh_r_23
    ? new THREE.CylinderGeometry(endpoint_thigh_r_23.endRadius, endpoint_thigh_r_23.baseRadius, endpoint_thigh_r_23.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_thigh_r_23) {
    mesh_thigh_r_23Geometry.scale(0.10640000000000001, 0.5021856, 0.10640000000000001);
  }
  const mesh_thigh_r_23 = new THREE.Mesh(
    mesh_thigh_r_23Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_r_23.name = "Thigh R";
  if (endpoint_thigh_r_23) {
    mesh_thigh_r_23.position.copy(endpoint_thigh_r_23.midpoint);
    mesh_thigh_r_23.quaternion.copy(endpoint_thigh_r_23.quaternion);
  }
  mesh_thigh_r_23.castShadow = options.castShadow ?? true;
  mesh_thigh_r_23.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_r_23.userData.sculptComponent = {"id": "thigh-r", "name": "Thigh R", "level": "meso", "role": "leg", "importance": 0.75, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Thigh R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "pelvis", "attachment": {"parentSocket": "pelvis-hip-r", "localStart": [-0.14381, -0.0476, 0.0056], "localEnd": [-0.14381, -0.54979, 0.0056], "contactType": "socket-joint", "baseRadius": 0.056, "endRadius": 0.0448, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.10640000000000001, "height": 0.5021856, "depth": 0.10640000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.14380800000000002, -0.0476, 0.005600000000000001], "rotation": [0.1, 0.14, 0.05], "scale": [0.10640000000000001, 0.5021856, 0.10640000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_thigh_r_23.add(mesh_thigh_r_23);
  meshes["thigh-r"] = mesh_thigh_r_23;
  colliders["thigh-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["thigh-r"] ??= [];
  destructionGroups["thigh-r"].push(node_thigh_r_23);

  const attachment_shin_r_24 = {"parentSocket": "thigh-knee-r", "localStart": [0.0, -0.50219, 0.0], "localEnd": [0.0, -0.94752, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_shin_r_24 = makeAttachmentEndpoint(attachment_shin_r_24);
  const node_shin_r_24 = new THREE.Group();
  node_shin_r_24.name = "Shin R__pivot";
  node_shin_r_24.scale.set(1, 1, 1);
  if (endpoint_shin_r_24) {
    node_shin_r_24.position.copy(endpoint_shin_r_24.start);
    node_shin_r_24.rotation.set(0.14, 0.0, 0.0);
  } else {
    node_shin_r_24.position.set(0.0, -0.5021856, 0.0);
    node_shin_r_24.rotation.set(0.14, 0.0, 0.0);
  }
  node_shin_r_24.userData.sculptComponent = {"id": "shin-r", "name": "Shin R", "level": "meso", "role": "leg", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Shin R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-r", "attachment": {"parentSocket": "thigh-knee-r", "localStart": [0.0, -0.50219, 0.0], "localEnd": [0.0, -0.94752, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07840000000000001, "height": 0.44533439999999996, "depth": 0.07840000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.5021856, 0.0], "rotation": [0.14, 0.0, 0.0], "scale": [0.07840000000000001, 0.44533439999999996, 0.07840000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_shin_r_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}};
  (nodes["thigh-r"] ?? root).add(node_shin_r_24);
  nodes["shin-r"] = node_shin_r_24;
  const mesh_shin_r_24Geometry = endpoint_shin_r_24
    ? new THREE.CylinderGeometry(endpoint_shin_r_24.endRadius, endpoint_shin_r_24.baseRadius, endpoint_shin_r_24.length, 32, 12)
    : buildWatertightCapsule(0.35, 0.7, 16, 32, 1);
  if (!endpoint_shin_r_24) {
    mesh_shin_r_24Geometry.scale(0.07840000000000001, 0.44533439999999996, 0.07840000000000001);
  }
  const mesh_shin_r_24 = new THREE.Mesh(
    mesh_shin_r_24Geometry,
    materialMap["pants"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_r_24.name = "Shin R";
  if (endpoint_shin_r_24) {
    mesh_shin_r_24.position.copy(endpoint_shin_r_24.midpoint);
    mesh_shin_r_24.quaternion.copy(endpoint_shin_r_24.quaternion);
  }
  mesh_shin_r_24.castShadow = options.castShadow ?? true;
  mesh_shin_r_24.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_r_24.userData.sculptComponent = {"id": "shin-r", "name": "Shin R", "level": "meso", "role": "leg", "importance": 0.7, "confidence": 0.8, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Shin R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "thigh-r", "attachment": {"parentSocket": "thigh-knee-r", "localStart": [0.0, -0.50219, 0.0], "localEnd": [0.0, -0.94752, -0.0056], "contactType": "hinge-joint", "baseRadius": 0.0392, "endRadius": 0.028, "embedDepth": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.07840000000000001, "height": 0.44533439999999996, "depth": 0.07840000000000001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.5021856, 0.0], "rotation": [0.14, 0.0, 0.0], "scale": [0.07840000000000001, 0.44533439999999996, 0.07840000000000001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pants"}}, "material": "pants", "materialLayers": ["pants"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_shin_r_24.add(mesh_shin_r_24);
  meshes["shin-r"] = mesh_shin_r_24;
  colliders["shin-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["shin-r"] ??= [];
  destructionGroups["shin-r"].push(node_shin_r_24);

  const attachment_foot_r_25 = null;
  const endpoint_foot_r_25 = makeAttachmentEndpoint(attachment_foot_r_25);
  const node_foot_r_25 = new THREE.Group();
  node_foot_r_25.name = "Foot R__pivot";
  node_foot_r_25.scale.set(1, 1, 1);
  if (endpoint_foot_r_25) {
    node_foot_r_25.position.copy(endpoint_foot_r_25.start);
    node_foot_r_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foot_r_25.position.set(0.0, -0.45933440000000003, 0.039200000000000006);
    node_foot_r_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_foot_r_25.userData.sculptComponent = {"id": "foot-r", "name": "Foot R", "level": "meso", "role": "foot", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Foot R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shin-r", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.044800000000000006, "depth": 0.12320000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.45933440000000003, 0.039200000000000006], "rotation": [0, 0, 0], "scale": [0.06720000000000001, 0.044800000000000006, 0.12320000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "shoes", "materialLayers": ["shoes"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_foot_r_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}};
  (nodes["shin-r"] ?? root).add(node_foot_r_25);
  nodes["foot-r"] = node_foot_r_25;
  const mesh_foot_r_25Geometry = endpoint_foot_r_25
    ? new THREE.CylinderGeometry(endpoint_foot_r_25.endRadius, endpoint_foot_r_25.baseRadius, endpoint_foot_r_25.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_foot_r_25) {
    mesh_foot_r_25Geometry.scale(0.06720000000000001, 0.044800000000000006, 0.12320000000000002);
  }
  const mesh_foot_r_25 = new THREE.Mesh(
    mesh_foot_r_25Geometry,
    materialMap["shoes"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_r_25.name = "Foot R";
  if (endpoint_foot_r_25) {
    mesh_foot_r_25.position.copy(endpoint_foot_r_25.midpoint);
    mesh_foot_r_25.quaternion.copy(endpoint_foot_r_25.quaternion);
  }
  mesh_foot_r_25.castShadow = options.castShadow ?? true;
  mesh_foot_r_25.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_r_25.userData.sculptComponent = {"id": "foot-r", "name": "Foot R", "level": "meso", "role": "foot", "importance": 0.5, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Foot R is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "shin-r", "attachment": null, "dimensions": {"width": 0.06720000000000001, "height": 0.044800000000000006, "depth": 0.12320000000000002, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0, -0.45933440000000003, 0.039200000000000006], "rotation": [0, 0, 0], "scale": [0.06720000000000001, 0.044800000000000006, 0.12320000000000002]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "shoes", "materialLayers": ["shoes"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_foot_r_25.add(mesh_foot_r_25);
  meshes["foot-r"] = mesh_foot_r_25;
  colliders["foot-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["foot-r"] ??= [];
  destructionGroups["foot-r"].push(node_foot_r_25);

  // PLAN_1.5 WS-C slice 1: bone hierarchy from spec.rig. Model-space joints are
  // converted to parent-local offsets here. Nothing is bound yet (rig.bound === false).
  const bones: Record<string, THREE.Bone> = {};
  const boneOrder: string[] = [];
  const bone_pelvis = new THREE.Bone();
  bone_pelvis.name = "pelvis";
  bone_pelvis.position.set(0.0, -0.09576, 0.0);
  root.add(bone_pelvis);
  bones["pelvis"] = bone_pelvis;
  boneOrder.push("pelvis");
  const bone_thigh_l = new THREE.Bone();
  bone_thigh_l.name = "thigh-l";
  bone_thigh_l.position.set(0.14381, -0.04759999999999999, 0.0056);
  bone_pelvis.add(bone_thigh_l);
  bones["thigh-l"] = bone_thigh_l;
  boneOrder.push("thigh-l");
  const bone_shin_l = new THREE.Bone();
  bone_shin_l.name = "shin-l";
  bone_shin_l.position.set(0.0, -0.5021899999999999, 0.0);
  bone_thigh_l.add(bone_shin_l);
  bones["shin-l"] = bone_shin_l;
  boneOrder.push("shin-l");
  const bone_foot_l = new THREE.Bone();
  bone_foot_l.name = "foot-l";
  bone_foot_l.position.set(0.0, -0.4593300000000001, 0.0392);
  bone_shin_l.add(bone_foot_l);
  bones["foot-l"] = bone_foot_l;
  boneOrder.push("foot-l");
  const bone_thigh_r = new THREE.Bone();
  bone_thigh_r.name = "thigh-r";
  bone_thigh_r.position.set(-0.14381, -0.04759999999999999, 0.0056);
  bone_pelvis.add(bone_thigh_r);
  bones["thigh-r"] = bone_thigh_r;
  boneOrder.push("thigh-r");
  const bone_shin_r = new THREE.Bone();
  bone_shin_r.name = "shin-r";
  bone_shin_r.position.set(0.0, -0.5021899999999999, 0.0);
  bone_thigh_r.add(bone_shin_r);
  bones["shin-r"] = bone_shin_r;
  boneOrder.push("shin-r");
  const bone_foot_r = new THREE.Bone();
  bone_foot_r.name = "foot-r";
  bone_foot_r.position.set(0.0, -0.4593300000000001, 0.0392);
  bone_shin_r.add(bone_foot_r);
  bones["foot-r"] = bone_foot_r;
  boneOrder.push("foot-r");
  const bone_torso = new THREE.Bone();
  bone_torso.name = "torso";
  bone_torso.position.set(0.0, 0.061599999999999995, 0.0);
  bone_pelvis.add(bone_torso);
  bones["torso"] = bone_torso;
  boneOrder.push("torso");
  const bone_upper_arm_l = new THREE.Bone();
  bone_upper_arm_l.name = "upper-arm-l";
  bone_upper_arm_l.position.set(0.20048, 0.38752000000000003, 0.014);
  bone_torso.add(bone_upper_arm_l);
  bones["upper-arm-l"] = bone_upper_arm_l;
  boneOrder.push("upper-arm-l");
  const bone_forearm_l = new THREE.Bone();
  bone_forearm_l.name = "forearm-l";
  bone_forearm_l.position.set(0.04604, -0.22712000000000002, 0.0);
  bone_upper_arm_l.add(bone_forearm_l);
  bones["forearm-l"] = bone_forearm_l;
  boneOrder.push("forearm-l");
  const bone_upper_arm_r = new THREE.Bone();
  bone_upper_arm_r.name = "upper-arm-r";
  bone_upper_arm_r.position.set(-0.20048, 0.38752000000000003, 0.014);
  bone_torso.add(bone_upper_arm_r);
  bones["upper-arm-r"] = bone_upper_arm_r;
  boneOrder.push("upper-arm-r");
  const bone_forearm_r = new THREE.Bone();
  bone_forearm_r.name = "forearm-r";
  bone_forearm_r.position.set(-0.04604, -0.22712000000000002, 0.0);
  bone_upper_arm_r.add(bone_forearm_r);
  bones["forearm-r"] = bone_forearm_r;
  boneOrder.push("forearm-r");
  const bone_hand_l = new THREE.Bone();
  bone_hand_l.name = "hand-l";
  bone_hand_l.position.set(0.02806, -0.23271999999999998, 0.0);
  bone_forearm_l.add(bone_hand_l);
  bones["hand-l"] = bone_hand_l;
  boneOrder.push("hand-l");
  const bone_hand_r = new THREE.Bone();
  bone_hand_r.name = "hand-r";
  bone_hand_r.position.set(-0.02806, -0.23271999999999998, 0.0);
  bone_forearm_r.add(bone_hand_r);
  bones["hand-r"] = bone_hand_r;
  boneOrder.push("hand-r");
  const bone_neck = new THREE.Bone();
  bone_neck.name = "neck";
  bone_neck.position.set(0.0, 0.38752000000000003, 0.0056);
  bone_torso.add(bone_neck);
  bones["neck"] = bone_neck;
  boneOrder.push("neck");
  const bone_head = new THREE.Bone();
  bone_head.name = "head";
  bone_head.position.set(0.0, 0.34663999999999995, 0.0);
  bone_neck.add(bone_head);
  bones["head"] = bone_head;
  boneOrder.push("head");
  const skeleton = new THREE.Skeleton(boneOrder.map((id) => bones[id]));
  root.userData.rig = { bones, skeleton, boneOrder, bound: false };

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createRegretKnightLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Regret Knight look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createRegretKnightEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameRegretKnightCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createRegretKnightPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureRegretKnightRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createRegretKnightInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
