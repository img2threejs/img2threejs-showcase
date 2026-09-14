import * as THREE from 'three';

/**
 * Small, deterministic surface maps for the instrument factories.
 *
 * These maps deliberately stay in code and are generated per material instance
 * so the showcase keeps its procedural-only boundary.  The same height field
 * drives the normal map and roughness variation; this avoids the common failure
 * mode where metadata says "wood grain" while the renderer only receives a
 * flat colour.  The maps are intentionally subtle at the wide camera and
 * become readable in the close instrument views.
 */

export type ProceduralSurfaceKind =
  | 'lacquer'
  | 'red-lacquer'
  | 'wood'
  | 'wood-dark'
  | 'rosewood'
  | 'ebonized'
  | 'ivory'
  | 'felt'
  | 'metal'
  | 'chrome'
  | 'chrome-dark'
  | 'brass'
  | 'brass-dark'
  | 'drum-head'
  | 'rubber'
  | 'rubber-edge'
  | 'binding'
  | 'pickup'
  | 'pick'
  | 'amber'
  | 'cavity';

export interface ProceduralMaterialOptions {
  readonly materialId: string;
  readonly kind: ProceduralSurfaceKind;
  readonly color: THREE.ColorRepresentation;
  readonly roughness: number;
  readonly metalness: number;
  readonly seed?: number;
  readonly mapRepeat?: readonly [number, number];
  readonly normalStrength?: number;
  readonly options?: Omit<
    THREE.MeshPhysicalMaterialParameters,
    'color' | 'roughness' | 'metalness' | 'map' | 'roughnessMap' | 'normalMap'
  >;
}

export interface ProceduralStandardMaterialOptions {
  readonly materialId: string;
  readonly kind: ProceduralSurfaceKind;
  readonly color: THREE.ColorRepresentation;
  readonly roughness: number;
  readonly metalness: number;
  readonly seed?: number;
  readonly mapRepeat?: readonly [number, number];
  readonly normalStrength?: number;
  readonly options?: Omit<
    THREE.MeshStandardMaterialParameters,
    'color' | 'roughness' | 'metalness' | 'map' | 'roughnessMap' | 'normalMap'
  >;
}

interface SurfaceMaps {
  readonly map: THREE.DataTexture;
  readonly roughnessMap: THREE.DataTexture;
  readonly normalMap: THREE.DataTexture;
}

const MAP_SIZE = 128;
const TAU = Math.PI * 2;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function hash2(x: number, y: number, seed: number): number {
  let value = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ Math.imul(seed | 0, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  let weight = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise(x * frequency, y * frequency, seed + octave * 101) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / weight;
}

function rgbBytes(color: THREE.ColorRepresentation): [number, number, number] {
  const parsed = new THREE.Color(color).getHex();
  return [(parsed >>> 16) & 255, (parsed >>> 8) & 255, parsed & 255];
}

function setTextureDefaults(texture: THREE.DataTexture, repeat: readonly [number, number], color: boolean): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
}

function surfaceHeight(kind: ProceduralSurfaceKind, u: number, v: number, seed: number): number {
  const warp = fbm(u * 4.5 + 4, v * 4.5 - 2, seed + 13, 3) - 0.5;
  switch (kind) {
    case 'wood':
    case 'wood-dark':
    case 'rosewood':
    case 'red-lacquer': {
      const grain = Math.sin((u * 19 + warp * 2.8 + v * 0.8) * TAU);
      const pores = fbm(u * 38 + 1, v * 12 + 3, seed + 41, 3) - 0.5;
      return 0.5 + grain * 0.18 + pores * 0.14;
    }
    case 'brass':
    case 'brass-dark': {
      const lathe = Math.sin((v * 42 + warp * 2.2) * TAU);
      const radial = Math.sin((u * 7 + warp) * TAU);
      return 0.5 + lathe * 0.14 + radial * 0.04;
    }
    case 'chrome':
    case 'chrome-dark':
    case 'metal': {
      const brushed = Math.sin((u * 96 + warp * 6) * TAU) * 0.06;
      return 0.5 + brushed + (fbm(u * 45, v * 45, seed + 71, 2) - 0.5) * 0.12;
    }
    case 'drum-head': {
      const weave = Math.sin((u * 58 + v * 3) * TAU) * 0.035 + Math.sin((v * 44 + u * 2) * TAU) * 0.025;
      return 0.5 + weave + (fbm(u * 28, v * 28, seed + 83, 2) - 0.5) * 0.10;
    }
    case 'felt': {
      return 0.5 + (fbm(u * 70, v * 70, seed + 89, 2) - 0.5) * 0.30;
    }
    case 'ivory':
    case 'ebonized':
    case 'lacquer':
    case 'binding':
    case 'pickup':
    case 'pick':
    case 'amber':
    case 'rubber':
    case 'rubber-edge':
    case 'cavity':
      return 0.5 + (fbm(u * 52, v * 52, seed + 97, 2) - 0.5) * 0.11;
  }
}

