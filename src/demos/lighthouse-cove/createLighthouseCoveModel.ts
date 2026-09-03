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

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
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
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : null;
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

// Generated from ObjectSculptSpec target: Lighthouse Cove
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createLighthouseCoveModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Lighthouse Cove";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": true, "fovDegrees": 30.0, "aspect": 1.2496, "orientation": {"yaw": -34.0, "pitch": -22.0, "roll": 0.0}, "positionHint": [9.5, 7.8, 11.5], "note": "Approximate three-quarter front-right fit to the generated reference; rear is inferred."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["rock-grey"] = createSculptMaterial(
    "rock-grey",
    {"id": "rock-grey", "name": "Islet Rock", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8A8378", "color": "#8A8378", "albedo": {"dominant": "#8A8378", "secondary": ["#6E675C", "#A79E8F", "#4F4A41"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#8A8378", "#6E675C", "#A79E8F", "#4F4A41", "#B8AE9D"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.431, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.723, "variation": 0.09, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.215, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.023, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "stone-cavity-dirt", "kind": "stain", "description": "Darker mortar and underside cavities.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/rock-grey.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.817, "estimatedFidelity": 0.817, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/rock-grey/rock-grey_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 140, "sourceHeight": 80, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 140, "height": 80}, "mask": {"backgroundColor": "#463520", "backgroundNoise": 53.141, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9971}, "mapStats": {"valueRange": 0.4309, "heightP90Gradient": 0.05038, "roughnessBase": 0.723, "roughnessVariation": 0.09, "normalStrength": 0.215, "blurRadius": 21}, "palette": ["#4A3B2C", "#372C16", "#6E573B", "#1A1408", "#977B5D"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["moss-green"] = createSculptMaterial(
    "moss-green",
    {"id": "moss-green", "name": "Moss And Grass", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#6E7C36", "color": "#6E7C36", "albedo": {"dominant": "#6E7C36", "secondary": ["#55622A", "#8B9A4C", "#3D471E"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#6E7C36", "#55622A", "#8B9A4C", "#3D471E", "#A9B56B"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [3.0, 3.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.472, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.722, "variation": 0.095, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.221, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.025, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/moss-green.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/moss-green/moss-green_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 110, "sourceHeight": 45, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 110, "height": 45}, "mask": {"backgroundColor": "#432D05", "backgroundNoise": 78.651, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9968}, "mapStats": {"valueRange": 0.548, "heightP90Gradient": 0.05537, "roughnessBase": 0.722, "roughnessVariation": 0.095, "normalStrength": 0.221, "blurRadius": 21}, "palette": ["#A2762B", "#7C5614", "#1B0E02", "#462E08", "#CFAA70"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["tower-plaster"] = createSculptMaterial(
    "tower-plaster",
    {"id": "tower-plaster", "name": "Tower Plaster", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#EFE7DA", "color": "#EFE7DA", "albedo": {"dominant": "#EFE7DA", "secondary": ["#D9CFC0", "#F6F0E6", "#C9BEAE"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#EFE7DA", "#D9CFC0", "#F6F0E6", "#C9BEAE", "#B8AD9C"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.454, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.226, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.099, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.693, "variation": 0.05, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.178, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "stucco-patina", "kind": "stain", "description": "Subtle warm variation and darker protected corners.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/tower-plaster.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.82, "estimatedFidelity": 0.82, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/tower-plaster/tower-plaster_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 100, "sourceHeight": 55, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 100, "height": 55}, "mask": {"backgroundColor": "#A88D78", "backgroundNoise": 111.252, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.498, "heightP90Gradient": 0.01817, "roughnessBase": 0.693, "roughnessVariation": 0.05, "normalStrength": 0.178, "blurRadius": 21}, "palette": ["#AC8E73", "#BC9D80", "#DEBD9A", "#957557", "#54381F"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["roof-red"] = createSculptMaterial(
    "roof-red",
    {"id": "roof-red", "name": "Lantern Roof Red", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#C0392B", "color": "#C0392B", "albedo": {"dominant": "#C0392B", "secondary": ["#96261C", "#E05141", "#6E1B13"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#C0392B", "#96261C", "#E05141", "#6E1B13", "#D8BB93"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.43, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.293, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.136, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.696, "variation": 0.055, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.196, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.015, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "tile-edge-wear", "kind": "bevel", "description": "Lighter bevel response on exposed tile noses.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/roof-red.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.817, "estimatedFidelity": 0.817, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-red/roof-red_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 90, "sourceHeight": 35, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 90, "height": 35}, "mask": {"backgroundColor": "#8A351F", "backgroundNoise": 80.833, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.4299, "heightP90Gradient": 0.03395, "roughnessBase": 0.696, "roughnessVariation": 0.055, "normalStrength": 0.196, "blurRadius": 21}, "palette": ["#D74D23", "#7F2106", "#AF3013", "#4A2207", "#F27949"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["roof-slate"] = createSculptMaterial(
    "roof-slate",
    {"id": "roof-slate", "name": "Cottage Slate", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#4A6076", "color": "#4A6076", "albedo": {"dominant": "#4A6076", "secondary": ["#37485A", "#5E7A92", "#2A3644"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#4A6076", "#37485A", "#5E7A92", "#2A3644", "#7E93A6"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.727, "variation": 0.134, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.258, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.039, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "tile-edge-wear", "kind": "bevel", "description": "Lighter bevel response on exposed tile noses.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/roof-slate.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/roof-slate/roof-slate_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 110, "sourceHeight": 60, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 110, "height": 60}, "mask": {"backgroundColor": "#2F3E4E", "backgroundNoise": 53.907, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8053}, "mapStats": {"valueRange": 0.3433, "heightP90Gradient": 0.08687, "roughnessBase": 0.727, "roughnessVariation": 0.134, "normalStrength": 0.258, "blurRadius": 21}, "palette": ["#46525C", "#53626D", "#343E46", "#141A1F", "#929EA5"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["brick-red"] = createSculptMaterial(
    "brick-red",
    {"id": "brick-red", "name": "Chimney Brick", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9E4A32", "color": "#9E4A32", "albedo": {"dominant": "#9E4A32", "secondary": ["#7C3826", "#B85E42", "#5E2A1C"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#9E4A32", "#7C3826", "#B85E42", "#5E2A1C", "#C9B29B"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.713, "variation": 0.092, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.213, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.022, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "tile-edge-wear", "kind": "bevel", "description": "Lighter bevel response on exposed tile noses.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/brick-red.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/brick-red/brick-red_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 45, "sourceHeight": 60, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 45, "height": 60}, "mask": {"backgroundColor": "#4F423A", "backgroundNoise": 99.121, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9922}, "mapStats": {"valueRange": 0.7263, "heightP90Gradient": 0.04869, "roughnessBase": 0.713, "roughnessVariation": 0.092, "normalStrength": 0.213, "blurRadius": 21}, "palette": ["#945027", "#5B3019", "#291810", "#B47244", "#EAD4B8"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["door-teal"] = createSculptMaterial(
    "door-teal",
    {"id": "door-teal", "name": "Teal Door", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#2E7F86", "color": "#2E7F86", "albedo": {"dominant": "#2E7F86", "secondary": ["#226269", "#3D99A0", "#174348"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#2E7F86", "#226269", "#3D99A0", "#174348", "#7FB6BA"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.427, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.717, "variation": 0.117, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.237, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.031, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/door-teal.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.814, "estimatedFidelity": 0.814, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/door-teal/door-teal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 48, "sourceHeight": 90, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 48, "height": 90}, "mask": {"backgroundColor": "#41533B", "backgroundNoise": 113.956, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9817}, "mapStats": {"valueRange": 0.42, "heightP90Gradient": 0.06931, "roughnessBase": 0.717, "roughnessVariation": 0.117, "normalStrength": 0.237, "blurRadius": 21}, "palette": ["#506D5D", "#405C4E", "#273022", "#0E120B", "#6E816B"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["lantern-glass"] = createSculptMaterial(
    "lantern-glass",
    {"id": "lantern-glass", "name": "Lantern Glass", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#FFC963", "color": "#FFC963", "albedo": {"dominant": "#FFC963", "secondary": ["#F2A93B", "#FFE49A", "#C77F1F"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#FFC963", "#F2A93B", "#FFE49A", "#C77F1F", "#FFF3D0"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.444, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.698, "variation": 0.101, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.214, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.022, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "emissive": {"color": "#FFB347", "intensity": 1.6}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/lantern-glass.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/lantern-glass/lantern-glass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 80, "sourceHeight": 55, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 80, "height": 55}, "mask": {"backgroundColor": "#FEDFA6", "backgroundNoise": 110.571, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.5255}, "mapStats": {"valueRange": 0.4687, "heightP90Gradient": 0.04916, "roughnessBase": 0.698, "roughnessVariation": 0.101, "normalStrength": 0.214, "blurRadius": 21}, "palette": ["#FDEDB4", "#FCE088", "#F0A636", "#F6C35D", "#BF7220"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["window-glow"] = createSculptMaterial(
    "window-glow",
    {"id": "window-glow", "name": "Cottage Window Glow", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#F5A93F", "color": "#F5A93F", "albedo": {"dominant": "#F5A93F", "secondary": ["#D88A25", "#FFCB74", "#A66417"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#F5A93F", "#D88A25", "#FFCB74", "#A66417", "#FFE9BF"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.347, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.711, "variation": 0.087, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.211, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.021, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "emissive": {"color": "#F59E2C", "intensity": 1.1}, "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/window-glow.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/window-glow/window-glow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 55, "sourceHeight": 55, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 55, "height": 55}, "mask": {"backgroundColor": "#604325", "backgroundNoise": 37.59, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.7782, "heightP90Gradient": 0.04691, "roughnessBase": 0.711, "roughnessVariation": 0.087, "normalStrength": 0.211, "blurRadius": 21}, "palette": ["#6C411D", "#F3A936", "#F9DE7B", "#B86116", "#3B1F07"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["glass-blue"] = createSculptMaterial(
    "glass-blue",
    {"id": "glass-blue", "name": "Tower Window Glass", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#5E8FA6", "color": "#5E8FA6", "albedo": {"dominant": "#5E8FA6", "secondary": ["#477083", "#7FAABE", "#33525F"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#5E8FA6", "#477083", "#7FAABE", "#33525F", "#A9C8D5"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.32, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.704, "variation": 0.08, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.05, "variation": 0.02}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.204, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.018, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/glass-blue.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/glass-blue/glass-blue_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 32, "sourceHeight": 42, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 32, "height": 42}, "mask": {"backgroundColor": "#EECCA4", "backgroundNoise": 68.132, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8988}, "mapStats": {"valueRange": 0.9045, "heightP90Gradient": 0.04038, "roughnessBase": 0.704, "roughnessVariation": 0.08, "normalStrength": 0.204, "blurRadius": 21}, "palette": ["#F1D9B6", "#0C0A06", "#40392A", "#76634A", "#AAA088"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["wood-dock"] = createSculptMaterial(
    "wood-dock",
    {"id": "wood-dock", "name": "Dock Timber", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#7A5A38", "color": "#7A5A38", "albedo": {"dominant": "#7A5A38", "secondary": ["#5E432A", "#96744A", "#42301D"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#7A5A38", "#5E432A", "#96744A", "#42301D", "#B09064"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.487, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.734, "variation": 0.115, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.231, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.029, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "timber-grain", "kind": "linework", "description": "Low-contrast lengthwise grain on porch and frames.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/wood-dock.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/wood-dock/wood-dock_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 140, "sourceHeight": 55, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 140, "height": 55}, "mask": {"backgroundColor": "#895625", "backgroundNoise": 101.099, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9997}, "mapStats": {"valueRange": 0.5906, "heightP90Gradient": 0.06374, "roughnessBase": 0.734, "roughnessVariation": 0.115, "normalStrength": 0.231, "blurRadius": 21}, "palette": ["#A8713F", "#C38A52", "#865428", "#40210B", "#E8B476"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["boat-red"] = createSculptMaterial(
    "boat-red",
    {"id": "boat-red", "name": "Rowboat Red", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B23A2E", "color": "#B23A2E", "albedo": {"dominant": "#B23A2E", "secondary": ["#8C2B22", "#D14E40", "#63201A"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#B23A2E", "#8C2B22", "#D14E40", "#63201A", "#E9DFD2"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.697, "variation": 0.088, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.213, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.022, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "tile-edge-wear", "kind": "bevel", "description": "Lighter bevel response on exposed tile noses.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/boat-red.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/boat-red/boat-red_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 120, "sourceHeight": 45, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 120, "height": 45}, "mask": {"backgroundColor": "#903011", "backgroundNoise": 61.0, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.7472, "heightP90Gradient": 0.04821, "roughnessBase": 0.697, "roughnessVariation": 0.088, "normalStrength": 0.213, "blurRadius": 21}, "palette": ["#7D1503", "#A96B40", "#180702", "#451707", "#EDD9BB"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["gull-white"] = createSculptMaterial(
    "gull-white",
    {"id": "gull-white", "name": "Gull White", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#F2EEE6", "color": "#F2EEE6", "albedo": {"dominant": "#F2EEE6", "secondary": ["#D9D4C9", "#FFFDF7", "#B9B3A6"], "samplingNotes": "reference local-colour zones authored by review; the single-image de-lit extraction is kept as provenance only", "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#F2EEE6", "#D9D4C9", "#FFFDF7", "#B9B3A6", "#8A8378"], "pattern": "reference-derived pixel palette", "amplitude": 0.14, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.281, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.13, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.697, "variation": 0.058, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.193, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.014, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "stucco-patina", "kind": "stain", "description": "Subtle warm variation and darker protected corners.", "evidenceRefs": ["full-object"], "confidence": 0.92}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Reference-derived stylized material with independent procedural channel variation.", "referencePbr": {"version": "1.0", "sourceImage": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/crops/gull-white.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/nicco/Desktop/img2threejs-free-assist-artifacts/lighthouse-cove/materials/gull-white/gull-white_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 50, "sourceHeight": 35, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 50, "height": 35}, "mask": {"backgroundColor": "#83630E", "backgroundNoise": 57.801, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.8817}, "mapStats": {"valueRange": 0.721, "heightP90Gradient": 0.0312, "roughnessBase": 0.697, "roughnessVariation": 0.058, "normalStrength": 0.193, "blurRadius": 21}, "palette": ["#8D6C15", "#F4E5D0", "#C0AB97", "#9C7F62", "#4A3E2F"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
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
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Root", "level": "macro", "role": "root", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "root is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(115, 134, 61, 1.0)", "secondaryAlbedo": "rgba(155, 172, 88, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_root_0.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}};
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
    materialMap["rock-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Root", "level": "macro", "role": "root", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "root is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(115, 134, 61, 1.0)", "secondaryAlbedo": "rgba(155, 172, 88, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const attachment_islet_base_1 = {"parentSocket": "root-surface", "localStart": [0, -0.1, 0], "localEnd": [0, 2.1, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 4.6, "endRadius": 3.9};
  const endpoint_islet_base_1 = makeAttachmentEndpoint(attachment_islet_base_1);
  const node_islet_base_1 = new THREE.Group();
  node_islet_base_1.name = "Islet Base__pivot";
  node_islet_base_1.scale.set(1, 1, 1);
  if (endpoint_islet_base_1) {
    node_islet_base_1.position.copy(endpoint_islet_base_1.start);
    node_islet_base_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_islet_base_1.position.set(0.0, -0.1, 0.0);
    node_islet_base_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_islet_base_1.userData.sculptComponent = {"id": "islet-base", "name": "Islet Base", "level": "macro", "role": "base", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-surface", "localStart": [0, -0.1, 0], "localEnd": [0, 2.1, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 4.6, "endRadius": 3.9}, "dimensions": {"width": 10, "height": 2.2, "depth": 9, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, -0.1, 0], "rotation": [0, 0, 0], "scale": [10, 2.2, 9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "islet-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "strata", "kind": "bevel", "description": "Layered blocky rock strata ring.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.85, "microRoughness": 0.6, "bumpAmplitude": 0.35, "normalPattern": "horizontal rock strata ledges", "displacementPattern": "stepped strata bands", "occlusionPattern": "deep strata shadow lines", "edgeWearPattern": "chipped ledge edges", "notes": "layered blocky coastal rock per zone-r2c1"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_islet_base_1.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "islet-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}};
  (nodes["root"] ?? root).add(node_islet_base_1);
  nodes["islet-base"] = node_islet_base_1;
  const mesh_islet_base_1Geometry = endpoint_islet_base_1
    ? new THREE.CylinderGeometry(endpoint_islet_base_1.endRadius, endpoint_islet_base_1.baseRadius, endpoint_islet_base_1.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_islet_base_1) {
    mesh_islet_base_1Geometry.scale(10.0, 2.2, 9.0);
  }
  const mesh_islet_base_1 = new THREE.Mesh(
    mesh_islet_base_1Geometry,
    materialMap["rock-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_islet_base_1.name = "Islet Base";
  if (endpoint_islet_base_1) {
    mesh_islet_base_1.position.copy(endpoint_islet_base_1.midpoint);
    mesh_islet_base_1.quaternion.copy(endpoint_islet_base_1.quaternion);
  }
  mesh_islet_base_1.castShadow = options.castShadow ?? true;
  mesh_islet_base_1.receiveShadow = options.receiveShadow ?? true;
  mesh_islet_base_1.userData.sculptComponent = {"id": "islet-base", "name": "Islet Base", "level": "macro", "role": "base", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-surface", "localStart": [0, -0.1, 0], "localEnd": [0, 2.1, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 4.6, "endRadius": 3.9}, "dimensions": {"width": 10, "height": 2.2, "depth": 9, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, -0.1, 0], "rotation": [0, 0, 0], "scale": [10, 2.2, 9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "islet-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "strata", "kind": "bevel", "description": "Layered blocky rock strata ring.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.85, "microRoughness": 0.6, "bumpAmplitude": 0.35, "normalPattern": "horizontal rock strata ledges", "displacementPattern": "stepped strata bands", "occlusionPattern": "deep strata shadow lines", "edgeWearPattern": "chipped ledge edges", "notes": "layered blocky coastal rock per zone-r2c1"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_islet_base_1.add(mesh_islet_base_1);
  meshes["islet-base"] = mesh_islet_base_1;
  colliders["islet-base"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["islet-base"] ??= [];
  destructionGroups["islet-base"].push(node_islet_base_1);

  const attachment_lighthouse_tower_2 = {"parentSocket": "islet-base-surface", "localStart": [-0.6, 1.9, -0.3], "localEnd": [-0.6, 7.5, -0.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.3, "endRadius": 1.0};
  const endpoint_lighthouse_tower_2 = makeAttachmentEndpoint(attachment_lighthouse_tower_2);
  const node_lighthouse_tower_2 = new THREE.Group();
  node_lighthouse_tower_2.name = "Lighthouse Tower__pivot";
  node_lighthouse_tower_2.scale.set(1, 1, 1);
  if (endpoint_lighthouse_tower_2) {
    node_lighthouse_tower_2.position.copy(endpoint_lighthouse_tower_2.start);
    node_lighthouse_tower_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lighthouse_tower_2.position.set(-0.6, 1.9, -0.3);
    node_lighthouse_tower_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_lighthouse_tower_2.userData.sculptComponent = {"id": "lighthouse-tower", "name": "Lighthouse Tower", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-0.6, 1.9, -0.3], "localEnd": [-0.6, 7.5, -0.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.3, "endRadius": 1.0}, "dimensions": {"width": 2.6, "height": 5.6, "depth": 2.6, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.6, 1.9, -0.3], "rotation": [0, 0, 0], "scale": [2.6, 5.6, 2.6]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lighthouse-tower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tower-plaster"}}, "material": "tower-plaster", "materialLayers": ["tower-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "stripe-bands", "kind": "contour", "description": "Two broad red plaster stripe bands.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.45, "bumpAmplitude": 0.12, "normalPattern": "troweled plaster grain", "displacementPattern": "", "occlusionPattern": "grime under gallery", "edgeWearPattern": "weathered plaster streaks", "notes": "painted plaster per zone-r0c1"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_lighthouse_tower_2.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lighthouse-tower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tower-plaster"}};
  (nodes["islet-base"] ?? root).add(node_lighthouse_tower_2);
  nodes["lighthouse-tower"] = node_lighthouse_tower_2;
  const mesh_lighthouse_tower_2Geometry = endpoint_lighthouse_tower_2
    ? new THREE.CylinderGeometry(endpoint_lighthouse_tower_2.endRadius, endpoint_lighthouse_tower_2.baseRadius, endpoint_lighthouse_tower_2.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_lighthouse_tower_2) {
    mesh_lighthouse_tower_2Geometry.scale(2.6, 5.6, 2.6);
  }
  const mesh_lighthouse_tower_2 = new THREE.Mesh(
    mesh_lighthouse_tower_2Geometry,
    materialMap["tower-plaster"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lighthouse_tower_2.name = "Lighthouse Tower";
  if (endpoint_lighthouse_tower_2) {
    mesh_lighthouse_tower_2.position.copy(endpoint_lighthouse_tower_2.midpoint);
    mesh_lighthouse_tower_2.quaternion.copy(endpoint_lighthouse_tower_2.quaternion);
  }
  mesh_lighthouse_tower_2.castShadow = options.castShadow ?? true;
  mesh_lighthouse_tower_2.receiveShadow = options.receiveShadow ?? true;
  mesh_lighthouse_tower_2.userData.sculptComponent = {"id": "lighthouse-tower", "name": "Lighthouse Tower", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-0.6, 1.9, -0.3], "localEnd": [-0.6, 7.5, -0.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.3, "endRadius": 1.0}, "dimensions": {"width": 2.6, "height": 5.6, "depth": 2.6, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.6, 1.9, -0.3], "rotation": [0, 0, 0], "scale": [2.6, 5.6, 2.6]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lighthouse-tower", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tower-plaster"}}, "material": "tower-plaster", "materialLayers": ["tower-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "stripe-bands", "kind": "contour", "description": "Two broad red plaster stripe bands.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.45, "bumpAmplitude": 0.12, "normalPattern": "troweled plaster grain", "displacementPattern": "", "occlusionPattern": "grime under gallery", "edgeWearPattern": "weathered plaster streaks", "notes": "painted plaster per zone-r0c1"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_lighthouse_tower_2.add(mesh_lighthouse_tower_2);
  meshes["lighthouse-tower"] = mesh_lighthouse_tower_2;
  colliders["lighthouse-tower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["lighthouse-tower"] ??= [];
  destructionGroups["lighthouse-tower"].push(node_lighthouse_tower_2);

  const attachment_gallery_deck_3 = {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 5.55, 0], "localEnd": [0, 5.83, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.38, "endRadius": 1.38};
  const endpoint_gallery_deck_3 = makeAttachmentEndpoint(attachment_gallery_deck_3);
  const node_gallery_deck_3 = new THREE.Group();
  node_gallery_deck_3.name = "Gallery Deck__pivot";
  node_gallery_deck_3.scale.set(1, 1, 1);
  if (endpoint_gallery_deck_3) {
    node_gallery_deck_3.position.copy(endpoint_gallery_deck_3.start);
    node_gallery_deck_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_gallery_deck_3.position.set(0.0, 5.55, 0.0);
    node_gallery_deck_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_gallery_deck_3.userData.sculptComponent = {"id": "gallery-deck", "name": "Gallery Deck", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 5.55, 0], "localEnd": [0, 5.83, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.38, "endRadius": 1.38}, "dimensions": {"width": 2.7, "height": 0.28, "depth": 2.7, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 5.55, 0], "rotation": [0, 0, 0], "scale": [2.7, 0.28, 2.7]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_gallery_deck_3.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}};
  (nodes["lighthouse-tower"] ?? root).add(node_gallery_deck_3);
  nodes["gallery-deck"] = node_gallery_deck_3;
  const mesh_gallery_deck_3Geometry = endpoint_gallery_deck_3
    ? new THREE.CylinderGeometry(endpoint_gallery_deck_3.endRadius, endpoint_gallery_deck_3.baseRadius, endpoint_gallery_deck_3.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_gallery_deck_3) {
    mesh_gallery_deck_3Geometry.scale(2.7, 0.28, 2.7);
  }
  const mesh_gallery_deck_3 = new THREE.Mesh(
    mesh_gallery_deck_3Geometry,
    materialMap["rock-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_gallery_deck_3.name = "Gallery Deck";
  if (endpoint_gallery_deck_3) {
    mesh_gallery_deck_3.position.copy(endpoint_gallery_deck_3.midpoint);
    mesh_gallery_deck_3.quaternion.copy(endpoint_gallery_deck_3.quaternion);
  }
  mesh_gallery_deck_3.castShadow = options.castShadow ?? true;
  mesh_gallery_deck_3.receiveShadow = options.receiveShadow ?? true;
  mesh_gallery_deck_3.userData.sculptComponent = {"id": "gallery-deck", "name": "Gallery Deck", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 5.55, 0], "localEnd": [0, 5.83, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.38, "endRadius": 1.38}, "dimensions": {"width": 2.7, "height": 0.28, "depth": 2.7, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 5.55, 0], "rotation": [0, 0, 0], "scale": [2.7, 0.28, 2.7]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_gallery_deck_3.add(mesh_gallery_deck_3);
  meshes["gallery-deck"] = mesh_gallery_deck_3;
  colliders["gallery-deck"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["gallery-deck"] ??= [];
  destructionGroups["gallery-deck"].push(node_gallery_deck_3);

  const attachment_lantern_room_4 = {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 5.83, 0], "localEnd": [0, 6.98, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.95, "endRadius": 0.95};
  const endpoint_lantern_room_4 = makeAttachmentEndpoint(attachment_lantern_room_4);
  const node_lantern_room_4 = new THREE.Group();
  node_lantern_room_4.name = "Lantern Room__pivot";
  node_lantern_room_4.scale.set(1, 1, 1);
  if (endpoint_lantern_room_4) {
    node_lantern_room_4.position.copy(endpoint_lantern_room_4.start);
    node_lantern_room_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lantern_room_4.position.set(0.0, 5.83, 0.0);
    node_lantern_room_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_lantern_room_4.userData.sculptComponent = {"id": "lantern-room", "name": "Lantern Room", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 5.83, 0], "localEnd": [0, 6.98, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.95, "endRadius": 0.95}, "dimensions": {"width": 1.9, "height": 1.15, "depth": 1.9, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 5.83, 0], "rotation": [0, 0, 0], "scale": [1.9, 1.15, 1.9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lantern-room", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lantern-glass"}}, "material": "lantern-glass", "materialLayers": ["lantern-glass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "glazing", "kind": "ridge", "description": "Mullioned glowing lantern glazing.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_lantern_room_4.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lantern-room", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lantern-glass"}};
  (nodes["lighthouse-tower"] ?? root).add(node_lantern_room_4);
  nodes["lantern-room"] = node_lantern_room_4;
  const mesh_lantern_room_4Geometry = endpoint_lantern_room_4
    ? new THREE.CylinderGeometry(endpoint_lantern_room_4.endRadius, endpoint_lantern_room_4.baseRadius, endpoint_lantern_room_4.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_lantern_room_4) {
    mesh_lantern_room_4Geometry.scale(1.9, 1.15, 1.9);
  }
  const mesh_lantern_room_4 = new THREE.Mesh(
    mesh_lantern_room_4Geometry,
    materialMap["lantern-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lantern_room_4.name = "Lantern Room";
  if (endpoint_lantern_room_4) {
    mesh_lantern_room_4.position.copy(endpoint_lantern_room_4.midpoint);
    mesh_lantern_room_4.quaternion.copy(endpoint_lantern_room_4.quaternion);
  }
  mesh_lantern_room_4.castShadow = options.castShadow ?? true;
  mesh_lantern_room_4.receiveShadow = options.receiveShadow ?? true;
  mesh_lantern_room_4.userData.sculptComponent = {"id": "lantern-room", "name": "Lantern Room", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 5.83, 0], "localEnd": [0, 6.98, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.95, "endRadius": 0.95}, "dimensions": {"width": 1.9, "height": 1.15, "depth": 1.9, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 5.83, 0], "rotation": [0, 0, 0], "scale": [1.9, 1.15, 1.9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lantern-room", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lantern-glass"}}, "material": "lantern-glass", "materialLayers": ["lantern-glass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "glazing", "kind": "ridge", "description": "Mullioned glowing lantern glazing.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_lantern_room_4.add(mesh_lantern_room_4);
  meshes["lantern-room"] = mesh_lantern_room_4;
  colliders["lantern-room"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["lantern-room"] ??= [];
  destructionGroups["lantern-room"].push(node_lantern_room_4);

  const attachment_lantern_roof_5 = {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 6.9, 0], "localEnd": [0, 7.9, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.18, "endRadius": 0.06};
  const endpoint_lantern_roof_5 = makeAttachmentEndpoint(attachment_lantern_roof_5);
  const node_lantern_roof_5 = new THREE.Group();
  node_lantern_roof_5.name = "Lantern Roof__pivot";
  node_lantern_roof_5.scale.set(1, 1, 1);
  if (endpoint_lantern_roof_5) {
    node_lantern_roof_5.position.copy(endpoint_lantern_roof_5.start);
    node_lantern_roof_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lantern_roof_5.position.set(0.0, 6.9, 0.0);
    node_lantern_roof_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_lantern_roof_5.userData.sculptComponent = {"id": "lantern-roof", "name": "Lantern Roof", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.86, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 6.9, 0], "localEnd": [0, 7.9, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.18, "endRadius": 0.06}, "dimensions": {"width": 2.3, "height": 1.0, "depth": 2.3, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 6.9, 0], "rotation": [0, 0, 0], "scale": [2.3, 1.0, 2.3]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lantern-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-red"}}, "material": "roof-red", "materialLayers": ["roof-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "finial", "kind": "contour", "description": "Red cone capped by a round finial.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_lantern_roof_5.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lantern-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-red"}};
  (nodes["lighthouse-tower"] ?? root).add(node_lantern_roof_5);
  nodes["lantern-roof"] = node_lantern_roof_5;
  const mesh_lantern_roof_5Geometry = endpoint_lantern_roof_5
    ? new THREE.CylinderGeometry(endpoint_lantern_roof_5.endRadius, endpoint_lantern_roof_5.baseRadius, endpoint_lantern_roof_5.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 1);
  if (!endpoint_lantern_roof_5) {
    mesh_lantern_roof_5Geometry.scale(2.3, 1.0, 2.3);
  }
  const mesh_lantern_roof_5 = new THREE.Mesh(
    mesh_lantern_roof_5Geometry,
    materialMap["roof-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lantern_roof_5.name = "Lantern Roof";
  if (endpoint_lantern_roof_5) {
    mesh_lantern_roof_5.position.copy(endpoint_lantern_roof_5.midpoint);
    mesh_lantern_roof_5.quaternion.copy(endpoint_lantern_roof_5.quaternion);
  }
  mesh_lantern_roof_5.castShadow = options.castShadow ?? true;
  mesh_lantern_roof_5.receiveShadow = options.receiveShadow ?? true;
  mesh_lantern_roof_5.userData.sculptComponent = {"id": "lantern-roof", "name": "Lantern Roof", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.86, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 6.9, 0], "localEnd": [0, 7.9, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.18, "endRadius": 0.06}, "dimensions": {"width": 2.3, "height": 1.0, "depth": 2.3, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 6.9, 0], "rotation": [0, 0, 0], "scale": [2.3, 1.0, 2.3]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lantern-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-red"}}, "material": "roof-red", "materialLayers": ["roof-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "finial", "kind": "contour", "description": "Red cone capped by a round finial.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_lantern_roof_5.add(mesh_lantern_roof_5);
  meshes["lantern-roof"] = mesh_lantern_roof_5;
  colliders["lantern-roof"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["lantern-roof"] ??= [];
  destructionGroups["lantern-roof"].push(node_lantern_roof_5);

  const endpoint_finial_orb_6 = makeAttachmentEndpoint(null);
  const node_finial_orb_6 = new THREE.Group();
  node_finial_orb_6.name = "Finial Orb__pivot";
  node_finial_orb_6.scale.set(1, 1, 1);
  if (endpoint_finial_orb_6) {
    node_finial_orb_6.position.copy(endpoint_finial_orb_6.start);
    node_finial_orb_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_finial_orb_6.position.set(0.0, 8.05, 0.0);
    node_finial_orb_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_finial_orb_6.userData.sculptComponent = {"id": "finial-orb", "name": "Finial Orb", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 8.05, 0], "localEnd": [0, 8.09, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.36, "height": 0.4, "depth": 0.36, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 8.05, 0], "rotation": [0, 0, 0], "scale": [0.36, 0.4, 0.36]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "finial-orb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-red"}}, "material": "roof-red", "materialLayers": ["roof-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_finial_orb_6.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "finial-orb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-red"}};
  (nodes["lighthouse-tower"] ?? root).add(node_finial_orb_6);
  nodes["finial-orb"] = node_finial_orb_6;
  const mesh_finial_orb_6Geometry = endpoint_finial_orb_6
    ? new THREE.CylinderGeometry(endpoint_finial_orb_6.endRadius, endpoint_finial_orb_6.baseRadius, endpoint_finial_orb_6.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_finial_orb_6) {
    mesh_finial_orb_6Geometry.scale(0.36, 0.4, 0.36);
  }
  const mesh_finial_orb_6 = new THREE.Mesh(
    mesh_finial_orb_6Geometry,
    materialMap["roof-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_finial_orb_6.name = "Finial Orb";
  if (endpoint_finial_orb_6) {
    mesh_finial_orb_6.position.copy(endpoint_finial_orb_6.midpoint);
    mesh_finial_orb_6.quaternion.copy(endpoint_finial_orb_6.quaternion);
  }
  mesh_finial_orb_6.castShadow = options.castShadow ?? true;
  mesh_finial_orb_6.receiveShadow = options.receiveShadow ?? true;
  mesh_finial_orb_6.userData.sculptComponent = {"id": "finial-orb", "name": "Finial Orb", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 8.05, 0], "localEnd": [0, 8.09, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.36, "height": 0.4, "depth": 0.36, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 8.05, 0], "rotation": [0, 0, 0], "scale": [0.36, 0.4, 0.36]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "finial-orb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-red"}}, "material": "roof-red", "materialLayers": ["roof-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_finial_orb_6.add(mesh_finial_orb_6);
  meshes["finial-orb"] = mesh_finial_orb_6;
  colliders["finial-orb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["finial-orb"] ??= [];
  destructionGroups["finial-orb"].push(node_finial_orb_6);

  const endpoint_tower_window_low_7 = makeAttachmentEndpoint(null);
  const node_tower_window_low_7 = new THREE.Group();
  node_tower_window_low_7.name = "Tower Window Low__pivot";
  node_tower_window_low_7.scale.set(1, 1, 1);
  if (endpoint_tower_window_low_7) {
    node_tower_window_low_7.position.copy(endpoint_tower_window_low_7.start);
    node_tower_window_low_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tower_window_low_7.position.set(0.0, 3.15, 1.2);
    node_tower_window_low_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_tower_window_low_7.userData.sculptComponent = {"id": "tower-window-low", "name": "Tower Window Low", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 3.15, 1.2], "localEnd": [0, 3.19, 1.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5, "height": 0.8, "depth": 0.14, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 3.15, 1.2], "rotation": [0, 0, 0], "scale": [0.5, 0.8, 0.14]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tower-window-low", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_tower_window_low_7.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tower-window-low", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["lighthouse-tower"] ?? root).add(node_tower_window_low_7);
  nodes["tower-window-low"] = node_tower_window_low_7;
  const mesh_tower_window_low_7Geometry = endpoint_tower_window_low_7
    ? new THREE.CylinderGeometry(endpoint_tower_window_low_7.endRadius, endpoint_tower_window_low_7.baseRadius, endpoint_tower_window_low_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_tower_window_low_7) {
    mesh_tower_window_low_7Geometry.scale(0.5, 0.8, 0.14);
  }
  const mesh_tower_window_low_7 = new THREE.Mesh(
    mesh_tower_window_low_7Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tower_window_low_7.name = "Tower Window Low";
  if (endpoint_tower_window_low_7) {
    mesh_tower_window_low_7.position.copy(endpoint_tower_window_low_7.midpoint);
    mesh_tower_window_low_7.quaternion.copy(endpoint_tower_window_low_7.quaternion);
  }
  mesh_tower_window_low_7.castShadow = options.castShadow ?? true;
  mesh_tower_window_low_7.receiveShadow = options.receiveShadow ?? true;
  mesh_tower_window_low_7.userData.sculptComponent = {"id": "tower-window-low", "name": "Tower Window Low", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 3.15, 1.2], "localEnd": [0, 3.19, 1.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5, "height": 0.8, "depth": 0.14, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 3.15, 1.2], "rotation": [0, 0, 0], "scale": [0.5, 0.8, 0.14]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tower-window-low", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_tower_window_low_7.add(mesh_tower_window_low_7);
  meshes["tower-window-low"] = mesh_tower_window_low_7;
  colliders["tower-window-low"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["tower-window-low"] ??= [];
  destructionGroups["tower-window-low"].push(node_tower_window_low_7);

  const endpoint_tower_window_high_8 = makeAttachmentEndpoint(null);
  const node_tower_window_high_8 = new THREE.Group();
  node_tower_window_high_8.name = "Tower Window High__pivot";
  node_tower_window_high_8.scale.set(1, 1, 1);
  if (endpoint_tower_window_high_8) {
    node_tower_window_high_8.position.copy(endpoint_tower_window_high_8.start);
    node_tower_window_high_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_tower_window_high_8.position.set(0.0, 4.7, 1.1);
    node_tower_window_high_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_tower_window_high_8.userData.sculptComponent = {"id": "tower-window-high", "name": "Tower Window High", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 4.7, 1.1], "localEnd": [0, 4.74, 1.1], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.45, "height": 0.7, "depth": 0.14, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 4.7, 1.1], "rotation": [0, 0, 0], "scale": [0.45, 0.7, 0.14]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tower-window-high", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_tower_window_high_8.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tower-window-high", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}};
  (nodes["lighthouse-tower"] ?? root).add(node_tower_window_high_8);
  nodes["tower-window-high"] = node_tower_window_high_8;
  const mesh_tower_window_high_8Geometry = endpoint_tower_window_high_8
    ? new THREE.CylinderGeometry(endpoint_tower_window_high_8.endRadius, endpoint_tower_window_high_8.baseRadius, endpoint_tower_window_high_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_tower_window_high_8) {
    mesh_tower_window_high_8Geometry.scale(0.45, 0.7, 0.14);
  }
  const mesh_tower_window_high_8 = new THREE.Mesh(
    mesh_tower_window_high_8Geometry,
    materialMap["glass-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tower_window_high_8.name = "Tower Window High";
  if (endpoint_tower_window_high_8) {
    mesh_tower_window_high_8.position.copy(endpoint_tower_window_high_8.midpoint);
    mesh_tower_window_high_8.quaternion.copy(endpoint_tower_window_high_8.quaternion);
  }
  mesh_tower_window_high_8.castShadow = options.castShadow ?? true;
  mesh_tower_window_high_8.receiveShadow = options.receiveShadow ?? true;
  mesh_tower_window_high_8.userData.sculptComponent = {"id": "tower-window-high", "name": "Tower Window High", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 4.7, 1.1], "localEnd": [0, 4.74, 1.1], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.45, "height": 0.7, "depth": 0.14, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 4.7, 1.1], "rotation": [0, 0, 0], "scale": [0.45, 0.7, 0.14]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tower-window-high", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "glass-blue"}}, "material": "glass-blue", "materialLayers": ["glass-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_tower_window_high_8.add(mesh_tower_window_high_8);
  meshes["tower-window-high"] = mesh_tower_window_high_8;
  colliders["tower-window-high"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["tower-window-high"] ??= [];
  destructionGroups["tower-window-high"].push(node_tower_window_high_8);

  const endpoint_keeper_cottage_9 = makeAttachmentEndpoint(null);
  const node_keeper_cottage_9 = new THREE.Group();
  node_keeper_cottage_9.name = "Keeper Cottage__pivot";
  node_keeper_cottage_9.scale.set(1, 1, 1);
  if (endpoint_keeper_cottage_9) {
    node_keeper_cottage_9.position.copy(endpoint_keeper_cottage_9.start);
    node_keeper_cottage_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_keeper_cottage_9.position.set(1.9, 3.05, 0.6);
    node_keeper_cottage_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_keeper_cottage_9.userData.sculptComponent = {"id": "keeper-cottage", "name": "Keeper Cottage", "level": "macro", "role": "body", "importance": 0.93, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [1.9, 3.05, 0.6], "localEnd": [1.9, 3.09, 0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0, "height": 2.2, "depth": 2.4, "units": "relative", "confidence": 0.84}, "transform": {"position": [1.9, 3.05, 0.6], "rotation": [0, 0, 0], "scale": [3.0, 2.2, 2.4]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "keeper-cottage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tower-plaster"}}, "material": "tower-plaster", "materialLayers": ["tower-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.5, "bumpAmplitude": 0.1, "normalPattern": "stucco dabs", "displacementPattern": "", "occlusionPattern": "corner grime", "edgeWearPattern": "sill streaks", "notes": "cottage stucco per zone-r1c2"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_keeper_cottage_9.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "keeper-cottage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tower-plaster"}};
  (nodes["islet-base"] ?? root).add(node_keeper_cottage_9);
  nodes["keeper-cottage"] = node_keeper_cottage_9;
  const mesh_keeper_cottage_9Geometry = endpoint_keeper_cottage_9
    ? new THREE.CylinderGeometry(endpoint_keeper_cottage_9.endRadius, endpoint_keeper_cottage_9.baseRadius, endpoint_keeper_cottage_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_keeper_cottage_9) {
    mesh_keeper_cottage_9Geometry.scale(3.0, 2.2, 2.4);
  }
  const mesh_keeper_cottage_9 = new THREE.Mesh(
    mesh_keeper_cottage_9Geometry,
    materialMap["tower-plaster"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_keeper_cottage_9.name = "Keeper Cottage";
  if (endpoint_keeper_cottage_9) {
    mesh_keeper_cottage_9.position.copy(endpoint_keeper_cottage_9.midpoint);
    mesh_keeper_cottage_9.quaternion.copy(endpoint_keeper_cottage_9.quaternion);
  }
  mesh_keeper_cottage_9.castShadow = options.castShadow ?? true;
  mesh_keeper_cottage_9.receiveShadow = options.receiveShadow ?? true;
  mesh_keeper_cottage_9.userData.sculptComponent = {"id": "keeper-cottage", "name": "Keeper Cottage", "level": "macro", "role": "body", "importance": 0.93, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [1.9, 3.05, 0.6], "localEnd": [1.9, 3.09, 0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0, "height": 2.2, "depth": 2.4, "units": "relative", "confidence": 0.84}, "transform": {"position": [1.9, 3.05, 0.6], "rotation": [0, 0, 0], "scale": [3.0, 2.2, 2.4]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "keeper-cottage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tower-plaster"}}, "material": "tower-plaster", "materialLayers": ["tower-plaster"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.5, "bumpAmplitude": 0.1, "normalPattern": "stucco dabs", "displacementPattern": "", "occlusionPattern": "corner grime", "edgeWearPattern": "sill streaks", "notes": "cottage stucco per zone-r1c2"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_keeper_cottage_9.add(mesh_keeper_cottage_9);
  meshes["keeper-cottage"] = mesh_keeper_cottage_9;
  colliders["keeper-cottage"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["keeper-cottage"] ??= [];
  destructionGroups["keeper-cottage"].push(node_keeper_cottage_9);

  const endpoint_cottage_roof_10 = makeAttachmentEndpoint(null);
  const node_cottage_roof_10 = new THREE.Group();
  node_cottage_roof_10.name = "Cottage Roof__pivot";
  node_cottage_roof_10.scale.set(1, 1, 1);
  if (endpoint_cottage_roof_10) {
    node_cottage_roof_10.position.copy(endpoint_cottage_roof_10.start);
    node_cottage_roof_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cottage_roof_10.position.set(0.0, 1.75, -1.45);
    node_cottage_roof_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_cottage_roof_10.userData.sculptComponent = {"id": "cottage-roof", "name": "Cottage Roof", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, -0.5], [0.5, -0.5], [0.0, 0.5]], "depth": 1}}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [0, 1.75, -1.45], "localEnd": [0, 1.79, -1.45], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.4, "height": 1.5, "depth": 2.9, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 1.75, -1.45], "rotation": [0, 0, 0], "scale": [3.4, 1.5, 2.9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-slate"}}, "material": "roof-slate", "materialLayers": ["roof-slate"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "gable", "kind": "ridge", "description": "Steep slate-blue gable roof.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.4, "bumpAmplitude": 0.22, "normalPattern": "staggered slate tile rows", "displacementPattern": "tile step relief", "occlusionPattern": "under-tile shadow", "edgeWearPattern": "chipped slate corners", "notes": "slate rows per zone-r1c2"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_cottage_roof_10.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-slate"}};
  (nodes["keeper-cottage"] ?? root).add(node_cottage_roof_10);
  nodes["cottage-roof"] = node_cottage_roof_10;
  const mesh_cottage_roof_10Geometry = endpoint_cottage_roof_10
    ? new THREE.CylinderGeometry(endpoint_cottage_roof_10.endRadius, endpoint_cottage_roof_10.baseRadius, endpoint_cottage_roof_10.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.5, -0.5], [0.5, -0.5], [0.0, 0.5]], "depth": 1});
  if (!endpoint_cottage_roof_10) {
    mesh_cottage_roof_10Geometry.scale(3.4, 1.5, 2.9);
  }
  const mesh_cottage_roof_10 = new THREE.Mesh(
    mesh_cottage_roof_10Geometry,
    materialMap["roof-slate"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cottage_roof_10.name = "Cottage Roof";
  if (endpoint_cottage_roof_10) {
    mesh_cottage_roof_10.position.copy(endpoint_cottage_roof_10.midpoint);
    mesh_cottage_roof_10.quaternion.copy(endpoint_cottage_roof_10.quaternion);
  }
  mesh_cottage_roof_10.castShadow = options.castShadow ?? true;
  mesh_cottage_roof_10.receiveShadow = options.receiveShadow ?? true;
  mesh_cottage_roof_10.userData.sculptComponent = {"id": "cottage-roof", "name": "Cottage Roof", "level": "macro", "role": "roof", "importance": 0.9, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, -0.5], [0.5, -0.5], [0.0, 0.5]], "depth": 1}}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [0, 1.75, -1.45], "localEnd": [0, 1.79, -1.45], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.4, "height": 1.5, "depth": 2.9, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 1.75, -1.45], "rotation": [0, 0, 0], "scale": [3.4, 1.5, 2.9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "roof-slate"}}, "material": "roof-slate", "materialLayers": ["roof-slate"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "gable", "kind": "ridge", "description": "Steep slate-blue gable roof.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.4, "bumpAmplitude": 0.22, "normalPattern": "staggered slate tile rows", "displacementPattern": "tile step relief", "occlusionPattern": "under-tile shadow", "edgeWearPattern": "chipped slate corners", "notes": "slate rows per zone-r1c2"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_cottage_roof_10.add(mesh_cottage_roof_10);
  meshes["cottage-roof"] = mesh_cottage_roof_10;
  colliders["cottage-roof"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["cottage-roof"] ??= [];
  destructionGroups["cottage-roof"].push(node_cottage_roof_10);

  const endpoint_cottage_chimney_11 = makeAttachmentEndpoint(null);
  const node_cottage_chimney_11 = new THREE.Group();
  node_cottage_chimney_11.name = "Cottage Chimney__pivot";
  node_cottage_chimney_11.scale.set(1, 1, 1);
  if (endpoint_cottage_chimney_11) {
    node_cottage_chimney_11.position.copy(endpoint_cottage_chimney_11.start);
    node_cottage_chimney_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cottage_chimney_11.position.set(0.95, 1.95, -0.5);
    node_cottage_chimney_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_cottage_chimney_11.userData.sculptComponent = {"id": "cottage-chimney", "name": "Cottage Chimney", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [0.95, 1.95, -0.5], "localEnd": [0.95, 1.99, -0.5], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5, "height": 1.5, "depth": 0.5, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.95, 1.95, -0.5], "rotation": [0, 0, 0], "scale": [0.5, 1.5, 0.5]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "brick-red"}}, "material": "brick-red", "materialLayers": ["brick-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_cottage_chimney_11.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "brick-red"}};
  (nodes["keeper-cottage"] ?? root).add(node_cottage_chimney_11);
  nodes["cottage-chimney"] = node_cottage_chimney_11;
  const mesh_cottage_chimney_11Geometry = endpoint_cottage_chimney_11
    ? new THREE.CylinderGeometry(endpoint_cottage_chimney_11.endRadius, endpoint_cottage_chimney_11.baseRadius, endpoint_cottage_chimney_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_cottage_chimney_11) {
    mesh_cottage_chimney_11Geometry.scale(0.5, 1.5, 0.5);
  }
  const mesh_cottage_chimney_11 = new THREE.Mesh(
    mesh_cottage_chimney_11Geometry,
    materialMap["brick-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cottage_chimney_11.name = "Cottage Chimney";
  if (endpoint_cottage_chimney_11) {
    mesh_cottage_chimney_11.position.copy(endpoint_cottage_chimney_11.midpoint);
    mesh_cottage_chimney_11.quaternion.copy(endpoint_cottage_chimney_11.quaternion);
  }
  mesh_cottage_chimney_11.castShadow = options.castShadow ?? true;
  mesh_cottage_chimney_11.receiveShadow = options.receiveShadow ?? true;
  mesh_cottage_chimney_11.userData.sculptComponent = {"id": "cottage-chimney", "name": "Cottage Chimney", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [0.95, 1.95, -0.5], "localEnd": [0.95, 1.99, -0.5], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5, "height": 1.5, "depth": 0.5, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.95, 1.95, -0.5], "rotation": [0, 0, 0], "scale": [0.5, 1.5, 0.5]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-chimney", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "brick-red"}}, "material": "brick-red", "materialLayers": ["brick-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_cottage_chimney_11.add(mesh_cottage_chimney_11);
  meshes["cottage-chimney"] = mesh_cottage_chimney_11;
  colliders["cottage-chimney"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["cottage-chimney"] ??= [];
  destructionGroups["cottage-chimney"].push(node_cottage_chimney_11);

  const endpoint_cottage_door_12 = makeAttachmentEndpoint(null);
  const node_cottage_door_12 = new THREE.Group();
  node_cottage_door_12.name = "Cottage Door__pivot";
  node_cottage_door_12.scale.set(1, 1, 1);
  if (endpoint_cottage_door_12) {
    node_cottage_door_12.position.copy(endpoint_cottage_door_12.start);
    node_cottage_door_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cottage_door_12.position.set(-0.62, -0.4, 1.2);
    node_cottage_door_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_cottage_door_12.userData.sculptComponent = {"id": "cottage-door", "name": "Cottage Door", "level": "meso", "role": "detail", "importance": 0.92, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.28], [0.34, 0.44], [0.0, 0.5], [-0.34, 0.44], [-0.5, 0.28]], "depth": 1}}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [-0.62, -0.4, 1.2], "localEnd": [-0.62, -0.36, 1.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.72, "height": 1.3, "depth": 0.14, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.62, -0.4, 1.2], "rotation": [0, 0, 0], "scale": [0.72, 1.3, 0.14]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "door-teal"}}, "material": "door-teal", "materialLayers": ["door-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arched-door", "kind": "contour", "description": "Arched teal door with stone surround.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_cottage_door_12.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "door-teal"}};
  (nodes["keeper-cottage"] ?? root).add(node_cottage_door_12);
  nodes["cottage-door"] = node_cottage_door_12;
  const mesh_cottage_door_12Geometry = endpoint_cottage_door_12
    ? new THREE.CylinderGeometry(endpoint_cottage_door_12.endRadius, endpoint_cottage_door_12.baseRadius, endpoint_cottage_door_12.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.28], [0.34, 0.44], [0.0, 0.5], [-0.34, 0.44], [-0.5, 0.28]], "depth": 1});
  if (!endpoint_cottage_door_12) {
    mesh_cottage_door_12Geometry.scale(0.72, 1.3, 0.14);
  }
  const mesh_cottage_door_12 = new THREE.Mesh(
    mesh_cottage_door_12Geometry,
    materialMap["door-teal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cottage_door_12.name = "Cottage Door";
  if (endpoint_cottage_door_12) {
    mesh_cottage_door_12.position.copy(endpoint_cottage_door_12.midpoint);
    mesh_cottage_door_12.quaternion.copy(endpoint_cottage_door_12.quaternion);
  }
  mesh_cottage_door_12.castShadow = options.castShadow ?? true;
  mesh_cottage_door_12.receiveShadow = options.receiveShadow ?? true;
  mesh_cottage_door_12.userData.sculptComponent = {"id": "cottage-door", "name": "Cottage Door", "level": "meso", "role": "detail", "importance": 0.92, "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.28], [0.34, 0.44], [0.0, 0.5], [-0.34, 0.44], [-0.5, 0.28]], "depth": 1}}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [-0.62, -0.4, 1.2], "localEnd": [-0.62, -0.36, 1.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.72, "height": 1.3, "depth": 0.14, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.62, -0.4, 1.2], "rotation": [0, 0, 0], "scale": [0.72, 1.3, 0.14]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "door-teal"}}, "material": "door-teal", "materialLayers": ["door-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arched-door", "kind": "contour", "description": "Arched teal door with stone surround.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_cottage_door_12.add(mesh_cottage_door_12);
  meshes["cottage-door"] = mesh_cottage_door_12;
  colliders["cottage-door"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["cottage-door"] ??= [];
  destructionGroups["cottage-door"].push(node_cottage_door_12);

  const endpoint_cottage_window_13 = makeAttachmentEndpoint(null);
  const node_cottage_window_13 = new THREE.Group();
  node_cottage_window_13.name = "Cottage Window__pivot";
  node_cottage_window_13.scale.set(1, 1, 1);
  if (endpoint_cottage_window_13) {
    node_cottage_window_13.position.copy(endpoint_cottage_window_13.start);
    node_cottage_window_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cottage_window_13.position.set(0.72, 0.05, 1.2);
    node_cottage_window_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_cottage_window_13.userData.sculptComponent = {"id": "cottage-window", "name": "Cottage Window", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [0.72, 0.05, 1.2], "localEnd": [0.72, 0.09, 1.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.14, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.72, 0.05, 1.2], "rotation": [0, 0, 0], "scale": [0.85, 0.85, 0.14]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-window", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow"}}, "material": "window-glow", "materialLayers": ["window-glow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lit-window", "kind": "contour", "description": "Warm mullioned lit window.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_cottage_window_13.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-window", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow"}};
  (nodes["keeper-cottage"] ?? root).add(node_cottage_window_13);
  nodes["cottage-window"] = node_cottage_window_13;
  const mesh_cottage_window_13Geometry = endpoint_cottage_window_13
    ? new THREE.CylinderGeometry(endpoint_cottage_window_13.endRadius, endpoint_cottage_window_13.baseRadius, endpoint_cottage_window_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_cottage_window_13) {
    mesh_cottage_window_13Geometry.scale(0.85, 0.85, 0.14);
  }
  const mesh_cottage_window_13 = new THREE.Mesh(
    mesh_cottage_window_13Geometry,
    materialMap["window-glow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cottage_window_13.name = "Cottage Window";
  if (endpoint_cottage_window_13) {
    mesh_cottage_window_13.position.copy(endpoint_cottage_window_13.midpoint);
    mesh_cottage_window_13.quaternion.copy(endpoint_cottage_window_13.quaternion);
  }
  mesh_cottage_window_13.castShadow = options.castShadow ?? true;
  mesh_cottage_window_13.receiveShadow = options.receiveShadow ?? true;
  mesh_cottage_window_13.userData.sculptComponent = {"id": "cottage-window", "name": "Cottage Window", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [0.72, 0.05, 1.2], "localEnd": [0.72, 0.09, 1.2], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.14, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.72, 0.05, 1.2], "rotation": [0, 0, 0], "scale": [0.85, 0.85, 0.14]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cottage-window", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow"}}, "material": "window-glow", "materialLayers": ["window-glow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lit-window", "kind": "contour", "description": "Warm mullioned lit window.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_cottage_window_13.add(mesh_cottage_window_13);
  meshes["cottage-window"] = mesh_cottage_window_13;
  colliders["cottage-window"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["cottage-window"] ??= [];
  destructionGroups["cottage-window"].push(node_cottage_window_13);

  const endpoint_door_lantern_14 = makeAttachmentEndpoint(null);
  const node_door_lantern_14 = new THREE.Group();
  node_door_lantern_14.name = "Door Lantern__pivot";
  node_door_lantern_14.scale.set(1, 1, 1);
  if (endpoint_door_lantern_14) {
    node_door_lantern_14.position.copy(endpoint_door_lantern_14.start);
    node_door_lantern_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_lantern_14.position.set(-0.05, 0.25, 1.28);
    node_door_lantern_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_lantern_14.userData.sculptComponent = {"id": "door-lantern", "name": "Door Lantern", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [-0.05, 0.25, 1.28], "localEnd": [-0.05, 0.29, 1.28], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.28, "depth": 0.2, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.05, 0.25, 1.28], "rotation": [0, 0, 0], "scale": [0.2, 0.28, 0.2]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-lantern", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow"}}, "material": "window-glow", "materialLayers": ["window-glow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_door_lantern_14.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-lantern", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow"}};
  (nodes["keeper-cottage"] ?? root).add(node_door_lantern_14);
  nodes["door-lantern"] = node_door_lantern_14;
  const mesh_door_lantern_14Geometry = endpoint_door_lantern_14
    ? new THREE.CylinderGeometry(endpoint_door_lantern_14.endRadius, endpoint_door_lantern_14.baseRadius, endpoint_door_lantern_14.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_door_lantern_14) {
    mesh_door_lantern_14Geometry.scale(0.2, 0.28, 0.2);
  }
  const mesh_door_lantern_14 = new THREE.Mesh(
    mesh_door_lantern_14Geometry,
    materialMap["window-glow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_lantern_14.name = "Door Lantern";
  if (endpoint_door_lantern_14) {
    mesh_door_lantern_14.position.copy(endpoint_door_lantern_14.midpoint);
    mesh_door_lantern_14.quaternion.copy(endpoint_door_lantern_14.quaternion);
  }
  mesh_door_lantern_14.castShadow = options.castShadow ?? true;
  mesh_door_lantern_14.receiveShadow = options.receiveShadow ?? true;
  mesh_door_lantern_14.userData.sculptComponent = {"id": "door-lantern", "name": "Door Lantern", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "keeper-cottage", "attachment": {"parentSocket": "keeper-cottage-surface", "localStart": [-0.05, 0.25, 1.28], "localEnd": [-0.05, 0.29, 1.28], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.28, "depth": 0.2, "units": "relative", "confidence": 0.84}, "transform": {"position": [-0.05, 0.25, 1.28], "rotation": [0, 0, 0], "scale": [0.2, 0.28, 0.2]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-lantern", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "window-glow"}}, "material": "window-glow", "materialLayers": ["window-glow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_door_lantern_14.add(mesh_door_lantern_14);
  meshes["door-lantern"] = mesh_door_lantern_14;
  colliders["door-lantern"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["door-lantern"] ??= [];
  destructionGroups["door-lantern"].push(node_door_lantern_14);

  const endpoint_rock_outcrop_15 = makeAttachmentEndpoint(null);
  const node_rock_outcrop_15 = new THREE.Group();
  node_rock_outcrop_15.name = "Rock Outcrop__pivot";
  node_rock_outcrop_15.scale.set(1, 1, 1);
  if (endpoint_rock_outcrop_15) {
    node_rock_outcrop_15.position.copy(endpoint_rock_outcrop_15.start);
    node_rock_outcrop_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rock_outcrop_15.position.set(-3.0, 2.35, 0.5);
    node_rock_outcrop_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_rock_outcrop_15.userData.sculptComponent = {"id": "rock-outcrop", "name": "Rock Outcrop", "level": "meso", "role": "base", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-3.0, 2.35, 0.5], "localEnd": [-3.0, 2.39, 0.5], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.2, "height": 1.4, "depth": 1.9, "units": "relative", "confidence": 0.84}, "transform": {"position": [-3.0, 2.35, 0.5], "rotation": [0, 0, 0], "scale": [2.2, 1.4, 1.9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rock-outcrop", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_rock_outcrop_15.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rock-outcrop", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}};
  (nodes["islet-base"] ?? root).add(node_rock_outcrop_15);
  nodes["rock-outcrop"] = node_rock_outcrop_15;
  const mesh_rock_outcrop_15Geometry = endpoint_rock_outcrop_15
    ? new THREE.CylinderGeometry(endpoint_rock_outcrop_15.endRadius, endpoint_rock_outcrop_15.baseRadius, endpoint_rock_outcrop_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_rock_outcrop_15) {
    mesh_rock_outcrop_15Geometry.scale(2.2, 1.4, 1.9);
  }
  const mesh_rock_outcrop_15 = new THREE.Mesh(
    mesh_rock_outcrop_15Geometry,
    materialMap["rock-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rock_outcrop_15.name = "Rock Outcrop";
  if (endpoint_rock_outcrop_15) {
    mesh_rock_outcrop_15.position.copy(endpoint_rock_outcrop_15.midpoint);
    mesh_rock_outcrop_15.quaternion.copy(endpoint_rock_outcrop_15.quaternion);
  }
  mesh_rock_outcrop_15.castShadow = options.castShadow ?? true;
  mesh_rock_outcrop_15.receiveShadow = options.receiveShadow ?? true;
  mesh_rock_outcrop_15.userData.sculptComponent = {"id": "rock-outcrop", "name": "Rock Outcrop", "level": "meso", "role": "base", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-3.0, 2.35, 0.5], "localEnd": [-3.0, 2.39, 0.5], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.2, "height": 1.4, "depth": 1.9, "units": "relative", "confidence": 0.84}, "transform": {"position": [-3.0, 2.35, 0.5], "rotation": [0, 0, 0], "scale": [2.2, 1.4, 1.9]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rock-outcrop", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_rock_outcrop_15.add(mesh_rock_outcrop_15);
  meshes["rock-outcrop"] = mesh_rock_outcrop_15;
  colliders["rock-outcrop"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rock-outcrop"] ??= [];
  destructionGroups["rock-outcrop"].push(node_rock_outcrop_15);

  const endpoint_stone_steps_16 = makeAttachmentEndpoint(null);
  const node_stone_steps_16 = new THREE.Group();
  node_stone_steps_16.name = "Stone Steps__pivot";
  node_stone_steps_16.scale.set(1, 1, 1);
  if (endpoint_stone_steps_16) {
    node_stone_steps_16.position.copy(endpoint_stone_steps_16.start);
    node_stone_steps_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stone_steps_16.position.set(0.3, 2.1, 2.4);
    node_stone_steps_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_stone_steps_16.userData.sculptComponent = {"id": "stone-steps", "name": "Stone Steps", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [0.3, 2.1, 2.4], "localEnd": [0.3, 2.14, 2.4], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1, "height": 0.35, "depth": 2.4, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.3, 2.1, 2.4], "rotation": [0, 0, 0], "scale": [1.1, 0.35, 2.4]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stone-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_stone_steps_16.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stone-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}};
  (nodes["islet-base"] ?? root).add(node_stone_steps_16);
  nodes["stone-steps"] = node_stone_steps_16;
  const mesh_stone_steps_16Geometry = endpoint_stone_steps_16
    ? new THREE.CylinderGeometry(endpoint_stone_steps_16.endRadius, endpoint_stone_steps_16.baseRadius, endpoint_stone_steps_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_stone_steps_16) {
    mesh_stone_steps_16Geometry.scale(1.1, 0.35, 2.4);
  }
  const mesh_stone_steps_16 = new THREE.Mesh(
    mesh_stone_steps_16Geometry,
    materialMap["rock-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stone_steps_16.name = "Stone Steps";
  if (endpoint_stone_steps_16) {
    mesh_stone_steps_16.position.copy(endpoint_stone_steps_16.midpoint);
    mesh_stone_steps_16.quaternion.copy(endpoint_stone_steps_16.quaternion);
  }
  mesh_stone_steps_16.castShadow = options.castShadow ?? true;
  mesh_stone_steps_16.receiveShadow = options.receiveShadow ?? true;
  mesh_stone_steps_16.userData.sculptComponent = {"id": "stone-steps", "name": "Stone Steps", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [0.3, 2.1, 2.4], "localEnd": [0.3, 2.14, 2.4], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1, "height": 0.35, "depth": 2.4, "units": "relative", "confidence": 0.84}, "transform": {"position": [0.3, 2.1, 2.4], "rotation": [0, 0, 0], "scale": [1.1, 0.35, 2.4]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stone-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "rock-grey", "materialLayers": ["rock-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_stone_steps_16.add(mesh_stone_steps_16);
  meshes["stone-steps"] = mesh_stone_steps_16;
  colliders["stone-steps"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["stone-steps"] ??= [];
  destructionGroups["stone-steps"].push(node_stone_steps_16);

  const endpoint_moss_patch_front_17 = makeAttachmentEndpoint(null);
  const node_moss_patch_front_17 = new THREE.Group();
  node_moss_patch_front_17.name = "Moss Patch Front__pivot";
  node_moss_patch_front_17.scale.set(1, 1, 1);
  if (endpoint_moss_patch_front_17) {
    node_moss_patch_front_17.position.copy(endpoint_moss_patch_front_17.start);
    node_moss_patch_front_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_moss_patch_front_17.position.set(-1.6, 2.25, 1.7);
    node_moss_patch_front_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_moss_patch_front_17.userData.sculptComponent = {"id": "moss-patch-front", "name": "Moss Patch Front", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-1.6, 2.25, 1.7], "localEnd": [-1.6, 2.29, 1.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0, "height": 0.35, "depth": 2.5, "units": "relative", "confidence": 0.84}, "transform": {"position": [-1.6, 2.25, 1.7], "rotation": [0, 0, 0], "scale": [3.0, 0.35, 2.5]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "moss-patch-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "moss-green"}}, "material": "moss-green", "materialLayers": ["moss-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "patches", "kind": "contour", "description": "Moss and grass patches with tiny flowers.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.7, "bumpAmplitude": 0.2, "normalPattern": "grass tuft noise", "displacementPattern": "tuft clumps", "occlusionPattern": "under-tuft shadow", "edgeWearPattern": "", "notes": "moss and grass per zone-r1c1"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_moss_patch_front_17.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "moss-patch-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "moss-green"}};
  (nodes["islet-base"] ?? root).add(node_moss_patch_front_17);
  nodes["moss-patch-front"] = node_moss_patch_front_17;
  const mesh_moss_patch_front_17Geometry = endpoint_moss_patch_front_17
    ? new THREE.CylinderGeometry(endpoint_moss_patch_front_17.endRadius, endpoint_moss_patch_front_17.baseRadius, endpoint_moss_patch_front_17.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_moss_patch_front_17) {
    mesh_moss_patch_front_17Geometry.scale(3.0, 0.35, 2.5);
  }
  const mesh_moss_patch_front_17 = new THREE.Mesh(
    mesh_moss_patch_front_17Geometry,
    materialMap["moss-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_moss_patch_front_17.name = "Moss Patch Front";
  if (endpoint_moss_patch_front_17) {
    mesh_moss_patch_front_17.position.copy(endpoint_moss_patch_front_17.midpoint);
    mesh_moss_patch_front_17.quaternion.copy(endpoint_moss_patch_front_17.quaternion);
  }
  mesh_moss_patch_front_17.castShadow = options.castShadow ?? true;
  mesh_moss_patch_front_17.receiveShadow = options.receiveShadow ?? true;
  mesh_moss_patch_front_17.userData.sculptComponent = {"id": "moss-patch-front", "name": "Moss Patch Front", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-1.6, 2.25, 1.7], "localEnd": [-1.6, 2.29, 1.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.0, "height": 0.35, "depth": 2.5, "units": "relative", "confidence": 0.84}, "transform": {"position": [-1.6, 2.25, 1.7], "rotation": [0, 0, 0], "scale": [3.0, 0.35, 2.5]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "moss-patch-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "moss-green"}}, "material": "moss-green", "materialLayers": ["moss-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "patches", "kind": "contour", "description": "Moss and grass patches with tiny flowers.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.7, "bumpAmplitude": 0.2, "normalPattern": "grass tuft noise", "displacementPattern": "tuft clumps", "occlusionPattern": "under-tuft shadow", "edgeWearPattern": "", "notes": "moss and grass per zone-r1c1"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_moss_patch_front_17.add(mesh_moss_patch_front_17);
  meshes["moss-patch-front"] = mesh_moss_patch_front_17;
  colliders["moss-patch-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["moss-patch-front"] ??= [];
  destructionGroups["moss-patch-front"].push(node_moss_patch_front_17);

  const endpoint_moss_patch_rear_18 = makeAttachmentEndpoint(null);
  const node_moss_patch_rear_18 = new THREE.Group();
  node_moss_patch_rear_18.name = "Moss Patch Rear__pivot";
  node_moss_patch_rear_18.scale.set(1, 1, 1);
  if (endpoint_moss_patch_rear_18) {
    node_moss_patch_rear_18.position.copy(endpoint_moss_patch_rear_18.start);
    node_moss_patch_rear_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_moss_patch_rear_18.position.set(2.3, 2.35, -1.3);
    node_moss_patch_rear_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_moss_patch_rear_18.userData.sculptComponent = {"id": "moss-patch-rear", "name": "Moss Patch Rear", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [2.3, 2.35, -1.3], "localEnd": [2.3, 2.39, -1.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.5, "height": 0.3, "depth": 2.1, "units": "relative", "confidence": 0.84}, "transform": {"position": [2.3, 2.35, -1.3], "rotation": [0, 0, 0], "scale": [2.5, 0.3, 2.1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "moss-patch-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "moss-green"}}, "material": "moss-green", "materialLayers": ["moss-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.7, "bumpAmplitude": 0.2, "normalPattern": "grass tuft noise", "displacementPattern": "tuft clumps", "occlusionPattern": "under-tuft shadow", "edgeWearPattern": "", "notes": "moss and grass per zone-r1c1"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_moss_patch_rear_18.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "moss-patch-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "moss-green"}};
  (nodes["islet-base"] ?? root).add(node_moss_patch_rear_18);
  nodes["moss-patch-rear"] = node_moss_patch_rear_18;
  const mesh_moss_patch_rear_18Geometry = endpoint_moss_patch_rear_18
    ? new THREE.CylinderGeometry(endpoint_moss_patch_rear_18.endRadius, endpoint_moss_patch_rear_18.baseRadius, endpoint_moss_patch_rear_18.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_moss_patch_rear_18) {
    mesh_moss_patch_rear_18Geometry.scale(2.5, 0.3, 2.1);
  }
  const mesh_moss_patch_rear_18 = new THREE.Mesh(
    mesh_moss_patch_rear_18Geometry,
    materialMap["moss-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_moss_patch_rear_18.name = "Moss Patch Rear";
  if (endpoint_moss_patch_rear_18) {
    mesh_moss_patch_rear_18.position.copy(endpoint_moss_patch_rear_18.midpoint);
    mesh_moss_patch_rear_18.quaternion.copy(endpoint_moss_patch_rear_18.quaternion);
  }
  mesh_moss_patch_rear_18.castShadow = options.castShadow ?? true;
  mesh_moss_patch_rear_18.receiveShadow = options.receiveShadow ?? true;
  mesh_moss_patch_rear_18.userData.sculptComponent = {"id": "moss-patch-rear", "name": "Moss Patch Rear", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [2.3, 2.35, -1.3], "localEnd": [2.3, 2.39, -1.3], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.5, "height": 0.3, "depth": 2.1, "units": "relative", "confidence": 0.84}, "transform": {"position": [2.3, 2.35, -1.3], "rotation": [0, 0, 0], "scale": [2.5, 0.3, 2.1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "moss-patch-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "moss-green"}}, "material": "moss-green", "materialLayers": ["moss-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.7, "bumpAmplitude": 0.2, "normalPattern": "grass tuft noise", "displacementPattern": "tuft clumps", "occlusionPattern": "under-tuft shadow", "edgeWearPattern": "", "notes": "moss and grass per zone-r1c1"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_moss_patch_rear_18.add(mesh_moss_patch_rear_18);
  meshes["moss-patch-rear"] = mesh_moss_patch_rear_18;
  colliders["moss-patch-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["moss-patch-rear"] ??= [];
  destructionGroups["moss-patch-rear"].push(node_moss_patch_rear_18);

  const endpoint_dock_pier_19 = makeAttachmentEndpoint(null);
  const node_dock_pier_19 = new THREE.Group();
  node_dock_pier_19.name = "Dock Pier__pivot";
  node_dock_pier_19.scale.set(1, 1, 1);
  if (endpoint_dock_pier_19) {
    node_dock_pier_19.position.copy(endpoint_dock_pier_19.start);
    node_dock_pier_19.rotation.set(0.0, 0.28, 0.0);
  } else {
    node_dock_pier_19.position.set(-2.3, 1.0, 3.9);
    node_dock_pier_19.rotation.set(0.0, 0.28, 0.0);
  }
  node_dock_pier_19.userData.sculptComponent = {"id": "dock-pier", "name": "Dock Pier", "level": "macro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-2.3, 1.0, 3.9], "localEnd": [-2.3, 1.04, 3.9], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.9, "height": 0.26, "depth": 1.5, "units": "relative", "confidence": 0.84}, "transform": {"position": [-2.3, 1.0, 3.9], "rotation": [0, 0.28, 0], "scale": [3.9, 0.26, 1.5]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-pier", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "planks", "kind": "ridge", "description": "Weathered plank dock with mooring posts.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.75, "microRoughness": 0.55, "bumpAmplitude": 0.18, "normalPattern": "plank grooves across the walkway", "displacementPattern": "plank gaps", "occlusionPattern": "gap shadows", "edgeWearPattern": "worn plank ends", "notes": "weathered planks per zone-r2c0"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_pier_19.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-pier", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}};
  (nodes["islet-base"] ?? root).add(node_dock_pier_19);
  nodes["dock-pier"] = node_dock_pier_19;
  const mesh_dock_pier_19Geometry = endpoint_dock_pier_19
    ? new THREE.CylinderGeometry(endpoint_dock_pier_19.endRadius, endpoint_dock_pier_19.baseRadius, endpoint_dock_pier_19.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_dock_pier_19) {
    mesh_dock_pier_19Geometry.scale(3.9, 0.26, 1.5);
  }
  const mesh_dock_pier_19 = new THREE.Mesh(
    mesh_dock_pier_19Geometry,
    materialMap["wood-dock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dock_pier_19.name = "Dock Pier";
  if (endpoint_dock_pier_19) {
    mesh_dock_pier_19.position.copy(endpoint_dock_pier_19.midpoint);
    mesh_dock_pier_19.quaternion.copy(endpoint_dock_pier_19.quaternion);
  }
  mesh_dock_pier_19.castShadow = options.castShadow ?? true;
  mesh_dock_pier_19.receiveShadow = options.receiveShadow ?? true;
  mesh_dock_pier_19.userData.sculptComponent = {"id": "dock-pier", "name": "Dock Pier", "level": "macro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-2.3, 1.0, 3.9], "localEnd": [-2.3, 1.04, 3.9], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.9, "height": 0.26, "depth": 1.5, "units": "relative", "confidence": 0.84}, "transform": {"position": [-2.3, 1.0, 3.9], "rotation": [0, 0.28, 0], "scale": [3.9, 0.26, 1.5]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-pier", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "planks", "kind": "ridge", "description": "Weathered plank dock with mooring posts.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.75, "microRoughness": 0.55, "bumpAmplitude": 0.18, "normalPattern": "plank grooves across the walkway", "displacementPattern": "plank gaps", "occlusionPattern": "gap shadows", "edgeWearPattern": "worn plank ends", "notes": "weathered planks per zone-r2c0"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_pier_19.add(mesh_dock_pier_19);
  meshes["dock-pier"] = mesh_dock_pier_19;
  colliders["dock-pier"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["dock-pier"] ??= [];
  destructionGroups["dock-pier"].push(node_dock_pier_19);

  const endpoint_dock_post_1_20 = makeAttachmentEndpoint(null);
  const node_dock_post_1_20 = new THREE.Group();
  node_dock_post_1_20.name = "Dock Post 1__pivot";
  node_dock_post_1_20.scale.set(1, 1, 1);
  if (endpoint_dock_post_1_20) {
    node_dock_post_1_20.position.copy(endpoint_dock_post_1_20.start);
    node_dock_post_1_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_dock_post_1_20.position.set(-1.5, -0.3, -0.6);
    node_dock_post_1_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_dock_post_1_20.userData.sculptComponent = {"id": "dock-post-1", "name": "Dock Post 1", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "dock-pier", "attachment": {"parentSocket": "dock-pier-surface", "localStart": [-1.5, -0.3, -0.6], "localEnd": [-1.5, -0.26, -0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.24, "height": 1.2, "depth": 0.24, "units": "relative", "confidence": 0.84}, "transform": {"position": [-1.5, -0.3, -0.6], "rotation": [0, 0, 0], "scale": [0.24, 1.2, 0.24]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_post_1_20.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}};
  (nodes["dock-pier"] ?? root).add(node_dock_post_1_20);
  nodes["dock-post-1"] = node_dock_post_1_20;
  const mesh_dock_post_1_20Geometry = endpoint_dock_post_1_20
    ? new THREE.CylinderGeometry(endpoint_dock_post_1_20.endRadius, endpoint_dock_post_1_20.baseRadius, endpoint_dock_post_1_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_dock_post_1_20) {
    mesh_dock_post_1_20Geometry.scale(0.24, 1.2, 0.24);
  }
  const mesh_dock_post_1_20 = new THREE.Mesh(
    mesh_dock_post_1_20Geometry,
    materialMap["wood-dock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dock_post_1_20.name = "Dock Post 1";
  if (endpoint_dock_post_1_20) {
    mesh_dock_post_1_20.position.copy(endpoint_dock_post_1_20.midpoint);
    mesh_dock_post_1_20.quaternion.copy(endpoint_dock_post_1_20.quaternion);
  }
  mesh_dock_post_1_20.castShadow = options.castShadow ?? true;
  mesh_dock_post_1_20.receiveShadow = options.receiveShadow ?? true;
  mesh_dock_post_1_20.userData.sculptComponent = {"id": "dock-post-1", "name": "Dock Post 1", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "dock-pier", "attachment": {"parentSocket": "dock-pier-surface", "localStart": [-1.5, -0.3, -0.6], "localEnd": [-1.5, -0.26, -0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.24, "height": 1.2, "depth": 0.24, "units": "relative", "confidence": 0.84}, "transform": {"position": [-1.5, -0.3, -0.6], "rotation": [0, 0, 0], "scale": [0.24, 1.2, 0.24]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_post_1_20.add(mesh_dock_post_1_20);
  meshes["dock-post-1"] = mesh_dock_post_1_20;
  colliders["dock-post-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["dock-post-1"] ??= [];
  destructionGroups["dock-post-1"].push(node_dock_post_1_20);

  const endpoint_dock_post_2_21 = makeAttachmentEndpoint(null);
  const node_dock_post_2_21 = new THREE.Group();
  node_dock_post_2_21.name = "Dock Post 2__pivot";
  node_dock_post_2_21.scale.set(1, 1, 1);
  if (endpoint_dock_post_2_21) {
    node_dock_post_2_21.position.copy(endpoint_dock_post_2_21.start);
    node_dock_post_2_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_dock_post_2_21.position.set(-1.5, -0.3, 0.6);
    node_dock_post_2_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_dock_post_2_21.userData.sculptComponent = {"id": "dock-post-2", "name": "Dock Post 2", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "dock-pier", "attachment": {"parentSocket": "dock-pier-surface", "localStart": [-1.5, -0.3, 0.6], "localEnd": [-1.5, -0.26, 0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.24, "height": 1.2, "depth": 0.24, "units": "relative", "confidence": 0.84}, "transform": {"position": [-1.5, -0.3, 0.6], "rotation": [0, 0, 0], "scale": [0.24, 1.2, 0.24]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_post_2_21.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}};
  (nodes["dock-pier"] ?? root).add(node_dock_post_2_21);
  nodes["dock-post-2"] = node_dock_post_2_21;
  const mesh_dock_post_2_21Geometry = endpoint_dock_post_2_21
    ? new THREE.CylinderGeometry(endpoint_dock_post_2_21.endRadius, endpoint_dock_post_2_21.baseRadius, endpoint_dock_post_2_21.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_dock_post_2_21) {
    mesh_dock_post_2_21Geometry.scale(0.24, 1.2, 0.24);
  }
  const mesh_dock_post_2_21 = new THREE.Mesh(
    mesh_dock_post_2_21Geometry,
    materialMap["wood-dock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dock_post_2_21.name = "Dock Post 2";
  if (endpoint_dock_post_2_21) {
    mesh_dock_post_2_21.position.copy(endpoint_dock_post_2_21.midpoint);
    mesh_dock_post_2_21.quaternion.copy(endpoint_dock_post_2_21.quaternion);
  }
  mesh_dock_post_2_21.castShadow = options.castShadow ?? true;
  mesh_dock_post_2_21.receiveShadow = options.receiveShadow ?? true;
  mesh_dock_post_2_21.userData.sculptComponent = {"id": "dock-post-2", "name": "Dock Post 2", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "dock-pier", "attachment": {"parentSocket": "dock-pier-surface", "localStart": [-1.5, -0.3, 0.6], "localEnd": [-1.5, -0.26, 0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.24, "height": 1.2, "depth": 0.24, "units": "relative", "confidence": 0.84}, "transform": {"position": [-1.5, -0.3, 0.6], "rotation": [0, 0, 0], "scale": [0.24, 1.2, 0.24]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_post_2_21.add(mesh_dock_post_2_21);
  meshes["dock-post-2"] = mesh_dock_post_2_21;
  colliders["dock-post-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["dock-post-2"] ??= [];
  destructionGroups["dock-post-2"].push(node_dock_post_2_21);

  const endpoint_dock_post_3_22 = makeAttachmentEndpoint(null);
  const node_dock_post_3_22 = new THREE.Group();
  node_dock_post_3_22.name = "Dock Post 3__pivot";
  node_dock_post_3_22.scale.set(1, 1, 1);
  if (endpoint_dock_post_3_22) {
    node_dock_post_3_22.position.copy(endpoint_dock_post_3_22.start);
    node_dock_post_3_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_dock_post_3_22.position.set(1.5, -0.3, -0.6);
    node_dock_post_3_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_dock_post_3_22.userData.sculptComponent = {"id": "dock-post-3", "name": "Dock Post 3", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "dock-pier", "attachment": {"parentSocket": "dock-pier-surface", "localStart": [1.5, -0.3, -0.6], "localEnd": [1.5, -0.26, -0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.24, "height": 1.2, "depth": 0.24, "units": "relative", "confidence": 0.84}, "transform": {"position": [1.5, -0.3, -0.6], "rotation": [0, 0, 0], "scale": [0.24, 1.2, 0.24]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_post_3_22.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}};
  (nodes["dock-pier"] ?? root).add(node_dock_post_3_22);
  nodes["dock-post-3"] = node_dock_post_3_22;
  const mesh_dock_post_3_22Geometry = endpoint_dock_post_3_22
    ? new THREE.CylinderGeometry(endpoint_dock_post_3_22.endRadius, endpoint_dock_post_3_22.baseRadius, endpoint_dock_post_3_22.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_dock_post_3_22) {
    mesh_dock_post_3_22Geometry.scale(0.24, 1.2, 0.24);
  }
  const mesh_dock_post_3_22 = new THREE.Mesh(
    mesh_dock_post_3_22Geometry,
    materialMap["wood-dock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dock_post_3_22.name = "Dock Post 3";
  if (endpoint_dock_post_3_22) {
    mesh_dock_post_3_22.position.copy(endpoint_dock_post_3_22.midpoint);
    mesh_dock_post_3_22.quaternion.copy(endpoint_dock_post_3_22.quaternion);
  }
  mesh_dock_post_3_22.castShadow = options.castShadow ?? true;
  mesh_dock_post_3_22.receiveShadow = options.receiveShadow ?? true;
  mesh_dock_post_3_22.userData.sculptComponent = {"id": "dock-post-3", "name": "Dock Post 3", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "dock-pier", "attachment": {"parentSocket": "dock-pier-surface", "localStart": [1.5, -0.3, -0.6], "localEnd": [1.5, -0.26, -0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.24, "height": 1.2, "depth": 0.24, "units": "relative", "confidence": 0.84}, "transform": {"position": [1.5, -0.3, -0.6], "rotation": [0, 0, 0], "scale": [0.24, 1.2, 0.24]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_post_3_22.add(mesh_dock_post_3_22);
  meshes["dock-post-3"] = mesh_dock_post_3_22;
  colliders["dock-post-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["dock-post-3"] ??= [];
  destructionGroups["dock-post-3"].push(node_dock_post_3_22);

  const endpoint_dock_post_4_23 = makeAttachmentEndpoint(null);
  const node_dock_post_4_23 = new THREE.Group();
  node_dock_post_4_23.name = "Dock Post 4__pivot";
  node_dock_post_4_23.scale.set(1, 1, 1);
  if (endpoint_dock_post_4_23) {
    node_dock_post_4_23.position.copy(endpoint_dock_post_4_23.start);
    node_dock_post_4_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_dock_post_4_23.position.set(1.5, -0.3, 0.6);
    node_dock_post_4_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_dock_post_4_23.userData.sculptComponent = {"id": "dock-post-4", "name": "Dock Post 4", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "dock-pier", "attachment": {"parentSocket": "dock-pier-surface", "localStart": [1.5, -0.3, 0.6], "localEnd": [1.5, -0.26, 0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.24, "height": 1.2, "depth": 0.24, "units": "relative", "confidence": 0.84}, "transform": {"position": [1.5, -0.3, 0.6], "rotation": [0, 0, 0], "scale": [0.24, 1.2, 0.24]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_post_4_23.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}};
  (nodes["dock-pier"] ?? root).add(node_dock_post_4_23);
  nodes["dock-post-4"] = node_dock_post_4_23;
  const mesh_dock_post_4_23Geometry = endpoint_dock_post_4_23
    ? new THREE.CylinderGeometry(endpoint_dock_post_4_23.endRadius, endpoint_dock_post_4_23.baseRadius, endpoint_dock_post_4_23.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_dock_post_4_23) {
    mesh_dock_post_4_23Geometry.scale(0.24, 1.2, 0.24);
  }
  const mesh_dock_post_4_23 = new THREE.Mesh(
    mesh_dock_post_4_23Geometry,
    materialMap["wood-dock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dock_post_4_23.name = "Dock Post 4";
  if (endpoint_dock_post_4_23) {
    mesh_dock_post_4_23.position.copy(endpoint_dock_post_4_23.midpoint);
    mesh_dock_post_4_23.quaternion.copy(endpoint_dock_post_4_23.quaternion);
  }
  mesh_dock_post_4_23.castShadow = options.castShadow ?? true;
  mesh_dock_post_4_23.receiveShadow = options.receiveShadow ?? true;
  mesh_dock_post_4_23.userData.sculptComponent = {"id": "dock-post-4", "name": "Dock Post 4", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "dock-pier", "attachment": {"parentSocket": "dock-pier-surface", "localStart": [1.5, -0.3, 0.6], "localEnd": [1.5, -0.26, 0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.24, "height": 1.2, "depth": 0.24, "units": "relative", "confidence": 0.84}, "transform": {"position": [1.5, -0.3, 0.6], "rotation": [0, 0, 0], "scale": [0.24, 1.2, 0.24]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dock-post-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_dock_post_4_23.add(mesh_dock_post_4_23);
  meshes["dock-post-4"] = mesh_dock_post_4_23;
  colliders["dock-post-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["dock-post-4"] ??= [];
  destructionGroups["dock-post-4"].push(node_dock_post_4_23);

  const endpoint_rowboat_hull_24 = makeAttachmentEndpoint(null);
  const node_rowboat_hull_24 = new THREE.Group();
  node_rowboat_hull_24.name = "Rowboat Hull__pivot";
  node_rowboat_hull_24.scale.set(1, 1, 1);
  if (endpoint_rowboat_hull_24) {
    node_rowboat_hull_24.position.copy(endpoint_rowboat_hull_24.start);
    node_rowboat_hull_24.rotation.set(0.0, 0.35, 0.0);
  } else {
    node_rowboat_hull_24.position.set(-4.4, 0.8, 4.9);
    node_rowboat_hull_24.rotation.set(0.0, 0.35, 0.0);
  }
  node_rowboat_hull_24.userData.sculptComponent = {"id": "rowboat-hull", "name": "Rowboat Hull", "level": "macro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.03, -0.5], [0.3, -0.42], [0.45, -0.18], [0.5, 0.22], [0.47, 0.5]], "segments": 20}}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-4.4, 0.8, 4.9], "localEnd": [-4.4, 0.84, 4.9], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.3, "height": 0.95, "depth": 1.1, "units": "relative", "confidence": 0.84}, "transform": {"position": [-4.4, 0.8, 4.9], "rotation": [0, 0.35, 0], "scale": [2.3, 0.95, 1.1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rowboat-hull", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boat-red"}}, "material": "boat-red", "materialLayers": ["boat-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "hull", "kind": "contour", "description": "Red clinker rowboat hull.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.4, "bumpAmplitude": 0.15, "normalPattern": "clinker strake lines", "displacementPattern": "strake overlap", "occlusionPattern": "strake shadow", "edgeWearPattern": "scuffed paint at rim", "notes": "clinker hull per zone-r2c0"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_rowboat_hull_24.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rowboat-hull", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boat-red"}};
  (nodes["islet-base"] ?? root).add(node_rowboat_hull_24);
  nodes["rowboat-hull"] = node_rowboat_hull_24;
  const mesh_rowboat_hull_24Geometry = endpoint_rowboat_hull_24
    ? new THREE.CylinderGeometry(endpoint_rowboat_hull_24.endRadius, endpoint_rowboat_hull_24.baseRadius, endpoint_rowboat_hull_24.length, 32, 12)
    : buildLatheGeometry({"points": [[0.03, -0.5], [0.3, -0.42], [0.45, -0.18], [0.5, 0.22], [0.47, 0.5]], "segments": 20});
  if (!endpoint_rowboat_hull_24) {
    mesh_rowboat_hull_24Geometry.scale(2.3, 0.95, 1.1);
  }
  const mesh_rowboat_hull_24 = new THREE.Mesh(
    mesh_rowboat_hull_24Geometry,
    materialMap["boat-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rowboat_hull_24.name = "Rowboat Hull";
  if (endpoint_rowboat_hull_24) {
    mesh_rowboat_hull_24.position.copy(endpoint_rowboat_hull_24.midpoint);
    mesh_rowboat_hull_24.quaternion.copy(endpoint_rowboat_hull_24.quaternion);
  }
  mesh_rowboat_hull_24.castShadow = options.castShadow ?? true;
  mesh_rowboat_hull_24.receiveShadow = options.receiveShadow ?? true;
  mesh_rowboat_hull_24.userData.sculptComponent = {"id": "rowboat-hull", "name": "Rowboat Hull", "level": "macro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "lathe", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.03, -0.5], [0.3, -0.42], [0.45, -0.18], [0.5, 0.22], [0.47, 0.5]], "segments": 20}}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-4.4, 0.8, 4.9], "localEnd": [-4.4, 0.84, 4.9], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 2.3, "height": 0.95, "depth": 1.1, "units": "relative", "confidence": 0.84}, "transform": {"position": [-4.4, 0.8, 4.9], "rotation": [0, 0.35, 0], "scale": [2.3, 0.95, 1.1]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rowboat-hull", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boat-red"}}, "material": "boat-red", "materialLayers": ["boat-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "hull", "kind": "contour", "description": "Red clinker rowboat hull.", "evidenceRefs": ["full-object"], "confidence": 0.95}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.4, "bumpAmplitude": 0.15, "normalPattern": "clinker strake lines", "displacementPattern": "strake overlap", "occlusionPattern": "strake shadow", "edgeWearPattern": "scuffed paint at rim", "notes": "clinker hull per zone-r2c0"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_rowboat_hull_24.add(mesh_rowboat_hull_24);
  meshes["rowboat-hull"] = mesh_rowboat_hull_24;
  colliders["rowboat-hull"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rowboat-hull"] ??= [];
  destructionGroups["rowboat-hull"].push(node_rowboat_hull_24);

  const attachment_barrel_1_25 = {"parentSocket": "islet-base-surface", "localStart": [3.6, 1.95, 1.7], "localEnd": [3.6, 2.75, 1.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.38, "endRadius": 0.38};
  const endpoint_barrel_1_25 = makeAttachmentEndpoint(attachment_barrel_1_25);
  const node_barrel_1_25 = new THREE.Group();
  node_barrel_1_25.name = "Barrel One__pivot";
  node_barrel_1_25.scale.set(1, 1, 1);
  if (endpoint_barrel_1_25) {
    node_barrel_1_25.position.copy(endpoint_barrel_1_25.start);
    node_barrel_1_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_barrel_1_25.position.set(3.6, 1.95, 1.7);
    node_barrel_1_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_barrel_1_25.userData.sculptComponent = {"id": "barrel-1", "name": "Barrel One", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [3.6, 1.95, 1.7], "localEnd": [3.6, 2.75, 1.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.38, "endRadius": 0.38}, "dimensions": {"width": 0.76, "height": 0.8, "depth": 0.76, "units": "relative", "confidence": 0.84}, "transform": {"position": [3.6, 1.95, 1.7], "rotation": [0, 0, 0], "scale": [0.76, 0.8, 0.76]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "barrel-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_barrel_1_25.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "barrel-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}};
  (nodes["islet-base"] ?? root).add(node_barrel_1_25);
  nodes["barrel-1"] = node_barrel_1_25;
  const mesh_barrel_1_25Geometry = endpoint_barrel_1_25
    ? new THREE.CylinderGeometry(endpoint_barrel_1_25.endRadius, endpoint_barrel_1_25.baseRadius, endpoint_barrel_1_25.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_barrel_1_25) {
    mesh_barrel_1_25Geometry.scale(0.76, 0.8, 0.76);
  }
  const mesh_barrel_1_25 = new THREE.Mesh(
    mesh_barrel_1_25Geometry,
    materialMap["wood-dock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_barrel_1_25.name = "Barrel One";
  if (endpoint_barrel_1_25) {
    mesh_barrel_1_25.position.copy(endpoint_barrel_1_25.midpoint);
    mesh_barrel_1_25.quaternion.copy(endpoint_barrel_1_25.quaternion);
  }
  mesh_barrel_1_25.castShadow = options.castShadow ?? true;
  mesh_barrel_1_25.receiveShadow = options.receiveShadow ?? true;
  mesh_barrel_1_25.userData.sculptComponent = {"id": "barrel-1", "name": "Barrel One", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [3.6, 1.95, 1.7], "localEnd": [3.6, 2.75, 1.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.38, "endRadius": 0.38}, "dimensions": {"width": 0.76, "height": 0.8, "depth": 0.76, "units": "relative", "confidence": 0.84}, "transform": {"position": [3.6, 1.95, 1.7], "rotation": [0, 0, 0], "scale": [0.76, 0.8, 0.76]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "barrel-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_barrel_1_25.add(mesh_barrel_1_25);
  meshes["barrel-1"] = mesh_barrel_1_25;
  colliders["barrel-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["barrel-1"] ??= [];
  destructionGroups["barrel-1"].push(node_barrel_1_25);

  const attachment_barrel_2_26 = {"parentSocket": "islet-base-surface", "localStart": [3.25, 1.9, 2.35], "localEnd": [3.25, 2.62, 2.35], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.34, "endRadius": 0.34};
  const endpoint_barrel_2_26 = makeAttachmentEndpoint(attachment_barrel_2_26);
  const node_barrel_2_26 = new THREE.Group();
  node_barrel_2_26.name = "Barrel Two__pivot";
  node_barrel_2_26.scale.set(1, 1, 1);
  if (endpoint_barrel_2_26) {
    node_barrel_2_26.position.copy(endpoint_barrel_2_26.start);
    node_barrel_2_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_barrel_2_26.position.set(3.25, 1.9, 2.35);
    node_barrel_2_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_barrel_2_26.userData.sculptComponent = {"id": "barrel-2", "name": "Barrel Two", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [3.25, 1.9, 2.35], "localEnd": [3.25, 2.62, 2.35], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.34, "endRadius": 0.34}, "dimensions": {"width": 0.68, "height": 0.72, "depth": 0.68, "units": "relative", "confidence": 0.84}, "transform": {"position": [3.25, 1.9, 2.35], "rotation": [0, 0, 0], "scale": [0.68, 0.72, 0.68]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "barrel-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_barrel_2_26.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "barrel-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}};
  (nodes["islet-base"] ?? root).add(node_barrel_2_26);
  nodes["barrel-2"] = node_barrel_2_26;
  const mesh_barrel_2_26Geometry = endpoint_barrel_2_26
    ? new THREE.CylinderGeometry(endpoint_barrel_2_26.endRadius, endpoint_barrel_2_26.baseRadius, endpoint_barrel_2_26.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_barrel_2_26) {
    mesh_barrel_2_26Geometry.scale(0.68, 0.72, 0.68);
  }
  const mesh_barrel_2_26 = new THREE.Mesh(
    mesh_barrel_2_26Geometry,
    materialMap["wood-dock"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_barrel_2_26.name = "Barrel Two";
  if (endpoint_barrel_2_26) {
    mesh_barrel_2_26.position.copy(endpoint_barrel_2_26.midpoint);
    mesh_barrel_2_26.quaternion.copy(endpoint_barrel_2_26.quaternion);
  }
  mesh_barrel_2_26.castShadow = options.castShadow ?? true;
  mesh_barrel_2_26.receiveShadow = options.receiveShadow ?? true;
  mesh_barrel_2_26.userData.sculptComponent = {"id": "barrel-2", "name": "Barrel Two", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [3.25, 1.9, 2.35], "localEnd": [3.25, 2.62, 2.35], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 0.34, "endRadius": 0.34}, "dimensions": {"width": 0.68, "height": 0.72, "depth": 0.68, "units": "relative", "confidence": 0.84}, "transform": {"position": [3.25, 1.9, 2.35], "rotation": [0, 0, 0], "scale": [0.68, 0.72, 0.68]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "barrel-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "wood-dock"}}, "material": "wood-dock", "materialLayers": ["wood-dock"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_barrel_2_26.add(mesh_barrel_2_26);
  meshes["barrel-2"] = mesh_barrel_2_26;
  colliders["barrel-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["barrel-2"] ??= [];
  destructionGroups["barrel-2"].push(node_barrel_2_26);

  const endpoint_gull_left_27 = makeAttachmentEndpoint(null);
  const node_gull_left_27 = new THREE.Group();
  node_gull_left_27.name = "Gull Left__pivot";
  node_gull_left_27.scale.set(1, 1, 1);
  if (endpoint_gull_left_27) {
    node_gull_left_27.position.copy(endpoint_gull_left_27.start);
    node_gull_left_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_gull_left_27.position.set(-3.1, 3.2, 0.6);
    node_gull_left_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_gull_left_27.userData.sculptComponent = {"id": "gull-left", "name": "Gull Left", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-3.1, 3.2, 0.6], "localEnd": [-3.1, 3.24, 0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.4, "height": 0.34, "depth": 0.5, "units": "relative", "confidence": 0.84}, "transform": {"position": [-3.1, 3.2, 0.6], "rotation": [0, 0, 0], "scale": [0.4, 0.34, 0.5]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gull-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gull-white"}}, "material": "gull-white", "materialLayers": ["gull-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_gull_left_27.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gull-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gull-white"}};
  (nodes["islet-base"] ?? root).add(node_gull_left_27);
  nodes["gull-left"] = node_gull_left_27;
  const mesh_gull_left_27Geometry = endpoint_gull_left_27
    ? new THREE.CylinderGeometry(endpoint_gull_left_27.endRadius, endpoint_gull_left_27.baseRadius, endpoint_gull_left_27.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_gull_left_27) {
    mesh_gull_left_27Geometry.scale(0.4, 0.34, 0.5);
  }
  const mesh_gull_left_27 = new THREE.Mesh(
    mesh_gull_left_27Geometry,
    materialMap["gull-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_gull_left_27.name = "Gull Left";
  if (endpoint_gull_left_27) {
    mesh_gull_left_27.position.copy(endpoint_gull_left_27.midpoint);
    mesh_gull_left_27.quaternion.copy(endpoint_gull_left_27.quaternion);
  }
  mesh_gull_left_27.castShadow = options.castShadow ?? true;
  mesh_gull_left_27.receiveShadow = options.receiveShadow ?? true;
  mesh_gull_left_27.userData.sculptComponent = {"id": "gull-left", "name": "Gull Left", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [-3.1, 3.2, 0.6], "localEnd": [-3.1, 3.24, 0.6], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.4, "height": 0.34, "depth": 0.5, "units": "relative", "confidence": 0.84}, "transform": {"position": [-3.1, 3.2, 0.6], "rotation": [0, 0, 0], "scale": [0.4, 0.34, 0.5]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gull-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gull-white"}}, "material": "gull-white", "materialLayers": ["gull-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_gull_left_27.add(mesh_gull_left_27);
  meshes["gull-left"] = mesh_gull_left_27;
  colliders["gull-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["gull-left"] ??= [];
  destructionGroups["gull-left"].push(node_gull_left_27);

  const endpoint_gull_front_28 = makeAttachmentEndpoint(null);
  const node_gull_front_28 = new THREE.Group();
  node_gull_front_28.name = "Gull Front__pivot";
  node_gull_front_28.scale.set(1, 1, 1);
  if (endpoint_gull_front_28) {
    node_gull_front_28.position.copy(endpoint_gull_front_28.start);
    node_gull_front_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_gull_front_28.position.set(2.1, 2.45, 2.7);
    node_gull_front_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_gull_front_28.userData.sculptComponent = {"id": "gull-front", "name": "Gull Front", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [2.1, 2.45, 2.7], "localEnd": [2.1, 2.49, 2.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.36, "height": 0.3, "depth": 0.46, "units": "relative", "confidence": 0.84}, "transform": {"position": [2.1, 2.45, 2.7], "rotation": [0, 0, 0], "scale": [0.36, 0.3, 0.46]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gull-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gull-white"}}, "material": "gull-white", "materialLayers": ["gull-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_gull_front_28.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gull-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gull-white"}};
  (nodes["islet-base"] ?? root).add(node_gull_front_28);
  nodes["gull-front"] = node_gull_front_28;
  const mesh_gull_front_28Geometry = endpoint_gull_front_28
    ? new THREE.CylinderGeometry(endpoint_gull_front_28.endRadius, endpoint_gull_front_28.baseRadius, endpoint_gull_front_28.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_gull_front_28) {
    mesh_gull_front_28Geometry.scale(0.36, 0.3, 0.46);
  }
  const mesh_gull_front_28 = new THREE.Mesh(
    mesh_gull_front_28Geometry,
    materialMap["gull-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_gull_front_28.name = "Gull Front";
  if (endpoint_gull_front_28) {
    mesh_gull_front_28.position.copy(endpoint_gull_front_28.midpoint);
    mesh_gull_front_28.quaternion.copy(endpoint_gull_front_28.quaternion);
  }
  mesh_gull_front_28.castShadow = options.castShadow ?? true;
  mesh_gull_front_28.receiveShadow = options.receiveShadow ?? true;
  mesh_gull_front_28.userData.sculptComponent = {"id": "gull-front", "name": "Gull Front", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "islet-base", "attachment": {"parentSocket": "islet-base-surface", "localStart": [2.1, 2.45, 2.7], "localEnd": [2.1, 2.49, 2.7], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.36, "height": 0.3, "depth": 0.46, "units": "relative", "confidence": 0.84}, "transform": {"position": [2.1, 2.45, 2.7], "rotation": [0, 0, 0], "scale": [0.36, 0.3, 0.46]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gull-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gull-white"}}, "material": "gull-white", "materialLayers": ["gull-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_gull_front_28.add(mesh_gull_front_28);
  meshes["gull-front"] = mesh_gull_front_28;
  colliders["gull-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["gull-front"] ??= [];
  destructionGroups["gull-front"].push(node_gull_front_28);

  const endpoint_boat_rim_29 = makeAttachmentEndpoint(null);
  const node_boat_rim_29 = new THREE.Group();
  node_boat_rim_29.name = "Boat Rim__pivot";
  node_boat_rim_29.scale.set(1, 1, 1);
  if (endpoint_boat_rim_29) {
    node_boat_rim_29.position.copy(endpoint_boat_rim_29.start);
    node_boat_rim_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boat_rim_29.position.set(0.0, 0.38, 0.0);
    node_boat_rim_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_boat_rim_29.userData.sculptComponent = {"id": "boat-rim", "name": "Boat Rim", "level": "macro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "rowboat-hull", "attachment": {"parentSocket": "rowboat-hull-surface", "localStart": [0, 0.38, 0], "localEnd": [0, 0.42, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.9, "height": 0.14, "depth": 0.8, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 0.38, 0], "rotation": [0, 0, 0], "scale": [1.9, 0.14, 0.8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rowboat-hull", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boat-red"}}, "material": "gull-white", "materialLayers": ["gull-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_boat_rim_29.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rowboat-hull", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boat-red"}};
  (nodes["rowboat-hull"] ?? root).add(node_boat_rim_29);
  nodes["boat-rim"] = node_boat_rim_29;
  const mesh_boat_rim_29Geometry = endpoint_boat_rim_29
    ? new THREE.CylinderGeometry(endpoint_boat_rim_29.endRadius, endpoint_boat_rim_29.baseRadius, endpoint_boat_rim_29.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_boat_rim_29) {
    mesh_boat_rim_29Geometry.scale(1.9, 0.14, 0.8);
  }
  const mesh_boat_rim_29 = new THREE.Mesh(
    mesh_boat_rim_29Geometry,
    materialMap["gull-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boat_rim_29.name = "Boat Rim";
  if (endpoint_boat_rim_29) {
    mesh_boat_rim_29.position.copy(endpoint_boat_rim_29.midpoint);
    mesh_boat_rim_29.quaternion.copy(endpoint_boat_rim_29.quaternion);
  }
  mesh_boat_rim_29.castShadow = options.castShadow ?? true;
  mesh_boat_rim_29.receiveShadow = options.receiveShadow ?? true;
  mesh_boat_rim_29.userData.sculptComponent = {"id": "boat-rim", "name": "Boat Rim", "level": "macro", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "rowboat-hull", "attachment": {"parentSocket": "rowboat-hull-surface", "localStart": [0, 0.38, 0], "localEnd": [0, 0.42, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.9, "height": 0.14, "depth": 0.8, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 0.38, 0], "rotation": [0, 0, 0], "scale": [1.9, 0.14, 0.8]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rowboat-hull", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boat-red"}}, "material": "gull-white", "materialLayers": ["gull-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_boat_rim_29.add(mesh_boat_rim_29);
  meshes["boat-rim"] = mesh_boat_rim_29;
  colliders["boat-rim"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rowboat-hull"] ??= [];
  destructionGroups["rowboat-hull"].push(node_boat_rim_29);

  const attachment_stripe_band_low_30 = {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 2.15, 0], "localEnd": [0, 3.05, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.185, "endRadius": 1.157};
  const endpoint_stripe_band_low_30 = makeAttachmentEndpoint(attachment_stripe_band_low_30);
  const node_stripe_band_low_30 = new THREE.Group();
  node_stripe_band_low_30.name = "Stripe Band Low__pivot";
  node_stripe_band_low_30.scale.set(1, 1, 1);
  if (endpoint_stripe_band_low_30) {
    node_stripe_band_low_30.position.copy(endpoint_stripe_band_low_30.start);
    node_stripe_band_low_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_band_low_30.position.set(0.0, 2.15, 0.0);
    node_stripe_band_low_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_band_low_30.userData.sculptComponent = {"id": "stripe-band-low", "name": "Stripe Band Low", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 2.15, 0], "localEnd": [0, 3.05, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.185, "endRadius": 1.157}, "dimensions": {"width": 2.37, "height": 0.9, "depth": 2.37, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 2.15, 0], "rotation": [0, 0, 0], "scale": [2.37, 0.9, 2.37]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "roof-red", "materialLayers": ["roof-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_stripe_band_low_30.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}};
  (nodes["lighthouse-tower"] ?? root).add(node_stripe_band_low_30);
  nodes["stripe-band-low"] = node_stripe_band_low_30;
  const mesh_stripe_band_low_30Geometry = endpoint_stripe_band_low_30
    ? new THREE.CylinderGeometry(endpoint_stripe_band_low_30.endRadius, endpoint_stripe_band_low_30.baseRadius, endpoint_stripe_band_low_30.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_stripe_band_low_30) {
    mesh_stripe_band_low_30Geometry.scale(2.37, 0.9, 2.37);
  }
  const mesh_stripe_band_low_30 = new THREE.Mesh(
    mesh_stripe_band_low_30Geometry,
    materialMap["roof-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_band_low_30.name = "Stripe Band Low";
  if (endpoint_stripe_band_low_30) {
    mesh_stripe_band_low_30.position.copy(endpoint_stripe_band_low_30.midpoint);
    mesh_stripe_band_low_30.quaternion.copy(endpoint_stripe_band_low_30.quaternion);
  }
  mesh_stripe_band_low_30.castShadow = options.castShadow ?? true;
  mesh_stripe_band_low_30.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_band_low_30.userData.sculptComponent = {"id": "stripe-band-low", "name": "Stripe Band Low", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 2.15, 0], "localEnd": [0, 3.05, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.185, "endRadius": 1.157}, "dimensions": {"width": 2.37, "height": 0.9, "depth": 2.37, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 2.15, 0], "rotation": [0, 0, 0], "scale": [2.37, 0.9, 2.37]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "roof-red", "materialLayers": ["roof-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_stripe_band_low_30.add(mesh_stripe_band_low_30);
  meshes["stripe-band-low"] = mesh_stripe_band_low_30;
  colliders["stripe-band-low"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["gallery-deck"] ??= [];
  destructionGroups["gallery-deck"].push(node_stripe_band_low_30);

  const attachment_stripe_band_high_31 = {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 3.95, 0], "localEnd": [0, 4.68, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.1, "endRadius": 1.077};
  const endpoint_stripe_band_high_31 = makeAttachmentEndpoint(attachment_stripe_band_high_31);
  const node_stripe_band_high_31 = new THREE.Group();
  node_stripe_band_high_31.name = "Stripe Band High__pivot";
  node_stripe_band_high_31.scale.set(1, 1, 1);
  if (endpoint_stripe_band_high_31) {
    node_stripe_band_high_31.position.copy(endpoint_stripe_band_high_31.start);
    node_stripe_band_high_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stripe_band_high_31.position.set(0.0, 3.95, 0.0);
    node_stripe_band_high_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_stripe_band_high_31.userData.sculptComponent = {"id": "stripe-band-high", "name": "Stripe Band High", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 3.95, 0], "localEnd": [0, 4.68, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.1, "endRadius": 1.077}, "dimensions": {"width": 2.2, "height": 0.73, "depth": 2.2, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 3.95, 0], "rotation": [0, 0, 0], "scale": [2.2, 0.73, 2.2]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "roof-red", "materialLayers": ["roof-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_stripe_band_high_31.userData.actionProfile = {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}};
  (nodes["lighthouse-tower"] ?? root).add(node_stripe_band_high_31);
  nodes["stripe-band-high"] = node_stripe_band_high_31;
  const mesh_stripe_band_high_31Geometry = endpoint_stripe_band_high_31
    ? new THREE.CylinderGeometry(endpoint_stripe_band_high_31.endRadius, endpoint_stripe_band_high_31.baseRadius, endpoint_stripe_band_high_31.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_stripe_band_high_31) {
    mesh_stripe_band_high_31Geometry.scale(2.2, 0.73, 2.2);
  }
  const mesh_stripe_band_high_31 = new THREE.Mesh(
    mesh_stripe_band_high_31Geometry,
    materialMap["roof-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stripe_band_high_31.name = "Stripe Band High";
  if (endpoint_stripe_band_high_31) {
    mesh_stripe_band_high_31.position.copy(endpoint_stripe_band_high_31.midpoint);
    mesh_stripe_band_high_31.quaternion.copy(endpoint_stripe_band_high_31.quaternion);
  }
  mesh_stripe_band_high_31.castShadow = options.castShadow ?? true;
  mesh_stripe_band_high_31.receiveShadow = options.receiveShadow ?? true;
  mesh_stripe_band_high_31.userData.sculptComponent = {"id": "stripe-band-high", "name": "Stripe Band High", "level": "meso", "role": "detail", "importance": 0.9, "confidence": 0.86, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "house-main is a separately visible architectural or garden assembly used for selection and explode behavior.", "geometryDescriptor": {"topologyIntent": "beveled procedural architectural solid", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "lighthouse-tower", "attachment": {"parentSocket": "lighthouse-tower-surface", "localStart": [0, 3.95, 0], "localEnd": [0, 4.68, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"], "baseRadius": 1.1, "endRadius": 1.077}, "dimensions": {"width": 2.2, "height": 0.73, "depth": 2.2, "units": "relative", "confidence": 0.84}, "transform": {"position": [0, 3.95, 0], "rotation": [0, 0, 0], "scale": [2.2, 0.73, 2.2]}, "actionProfile": {"animationRole": "rigid-parented", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gallery-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "rock-grey"}}, "material": "roof-red", "materialLayers": ["roof-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural", "colorMaterialRecipe": {"dominantAlbedo": "rgba(220, 201, 159, 1.0)", "secondaryAlbedo": "rgba(240, 221, 180, 1.0)", "materialClass": "stone", "materialClassConfidence": 0.9, "evidenceRef": "reference/whimsical-hearth-house.png"}};
  node_stripe_band_high_31.add(mesh_stripe_band_high_31);
  meshes["stripe-band-high"] = mesh_stripe_band_high_31;
  colliders["stripe-band-high"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["gallery-deck"] ??= [];
  destructionGroups["gallery-deck"].push(node_stripe_band_high_31);

  // repetition system: islet-curb-ring (InstancedMesh, radial, count=24, level=meso)
  {
    const parent = nodes["islet-base"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
    const mat = materialMap["rock-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.62, 0.55, 0.5];
    const axis = new THREE.Vector3(0.0, 1.0, 0.0).normalize();
    const radius = 9.2;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 24);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 24; i++) {
      const ang = ((5.0) + (i * 360) / 24) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "islet-curb-ring";
    parent.add(cluster);
  }

  // repetition system: gallery-rail-ring (InstancedMesh, radial, count=14, level=meso)
  {
    const parent = nodes["gallery-deck"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
    const mat = materialMap["rock-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.06, 0.55, 0.06];
    const axis = new THREE.Vector3(0.0, 1.0, 0.0).normalize();
    const radius = 2.85;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 14);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 14; i++) {
      const ang = ((0.0) + (i * 360) / 14) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "gallery-rail-ring";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createLighthouseCoveLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Lighthouse Cove look-dev lights";
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
  if (mode === 'grazing') key.position.set(15.08, 2.21, 8.04);
  else if (mode === 'reference') key.position.set(-9.05, 15.08, 10.05);
  else key.position.set(-8.04, 12.06, 11.06);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 80.4;
  key.shadow.camera.left = -14.07;
  key.shadow.camera.right = 14.07;
  key.shadow.camera.top = 14.07;
  key.shadow.camera.bottom = -14.07;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(8.04, 6.03, 7.04);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(1.01, 9.05, -12.06);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"type": "key light", "direction": "upper-left/front", "color": "#FFE2B8", "intensity": 2.2, "softness": 0.7}, {"type": "fill light", "direction": "upper-right/front", "color": "#C9D6E4", "intensity": 0.6, "ratioToKey": 0.28}, {"type": "environment light", "color": "#F2E6D6", "intensity": 0.55, "purpose": "warm sunset ambient"}, {"type": "render intent", "exposure": 1.0, "toneMapping": "ACESFilmic", "background": "#F4EBDE", "contact shadow": "soft oval beneath the islet and dock"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createLighthouseCoveEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameLighthouseCoveCamera(
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
export function createLighthouseCovePresentationComposer(
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

export function configureLighthouseCoveRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createLighthouseCoveInspectControls(
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
