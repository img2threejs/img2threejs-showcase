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

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
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
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
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
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
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
    flatShading: spec.flatShading === true,
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
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
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

// Generated from ObjectSculptSpec target: Whimsical Hearth House
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createWhimsicalHearthHouseModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Whimsical Hearth House";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": true, "fovDegrees": 32.0, "aspect": 1.25156, "orientation": {"yaw": -38.0, "pitch": -25.0, "roll": 0.0}, "positionHint": [9.2, 7.2, 10.8], "note": "Approximate isometric fit to the generated front-right reference; rear remains inferred."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["ground-grass"] = createSculptMaterial(
    "ground-grass",
    {"id": "ground-grass", "name": "Ground Grass", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#73863D", "color": "#73863D", "albedo": {"dominant": "#2A2608", "secondary": ["#5D540B", "#8F7B22", "#493C27"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_albedo.png", "url": "ground-grass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#2A2608", "#5D540B", "#8F7B22", "#493C27", "#E4D8B4"], "pattern": "reference-derived pixel palette", "amplitude": 0.241, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.481, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.726, "variation": 0.12, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_roughness.png", "url": "ground-grass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.239, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_normal.png", "url": "ground-grass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_height.png", "url": "ground-grass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.032, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_height.png", "url": "ground-grass_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_ao.png", "url": "ground-grass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/ground-grass.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_albedo.png", "url": "ground-grass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_roughness.png", "url": "ground-grass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_height.png", "url": "ground-grass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_normal.png", "url": "ground-grass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/ground-grass/ground-grass_ao.png", "url": "ground-grass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 180, "sourceHeight": 180, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 180, "height": 180}, "mask": {"backgroundColor": "#897113", "backgroundNoise": 101.297, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9924}, "mapStats": {"valueRange": 0.5733, "heightP90Gradient": 0.07068, "roughnessBase": 0.726, "roughnessVariation": 0.12, "normalStrength": 0.239, "blurRadius": 21}, "palette": ["#2A2608", "#5D540B", "#8F7B22", "#493C27", "#E4D8B4"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["stucco-cream"] = createSculptMaterial(
    "stucco-cream",
    {"id": "stucco-cream", "name": "Stucco Cream", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#DCC99F", "color": "#DCC99F", "albedo": {"dominant": "#642F0E", "secondary": ["#954113", "#CE591E", "#331705"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_albedo.png", "url": "stucco-cream_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#642F0E", "#954113", "#CE591E", "#331705", "#C1986A"], "pattern": "reference-derived pixel palette", "amplitude": 0.23, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.472, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.727, "variation": 0.14, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_roughness.png", "url": "stucco-cream_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.242, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_normal.png", "url": "stucco-cream_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_height.png", "url": "stucco-cream_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.033, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_height.png", "url": "stucco-cream_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_ao.png", "url": "stucco-cream_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "stucco-patina", "kind": "stain", "description": "Subtle warm variation and darker protected corners.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/stucco-cream.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_albedo.png", "url": "stucco-cream_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_roughness.png", "url": "stucco-cream_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_height.png", "url": "stucco-cream_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_normal.png", "url": "stucco-cream_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stucco-cream/stucco-cream_ao.png", "url": "stucco-cream_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 240, "sourceHeight": 250, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 240, "height": 250}, "mask": {"backgroundColor": "#805C39", "backgroundNoise": 101.129, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9989}, "mapStats": {"valueRange": 0.5479, "heightP90Gradient": 0.07281, "roughnessBase": 0.727, "roughnessVariation": 0.14, "normalStrength": 0.242, "blurRadius": 21}, "palette": ["#642F0E", "#954113", "#CE591E", "#331705", "#C1986A"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["roof-terracotta"] = createSculptMaterial(
    "roof-terracotta",
    {"id": "roof-terracotta", "name": "Roof Terracotta", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B84B1E", "color": "#B84B1E", "albedo": {"dominant": "#D96329", "secondary": ["#AB4816", "#773010", "#3D1B08"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_albedo.png", "url": "roof-terracotta_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#D96329", "#AB4816", "#773010", "#3D1B08", "#D8BB93"], "pattern": "reference-derived pixel palette", "amplitude": 0.266, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.501, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.716, "variation": 0.153, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_roughness.png", "url": "roof-terracotta_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.244, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_normal.png", "url": "roof-terracotta_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_height.png", "url": "roof-terracotta_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.034, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_height.png", "url": "roof-terracotta_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_ao.png", "url": "roof-terracotta_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "tile-edge-wear", "kind": "bevel", "description": "Lighter bevel response on exposed tile noses.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/roof-terracotta.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_albedo.png", "url": "roof-terracotta_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_roughness.png", "url": "roof-terracotta_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_height.png", "url": "roof-terracotta_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_normal.png", "url": "roof-terracotta_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/roof-terracotta/roof-terracotta_ao.png", "url": "roof-terracotta_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 520, "sourceHeight": 300, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 520, "height": 300}, "mask": {"backgroundColor": "#E9E0D8", "backgroundNoise": 202.536, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8123}, "mapStats": {"valueRange": 0.6328, "heightP90Gradient": 0.07499, "roughnessBase": 0.716, "roughnessVariation": 0.153, "normalStrength": 0.244, "blurRadius": 21}, "palette": ["#D96329", "#AB4816", "#773010", "#3D1B08", "#D8BB93"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["wood-walnut"] = createSculptMaterial(
    "wood-walnut",
    {"id": "wood-walnut", "name": "Wood Walnut", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#6F3A1C", "color": "#6F3A1C", "albedo": {"dominant": "#753F11", "secondary": ["#391B03", "#B06227", "#0F2F29"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_albedo.png", "url": "wood-walnut_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#753F11", "#391B03", "#B06227", "#0F2F29", "#E5B174"], "pattern": "reference-derived pixel palette", "amplitude": 0.266, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.502, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.714, "variation": 0.101, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_roughness.png", "url": "wood-walnut_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.219, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_normal.png", "url": "wood-walnut_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_height.png", "url": "wood-walnut_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.024, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_height.png", "url": "wood-walnut_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_ao.png", "url": "wood-walnut_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "timber-grain", "kind": "linework", "description": "Low-contrast lengthwise grain on porch and frames.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/wood-walnut.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_albedo.png", "url": "wood-walnut_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_roughness.png", "url": "wood-walnut_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_height.png", "url": "wood-walnut_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_normal.png", "url": "wood-walnut_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/wood-walnut/wood-walnut_ao.png", "url": "wood-walnut_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 260, "sourceHeight": 220, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 260, "height": 220}, "mask": {"backgroundColor": "#936231", "backgroundNoise": 148.98, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9998}, "mapStats": {"valueRange": 0.6341, "heightP90Gradient": 0.05323, "roughnessBase": 0.714, "roughnessVariation": 0.101, "normalStrength": 0.219, "blurRadius": 21}, "palette": ["#753F11", "#391B03", "#B06227", "#0F2F29", "#E5B174"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["door-teal"] = createSculptMaterial(
    "door-teal",
    {"id": "door-teal", "name": "Door Teal", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#075D5A", "color": "#075D5A", "albedo": {"dominant": "#976636", "secondary": ["#693D15", "#153E39", "#181D10"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_albedo.png", "url": "door-teal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#976636", "#693D15", "#153E39", "#181D10", "#C69B6C"], "pattern": "reference-derived pixel palette", "amplitude": 0.233, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.475, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.707, "variation": 0.095, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_roughness.png", "url": "door-teal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.214, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_normal.png", "url": "door-teal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_height.png", "url": "door-teal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.022, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_height.png", "url": "door-teal_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_ao.png", "url": "door-teal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/door-teal.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_albedo.png", "url": "door-teal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_roughness.png", "url": "door-teal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_height.png", "url": "door-teal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_normal.png", "url": "door-teal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/door-teal/door-teal_ao.png", "url": "door-teal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 130, "sourceHeight": 210, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 130, "height": 210}, "mask": {"backgroundColor": "#936A42", "backgroundNoise": 105.835, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.5559, "heightP90Gradient": 0.04934, "roughnessBase": 0.707, "roughnessVariation": 0.095, "normalStrength": 0.214, "blurRadius": 21}, "palette": ["#976636", "#693D15", "#153E39", "#181D10", "#C69B6C"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["glass-blue"] = createSculptMaterial(
    "glass-blue",
    {"id": "glass-blue", "name": "Glass Blue", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#59A6B5", "color": "#59A6B5", "albedo": {"dominant": "#682205", "secondary": ["#A03911", "#351708", "#744E29"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_albedo.png", "url": "glass-blue_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#682205", "#A03911", "#351708", "#744E29", "#B28053"], "pattern": "reference-derived pixel palette", "amplitude": 0.194, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.442, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.704, "variation": 0.099, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_roughness.png", "url": "glass-blue_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.05, "variation": 0.02}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.216, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_normal.png", "url": "glass-blue_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_height.png", "url": "glass-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.023, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_height.png", "url": "glass-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_ao.png", "url": "glass-blue_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/glass-blue.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.825, "estimatedFidelity": 0.825, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_albedo.png", "url": "glass-blue_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_roughness.png", "url": "glass-blue_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_height.png", "url": "glass-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_normal.png", "url": "glass-blue_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/glass-blue/glass-blue_ao.png", "url": "glass-blue_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 120, "sourceHeight": 150, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 120, "height": 150}, "mask": {"backgroundColor": "#835C30", "backgroundNoise": 113.314, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9982}, "mapStats": {"valueRange": 0.4627, "heightP90Gradient": 0.05098, "roughnessBase": 0.704, "roughnessVariation": 0.099, "normalStrength": 0.216, "blurRadius": 21}, "palette": ["#682205", "#A03911", "#351708", "#744E29", "#B28053"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["window-glow-material"] = createSculptMaterial(
    "window-glow-material",
    {"id": "window-glow-material", "name": "Window Glow Material", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#F0A62E", "color": "#F0A62E", "albedo": {"dominant": "#582107", "secondary": ["#381806", "#7E330F", "#1A0B02"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_albedo.png", "url": "window-glow-material_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#582107", "#381806", "#7E330F", "#1A0B02", "#93653A"], "pattern": "reference-derived pixel palette", "amplitude": 0.155, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.409, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.71, "variation": 0.101, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_roughness.png", "url": "window-glow-material_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.218, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_normal.png", "url": "window-glow-material_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_height.png", "url": "window-glow-material_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.024, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_height.png", "url": "window-glow-material_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_ao.png", "url": "window-glow-material_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/window-glow-material.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.801, "estimatedFidelity": 0.801, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_albedo.png", "url": "window-glow-material_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_roughness.png", "url": "window-glow-material_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_height.png", "url": "window-glow-material_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_normal.png", "url": "window-glow-material_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/window-glow-material/window-glow-material_ao.png", "url": "window-glow-material_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 100, "sourceHeight": 150, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 100, "height": 150}, "mask": {"backgroundColor": "#6E4928", "backgroundNoise": 71.944, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9987}, "mapStats": {"valueRange": 0.3689, "heightP90Gradient": 0.05265, "roughnessBase": 0.71, "roughnessVariation": 0.101, "normalStrength": 0.218, "blurRadius": 21}, "palette": ["#582107", "#381806", "#7E330F", "#1A0B02", "#93653A"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["stone-foundation"] = createSculptMaterial(
    "stone-foundation",
    {"id": "stone-foundation", "name": "Stone Foundation", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#756B5A", "color": "#756B5A", "albedo": {"dominant": "#B68B5B", "secondary": ["#947134", "#6F501C", "#D3A97C"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_albedo.png", "url": "stone-foundation_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#B68B5B", "#947134", "#6F501C", "#D3A97C", "#33290D"], "pattern": "reference-derived pixel palette", "amplitude": 0.238, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.478, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.727, "variation": 0.126, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_roughness.png", "url": "stone-foundation_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.236, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_normal.png", "url": "stone-foundation_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_height.png", "url": "stone-foundation_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.031, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_height.png", "url": "stone-foundation_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_ao.png", "url": "stone-foundation_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "stone-cavity-dirt", "kind": "stain", "description": "Darker mortar and underside cavities.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/stone-foundation.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_albedo.png", "url": "stone-foundation_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_roughness.png", "url": "stone-foundation_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_height.png", "url": "stone-foundation_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_normal.png", "url": "stone-foundation_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/stone-foundation/stone-foundation_ao.png", "url": "stone-foundation_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 220, "sourceHeight": 180, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 220, "height": 180}, "mask": {"backgroundColor": "#8D6623", "backgroundNoise": 128.503, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9999}, "mapStats": {"valueRange": 0.567, "heightP90Gradient": 0.0681, "roughnessBase": 0.727, "roughnessVariation": 0.126, "normalStrength": 0.236, "blurRadius": 21}, "palette": ["#B68B5B", "#947134", "#6F501C", "#D3A97C", "#33290D"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["gutter-copper"] = createSculptMaterial(
    "gutter-copper",
    {"id": "gutter-copper", "name": "Gutter Copper", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#78351D", "color": "#78351D", "albedo": {"dominant": "#DDAA6F", "secondary": ["#906132", "#673714", "#381906"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_albedo.png", "url": "gutter-copper_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#DDAA6F", "#906132", "#673714", "#381906", "#B9854C"], "pattern": "reference-derived pixel palette", "amplitude": 0.266, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.502, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.304, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.695, "variation": 0.067, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_roughness.png", "url": "gutter-copper_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.86, "variation": 0.02}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.199, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_normal.png", "url": "gutter-copper_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_height.png", "url": "gutter-copper_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.016, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_height.png", "url": "gutter-copper_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_ao.png", "url": "gutter-copper_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/gutter-copper.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_albedo.png", "url": "gutter-copper_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_roughness.png", "url": "gutter-copper_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_height.png", "url": "gutter-copper_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_normal.png", "url": "gutter-copper_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/gutter-copper/gutter-copper_ao.png", "url": "gutter-copper_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 90, "sourceHeight": 240, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 90, "height": 240}, "mask": {"backgroundColor": "#D6A66F", "backgroundNoise": 140.702, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9997}, "mapStats": {"valueRange": 0.6332, "heightP90Gradient": 0.0366, "roughnessBase": 0.695, "roughnessVariation": 0.067, "normalStrength": 0.199, "blurRadius": 21}, "palette": ["#DDAA6F", "#906132", "#673714", "#381906", "#B9854C"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["foliage-sage"] = createSculptMaterial(
    "foliage-sage",
    {"id": "foliage-sage", "name": "Foliage Sage", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#60773A", "color": "#60773A", "albedo": {"dominant": "#44390A", "secondary": ["#695819", "#9C7B2C", "#241F03"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_albedo.png", "url": "foliage-sage_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#44390A", "#695819", "#9C7B2C", "#241F03", "#C5AF5F"], "pattern": "reference-derived pixel palette", "amplitude": 0.242, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.482, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.721, "variation": 0.142, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_roughness.png", "url": "foliage-sage_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.239, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_normal.png", "url": "foliage-sage_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_height.png", "url": "foliage-sage_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.032, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_height.png", "url": "foliage-sage_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_ao.png", "url": "foliage-sage_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/foliage-sage.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_albedo.png", "url": "foliage-sage_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_roughness.png", "url": "foliage-sage_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_height.png", "url": "foliage-sage_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_normal.png", "url": "foliage-sage_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/foliage-sage/foliage-sage_ao.png", "url": "foliage-sage_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 220, "sourceHeight": 240, "mapSize": 1024, "cropBBoxPixels": {"x": 10, "y": 0, "width": 210, "height": 240}, "mask": {"backgroundColor": "#E8DFD7", "backgroundNoise": 257.224, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.6367}, "mapStats": {"valueRange": 0.577, "heightP90Gradient": 0.07089, "roughnessBase": 0.721, "roughnessVariation": 0.142, "normalStrength": 0.239, "blurRadius": 21}, "palette": ["#44390A", "#695819", "#9C7B2C", "#241F03", "#C5AF5F"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["flower-petal"] = createSculptMaterial(
    "flower-petal",
    {"id": "flower-petal", "name": "Flower Petal", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#F1E7D4", "color": "#F1E7D4", "albedo": {"dominant": "#32330B", "secondary": ["#51570D", "#191B03", "#888323"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_albedo.png", "url": "flower-petal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#32330B", "#51570D", "#191B03", "#888323", "#E6E0BE"], "pattern": "reference-derived pixel palette", "amplitude": 0.343, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.712, "variation": 0.098, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_roughness.png", "url": "flower-petal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.218, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_normal.png", "url": "flower-petal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_height.png", "url": "flower-petal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.024, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_height.png", "url": "flower-petal_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_ao.png", "url": "flower-petal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/crops/flower-petal.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_albedo.png", "url": "flower-petal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_roughness.png", "url": "flower-petal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_height.png", "url": "flower-petal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_normal.png", "url": "flower-petal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-cartoon-character/artifacts/whimsical-hearth-house/materials/flower-petal/flower-petal_ao.png", "url": "flower-petal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 160, "sourceHeight": 120, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 160, "height": 120}, "mask": {"backgroundColor": "#5B5809", "backgroundNoise": 53.907, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9997}, "mapStats": {"valueRange": 0.8162, "heightP90Gradient": 0.05299, "roughnessBase": 0.712, "roughnessVariation": 0.098, "normalStrength": 0.218, "blurRadius": 21}, "palette": ["#32330B", "#51570D", "#191B03", "#888323", "#E6E0BE"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Root", "level": "macro", "role": "root", "importance": 0.92, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "root is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.1881588094659405, "height": 0.827625145130359, "depth": 1.0169318056277665, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ground-grass"}}, "material": "ground-grass", "materialLayers": ["ground-grass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(115, 134, 61, 1.0)", "secondaryAlbedo": "rgba(155, 172, 88, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_root_0.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ground-grass"}};
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
    materialMap["ground-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Root", "level": "macro", "role": "root", "importance": 0.92, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "root is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1.1881588094659405, "height": 0.827625145130359, "depth": 1.0169318056277665, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ground-grass"}}, "material": "ground-grass", "materialLayers": ["ground-grass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(115, 134, 61, 1.0)", "secondaryAlbedo": "rgba(155, 172, 88, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const attachment_garden_base_1 = {"parentSocket": "root-surface", "localStart": [0, -0.005, 0], "localEnd": [0, 0.445, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 4.5, "endRadius": 4.5};
  const endpoint_garden_base_1 = makeAttachmentEndpoint(attachment_garden_base_1);
  const node_garden_base_1 = new THREE.Group();
  node_garden_base_1.name = "Garden Base__pivot";
  node_garden_base_1.scale.set(1, 1, 1);
  if (endpoint_garden_base_1) {
    node_garden_base_1.position.copy(endpoint_garden_base_1.start);
    node_garden_base_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_garden_base_1.position.set(0.0, 0.18207753192867898, 0.0);
    node_garden_base_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_garden_base_1.userData.sculptComponent = {"id": "garden-base", "name": "Garden Base", "level": "macro", "role": "base", "importance": 0.92, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "garden-base is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-surface", "localStart": [0, -0.005, 0], "localEnd": [0, 0.445, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 4.5, "endRadius": 4.5}, "dimensions": {"width": 11.881588094659406, "height": 0.3724313153086616, "depth": 8.135454445022132, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 0.18207753192867898, 0], "rotation": [0.0, 0.0, 0.0], "scale": [10, 0.45, 8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ground-grass"}}, "material": "ground-grass", "materialLayers": ["ground-grass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "curb-stones", "kind": "bevel", "description": "Irregular beveled perimeter stone ring.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(115, 134, 61, 1.0)", "secondaryAlbedo": "rgba(155, 172, 88, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_garden_base_1.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ground-grass"}};
  (nodes["root"] ?? root).add(node_garden_base_1);
  nodes["garden-base"] = node_garden_base_1;
  const mesh_garden_base_1Geometry = endpoint_garden_base_1
    ? new THREE.CylinderGeometry(endpoint_garden_base_1.endRadius, endpoint_garden_base_1.baseRadius, endpoint_garden_base_1.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_garden_base_1) {
    mesh_garden_base_1Geometry.scale(10.0, 0.45, 8.0);
  }
  const mesh_garden_base_1 = new THREE.Mesh(
    mesh_garden_base_1Geometry,
    materialMap["ground-grass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_garden_base_1.name = "Garden Base";
  if (endpoint_garden_base_1) {
    mesh_garden_base_1.position.copy(endpoint_garden_base_1.midpoint);
    mesh_garden_base_1.quaternion.copy(endpoint_garden_base_1.quaternion);
  }
  mesh_garden_base_1.castShadow = options.castShadow ?? true;
  mesh_garden_base_1.receiveShadow = options.receiveShadow ?? true;
  mesh_garden_base_1.userData.sculptComponent = {"id": "garden-base", "name": "Garden Base", "level": "macro", "role": "base", "importance": 0.92, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "garden-base is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-surface", "localStart": [0, -0.005, 0], "localEnd": [0, 0.445, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 4.5, "endRadius": 4.5}, "dimensions": {"width": 11.881588094659406, "height": 0.3724313153086616, "depth": 8.135454445022132, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 0.18207753192867898, 0], "rotation": [0.0, 0.0, 0.0], "scale": [10, 0.45, 8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "ground-grass"}}, "material": "ground-grass", "materialLayers": ["ground-grass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "curb-stones", "kind": "bevel", "description": "Irregular beveled perimeter stone ring.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(115, 134, 61, 1.0)", "secondaryAlbedo": "rgba(155, 172, 88, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_garden_base_1.add(mesh_garden_base_1);
  meshes["garden-base"] = mesh_garden_base_1;
  colliders["garden-base"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["garden-base"] ??= [];
  destructionGroups["garden-base"].push(node_garden_base_1);

  const endpoint_house_main_2 = makeAttachmentEndpoint(null);
  const node_house_main_2 = new THREE.Group();
  node_house_main_2.name = "House Main__pivot";
  node_house_main_2.scale.set(1, 1, 1);
  if (endpoint_house_main_2) {
    node_house_main_2.position.copy(endpoint_house_main_2.start);
    node_house_main_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_house_main_2.position.set(0.0, 2.197344760321103, 0.30507954168832996);
    node_house_main_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_house_main_2.userData.sculptComponent = {"id": "house-main", "name": "House Main", "level": "macro", "role": "body", "importance": 0.92, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [0.0, 2.655, 0.3], "localEnd": [0.0, 2.695, 0.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 6.178425809222891, "height": 3.9726006966257232, "depth": 4.169420403073842, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 2.197344760321103, 0.30507954168832996], "rotation": [0.0, 0.0, 0.0], "scale": [5.2, 4.8, 4.1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "house-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_house_main_2.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "house-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}};
  (nodes["garden-base"] ?? root).add(node_house_main_2);
  nodes["house-main"] = node_house_main_2;
  const mesh_house_main_2Geometry = endpoint_house_main_2
    ? new THREE.CylinderGeometry(endpoint_house_main_2.endRadius, endpoint_house_main_2.baseRadius, endpoint_house_main_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_house_main_2) {
    mesh_house_main_2Geometry.scale(5.2, 4.8, 4.1);
  }
  const mesh_house_main_2 = new THREE.Mesh(
    mesh_house_main_2Geometry,
    materialMap["stucco-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_house_main_2.name = "House Main";
  if (endpoint_house_main_2) {
    mesh_house_main_2.position.copy(endpoint_house_main_2.midpoint);
    mesh_house_main_2.quaternion.copy(endpoint_house_main_2.quaternion);
  }
  mesh_house_main_2.castShadow = options.castShadow ?? true;
  mesh_house_main_2.receiveShadow = options.receiveShadow ?? true;
  mesh_house_main_2.userData.sculptComponent = {"id": "house-main", "name": "House Main", "level": "macro", "role": "body", "importance": 0.92, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [0.0, 2.655, 0.3], "localEnd": [0.0, 2.695, 0.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 6.178425809222891, "height": 3.9726006966257232, "depth": 4.169420403073842, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 2.197344760321103, 0.30507954168832996], "rotation": [0.0, 0.0, 0.0], "scale": [5.2, 4.8, 4.1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "house-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_house_main_2.add(mesh_house_main_2);
  meshes["house-main"] = mesh_house_main_2;
  colliders["house-main"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["house-main"] ??= [];
  destructionGroups["house-main"].push(node_house_main_2);

  const endpoint_lower_wing_3 = makeAttachmentEndpoint(null);
  const node_lower_wing_3 = new THREE.Group();
  node_lower_wing_3.name = "Lower Wing__pivot";
  node_lower_wing_3.scale.set(1, 1, 1);
  if (endpoint_lower_wing_3) {
    node_lower_wing_3.position.copy(endpoint_lower_wing_3.start);
    node_lower_wing_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lower_wing_3.position.set(-3.0892129046114456, 1.4111008724472622, 0.9152386250649899);
    node_lower_wing_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_lower_wing_3.userData.sculptComponent = {"id": "lower-wing", "name": "Lower Wing", "level": "macro", "role": "body", "importance": 0.92, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "lower-wing is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [-2.6, 1.705, 0.9], "localEnd": [-2.6, 1.745, 0.9], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.4456605474512276, "height": 2.317350406365005, "depth": 3.8643408613855126, "units": "relative", "confidence": 0.84}, "transform": {"position": [-3.0892129046114456, 1.4111008724472622, 0.9152386250649899], "rotation": [0.0, 0.0, 0.0], "scale": [2.9, 2.8, 3.8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lower-wing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_lower_wing_3.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lower-wing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}};
  (nodes["garden-base"] ?? root).add(node_lower_wing_3);
  nodes["lower-wing"] = node_lower_wing_3;
  const mesh_lower_wing_3Geometry = endpoint_lower_wing_3
    ? new THREE.CylinderGeometry(endpoint_lower_wing_3.endRadius, endpoint_lower_wing_3.baseRadius, endpoint_lower_wing_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_lower_wing_3) {
    mesh_lower_wing_3Geometry.scale(2.9, 2.8, 3.8);
  }
  const mesh_lower_wing_3 = new THREE.Mesh(
    mesh_lower_wing_3Geometry,
    materialMap["stucco-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lower_wing_3.name = "Lower Wing";
  if (endpoint_lower_wing_3) {
    mesh_lower_wing_3.position.copy(endpoint_lower_wing_3.midpoint);
    mesh_lower_wing_3.quaternion.copy(endpoint_lower_wing_3.quaternion);
  }
  mesh_lower_wing_3.castShadow = options.castShadow ?? true;
  mesh_lower_wing_3.receiveShadow = options.receiveShadow ?? true;
  mesh_lower_wing_3.userData.sculptComponent = {"id": "lower-wing", "name": "Lower Wing", "level": "macro", "role": "body", "importance": 0.92, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "lower-wing is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [-2.6, 1.705, 0.9], "localEnd": [-2.6, 1.745, 0.9], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.4456605474512276, "height": 2.317350406365005, "depth": 3.8643408613855126, "units": "relative", "confidence": 0.84}, "transform": {"position": [-3.0892129046114456, 1.4111008724472622, 0.9152386250649899], "rotation": [0.0, 0.0, 0.0], "scale": [2.9, 2.8, 3.8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lower-wing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_lower_wing_3.add(mesh_lower_wing_3);
  meshes["lower-wing"] = mesh_lower_wing_3;
  colliders["lower-wing"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["lower-wing"] ??= [];
  destructionGroups["lower-wing"].push(node_lower_wing_3);

  const attachment_turret_4 = {"parentSocket": "garden-base-surface", "localStart": [2.95, 0.105, 0.25], "localEnd": [2.95, 5.305, 0.25], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.175, "endRadius": 1.175};
  const endpoint_turret_4 = makeAttachmentEndpoint(attachment_turret_4);
  const node_turret_4 = new THREE.Group();
  node_turret_4.name = "Turret__pivot";
  node_turret_4.scale.set(1, 1, 1);
  if (endpoint_turret_4) {
    node_turret_4.position.copy(endpoint_turret_4.start);
    node_turret_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_turret_4.position.set(3.505068487924525, 2.2387260175776214, 0.25423295140694163);
    node_turret_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_turret_4.userData.sculptComponent = {"id": "turret", "name": "Turret", "level": "macro", "role": "body", "importance": 0.92, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "turret is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [2.95, 0.105, 0.25], "localEnd": [2.95, 5.305, 0.25], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.175, "endRadius": 1.175}, "dimensions": {"width": 2.7921732022449604, "height": 4.303650754677867, "depth": 2.3897897432252515, "units": "relative", "confidence": 0.84}, "transform": {"position": [3.505068487924525, 2.2387260175776214, 0.25423295140694163], "rotation": [0.0, 0.0, 0.0], "scale": [2.35, 5.2, 2.35]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "turret", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "windows", "kind": "contour", "description": "Arched recessed window rhythm around the tower.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_turret_4.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "turret", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}};
  (nodes["garden-base"] ?? root).add(node_turret_4);
  nodes["turret"] = node_turret_4;
  const mesh_turret_4Geometry = endpoint_turret_4
    ? new THREE.CylinderGeometry(endpoint_turret_4.endRadius, endpoint_turret_4.baseRadius, endpoint_turret_4.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_turret_4) {
    mesh_turret_4Geometry.scale(2.35, 5.2, 2.35);
  }
  const mesh_turret_4 = new THREE.Mesh(
    mesh_turret_4Geometry,
    materialMap["stucco-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_turret_4.name = "Turret";
  if (endpoint_turret_4) {
    mesh_turret_4.position.copy(endpoint_turret_4.midpoint);
    mesh_turret_4.quaternion.copy(endpoint_turret_4.quaternion);
  }
  mesh_turret_4.castShadow = options.castShadow ?? true;
  mesh_turret_4.receiveShadow = options.receiveShadow ?? true;
  mesh_turret_4.userData.sculptComponent = {"id": "turret", "name": "Turret", "level": "macro", "role": "body", "importance": 0.92, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "turret is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [2.95, 0.105, 0.25], "localEnd": [2.95, 5.305, 0.25], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.175, "endRadius": 1.175}, "dimensions": {"width": 2.7921732022449604, "height": 4.303650754677867, "depth": 2.3897897432252515, "units": "relative", "confidence": 0.84}, "transform": {"position": [3.505068487924525, 2.2387260175776214, 0.25423295140694163], "rotation": [0.0, 0.0, 0.0], "scale": [2.35, 5.2, 2.35]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "turret", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "windows", "kind": "contour", "description": "Arched recessed window rhythm around the tower.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_turret_4.add(mesh_turret_4);
  meshes["turret"] = mesh_turret_4;
  colliders["turret"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["turret"] ??= [];
  destructionGroups["turret"].push(node_turret_4);

  const endpoint_roof_main_5 = makeAttachmentEndpoint(null);
  const node_roof_main_5 = new THREE.Group();
  node_roof_main_5.name = "Roof Main__pivot";
  node_roof_main_5.scale.set(1, 1, 1);
  if (endpoint_roof_main_5) {
    node_roof_main_5.position.copy(endpoint_roof_main_5.start);
    node_roof_main_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_main_5.position.set(0.0, 2.317350406365005, -0.050846590281388326);
    node_roof_main_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_main_5.userData.sculptComponent = {"id": "roof-main", "name": "Roof Main", "level": "macro", "role": "roof", "importance": 0.92, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "roof-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [0.0, 2.8, -0.05], "localEnd": [0.0, 2.84, -0.05], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 7.247768737742237, "height": 1.9863003483128616, "depth": 4.881272667013279, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 2.317350406365005, -0.050846590281388326], "rotation": [0.0, 0.0, 0.0], "scale": [6.1, 2.4, 4.8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}}, "material": "roof-terracotta", "materialLayers": ["roof-terracotta"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tile-bands", "kind": "ridge", "description": "Staggered overlapping tile rows and thick eaves.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 75, 30, 1.0)", "secondaryAlbedo": "rgba(226, 107, 43, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_roof_main_5.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}};
  (nodes["house-main"] ?? root).add(node_roof_main_5);
  nodes["roof-main"] = node_roof_main_5;
  const mesh_roof_main_5Geometry = endpoint_roof_main_5
    ? new THREE.CylinderGeometry(endpoint_roof_main_5.endRadius, endpoint_roof_main_5.baseRadius, endpoint_roof_main_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_roof_main_5) {
    mesh_roof_main_5Geometry.scale(6.1, 2.4, 4.8);
  }
  const mesh_roof_main_5 = new THREE.Mesh(
    mesh_roof_main_5Geometry,
    materialMap["roof-terracotta"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_main_5.name = "Roof Main";
  if (endpoint_roof_main_5) {
    mesh_roof_main_5.position.copy(endpoint_roof_main_5.midpoint);
    mesh_roof_main_5.quaternion.copy(endpoint_roof_main_5.quaternion);
  }
  mesh_roof_main_5.castShadow = options.castShadow ?? true;
  mesh_roof_main_5.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_main_5.userData.sculptComponent = {"id": "roof-main", "name": "Roof Main", "level": "macro", "role": "roof", "importance": 0.92, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "roof-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [0.0, 2.8, -0.05], "localEnd": [0.0, 2.84, -0.05], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 7.247768737742237, "height": 1.9863003483128616, "depth": 4.881272667013279, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 2.317350406365005, -0.050846590281388326], "rotation": [0.0, 0.0, 0.0], "scale": [6.1, 2.4, 4.8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}}, "material": "roof-terracotta", "materialLayers": ["roof-terracotta"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tile-bands", "kind": "ridge", "description": "Staggered overlapping tile rows and thick eaves.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 75, 30, 1.0)", "secondaryAlbedo": "rgba(226, 107, 43, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_roof_main_5.add(mesh_roof_main_5);
  meshes["roof-main"] = mesh_roof_main_5;
  colliders["roof-main"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["roof-main"] ??= [];
  destructionGroups["roof-main"].push(node_roof_main_5);

  const endpoint_roof_wing_6 = makeAttachmentEndpoint(null);
  const node_roof_wing_6 = new THREE.Group();
  node_roof_wing_6.name = "Roof Wing__pivot";
  node_roof_wing_6.scale.set(1, 1, 1);
  if (endpoint_roof_wing_6) {
    node_roof_wing_6.position.copy(endpoint_roof_wing_6.start);
    node_roof_wing_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_wing_6.position.set(0.17822382141989107, 1.2000564604390205, 0.0);
    node_roof_wing_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_wing_6.userData.sculptComponent = {"id": "roof-wing", "name": "Roof Wing", "level": "meso", "role": "roof", "importance": 0.82, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "roof-wing is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lower-wing", "attachment": {"parentSocket": "lower-wing-surface", "localStart": [0.15, 1.45, 0.0], "localEnd": [0.15, 1.49, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 4.158555833130792, "height": 1.0345314314129488, "depth": 4.423653354480784, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.17822382141989107, 1.2000564604390205, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [3.5, 1.25, 4.35]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-wing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}}, "material": "roof-terracotta", "materialLayers": ["roof-terracotta"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "wing-tile-bands", "kind": "ridge", "description": "Repeated staggered tile rows.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 75, 30, 1.0)", "secondaryAlbedo": "rgba(226, 107, 43, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_roof_wing_6.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-wing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}};
  (nodes["lower-wing"] ?? root).add(node_roof_wing_6);
  nodes["roof-wing"] = node_roof_wing_6;
  const mesh_roof_wing_6Geometry = endpoint_roof_wing_6
    ? new THREE.CylinderGeometry(endpoint_roof_wing_6.endRadius, endpoint_roof_wing_6.baseRadius, endpoint_roof_wing_6.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_roof_wing_6) {
    mesh_roof_wing_6Geometry.scale(3.5, 1.25, 4.35);
  }
  const mesh_roof_wing_6 = new THREE.Mesh(
    mesh_roof_wing_6Geometry,
    materialMap["roof-terracotta"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_wing_6.name = "Roof Wing";
  if (endpoint_roof_wing_6) {
    mesh_roof_wing_6.position.copy(endpoint_roof_wing_6.midpoint);
    mesh_roof_wing_6.quaternion.copy(endpoint_roof_wing_6.quaternion);
  }
  mesh_roof_wing_6.castShadow = options.castShadow ?? true;
  mesh_roof_wing_6.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_wing_6.userData.sculptComponent = {"id": "roof-wing", "name": "Roof Wing", "level": "meso", "role": "roof", "importance": 0.82, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "roof-wing is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lower-wing", "attachment": {"parentSocket": "lower-wing-surface", "localStart": [0.15, 1.45, 0.0], "localEnd": [0.15, 1.49, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 4.158555833130792, "height": 1.0345314314129488, "depth": 4.423653354480784, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.17822382141989107, 1.2000564604390205, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [3.5, 1.25, 4.35]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-wing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}}, "material": "roof-terracotta", "materialLayers": ["roof-terracotta"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "wing-tile-bands", "kind": "ridge", "description": "Repeated staggered tile rows.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 75, 30, 1.0)", "secondaryAlbedo": "rgba(226, 107, 43, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_roof_wing_6.add(mesh_roof_wing_6);
  meshes["roof-wing"] = mesh_roof_wing_6;
  colliders["roof-wing"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["roof-wing"] ??= [];
  destructionGroups["roof-wing"].push(node_roof_wing_6);

  const attachment_turret_roof_7 = {"parentSocket": "turret-surface", "localStart": [0, 5.05, 0], "localEnd": [0, 7.4, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.5, "endRadius": 0.05};
  const endpoint_turret_roof_7 = makeAttachmentEndpoint(attachment_turret_roof_7);
  const node_turret_roof_7 = new THREE.Group();
  node_turret_roof_7.name = "Turret Roof__pivot";
  node_turret_roof_7.scale.set(1, 1, 1);
  if (endpoint_turret_roof_7) {
    node_turret_roof_7.position.copy(endpoint_turret_roof_7.start);
    node_turret_roof_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_turret_roof_7.position.set(0.0, 5.151966528436485, 0.0);
    node_turret_roof_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_turret_roof_7.userData.sculptComponent = {"id": "turret-roof", "name": "Turret Roof", "level": "macro", "role": "roof", "importance": 0.92, "confidence": 0.86, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "turret-roof is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "turret", "attachment": {"parentSocket": "turret-surface", "localStart": [0, 5.05, 0], "localEnd": [0, 7.4, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.5, "endRadius": 0.05}, "dimensions": {"width": 3.5644764283978216, "height": 1.9449190910563436, "depth": 3.0507954168832994, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 5.151966528436485, 0], "rotation": [0.0, 0.0, 0.0], "scale": [3.0, 2.35, 3.0]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "turret-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}}, "material": "roof-terracotta", "materialLayers": ["roof-terracotta"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "finial", "kind": "contour", "description": "Stacked copper finial above the roof cone.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 75, 30, 1.0)", "secondaryAlbedo": "rgba(226, 107, 43, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_turret_roof_7.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "turret-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}};
  (nodes["turret"] ?? root).add(node_turret_roof_7);
  nodes["turret-roof"] = node_turret_roof_7;
  const mesh_turret_roof_7Geometry = endpoint_turret_roof_7
    ? new THREE.CylinderGeometry(endpoint_turret_roof_7.endRadius, endpoint_turret_roof_7.baseRadius, endpoint_turret_roof_7.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_turret_roof_7) {
    mesh_turret_roof_7Geometry.scale(3.0, 2.35, 3.0);
  }
  const mesh_turret_roof_7 = new THREE.Mesh(
    mesh_turret_roof_7Geometry,
    materialMap["roof-terracotta"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_turret_roof_7.name = "Turret Roof";
  if (endpoint_turret_roof_7) {
    mesh_turret_roof_7.position.copy(endpoint_turret_roof_7.midpoint);
    mesh_turret_roof_7.quaternion.copy(endpoint_turret_roof_7.quaternion);
  }
  mesh_turret_roof_7.castShadow = options.castShadow ?? true;
  mesh_turret_roof_7.receiveShadow = options.receiveShadow ?? true;
  mesh_turret_roof_7.userData.sculptComponent = {"id": "turret-roof", "name": "Turret Roof", "level": "macro", "role": "roof", "importance": 0.92, "confidence": 0.86, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "turret-roof is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "turret", "attachment": {"parentSocket": "turret-surface", "localStart": [0, 5.05, 0], "localEnd": [0, 7.4, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.5, "endRadius": 0.05}, "dimensions": {"width": 3.5644764283978216, "height": 1.9449190910563436, "depth": 3.0507954168832994, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 5.151966528436485, 0], "rotation": [0.0, 0.0, 0.0], "scale": [3.0, 2.35, 3.0]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "turret-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}}, "material": "roof-terracotta", "materialLayers": ["roof-terracotta"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "finial", "kind": "contour", "description": "Stacked copper finial above the roof cone.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 75, 30, 1.0)", "secondaryAlbedo": "rgba(226, 107, 43, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_turret_roof_7.add(mesh_turret_roof_7);
  meshes["turret-roof"] = mesh_turret_roof_7;
  colliders["turret-roof"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["turret-roof"] ??= [];
  destructionGroups["turret-roof"].push(node_turret_roof_7);

  const endpoint_chimney_8 = makeAttachmentEndpoint(null);
  const node_chimney_8 = new THREE.Group();
  node_chimney_8.name = "Chimney__pivot";
  node_chimney_8.scale.set(1, 1, 1);
  if (endpoint_chimney_8) {
    node_chimney_8.position.copy(endpoint_chimney_8.start);
    node_chimney_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chimney_8.position.set(-2.6139493808250696, 3.0622130369823286, -0.6101590833766599);
    node_chimney_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_chimney_8.userData.sculptComponent = {"id": "chimney", "name": "Chimney", "level": "meso", "role": "vent", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "chimney is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [-2.2, 3.7, -0.6], "localEnd": [-2.2, 3.74, -0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.8911191070994554, "height": 2.482875435391077, "depth": 0.7626988542208248, "units": "relative", "confidence": 0.84}, "transform": {"position": [-2.6139493808250696, 3.0622130369823286, -0.6101590833766599], "rotation": [0.0, 0.0, 0.0], "scale": [0.75, 3.0, 0.75]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}}, "material": "roof-terracotta", "materialLayers": ["roof-terracotta"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "brick-courses", "kind": "ridge", "description": "Offset brick courses and pale cap stones.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 75, 30, 1.0)", "secondaryAlbedo": "rgba(226, 107, 43, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_chimney_8.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}};
  (nodes["house-main"] ?? root).add(node_chimney_8);
  nodes["chimney"] = node_chimney_8;
  const mesh_chimney_8Geometry = endpoint_chimney_8
    ? new THREE.CylinderGeometry(endpoint_chimney_8.endRadius, endpoint_chimney_8.baseRadius, endpoint_chimney_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chimney_8) {
    mesh_chimney_8Geometry.scale(0.75, 3.0, 0.75);
  }
  const mesh_chimney_8 = new THREE.Mesh(
    mesh_chimney_8Geometry,
    materialMap["roof-terracotta"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chimney_8.name = "Chimney";
  if (endpoint_chimney_8) {
    mesh_chimney_8.position.copy(endpoint_chimney_8.midpoint);
    mesh_chimney_8.quaternion.copy(endpoint_chimney_8.quaternion);
  }
  mesh_chimney_8.castShadow = options.castShadow ?? true;
  mesh_chimney_8.receiveShadow = options.receiveShadow ?? true;
  mesh_chimney_8.userData.sculptComponent = {"id": "chimney", "name": "Chimney", "level": "meso", "role": "vent", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "chimney is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [-2.2, 3.7, -0.6], "localEnd": [-2.2, 3.74, -0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.8911191070994554, "height": 2.482875435391077, "depth": 0.7626988542208248, "units": "relative", "confidence": 0.84}, "transform": {"position": [-2.6139493808250696, 3.0622130369823286, -0.6101590833766599], "rotation": [0.0, 0.0, 0.0], "scale": [0.75, 3.0, 0.75]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-terracotta"}}, "material": "roof-terracotta", "materialLayers": ["roof-terracotta"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "brick-courses", "kind": "ridge", "description": "Offset brick courses and pale cap stones.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 75, 30, 1.0)", "secondaryAlbedo": "rgba(226, 107, 43, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_chimney_8.add(mesh_chimney_8);
  meshes["chimney"] = mesh_chimney_8;
  colliders["chimney"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["chimney"] ??= [];
  destructionGroups["chimney"].push(node_chimney_8);

  const endpoint_front_dormer_9 = makeAttachmentEndpoint(null);
  const node_front_dormer_9 = new THREE.Group();
  node_front_dormer_9.name = "Front Dormer__pivot";
  node_front_dormer_9.scale.set(1, 1, 1);
  if (endpoint_front_dormer_9) {
    node_front_dormer_9.position.copy(endpoint_front_dormer_9.start);
    node_front_dormer_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_dormer_9.position.set(-1.0693429285193465, -0.12414377176955385, 1.7796306598485914);
    node_front_dormer_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_dormer_9.userData.sculptComponent = {"id": "front-dormer", "name": "Front Dormer", "level": "meso", "role": "opening", "importance": 0.82, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "front-dormer is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "roof-main", "attachment": {"parentSocket": "roof-main-surface", "localStart": [-0.9, -0.15, 1.75], "localEnd": [-0.9, -0.11, 1.75], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.138685857038693, "height": 1.738012804773754, "depth": 0.9152386250649899, "units": "relative", "confidence": 0.84}, "transform": {"position": [-1.0693429285193465, -0.12414377176955385, 1.7796306598485914], "rotation": [0.0, 0.0, 0.0], "scale": [1.8, 2.1, 0.9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-dormer", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_front_dormer_9.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-dormer", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}};
  (nodes["roof-main"] ?? root).add(node_front_dormer_9);
  nodes["front-dormer"] = node_front_dormer_9;
  const mesh_front_dormer_9Geometry = endpoint_front_dormer_9
    ? new THREE.CylinderGeometry(endpoint_front_dormer_9.endRadius, endpoint_front_dormer_9.baseRadius, endpoint_front_dormer_9.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_front_dormer_9) {
    mesh_front_dormer_9Geometry.scale(1.8, 2.1, 0.9);
  }
  const mesh_front_dormer_9 = new THREE.Mesh(
    mesh_front_dormer_9Geometry,
    materialMap["stucco-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_dormer_9.name = "Front Dormer";
  if (endpoint_front_dormer_9) {
    mesh_front_dormer_9.position.copy(endpoint_front_dormer_9.midpoint);
    mesh_front_dormer_9.quaternion.copy(endpoint_front_dormer_9.quaternion);
  }
  mesh_front_dormer_9.castShadow = options.castShadow ?? true;
  mesh_front_dormer_9.receiveShadow = options.receiveShadow ?? true;
  mesh_front_dormer_9.userData.sculptComponent = {"id": "front-dormer", "name": "Front Dormer", "level": "meso", "role": "opening", "importance": 0.82, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "front-dormer is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "roof-main", "attachment": {"parentSocket": "roof-main-surface", "localStart": [-0.9, -0.15, 1.75], "localEnd": [-0.9, -0.11, 1.75], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.138685857038693, "height": 1.738012804773754, "depth": 0.9152386250649899, "units": "relative", "confidence": 0.84}, "transform": {"position": [-1.0693429285193465, -0.12414377176955385, 1.7796306598485914], "rotation": [0.0, 0.0, 0.0], "scale": [1.8, 2.1, 0.9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-dormer", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_front_dormer_9.add(mesh_front_dormer_9);
  meshes["front-dormer"] = mesh_front_dormer_9;
  colliders["front-dormer"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["front-dormer"] ??= [];
  destructionGroups["front-dormer"].push(node_front_dormer_9);

  const endpoint_front_porch_10 = makeAttachmentEndpoint(null);
  const node_front_porch_10 = new THREE.Group();
  node_front_porch_10.name = "Front Porch__pivot";
  node_front_porch_10.scale.set(1, 1, 1);
  if (endpoint_front_porch_10) {
    node_front_porch_10.position.copy(endpoint_front_porch_10.start);
    node_front_porch_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_porch_10.position.set(-0.41585558331307915, -0.5379563443347334, 2.2372499723810866);
    node_front_porch_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_porch_10.userData.sculptComponent = {"id": "front-porch", "name": "Front Porch", "level": "meso", "role": "entrance", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "front-porch is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [-0.35, -0.65, 2.2], "localEnd": [-0.35, -0.61, 2.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.80210819029101, "height": 2.482875435391077, "depth": 1.4745511181602615, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.41585558331307915, -0.5379563443347334, 2.2372499723810866], "rotation": [0.0, 0.0, 0.0], "scale": [3.2, 3.0, 1.45]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-porch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}}, "material": "wood-walnut", "materialLayers": ["wood-walnut"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "braces", "kind": "ridge", "description": "Tapered posts, brackets and blank layered plaque.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 58, 28, 1.0)", "secondaryAlbedo": "rgba(154, 88, 42, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_front_porch_10.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-porch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}};
  (nodes["house-main"] ?? root).add(node_front_porch_10);
  nodes["front-porch"] = node_front_porch_10;
  const mesh_front_porch_10Geometry = endpoint_front_porch_10
    ? new THREE.CylinderGeometry(endpoint_front_porch_10.endRadius, endpoint_front_porch_10.baseRadius, endpoint_front_porch_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_front_porch_10) {
    mesh_front_porch_10Geometry.scale(3.2, 3.0, 1.45);
  }
  const mesh_front_porch_10 = new THREE.Mesh(
    mesh_front_porch_10Geometry,
    materialMap["wood-walnut"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_porch_10.name = "Front Porch";
  if (endpoint_front_porch_10) {
    mesh_front_porch_10.position.copy(endpoint_front_porch_10.midpoint);
    mesh_front_porch_10.quaternion.copy(endpoint_front_porch_10.quaternion);
  }
  mesh_front_porch_10.castShadow = options.castShadow ?? true;
  mesh_front_porch_10.receiveShadow = options.receiveShadow ?? true;
  mesh_front_porch_10.userData.sculptComponent = {"id": "front-porch", "name": "Front Porch", "level": "meso", "role": "entrance", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "front-porch is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [-0.35, -0.65, 2.2], "localEnd": [-0.35, -0.61, 2.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.80210819029101, "height": 2.482875435391077, "depth": 1.4745511181602615, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.41585558331307915, -0.5379563443347334, 2.2372499723810866], "rotation": [0.0, 0.0, 0.0], "scale": [3.2, 3.0, 1.45]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-porch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}}, "material": "wood-walnut", "materialLayers": ["wood-walnut"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "braces", "kind": "ridge", "description": "Tapered posts, brackets and blank layered plaque.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 58, 28, 1.0)", "secondaryAlbedo": "rgba(154, 88, 42, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_front_porch_10.add(mesh_front_porch_10);
  meshes["front-porch"] = mesh_front_porch_10;
  colliders["front-porch"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["front-porch"] ??= [];
  destructionGroups["front-porch"].push(node_front_porch_10);

  const endpoint_front_door_11 = makeAttachmentEndpoint(null);
  const node_front_door_11 = new THREE.Group();
  node_front_door_11.name = "Front Door__pivot";
  node_front_door_11.scale.set(1, 1, 1);
  if (endpoint_front_door_11) {
    node_front_door_11.position.copy(endpoint_front_door_11.start);
    node_front_door_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_door_11.position.set(0.0, -0.2896688007956256, 0.12203181667533197);
    node_front_door_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_door_11.userData.sculptComponent = {"id": "front-door", "name": "Front Door", "level": "meso", "role": "hinge", "importance": 0.82, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "front-door is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-porch", "attachment": {"parentSocket": "front-porch-surface", "localStart": [0.0, -0.35, 0.12], "localEnd": [0.0, -0.31, 0.12], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.4257905713591286, "height": 2.0690628628258976, "depth": 0.15253977084416498, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, -0.2896688007956256, 0.12203181667533197], "rotation": [0.0, 0.0, 0.0], "scale": [1.2, 2.5, 0.15]}, "actionProfile": {"animationRole": "hinged", "pivot": {"mode": "hinge-left", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "door-teal"}}, "material": "door-teal", "materialLayers": ["door-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "brass-handle", "kind": "fastener", "description": "Small brass handle on the right door stile.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(7, 93, 90, 1.0)", "secondaryAlbedo": "rgba(12, 128, 121, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_front_door_11.userData.actionProfile = {"animationRole": "hinged", "pivot": {"mode": "hinge-left", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "door-teal"}};
  (nodes["front-porch"] ?? root).add(node_front_door_11);
  nodes["front-door"] = node_front_door_11;
  const mesh_front_door_11Geometry = endpoint_front_door_11
    ? new THREE.CylinderGeometry(endpoint_front_door_11.endRadius, endpoint_front_door_11.baseRadius, endpoint_front_door_11.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_front_door_11) {
    mesh_front_door_11Geometry.scale(1.2, 2.5, 0.15);
  }
  const mesh_front_door_11 = new THREE.Mesh(
    mesh_front_door_11Geometry,
    materialMap["door-teal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_door_11.name = "Front Door";
  if (endpoint_front_door_11) {
    mesh_front_door_11.position.copy(endpoint_front_door_11.midpoint);
    mesh_front_door_11.quaternion.copy(endpoint_front_door_11.quaternion);
  }
  mesh_front_door_11.castShadow = options.castShadow ?? true;
  mesh_front_door_11.receiveShadow = options.receiveShadow ?? true;
  mesh_front_door_11.userData.sculptComponent = {"id": "front-door", "name": "Front Door", "level": "meso", "role": "hinge", "importance": 0.82, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "front-door is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-porch", "attachment": {"parentSocket": "front-porch-surface", "localStart": [0.0, -0.35, 0.12], "localEnd": [0.0, -0.31, 0.12], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.4257905713591286, "height": 2.0690628628258976, "depth": 0.15253977084416498, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, -0.2896688007956256, 0.12203181667533197], "rotation": [0.0, 0.0, 0.0], "scale": [1.2, 2.5, 0.15]}, "actionProfile": {"animationRole": "hinged", "pivot": {"mode": "hinge-left", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "door-teal"}}, "material": "door-teal", "materialLayers": ["door-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "brass-handle", "kind": "fastener", "description": "Small brass handle on the right door stile.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(7, 93, 90, 1.0)", "secondaryAlbedo": "rgba(12, 128, 121, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_front_door_11.add(mesh_front_door_11);
  meshes["front-door"] = mesh_front_door_11;
  colliders["front-door"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["front-door"] ??= [];
  destructionGroups["front-door"].push(node_front_door_11);

  const endpoint_vestibule_12 = makeAttachmentEndpoint(null);
  const node_vestibule_12 = new THREE.Group();
  node_vestibule_12.name = "Vestibule__pivot";
  node_vestibule_12.scale.set(1, 1, 1);
  if (endpoint_vestibule_12) {
    node_vestibule_12.position.copy(endpoint_vestibule_12.start);
    node_vestibule_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vestibule_12.position.set(-0.41585558331307915, -0.827625145130359, 2.1762340640434203);
    node_vestibule_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_vestibule_12.userData.sculptComponent = {"id": "vestibule", "name": "Vestibule", "level": "micro", "role": "interior", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "vestibule is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [-0.35, -1.0, 2.14], "localEnd": [-0.35, -0.96, 2.14], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1881588094659405, "height": 1.8621565765433077, "depth": 0.25423295140694163, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.41585558331307915, -0.827625145130359, 2.1762340640434203], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 2.25, 0.25]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vestibule", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}}, "material": "wood-walnut", "materialLayers": ["wood-walnut"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 58, 28, 1.0)", "secondaryAlbedo": "rgba(154, 88, 42, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_vestibule_12.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vestibule", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}};
  (nodes["house-main"] ?? root).add(node_vestibule_12);
  nodes["vestibule"] = node_vestibule_12;
  const mesh_vestibule_12Geometry = endpoint_vestibule_12
    ? new THREE.CylinderGeometry(endpoint_vestibule_12.endRadius, endpoint_vestibule_12.baseRadius, endpoint_vestibule_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_vestibule_12) {
    mesh_vestibule_12Geometry.scale(1.0, 2.25, 0.25);
  }
  const mesh_vestibule_12 = new THREE.Mesh(
    mesh_vestibule_12Geometry,
    materialMap["wood-walnut"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vestibule_12.name = "Vestibule";
  if (endpoint_vestibule_12) {
    mesh_vestibule_12.position.copy(endpoint_vestibule_12.midpoint);
    mesh_vestibule_12.quaternion.copy(endpoint_vestibule_12.quaternion);
  }
  mesh_vestibule_12.castShadow = options.castShadow ?? true;
  mesh_vestibule_12.receiveShadow = options.receiveShadow ?? true;
  mesh_vestibule_12.userData.sculptComponent = {"id": "vestibule", "name": "Vestibule", "level": "micro", "role": "interior", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "vestibule is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [-0.35, -1.0, 2.14], "localEnd": [-0.35, -0.96, 2.14], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1881588094659405, "height": 1.8621565765433077, "depth": 0.25423295140694163, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.41585558331307915, -0.827625145130359, 2.1762340640434203], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 2.25, 0.25]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "vestibule", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}}, "material": "wood-walnut", "materialLayers": ["wood-walnut"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 58, 28, 1.0)", "secondaryAlbedo": "rgba(154, 88, 42, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_vestibule_12.add(mesh_vestibule_12);
  meshes["vestibule"] = mesh_vestibule_12;
  colliders["vestibule"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["vestibule"] ??= [];
  destructionGroups["vestibule"].push(node_vestibule_12);

  const endpoint_window_blue_13 = makeAttachmentEndpoint(null);
  const node_window_blue_13 = new THREE.Group();
  node_window_blue_13.name = "Window Blue__pivot";
  node_window_blue_13.scale.set(1, 1, 1);
  if (endpoint_window_blue_13) {
    node_window_blue_13.position.copy(endpoint_window_blue_13.start);
    node_window_blue_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_blue_13.position.set(0.8317111666261583, 0.3724313153086616, 2.0948795195931993);
    node_window_blue_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_blue_13.userData.sculptComponent = {"id": "window-blue", "name": "Window Blue", "level": "meso", "role": "opening", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "window-blue is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [0.7, 0.45, 2.06], "localEnd": [0.7, 0.49, 2.06], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1881588094659405, "height": 1.2828189749520564, "depth": 0.12203181667533197, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.8317111666261583, 0.3724313153086616, 2.0948795195931993], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.55, 0.12]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-blue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "window-mullions", "kind": "linework", "description": "Deep frame with vertical and horizontal mullions.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(89, 166, 181, 1.0)", "secondaryAlbedo": "rgba(157, 214, 221, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_window_blue_13.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-blue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["house-main"] ?? root).add(node_window_blue_13);
  nodes["window-blue"] = node_window_blue_13;
  const mesh_window_blue_13Geometry = endpoint_window_blue_13
    ? new THREE.CylinderGeometry(endpoint_window_blue_13.endRadius, endpoint_window_blue_13.baseRadius, endpoint_window_blue_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_blue_13) {
    mesh_window_blue_13Geometry.scale(1.0, 1.55, 0.12);
  }
  const mesh_window_blue_13 = new THREE.Mesh(
    mesh_window_blue_13Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_blue_13.name = "Window Blue";
  if (endpoint_window_blue_13) {
    mesh_window_blue_13.position.copy(endpoint_window_blue_13.midpoint);
    mesh_window_blue_13.quaternion.copy(endpoint_window_blue_13.quaternion);
  }
  mesh_window_blue_13.castShadow = options.castShadow ?? true;
  mesh_window_blue_13.receiveShadow = options.receiveShadow ?? true;
  mesh_window_blue_13.userData.sculptComponent = {"id": "window-blue", "name": "Window Blue", "level": "meso", "role": "opening", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "window-blue is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [0.7, 0.45, 2.06], "localEnd": [0.7, 0.49, 2.06], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1881588094659405, "height": 1.2828189749520564, "depth": 0.12203181667533197, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.8317111666261583, 0.3724313153086616, 2.0948795195931993], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.55, 0.12]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-blue", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "window-mullions", "kind": "linework", "description": "Deep frame with vertical and horizontal mullions.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(89, 166, 181, 1.0)", "secondaryAlbedo": "rgba(157, 214, 221, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_window_blue_13.add(mesh_window_blue_13);
  meshes["window-blue"] = mesh_window_blue_13;
  colliders["window-blue"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["window-blue"] ??= [];
  destructionGroups["window-blue"].push(node_window_blue_13);

  const endpoint_window_glow_14 = makeAttachmentEndpoint(null);
  const node_window_glow_14 = new THREE.Group();
  node_window_glow_14.name = "Window Glow__pivot";
  node_window_glow_14.scale.set(1, 1, 1);
  if (endpoint_window_glow_14) {
    node_window_glow_14.position.copy(endpoint_window_glow_14.start);
    node_window_glow_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_glow_14.position.set(0.0, -0.04138125725651795, 1.2203181667533198);
    node_window_glow_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_glow_14.userData.sculptComponent = {"id": "window-glow", "name": "Window Glow", "level": "meso", "role": "opening", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "window-glow is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "turret", "attachment": {"parentSocket": "turret-surface", "localStart": [0.0, -0.05, 1.2], "localEnd": [0.0, -0.01, 1.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.9505270475727525, "height": 1.2828189749520564, "depth": 0.12203181667533197, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, -0.04138125725651795, 1.2203181667533198], "rotation": [0.0, 0.0, 0.0], "scale": [0.8, 1.55, 0.12]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-glow", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow-material"}}, "material": "window-glow-material", "materialLayers": ["window-glow-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "warm-emission", "kind": "emissive", "description": "Two tower panes emit warm amber light.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 166, 46, 1.0)", "secondaryAlbedo": "rgba(255, 216, 128, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_window_glow_14.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-glow", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow-material"}};
  (nodes["turret"] ?? root).add(node_window_glow_14);
  nodes["window-glow"] = node_window_glow_14;
  const mesh_window_glow_14Geometry = endpoint_window_glow_14
    ? new THREE.CylinderGeometry(endpoint_window_glow_14.endRadius, endpoint_window_glow_14.baseRadius, endpoint_window_glow_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_glow_14) {
    mesh_window_glow_14Geometry.scale(0.8, 1.55, 0.12);
  }
  const mesh_window_glow_14 = new THREE.Mesh(
    mesh_window_glow_14Geometry,
    materialMap["window-glow-material"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_glow_14.name = "Window Glow";
  if (endpoint_window_glow_14) {
    mesh_window_glow_14.position.copy(endpoint_window_glow_14.midpoint);
    mesh_window_glow_14.quaternion.copy(endpoint_window_glow_14.quaternion);
  }
  mesh_window_glow_14.castShadow = options.castShadow ?? true;
  mesh_window_glow_14.receiveShadow = options.receiveShadow ?? true;
  mesh_window_glow_14.userData.sculptComponent = {"id": "window-glow", "name": "Window Glow", "level": "meso", "role": "opening", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "window-glow is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "turret", "attachment": {"parentSocket": "turret-surface", "localStart": [0.0, -0.05, 1.2], "localEnd": [0.0, -0.01, 1.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.9505270475727525, "height": 1.2828189749520564, "depth": 0.12203181667533197, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, -0.04138125725651795, 1.2203181667533198], "rotation": [0.0, 0.0, 0.0], "scale": [0.8, 1.55, 0.12]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-glow", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow-material"}}, "material": "window-glow-material", "materialLayers": ["window-glow-material"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "warm-emission", "kind": "emissive", "description": "Two tower panes emit warm amber light.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 166, 46, 1.0)", "secondaryAlbedo": "rgba(255, 216, 128, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_window_glow_14.add(mesh_window_glow_14);
  meshes["window-glow"] = mesh_window_glow_14;
  colliders["window-glow"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["window-glow"] ??= [];
  destructionGroups["window-glow"].push(node_window_glow_14);

  const endpoint_window_set_15 = makeAttachmentEndpoint(null);
  const node_window_set_15 = new THREE.Group();
  node_window_set_15.name = "Window Set__pivot";
  node_window_set_15.scale.set(1, 1, 1);
  if (endpoint_window_set_15) {
    node_window_set_15.position.copy(endpoint_window_set_15.start);
    node_window_set_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_set_15.position.set(0.0, 0.2896688007956256, -0.30507954168832996);
    node_window_set_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_set_15.userData.sculptComponent = {"id": "window-set", "name": "Window Set", "level": "meso", "role": "opening", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "window-set is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [0.0, 0.35, -0.3], "localEnd": [0.0, 0.39, -0.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1881588094659405, "height": 0.827625145130359, "depth": 1.0169318056277665, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 0.2896688007956256, -0.30507954168832996], "rotation": [0.0, 0.0, 0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-set", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arched-frames", "kind": "contour", "description": "Six-plus deeply framed windows with mullions.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(89, 166, 181, 1.0)", "secondaryAlbedo": "rgba(157, 214, 221, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_window_set_15.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-set", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["house-main"] ?? root).add(node_window_set_15);
  nodes["window-set"] = node_window_set_15;
  const mesh_window_set_15Geometry = endpoint_window_set_15
    ? new THREE.CylinderGeometry(endpoint_window_set_15.endRadius, endpoint_window_set_15.baseRadius, endpoint_window_set_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_window_set_15) {
    mesh_window_set_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_window_set_15 = new THREE.Mesh(
    mesh_window_set_15Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_set_15.name = "Window Set";
  if (endpoint_window_set_15) {
    mesh_window_set_15.position.copy(endpoint_window_set_15.midpoint);
    mesh_window_set_15.quaternion.copy(endpoint_window_set_15.quaternion);
  }
  mesh_window_set_15.castShadow = options.castShadow ?? true;
  mesh_window_set_15.receiveShadow = options.receiveShadow ?? true;
  mesh_window_set_15.userData.sculptComponent = {"id": "window-set", "name": "Window Set", "level": "meso", "role": "opening", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "window-set is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [0.0, 0.35, -0.3], "localEnd": [0.0, 0.39, -0.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1881588094659405, "height": 0.827625145130359, "depth": 1.0169318056277665, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 0.2896688007956256, -0.30507954168832996], "rotation": [0.0, 0.0, 0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-set", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arched-frames", "kind": "contour", "description": "Six-plus deeply framed windows with mullions.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(89, 166, 181, 1.0)", "secondaryAlbedo": "rgba(157, 214, 221, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_window_set_15.add(mesh_window_set_15);
  meshes["window-set"] = mesh_window_set_15;
  colliders["window-set"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["window-set"] ??= [];
  destructionGroups["window-set"].push(node_window_set_15);

  const endpoint_foundation_16 = makeAttachmentEndpoint(null);
  const node_foundation_16 = new THREE.Group();
  node_foundation_16.name = "Foundation__pivot";
  node_foundation_16.scale.set(1, 1, 1);
  if (endpoint_foundation_16) {
    node_foundation_16.position.copy(endpoint_foundation_16.start);
    node_foundation_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_foundation_16.position.set(0.0, -1.4317915010755211, 0.0);
    node_foundation_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_foundation_16.userData.sculptComponent = {"id": "foundation", "name": "Foundation", "level": "meso", "role": "support", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "foundation is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [0.0, -1.73, 0.0], "localEnd": [0.0, -1.69, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 6.59428139253597, "height": 0.786243887873841, "depth": 4.423653354480784, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, -1.4317915010755211, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [5.55, 0.95, 4.35]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foundation", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}}, "material": "stone-foundation", "materialLayers": ["stone-foundation"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "stone-modules", "kind": "bevel", "description": "Irregular masonry modules with dark joints.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(117, 107, 90, 1.0)", "secondaryAlbedo": "rgba(169, 155, 128, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_foundation_16.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foundation", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}};
  (nodes["house-main"] ?? root).add(node_foundation_16);
  nodes["foundation"] = node_foundation_16;
  const mesh_foundation_16Geometry = endpoint_foundation_16
    ? new THREE.CylinderGeometry(endpoint_foundation_16.endRadius, endpoint_foundation_16.baseRadius, endpoint_foundation_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_foundation_16) {
    mesh_foundation_16Geometry.scale(5.55, 0.95, 4.35);
  }
  const mesh_foundation_16 = new THREE.Mesh(
    mesh_foundation_16Geometry,
    materialMap["stone-foundation"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foundation_16.name = "Foundation";
  if (endpoint_foundation_16) {
    mesh_foundation_16.position.copy(endpoint_foundation_16.midpoint);
    mesh_foundation_16.quaternion.copy(endpoint_foundation_16.quaternion);
  }
  mesh_foundation_16.castShadow = options.castShadow ?? true;
  mesh_foundation_16.receiveShadow = options.receiveShadow ?? true;
  mesh_foundation_16.userData.sculptComponent = {"id": "foundation", "name": "Foundation", "level": "meso", "role": "support", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "foundation is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "house-main", "attachment": {"parentSocket": "house-main-surface", "localStart": [0.0, -1.73, 0.0], "localEnd": [0.0, -1.69, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 6.59428139253597, "height": 0.786243887873841, "depth": 4.423653354480784, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, -1.4317915010755211, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [5.55, 0.95, 4.35]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foundation", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}}, "material": "stone-foundation", "materialLayers": ["stone-foundation"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "stone-modules", "kind": "bevel", "description": "Irregular masonry modules with dark joints.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(117, 107, 90, 1.0)", "secondaryAlbedo": "rgba(169, 155, 128, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_foundation_16.add(mesh_foundation_16);
  meshes["foundation"] = mesh_foundation_16;
  colliders["foundation"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["foundation"] ??= [];
  destructionGroups["foundation"].push(node_foundation_16);

  const endpoint_front_steps_17 = makeAttachmentEndpoint(null);
  const node_front_steps_17 = new THREE.Group();
  node_front_steps_17.name = "Front Steps__pivot";
  node_front_steps_17.scale.set(1, 1, 1);
  if (endpoint_front_steps_17) {
    node_front_steps_17.position.copy(endpoint_front_steps_17.start);
    node_front_steps_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_steps_17.position.set(-0.41585558331307915, 0.48416070990126, 3.406721548853018);
    node_front_steps_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_steps_17.userData.sculptComponent = {"id": "front-steps", "name": "Front Steps", "level": "meso", "role": "path", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "front-steps is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [-0.35, 0.585, 3.35], "localEnd": [-0.35, 0.625, 3.35], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.6139493808250696, "height": 0.5379563443347334, "depth": 1.4237045278788731, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.41585558331307915, 0.48416070990126, 3.406721548853018], "rotation": [0.0, 0.0, 0.0], "scale": [2.2, 0.65, 1.4]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}}, "material": "stone-foundation", "materialLayers": ["stone-foundation"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(117, 107, 90, 1.0)", "secondaryAlbedo": "rgba(169, 155, 128, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_front_steps_17.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}};
  (nodes["garden-base"] ?? root).add(node_front_steps_17);
  nodes["front-steps"] = node_front_steps_17;
  const mesh_front_steps_17Geometry = endpoint_front_steps_17
    ? new THREE.CylinderGeometry(endpoint_front_steps_17.endRadius, endpoint_front_steps_17.baseRadius, endpoint_front_steps_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_front_steps_17) {
    mesh_front_steps_17Geometry.scale(2.2, 0.65, 1.4);
  }
  const mesh_front_steps_17 = new THREE.Mesh(
    mesh_front_steps_17Geometry,
    materialMap["stone-foundation"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_steps_17.name = "Front Steps";
  if (endpoint_front_steps_17) {
    mesh_front_steps_17.position.copy(endpoint_front_steps_17.midpoint);
    mesh_front_steps_17.quaternion.copy(endpoint_front_steps_17.quaternion);
  }
  mesh_front_steps_17.castShadow = options.castShadow ?? true;
  mesh_front_steps_17.receiveShadow = options.receiveShadow ?? true;
  mesh_front_steps_17.userData.sculptComponent = {"id": "front-steps", "name": "Front Steps", "level": "meso", "role": "path", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "front-steps is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [-0.35, 0.585, 3.35], "localEnd": [-0.35, 0.625, 3.35], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.6139493808250696, "height": 0.5379563443347334, "depth": 1.4237045278788731, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.41585558331307915, 0.48416070990126, 3.406721548853018], "rotation": [0.0, 0.0, 0.0], "scale": [2.2, 0.65, 1.4]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}}, "material": "stone-foundation", "materialLayers": ["stone-foundation"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(117, 107, 90, 1.0)", "secondaryAlbedo": "rgba(169, 155, 128, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_front_steps_17.add(mesh_front_steps_17);
  meshes["front-steps"] = mesh_front_steps_17;
  colliders["front-steps"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["front-steps"] ??= [];
  destructionGroups["front-steps"].push(node_front_steps_17);

  const endpoint_garden_path_18 = makeAttachmentEndpoint(null);
  const node_garden_path_18 = new THREE.Group();
  node_garden_path_18.name = "Garden Path__pivot";
  node_garden_path_18.scale.set(1, 1, 1);
  if (endpoint_garden_path_18) {
    node_garden_path_18.position.copy(endpoint_garden_path_18.start);
    node_garden_path_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_garden_path_18.position.set(-0.7128952856795643, 0.4179506982908313, 4.779579486450503);
    node_garden_path_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_garden_path_18.userData.sculptComponent = {"id": "garden-path", "name": "Garden Path", "level": "meso", "role": "path", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "garden-path is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [-0.6, 0.505, 4.7], "localEnd": [-0.6, 0.545, 4.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0892129046114456, "height": 0.09931501741564308, "depth": 3.0507954168832994, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.7128952856795643, 0.4179506982908313, 4.779579486450503], "rotation": [0.0, 0.0, 0.0], "scale": [2.6, 0.12, 3.0]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-path", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}}, "material": "stone-foundation", "materialLayers": ["stone-foundation"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pavers", "kind": "bevel", "description": "Mixed-size warm stone pavers with visible gaps.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(117, 107, 90, 1.0)", "secondaryAlbedo": "rgba(169, 155, 128, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_garden_path_18.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-path", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}};
  (nodes["garden-base"] ?? root).add(node_garden_path_18);
  nodes["garden-path"] = node_garden_path_18;
  const mesh_garden_path_18Geometry = endpoint_garden_path_18
    ? new THREE.CylinderGeometry(endpoint_garden_path_18.endRadius, endpoint_garden_path_18.baseRadius, endpoint_garden_path_18.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_garden_path_18) {
    mesh_garden_path_18Geometry.scale(2.6, 0.12, 3.0);
  }
  const mesh_garden_path_18 = new THREE.Mesh(
    mesh_garden_path_18Geometry,
    materialMap["stone-foundation"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_garden_path_18.name = "Garden Path";
  if (endpoint_garden_path_18) {
    mesh_garden_path_18.position.copy(endpoint_garden_path_18.midpoint);
    mesh_garden_path_18.quaternion.copy(endpoint_garden_path_18.quaternion);
  }
  mesh_garden_path_18.castShadow = options.castShadow ?? true;
  mesh_garden_path_18.receiveShadow = options.receiveShadow ?? true;
  mesh_garden_path_18.userData.sculptComponent = {"id": "garden-path", "name": "Garden Path", "level": "meso", "role": "path", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "garden-path is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [-0.6, 0.505, 4.7], "localEnd": [-0.6, 0.545, 4.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0892129046114456, "height": 0.09931501741564308, "depth": 3.0507954168832994, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.7128952856795643, 0.4179506982908313, 4.779579486450503], "rotation": [0.0, 0.0, 0.0], "scale": [2.6, 0.12, 3.0]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-path", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stone-foundation"}}, "material": "stone-foundation", "materialLayers": ["stone-foundation"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pavers", "kind": "bevel", "description": "Mixed-size warm stone pavers with visible gaps.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(117, 107, 90, 1.0)", "secondaryAlbedo": "rgba(169, 155, 128, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_garden_path_18.add(mesh_garden_path_18);
  meshes["garden-path"] = mesh_garden_path_18;
  colliders["garden-path"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["garden-path"] ??= [];
  destructionGroups["garden-path"].push(node_garden_path_18);

  const attachment_gutter_system_19 = {"parentSocket": "roof-main-surface", "localStart": [-3.0, -0.9, 2.1], "localEnd": [3.0, -0.9, 2.1], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.08, "endRadius": 0.08};
  const endpoint_gutter_system_19 = makeAttachmentEndpoint(attachment_gutter_system_19);
  const node_gutter_system_19 = new THREE.Group();
  node_gutter_system_19.name = "Gutter System__pivot";
  node_gutter_system_19.scale.set(1, 1, 1);
  if (endpoint_gutter_system_19) {
    node_gutter_system_19.position.copy(endpoint_gutter_system_19.start);
    node_gutter_system_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_gutter_system_19.position.set(0.0, -0.7448626306173232, 2.13555679181831);
    node_gutter_system_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_gutter_system_19.userData.sculptComponent = {"id": "gutter-system", "name": "Gutter System", "level": "meso", "role": "connector", "importance": 0.82, "confidence": 0.86, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "gutter-system is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "roof-main", "attachment": {"parentSocket": "roof-main-surface", "localStart": [-3.0, -0.9, 2.1], "localEnd": [3.0, -0.9, 2.1], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.08, "endRadius": 0.08}, "dimensions": {"width": 7.128952856795643, "height": 0.13242002322085744, "depth": 0.16270908890044264, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, -0.7448626306173232, 2.13555679181831], "rotation": [0.0, 0.0, 0.0], "scale": [6.0, 0.16, 0.16]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gutter-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gutter-copper"}}, "material": "gutter-copper", "materialLayers": ["gutter-copper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "elbows", "kind": "ridge", "description": "Eave gutters connect to segmented downspout elbows.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(120, 53, 29, 1.0)", "secondaryAlbedo": "rgba(182, 97, 50, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_gutter_system_19.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gutter-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gutter-copper"}};
  (nodes["roof-main"] ?? root).add(node_gutter_system_19);
  nodes["gutter-system"] = node_gutter_system_19;
  const mesh_gutter_system_19Geometry = endpoint_gutter_system_19
    ? new THREE.CylinderGeometry(endpoint_gutter_system_19.endRadius, endpoint_gutter_system_19.baseRadius, endpoint_gutter_system_19.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_gutter_system_19) {
    mesh_gutter_system_19Geometry.scale(6.0, 0.16, 0.16);
  }
  const mesh_gutter_system_19 = new THREE.Mesh(
    mesh_gutter_system_19Geometry,
    materialMap["gutter-copper"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_gutter_system_19.name = "Gutter System";
  if (endpoint_gutter_system_19) {
    mesh_gutter_system_19.position.copy(endpoint_gutter_system_19.midpoint);
    mesh_gutter_system_19.quaternion.copy(endpoint_gutter_system_19.quaternion);
  }
  mesh_gutter_system_19.castShadow = options.castShadow ?? true;
  mesh_gutter_system_19.receiveShadow = options.receiveShadow ?? true;
  mesh_gutter_system_19.userData.sculptComponent = {"id": "gutter-system", "name": "Gutter System", "level": "meso", "role": "connector", "importance": 0.82, "confidence": 0.86, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "gutter-system is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "roof-main", "attachment": {"parentSocket": "roof-main-surface", "localStart": [-3.0, -0.9, 2.1], "localEnd": [3.0, -0.9, 2.1], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.08, "endRadius": 0.08}, "dimensions": {"width": 7.128952856795643, "height": 0.13242002322085744, "depth": 0.16270908890044264, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, -0.7448626306173232, 2.13555679181831], "rotation": [0.0, 0.0, 0.0], "scale": [6.0, 0.16, 0.16]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gutter-system", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gutter-copper"}}, "material": "gutter-copper", "materialLayers": ["gutter-copper"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "elbows", "kind": "ridge", "description": "Eave gutters connect to segmented downspout elbows.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(120, 53, 29, 1.0)", "secondaryAlbedo": "rgba(182, 97, 50, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_gutter_system_19.add(mesh_gutter_system_19);
  meshes["gutter-system"] = mesh_gutter_system_19;
  colliders["gutter-system"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["gutter-system"] ??= [];
  destructionGroups["gutter-system"].push(node_gutter_system_19);

  const attachment_garden_tree_20 = {"parentSocket": "garden-base-surface", "localStart": [-4.0, 0.35, 0.8], "localEnd": [-4.0, 4.3, 0.8], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.35, "endRadius": 0.2};
  const endpoint_garden_tree_20 = makeAttachmentEndpoint(attachment_garden_tree_20);
  const node_garden_tree_20 = new THREE.Group();
  node_garden_tree_20.name = "Garden Tree__pivot";
  node_garden_tree_20.scale.set(1, 1, 1);
  if (endpoint_garden_tree_20) {
    node_garden_tree_20.position.copy(endpoint_garden_tree_20.start);
    node_garden_tree_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_garden_tree_20.position.set(-4.752635237863762, 1.9242284624280848, 0.8135454445022132);
    node_garden_tree_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_garden_tree_20.userData.sculptComponent = {"id": "garden-tree", "name": "Garden Tree", "level": "macro", "role": "botanical", "importance": 0.92, "confidence": 0.86, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "garden-tree is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [-4.0, 0.35, 0.8], "localEnd": [-4.0, 4.3, 0.8], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.35, "endRadius": 0.2}, "dimensions": {"width": 2.138685857038693, "height": 3.476025609547508, "depth": 1.8304772501299797, "units": "relative", "confidence": 0.84}, "transform": {"position": [-4.752635237863762, 1.9242284624280848, 0.8135454445022132], "rotation": [0.0, 0.0, 0.0], "scale": [1.8, 4.2, 1.8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-tree", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}}, "material": "wood-walnut", "materialLayers": ["wood-walnut"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "branching", "kind": "contour", "description": "Forked trunk supports overlapping rounded leaf masses.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 58, 28, 1.0)", "secondaryAlbedo": "rgba(154, 88, 42, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_garden_tree_20.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-tree", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}};
  (nodes["garden-base"] ?? root).add(node_garden_tree_20);
  nodes["garden-tree"] = node_garden_tree_20;
  const mesh_garden_tree_20Geometry = endpoint_garden_tree_20
    ? new THREE.CylinderGeometry(endpoint_garden_tree_20.endRadius, endpoint_garden_tree_20.baseRadius, endpoint_garden_tree_20.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_garden_tree_20) {
    mesh_garden_tree_20Geometry.scale(1.8, 4.2, 1.8);
  }
  const mesh_garden_tree_20 = new THREE.Mesh(
    mesh_garden_tree_20Geometry,
    materialMap["wood-walnut"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_garden_tree_20.name = "Garden Tree";
  if (endpoint_garden_tree_20) {
    mesh_garden_tree_20.position.copy(endpoint_garden_tree_20.midpoint);
    mesh_garden_tree_20.quaternion.copy(endpoint_garden_tree_20.quaternion);
  }
  mesh_garden_tree_20.castShadow = options.castShadow ?? true;
  mesh_garden_tree_20.receiveShadow = options.receiveShadow ?? true;
  mesh_garden_tree_20.userData.sculptComponent = {"id": "garden-tree", "name": "Garden Tree", "level": "macro", "role": "botanical", "importance": 0.92, "confidence": 0.86, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "garden-tree is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [-4.0, 0.35, 0.8], "localEnd": [-4.0, 4.3, 0.8], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.35, "endRadius": 0.2}, "dimensions": {"width": 2.138685857038693, "height": 3.476025609547508, "depth": 1.8304772501299797, "units": "relative", "confidence": 0.84}, "transform": {"position": [-4.752635237863762, 1.9242284624280848, 0.8135454445022132], "rotation": [0.0, 0.0, 0.0], "scale": [1.8, 4.2, 1.8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "garden-tree", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}}, "material": "wood-walnut", "materialLayers": ["wood-walnut"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "branching", "kind": "contour", "description": "Forked trunk supports overlapping rounded leaf masses.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 58, 28, 1.0)", "secondaryAlbedo": "rgba(154, 88, 42, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_garden_tree_20.add(mesh_garden_tree_20);
  meshes["garden-tree"] = mesh_garden_tree_20;
  colliders["garden-tree"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["garden-tree"] ??= [];
  destructionGroups["garden-tree"].push(node_garden_tree_20);

  const endpoint_shrubs_21 = makeAttachmentEndpoint(null);
  const node_shrubs_21 = new THREE.Group();
  node_shrubs_21.name = "Shrubs__pivot";
  node_shrubs_21.scale.set(1, 1, 1);
  if (endpoint_shrubs_21) {
    node_shrubs_21.position.copy(endpoint_shrubs_21.start);
    node_shrubs_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shrubs_21.position.set(1.5446064523057228, 0.7490007563429749, 3.0507954168832994);
    node_shrubs_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_shrubs_21.userData.sculptComponent = {"id": "shrubs", "name": "Shrubs", "level": "meso", "role": "botanical", "importance": 0.82, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "shrubs is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [1.3, 0.905, 3.0], "localEnd": [1.3, 0.945, 3.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 5.346714642596733, "height": 1.0759126886694668, "depth": 1.2203181667533198, "units": "relative", "confidence": 0.84}, "transform": {"position": [1.5446064523057228, 0.7490007563429749, 3.0507954168832994], "rotation": [0.0, 0.0, 0.0], "scale": [4.5, 1.3, 1.2]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shrubs", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "foliage-sage"}}, "material": "foliage-sage", "materialLayers": ["foliage-sage"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(96, 119, 58, 1.0)", "secondaryAlbedo": "rgba(145, 166, 83, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_shrubs_21.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shrubs", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "foliage-sage"}};
  (nodes["garden-base"] ?? root).add(node_shrubs_21);
  nodes["shrubs"] = node_shrubs_21;
  const mesh_shrubs_21Geometry = endpoint_shrubs_21
    ? new THREE.CylinderGeometry(endpoint_shrubs_21.endRadius, endpoint_shrubs_21.baseRadius, endpoint_shrubs_21.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_shrubs_21) {
    mesh_shrubs_21Geometry.scale(4.5, 1.3, 1.2);
  }
  const mesh_shrubs_21 = new THREE.Mesh(
    mesh_shrubs_21Geometry,
    materialMap["foliage-sage"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shrubs_21.name = "Shrubs";
  if (endpoint_shrubs_21) {
    mesh_shrubs_21.position.copy(endpoint_shrubs_21.midpoint);
    mesh_shrubs_21.quaternion.copy(endpoint_shrubs_21.quaternion);
  }
  mesh_shrubs_21.castShadow = options.castShadow ?? true;
  mesh_shrubs_21.receiveShadow = options.receiveShadow ?? true;
  mesh_shrubs_21.userData.sculptComponent = {"id": "shrubs", "name": "Shrubs", "level": "meso", "role": "botanical", "importance": 0.82, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "shrubs is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [1.3, 0.905, 3.0], "localEnd": [1.3, 0.945, 3.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 5.346714642596733, "height": 1.0759126886694668, "depth": 1.2203181667533198, "units": "relative", "confidence": 0.84}, "transform": {"position": [1.5446064523057228, 0.7490007563429749, 3.0507954168832994], "rotation": [0.0, 0.0, 0.0], "scale": [4.5, 1.3, 1.2]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shrubs", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "foliage-sage"}}, "material": "foliage-sage", "materialLayers": ["foliage-sage"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(96, 119, 58, 1.0)", "secondaryAlbedo": "rgba(145, 166, 83, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_shrubs_21.add(mesh_shrubs_21);
  meshes["shrubs"] = mesh_shrubs_21;
  colliders["shrubs"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["shrubs"] ??= [];
  destructionGroups["shrubs"].push(node_shrubs_21);

  const endpoint_flower_beds_22 = makeAttachmentEndpoint(null);
  const node_flower_beds_22 = new THREE.Group();
  node_flower_beds_22.name = "Flower Beds__pivot";
  node_flower_beds_22.scale.set(1, 1, 1);
  if (endpoint_flower_beds_22) {
    node_flower_beds_22.position.copy(endpoint_flower_beds_22.start);
    node_flower_beds_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_flower_beds_22.position.set(0.23763176189318813, 0.566923224414296, 3.9660340419482893);
    node_flower_beds_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_flower_beds_22.userData.sculptComponent = {"id": "flower-beds", "name": "Flower Beds", "level": "micro", "role": "botanical", "importance": 0.82, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "flower-beds is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [0.2, 0.685, 3.9], "localEnd": [0.2, 0.725, 3.9], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 6.891321094902455, "height": 0.4965750870782154, "depth": 1.2203181667533198, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.23763176189318813, 0.566923224414296, 3.9660340419482893], "rotation": [0.0, 0.0, 0.0], "scale": [5.8, 0.6, 1.2]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "flower-beds", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "flower-petal"}}, "material": "flower-petal", "materialLayers": ["flower-petal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cluster-colors", "kind": "contour", "description": "White, pink, yellow and violet flower clusters.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(241, 231, 212, 1.0)", "secondaryAlbedo": "rgba(217, 156, 175, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_flower_beds_22.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "flower-beds", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "flower-petal"}};
  (nodes["garden-base"] ?? root).add(node_flower_beds_22);
  nodes["flower-beds"] = node_flower_beds_22;
  const mesh_flower_beds_22Geometry = endpoint_flower_beds_22
    ? new THREE.CylinderGeometry(endpoint_flower_beds_22.endRadius, endpoint_flower_beds_22.baseRadius, endpoint_flower_beds_22.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_flower_beds_22) {
    mesh_flower_beds_22Geometry.scale(5.8, 0.6, 1.2);
  }
  const mesh_flower_beds_22 = new THREE.Mesh(
    mesh_flower_beds_22Geometry,
    materialMap["flower-petal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_flower_beds_22.name = "Flower Beds";
  if (endpoint_flower_beds_22) {
    mesh_flower_beds_22.position.copy(endpoint_flower_beds_22.midpoint);
    mesh_flower_beds_22.quaternion.copy(endpoint_flower_beds_22.quaternion);
  }
  mesh_flower_beds_22.castShadow = options.castShadow ?? true;
  mesh_flower_beds_22.receiveShadow = options.receiveShadow ?? true;
  mesh_flower_beds_22.userData.sculptComponent = {"id": "flower-beds", "name": "Flower Beds", "level": "micro", "role": "botanical", "importance": 0.82, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "flower-beds is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "garden-base", "attachment": {"parentSocket": "garden-base-surface", "localStart": [0.2, 0.685, 3.9], "localEnd": [0.2, 0.725, 3.9], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 6.891321094902455, "height": 0.4965750870782154, "depth": 1.2203181667533198, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.23763176189318813, 0.566923224414296, 3.9660340419482893], "rotation": [0.0, 0.0, 0.0], "scale": [5.8, 0.6, 1.2]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "flower-beds", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "flower-petal"}}, "material": "flower-petal", "materialLayers": ["flower-petal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cluster-colors", "kind": "contour", "description": "White, pink, yellow and violet flower clusters.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(241, 231, 212, 1.0)", "secondaryAlbedo": "rgba(217, 156, 175, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_flower_beds_22.add(mesh_flower_beds_22);
  meshes["flower-beds"] = mesh_flower_beds_22;
  colliders["flower-beds"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["flower-beds"] ??= [];
  destructionGroups["flower-beds"].push(node_flower_beds_22);

  const endpoint_chimney_smoke_23 = makeAttachmentEndpoint(null);
  const node_chimney_smoke_23 = new THREE.Group();
  node_chimney_smoke_23.name = "Chimney Smoke__pivot";
  node_chimney_smoke_23.scale.set(1, 1, 1);
  if (endpoint_chimney_smoke_23) {
    node_chimney_smoke_23.position.copy(endpoint_chimney_smoke_23.start);
    node_chimney_smoke_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chimney_smoke_23.position.set(0.0, 1.3655814894650924, 0.0);
    node_chimney_smoke_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_chimney_smoke_23.userData.sculptComponent = {"id": "chimney-smoke", "name": "Chimney Smoke", "level": "micro", "role": "effect", "importance": 0.82, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "chimney-smoke is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "chimney", "attachment": {"parentSocket": "chimney-surface", "localStart": [0.0, 1.65, 0.0], "localEnd": [0.0, 1.69, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5940794047329703, "height": 1.4897252612346463, "depth": 0.5084659028138833, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 1.3655814894650924, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.5, 1.8, 0.5]}, "actionProfile": {"animationRole": "effect-emitter", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chimney-smoke", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_chimney_smoke_23.userData.actionProfile = {"animationRole": "effect-emitter", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chimney-smoke", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}};
  (nodes["chimney"] ?? root).add(node_chimney_smoke_23);
  nodes["chimney-smoke"] = node_chimney_smoke_23;
  const mesh_chimney_smoke_23Geometry = endpoint_chimney_smoke_23
    ? new THREE.CylinderGeometry(endpoint_chimney_smoke_23.endRadius, endpoint_chimney_smoke_23.baseRadius, endpoint_chimney_smoke_23.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_chimney_smoke_23) {
    mesh_chimney_smoke_23Geometry.scale(0.5, 1.8, 0.5);
  }
  const mesh_chimney_smoke_23 = new THREE.Mesh(
    mesh_chimney_smoke_23Geometry,
    materialMap["stucco-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chimney_smoke_23.name = "Chimney Smoke";
  if (endpoint_chimney_smoke_23) {
    mesh_chimney_smoke_23.position.copy(endpoint_chimney_smoke_23.midpoint);
    mesh_chimney_smoke_23.quaternion.copy(endpoint_chimney_smoke_23.quaternion);
  }
  mesh_chimney_smoke_23.castShadow = options.castShadow ?? true;
  mesh_chimney_smoke_23.receiveShadow = options.receiveShadow ?? true;
  mesh_chimney_smoke_23.userData.sculptComponent = {"id": "chimney-smoke", "name": "Chimney Smoke", "level": "micro", "role": "effect", "importance": 0.82, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "chimney-smoke is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "chimney", "attachment": {"parentSocket": "chimney-surface", "localStart": [0.0, 1.65, 0.0], "localEnd": [0.0, 1.69, 0.0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5940794047329703, "height": 1.4897252612346463, "depth": 0.5084659028138833, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 1.3655814894650924, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.5, 1.8, 0.5]}, "actionProfile": {"animationRole": "effect-emitter", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chimney-smoke", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "stucco-cream"}}, "material": "stucco-cream", "materialLayers": ["stucco-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_chimney_smoke_23.add(mesh_chimney_smoke_23);
  meshes["chimney-smoke"] = mesh_chimney_smoke_23;
  colliders["chimney-smoke"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["chimney-smoke"] ??= [];
  destructionGroups["chimney-smoke"].push(node_chimney_smoke_23);

  const endpoint_blank_plaque_24 = makeAttachmentEndpoint(null);
  const node_blank_plaque_24 = new THREE.Group();
  node_blank_plaque_24.name = "Blank Plaque__pivot";
  node_blank_plaque_24.scale.set(1, 1, 1);
  if (endpoint_blank_plaque_24) {
    node_blank_plaque_24.position.copy(endpoint_blank_plaque_24.start);
    node_blank_plaque_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_blank_plaque_24.position.set(0.0, 0.910387659643395, 0.6304977194892153);
    node_blank_plaque_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_blank_plaque_24.userData.sculptComponent = {"id": "blank-plaque", "name": "Blank Plaque", "level": "micro", "role": "detail", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "blank-plaque is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-porch", "attachment": {"parentSocket": "front-porch-surface", "localStart": [0.0, 1.1, 0.62], "localEnd": [0.0, 1.14, 0.62], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.4851985118324258, "height": 0.3972600696625723, "depth": 0.12203181667533197, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 0.910387659643395, 0.6304977194892153], "rotation": [0.0, 0.0, 0.0], "scale": [1.25, 0.48, 0.12]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blank-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}}, "material": "wood-walnut", "materialLayers": ["wood-walnut"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plaque-bevel", "kind": "bevel", "description": "Blank layered geometric sign without text.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 58, 28, 1.0)", "secondaryAlbedo": "rgba(154, 88, 42, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_blank_plaque_24.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blank-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}};
  (nodes["front-porch"] ?? root).add(node_blank_plaque_24);
  nodes["blank-plaque"] = node_blank_plaque_24;
  const mesh_blank_plaque_24Geometry = endpoint_blank_plaque_24
    ? new THREE.CylinderGeometry(endpoint_blank_plaque_24.endRadius, endpoint_blank_plaque_24.baseRadius, endpoint_blank_plaque_24.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_blank_plaque_24) {
    mesh_blank_plaque_24Geometry.scale(1.25, 0.48, 0.12);
  }
  const mesh_blank_plaque_24 = new THREE.Mesh(
    mesh_blank_plaque_24Geometry,
    materialMap["wood-walnut"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_blank_plaque_24.name = "Blank Plaque";
  if (endpoint_blank_plaque_24) {
    mesh_blank_plaque_24.position.copy(endpoint_blank_plaque_24.midpoint);
    mesh_blank_plaque_24.quaternion.copy(endpoint_blank_plaque_24.quaternion);
  }
  mesh_blank_plaque_24.castShadow = options.castShadow ?? true;
  mesh_blank_plaque_24.receiveShadow = options.receiveShadow ?? true;
  mesh_blank_plaque_24.userData.sculptComponent = {"id": "blank-plaque", "name": "Blank Plaque", "level": "micro", "role": "detail", "importance": 0.82, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "blank-plaque is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-porch", "attachment": {"parentSocket": "front-porch-surface", "localStart": [0.0, 1.1, 0.62], "localEnd": [0.0, 1.14, 0.62], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.4851985118324258, "height": 0.3972600696625723, "depth": 0.12203181667533197, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.0, 0.910387659643395, 0.6304977194892153], "rotation": [0.0, 0.0, 0.0], "scale": [1.25, 0.48, 0.12]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blank-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-walnut"}}, "material": "wood-walnut", "materialLayers": ["wood-walnut"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plaque-bevel", "kind": "bevel", "description": "Blank layered geometric sign without text.", "evidenceRefs": ["full-object"], "confidence": 0.92}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 58, 28, 1.0)", "secondaryAlbedo": "rgba(154, 88, 42, 1.0)", "materialClass": "wood", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_blank_plaque_24.add(mesh_blank_plaque_24);
  meshes["blank-plaque"] = mesh_blank_plaque_24;
  colliders["blank-plaque"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["blank-plaque"] ??= [];
  destructionGroups["blank-plaque"].push(node_blank_plaque_24);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createWhimsicalHearthHouseLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Whimsical Hearth House look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"type": "key light", "direction": "upper-left/front", "color": "#FFF0D5", "intensity": 2.1, "softness": 0.72}, {"type": "fill light", "direction": "upper-right/front", "color": "#B9D0E2", "intensity": 0.72, "ratioToKey": 0.34}, {"type": "environment light", "color": "#E9DED0", "intensity": 0.52, "purpose": "soft studio fill"}, {"type": "render intent", "exposure": 1.0, "toneMapping": "ACESFilmic", "background": "#E6DDD2", "contact shadow": "soft oval beneath garden island"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createWhimsicalHearthHouseEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameWhimsicalHearthHouseCamera(
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
export function createWhimsicalHearthHousePresentationComposer(
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

export function configureWhimsicalHearthHouseRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createWhimsicalHearthHouseInspectControls(
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