function surfaceColor(
  kind: ProceduralSurfaceKind,
  base: [number, number, number],
  u: number,
  v: number,
  seed: number,
): [number, number, number] {
  const height = surfaceHeight(kind, u, v, seed);
  const micro = fbm(u * 56, v * 56, seed + 109, 2) - 0.5;
  switch (kind) {
    case 'wood':
    case 'wood-dark':
    case 'rosewood':
    case 'red-lacquer': {
      const grain = 0.5 + 0.5 * Math.sin((u * 19 + (height - 0.5) * 2.6 + v * 0.8) * TAU);
      const warm = kind === 'red-lacquer' ? [1.12, 0.72, 0.78] : [1.0, 0.84, 0.68];
      const darkening = kind === 'wood-dark' || kind === 'rosewood' ? 0.76 : 0.9;
      const factor = darkening + grain * 0.22 + micro * 0.07;
      return [
        clamp01((base[0] / 255) * factor * warm[0]) * 255,
        clamp01((base[1] / 255) * factor * warm[1]) * 255,
        clamp01((base[2] / 255) * factor * warm[2]) * 255,
      ];
    }
    case 'lacquer': {
      const film = 0.96 + micro * 0.05 + (fbm(u * 8, v * 8, seed + 127, 3) - 0.5) * 0.035;
      return [base[0] * film, base[1] * film * 1.01, base[2] * film * 1.04];
    }
    case 'ivory': {
      const warm = 0.97 + Math.sin((v * 16 + micro) * TAU) * 0.018 + micro * 0.035;
      return [base[0] * warm, base[1] * (warm * 0.98), base[2] * (warm * 0.90)];
    }
    case 'ebonized':
    case 'pickup':
    case 'pick':
    case 'cavity': {
      const value = 0.95 + micro * 0.06;
      return [base[0] * value, base[1] * value, base[2] * value];
    }
    case 'brass':
    case 'brass-dark': {
      const lathe = 0.5 + 0.5 * Math.sin((v * 42 + (height - 0.5) * 2.0) * TAU);
      const factor = (kind === 'brass-dark' ? 0.80 : 0.92) + lathe * 0.16 + micro * 0.045;
      return [base[0] * factor * 1.08, base[1] * factor * 0.96, base[2] * factor * 0.72];
    }
    case 'chrome':
    case 'chrome-dark':
    case 'metal': {
      const factor = (kind === 'chrome-dark' ? 0.84 : 0.95) + micro * 0.035;
      return [base[0] * factor, base[1] * factor, base[2] * factor];
    }
    case 'drum-head': {
      const stain = fbm(u * 6, v * 6, seed + 137, 3) - 0.5;
      const factor = 0.98 + stain * 0.06 + micro * 0.03;
      return [base[0] * factor, base[1] * factor, base[2] * factor * 0.97];
    }
    case 'felt': {
      const factor = 0.86 + micro * 0.18;
      return [base[0] * factor, base[1] * factor, base[2] * factor];
    }
    case 'rubber':
    case 'rubber-edge': {
      const factor = (kind === 'rubber-edge' ? 1.0 : 0.86) + micro * 0.12;
      return [base[0] * factor, base[1] * factor, base[2] * factor];
    }
    case 'binding': {
      const factor = 0.96 + micro * 0.05;
      return [base[0] * factor, base[1] * factor, base[2] * factor * 0.94];
    }
    case 'amber': {
      const rings = 0.93 + 0.10 * (0.5 + 0.5 * Math.sin((u * 11 + v * 3) * TAU)) + micro * 0.03;
      return [base[0] * rings, base[1] * rings, base[2] * rings * 0.62];
    }
  }
}

function roughnessFor(kind: ProceduralSurfaceKind, u: number, v: number, seed: number): number {
  const n = fbm(u * 22, v * 22, seed + 149, 3) - 0.5;
  switch (kind) {
    case 'lacquer':
    case 'red-lacquer':
      return clamp01(0.13 + n * 0.045);
    case 'wood':
      return clamp01(0.31 + n * 0.12);
    case 'wood-dark':
    case 'rosewood':
      return clamp01(0.39 + n * 0.13);
    case 'brass':
      return clamp01(0.20 + n * 0.12);
    case 'brass-dark':
      return clamp01(0.29 + n * 0.11);
    case 'chrome':
      return clamp01(0.15 + n * 0.055);
    case 'chrome-dark':
    case 'metal':
      return clamp01(0.22 + n * 0.09);
    case 'drum-head':
      return clamp01(0.50 + n * 0.12);
    case 'felt':
      return clamp01(0.82 + n * 0.09);
    case 'ivory':
      return clamp01(0.28 + n * 0.10);
    case 'ebonized':
      return clamp01(0.24 + n * 0.08);
    case 'rubber':
    case 'rubber-edge':
      return clamp01(0.76 + n * 0.10);
    case 'binding':
      return clamp01(0.26 + n * 0.07);
    case 'pickup':
      return clamp01(0.34 + n * 0.08);
    case 'pick':
      return clamp01(0.36 + n * 0.10);
    case 'amber':
      return clamp01(0.23 + n * 0.08);
    case 'cavity':
      return clamp01(0.68 + n * 0.08);
  }
}

function createSurfaceMaps(
  kind: ProceduralSurfaceKind,
  color: THREE.ColorRepresentation,
  seed: number,
  baseRoughness: number,
  repeat: readonly [number, number],
): SurfaceMaps {
  const albedo = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
  const roughness = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
  const normal = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
  const base = rgbBytes(color);
  const height = new Float32Array(MAP_SIZE * MAP_SIZE);
  for (let y = 0; y < MAP_SIZE; y += 1) {
    const v = y / (MAP_SIZE - 1);
    for (let x = 0; x < MAP_SIZE; x += 1) {
      const u = x / (MAP_SIZE - 1);
      const index = y * MAP_SIZE + x;
      const rgba = index * 4;
      const rgb = surfaceColor(kind, base, u, v, seed);
      height[index] = surfaceHeight(kind, u, v, seed);
      albedo[rgba] = Math.round(clamp01(rgb[0] / 255) * 255);
      albedo[rgba + 1] = Math.round(clamp01(rgb[1] / 255) * 255);
      albedo[rgba + 2] = Math.round(clamp01(rgb[2] / 255) * 255);
      albedo[rgba + 3] = 255;
      // MeshStandard/Physical multiply roughnessFactor by roughnessMap. Store
      // a relative multiplier here so callers retain their calibrated base
      // roughness while still receiving deterministic breakup.
      const rough = Math.round(
        clamp01(roughnessFor(kind, u, v, seed) / Math.max(0.08, baseRoughness)) * 255,
      );
      roughness[rgba] = rough;
      roughness[rgba + 1] = rough;
      roughness[rgba + 2] = rough;
      roughness[rgba + 3] = 255;
    }
  }
  for (let y = 0; y < MAP_SIZE; y += 1) {
    for (let x = 0; x < MAP_SIZE; x += 1) {
      const index = y * MAP_SIZE + x;
      const rgba = index * 4;
      const left = height[y * MAP_SIZE + ((x + MAP_SIZE - 1) % MAP_SIZE)] ?? 0.5;
      const right = height[y * MAP_SIZE + ((x + 1) % MAP_SIZE)] ?? 0.5;
      const down = height[((y + MAP_SIZE - 1) % MAP_SIZE) * MAP_SIZE + x] ?? 0.5;
      const up = height[((y + 1) % MAP_SIZE) * MAP_SIZE + x] ?? 0.5;
      // Keep the texture's tangent-space encoding neutral. The material's
      // normalScale applies the artist-facing strength exactly once.
      const dx = (right - left) * 1.2 * 255;
      const dy = (up - down) * 1.2 * 255;
      normal[rgba] = Math.round(clamp01(0.5 - dx / 255) * 255);
      normal[rgba + 1] = Math.round(clamp01(0.5 - dy / 255) * 255);
      normal[rgba + 2] = 255;
      normal[rgba + 3] = 255;
    }
  }
  const map = new THREE.DataTexture(albedo, MAP_SIZE, MAP_SIZE, THREE.RGBAFormat);
  const roughnessMap = new THREE.DataTexture(roughness, MAP_SIZE, MAP_SIZE, THREE.RGBAFormat);
  const normalMap = new THREE.DataTexture(normal, MAP_SIZE, MAP_SIZE, THREE.RGBAFormat);
  setTextureDefaults(map, repeat, true);
  setTextureDefaults(roughnessMap, repeat, false);
  setTextureDefaults(normalMap, repeat, false);
  return { map, roughnessMap, normalMap };
}

function attachProfile(
  material: THREE.Material,
  options: {
    readonly materialId: string;
    readonly kind: ProceduralSurfaceKind;
    readonly seed: number;
    readonly repeat: readonly [number, number];
    readonly baseColor: THREE.ColorRepresentation;
    readonly baseRoughness: number;
  },
  maps: SurfaceMaps,
): void {
  material.userData.materialId = options.materialId;
  material.userData.referenceDerived = 'reference-informed-procedural-approximation';
  material.userData.baseColor = options.baseColor;
  material.userData.baseRoughness = options.baseRoughness;
  material.userData.proceduralSource = {
    generator: 'deterministic-surface-v2',
    kind: options.kind,
    seed: options.seed,
    resolution: MAP_SIZE,
    repeat: [...options.repeat],
  };
  material.userData.proceduralChannels = {
    albedo: 'DataTexture',
    roughness: 'DataTexture',
    height: 'height-field-derived-normal',
    normal: 'DataTexture',
    ambientOcclusion: 'renderer-contact-and-cavity-lighting',
  };
  material.userData.textureUUIDs = {
    albedo: maps.map.uuid,
    roughness: maps.roughnessMap.uuid,
    normal: maps.normalMap.uuid,
  };
}

export function createProceduralPhysicalMaterial(
  options: ProceduralMaterialOptions,
): THREE.MeshPhysicalMaterial {
  const seed = options.seed ?? 1;
  const repeat = options.mapRepeat ?? [1, 1];
  const normalStrength = options.normalStrength ?? 0.55;
  const maps = createSurfaceMaps(options.kind, options.color, seed, options.roughness, repeat);
  const material = new THREE.MeshPhysicalMaterial({
    // The albedo map already contains the calibrated base colour. Keeping the
    // material tint white prevents a second linear colour multiplication.
    color: '#ffffff',
    roughness: options.roughness,
    metalness: options.metalness,
    map: maps.map,
    roughnessMap: maps.roughnessMap,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(normalStrength, normalStrength),
    ...options.options,
  });
  attachProfile(material, {
    materialId: options.materialId,
    kind: options.kind,
    seed,
    repeat,
    baseColor: options.color,
    baseRoughness: options.roughness,
  }, maps);
  return material;
}

export function createProceduralStandardMaterial(
  options: ProceduralStandardMaterialOptions,
): THREE.MeshStandardMaterial {
  const seed = options.seed ?? 1;
  const repeat = options.mapRepeat ?? [1, 1];
  const normalStrength = options.normalStrength ?? 0.55;
  const maps = createSurfaceMaps(options.kind, options.color, seed, options.roughness, repeat);
  const material = new THREE.MeshStandardMaterial({
    // See the physical-material factory above: map pixels own the albedo.
    color: '#ffffff',
    roughness: options.roughness,
    metalness: options.metalness,
    map: maps.map,
    roughnessMap: maps.roughnessMap,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(normalStrength, normalStrength),
    ...options.options,
  });
  attachProfile(material, {
    materialId: options.materialId,
    kind: options.kind,
    seed,
    repeat,
    baseColor: options.color,
    baseRoughness: options.roughness,
  }, maps);
  return material;
}
