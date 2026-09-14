import * as THREE from 'three';

/**
 * Experimental appearance pass for the measured Ocean surface.
 *
 * The measured mesh is deliberately left as the source of truth. This pass
 * adds only shading attributes and a composed shader callback; it never edits
 * positions, indices, or the authored geometry normals. The mask is made from
 * the measured vertex colour, raw measured axes (x depth, y vertical, z
 * width), and the measured front-facing normal so the blue treatment cannot
 * bleed onto the brown shell, hardware, strings, or headstock.
 */

const SHADER_MARKER = '/* ocean-finish-v1 */';
const FINISH_CACHE_KEY = 'ocean-source-flow-v2';

type CompileShader = Parameters<THREE.Material['onBeforeCompile']>[0];
type CompileRenderer = Parameters<THREE.Material['onBeforeCompile']>[1];

interface FinishUniforms {
  uOceanSource: { value: THREE.DataTexture | null };
  uOceanTime: { value: number };
  uOceanWaterEnabled: { value: number };
  uOceanPolished: { value: number };
  uOceanNormalBlend: { value: number };
  uOceanLightDirection: { value: THREE.Vector3 };
  uOceanLightColor: { value: THREE.Color };
}

interface FinishMaterialRecord {
  sourceMaterial: THREE.Material;
  material: THREE.Material;
  sourceOriginalCompile: THREE.Material['onBeforeCompile'];
  sourceOriginalCacheKeyFn: THREE.Material['customProgramCacheKey'];
  originalCacheKey: string;
  activeOriginalCompile: THREE.Material['onBeforeCompile'];
  activeOriginalCacheKeyFn: THREE.Material['customProgramCacheKey'];
  patched: boolean;
  physical: boolean;
  originalClearcoat: number | null;
  originalClearcoatRoughness: number | null;
  promoted: boolean;
}

export interface OceanFinishInspection {
  version: typeof FINISH_CACHE_KEY;
  ready: boolean;
  polished: boolean;
  waterEnabled: boolean;
  frontVertexCount: number;
  frontWeightedVertexCount: number;
  frontMaskMean: number;
  frontMaskBounds: {
    min: [number, number, number];
    max: [number, number, number];
  } | null;
  geometry: {
    positionCount: number;
    indexCount: number;
    unchanged: boolean;
    authoredNormalUnchanged: boolean;
  };
  material: {
    count: number;
    physicalCount: number;
    composedMeasuredShader: boolean;
    runtimeTextures: number;
  };
}

export interface OceanFinishHandle {
  /** Enable the moving water experiment. It is disabled for the baseline. */
  setWaterEnabled(enabled: boolean): void;
  /** Toggle the polished blue finish and its normal low-pass. */
  setPolished(enabled: boolean): void;
  /** Advance the analytic wave phase; no per-vertex work occurs here. */
  update(delta: number): void;
  /** Return bounded diagnostics for the mask and source integrity. */
  inspect(): OceanFinishInspection;
  /** Restore the source material and remove only this pass's attributes. */
  dispose(): void;
}

const activeFinishes = new WeakMap<THREE.Mesh, OceanFinishHandle>();

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function insideEllipse(y: number, z: number, centreY: number, centreZ: number, radiusY: number, radiusZ: number): boolean {
  const dy = (y - centreY) / radiusY;
  const dz = (z - centreZ) / radiusZ;
  return dy * dy + dz * dz < 1;
}

function sourceMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/**
 * The measured source is currently MeshStandardMaterial, but the requested
 * finish is a lacquer-like broad clearcoat. Promote that one source material
 * to a physical clone so the shader can use Three's native clearcoat BRDF.
 * The source object is copied through the base material fields and receives
 * explicit physical defaults because MeshPhysicalMaterial.copy expects the
 * additional physical fields to exist on its source.
 */
function promoteStandardMaterial(material: THREE.Material): { material: THREE.Material; promoted: boolean } {
  if (!(material instanceof THREE.MeshStandardMaterial) || material instanceof THREE.MeshPhysicalMaterial) {
    return { material, promoted: false };
  }

  const physical = new THREE.MeshPhysicalMaterial();
  const copySource = {
    ...material,
    anisotropy: 0,
    anisotropyRotation: 0,
    anisotropyMap: null,
    clearcoat: 0,
    clearcoatMap: null,
    clearcoatRoughness: 1,
    clearcoatRoughnessMap: null,
    clearcoatNormalMap: null,
    clearcoatNormalScale: new THREE.Vector2(1, 1),
    dispersion: 0,
    ior: 1.5,
    iridescence: 0,
    iridescenceMap: null,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 400],
    iridescenceThicknessMap: null,
    sheen: 0,
    sheenColor: new THREE.Color(0x000000),
    sheenColorMap: null,
    sheenRoughness: 1,
    sheenRoughnessMap: null,
    transmission: 0,
    transmissionMap: null,
    thickness: 0,
    thicknessMap: null,
    attenuationDistance: Infinity,
    attenuationColor: new THREE.Color(0xffffff),
    specularIntensity: 1,
    specularIntensityMap: null,
    specularColor: new THREE.Color(0xffffff),
    specularColorMap: null,
  } as unknown as THREE.MeshPhysicalMaterial;
  physical.copy(copySource);
  physical.clearcoat = 0.78;
  physical.clearcoatRoughness = 0.10;
  physical.name = material.name ? `${material.name} · polished physical` : 'Ocean polished physical';
  return { material: physical, promoted: true };
}

function shaderPrefix(): string {
  return `${SHADER_MARKER}
attribute float oceanFrontMask;
attribute vec3 oceanFinishNormal;
uniform float uOceanNormalBlend;
varying float vOceanFrontMask;
varying vec3 vOceanLocalPosition;
`;
}

function fragmentPrefix(): string {
  return `${SHADER_MARKER}
uniform sampler2D uOceanSource;
uniform float uOceanTime;
uniform float uOceanWaterEnabled;
uniform float uOceanPolished;
uniform vec3 uOceanLightDirection;
uniform vec3 uOceanLightColor;
varying float vOceanFrontMask;
varying vec3 vOceanLocalPosition;
`;
}

function injectVertexShader(shader: CompileShader): void {
  if (shader.vertexShader.includes(SHADER_MARKER)) return;
  shader.vertexShader = shaderPrefix() + shader.vertexShader;

  // Keep measuredNormal as the starting point. oceanFinishNormal is a
  // low-passed shading target and is mixed only for the blue front mask.
  const finishNormal = 'objectNormal = normalize(mix(objectNormal, oceanFinishNormal, oceanFrontMask * uOceanNormalBlend));';
  // The measured refinement callback runs before this callback and writes
  // `objectNormal = measuredNormal;` immediately after the chunk include.
  // Append after that assignment so the measured source cannot overwrite the
  // smooth target again. Keep the include fallback for an unrefined mesh.
  if (/\bobjectNormal\s*=\s*measuredNormal\s*;/.test(shader.vertexShader)) {
    shader.vertexShader = shader.vertexShader.replace(
      /(\bobjectNormal\s*=\s*measuredNormal\s*;)/,
      `$1\n${finishNormal}`,
    );
  } else {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>\n${finishNormal}`,
    );
  }
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    '#include <begin_vertex>\nvOceanFrontMask = oceanFrontMask;\nvOceanLocalPosition = transformed;',
  );
}

function injectFragmentShader(shader: CompileShader, physical: boolean): void {
  if (shader.fragmentShader.includes(SHADER_MARKER)) return;
  shader.fragmentShader = fragmentPrefix() + shader.fragmentShader;
  // Re-sample the measured colours themselves. No invented palette or foam.
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
#include <color_fragment>
float sourceFlowMask = clamp(vOceanFrontMask * uOceanWaterEnabled, 0.0, 1.0);
if (sourceFlowMask > 0.001) {
  vec2 sourceUv = vec2((vOceanLocalPosition.z + 0.20) / 0.40,
                       (vOceanLocalPosition.y + 0.50) / 0.54);
  // Small, broad waves keep the sampling field away from compression/folding.
  // The former high-amplitude harmonic stretched bright source details into bands.
  float phase = vOceanLocalPosition.y * 32.0 + sin(vOceanLocalPosition.z * 13.0) * 0.35 - uOceanTime * 1.05;
  float swell = vOceanLocalPosition.y * 17.0 + vOceanLocalPosition.z * 12.0 - uOceanTime * 0.70;
  vec2 flow = vec2(sin(swell + 0.6) * 0.003,
                   sin(phase) * 0.008 + sin(swell + 1.2) * 0.0015);
  vec3 movingSource = texture2D(uOceanSource, clamp(sourceUv + flow, vec2(0.002), vec2(0.998))).rgb;
  diffuseColor.rgb = mix(diffuseColor.rgb, movingSource, sourceFlowMask);
}
`);
  if (physical) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>',
      '#include <lights_physical_fragment>\nmaterial.clearcoat *= vOceanFrontMask * uOceanPolished;');
  }
}

/** Bake existing vertex colours into a sampling cache, never a new design.
 * Empty cells inherit their nearest source sample so a moving lookup cannot
 * pull black holes or hardware colours into the masked blue surface.
 */
function bakeSourceColours(geometry: THREE.BufferGeometry, mask: Float32Array): THREE.DataTexture {
  const size = 768;
  const positions = geometry.getAttribute('position');
  const colours = geometry.getAttribute('color');
  const sums = new Float32Array(size * size * 3);
  const weights = new Uint32Array(size * size);
  const owners = new Int32Array(size * size).fill(-1);
  const queue = new Int32Array(size * size);
  for (let i = 0; i < positions.count; i++) {
    if (mask[i] < 0.5) continue;
    const x = Math.max(0, Math.min(size - 1, Math.floor((positions.getZ(i) + 0.20) / 0.40 * size)));
    const y = Math.max(0, Math.min(size - 1, Math.floor((positions.getY(i) + 0.50) / 0.54 * size)));
    const cell = y * size + x;
    weights[cell]++;
    sums[cell * 3] += colours.getX(i);
    sums[cell * 3 + 1] += colours.getY(i);
    sums[cell * 3 + 2] += colours.getZ(i);
  }
  let head = 0, tail = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i]) { owners[i] = i; queue[tail++] = i; }
  }
  while (head < tail) {
    const cell = queue[head++];
    const x = cell % size;
    for (const next of [x > 0 ? cell - 1 : -1, x < size - 1 ? cell + 1 : -1, cell - size, cell + size]) {
      if (next < 0 || next >= owners.length || owners[next] >= 0) continue;
      owners[next] = owners[cell]; queue[tail++] = next;
    }
  }
  const pixels = new Uint8Array(size * size * 4);
  const colour = new THREE.Color();
  for (let i = 0; i < owners.length; i++) {
    const source = owners[i];
    if (source >= 0) {
      colour.setRGB(sums[source * 3] / weights[source], sums[source * 3 + 1] / weights[source], sums[source * 3 + 2] / weights[source]);
      colour.convertLinearToSRGB();
      pixels[i * 4] = Math.round(colour.r * 255);
      pixels[i * 4 + 1] = Math.round(colour.g * 255);
      pixels[i * 4 + 2] = Math.round(colour.b * 255);
    }
    pixels[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  texture.name = 'Original measured blue colour sampling cache';
  return texture;
}

function createUniforms(): FinishUniforms {
  return {
    uOceanSource: { value: null },
    uOceanTime: { value: 0 },
    uOceanWaterEnabled: { value: 0 },
    uOceanPolished: { value: 1 },
    uOceanNormalBlend: { value: 0 },
    // Screen-space studio direction keeps the highlight legible under the
    // existing RoomEnvironment while remaining independent of scene lights.
    uOceanLightDirection: { value: new THREE.Vector3(0.42, 0.74, 0.52).normalize() },
    uOceanLightColor: { value: new THREE.Color(0x8ddff5) },
  };
}

function patchMaterial(
  sourceMaterial: THREE.Material,
  material: THREE.Material,
  uniforms: FinishUniforms,
  promoted: boolean,
): FinishMaterialRecord {
  const sourceOriginalCompile = sourceMaterial.onBeforeCompile;
  const sourceOriginalCacheKeyFn = sourceMaterial.customProgramCacheKey;
  const originalCacheKey = sourceMaterial.customProgramCacheKey();
  const activeOriginalCompile = material.onBeforeCompile;
  const activeOriginalCacheKeyFn = material.customProgramCacheKey;
  const physical = material instanceof THREE.MeshPhysicalMaterial;
  let originalClearcoat: number | null = null;
  let originalClearcoatRoughness: number | null = null;

  if (physical) {
    originalClearcoat = material.clearcoat;
    originalClearcoatRoughness = material.clearcoatRoughness;
    // Enable the native physical clearcoat path. The fragment patch masks its
    // value per fragment, so the rest of the measured shell remains unchanged.
    material.clearcoat = Math.max(material.clearcoat, 0.78);
    material.clearcoatRoughness = Math.min(material.clearcoatRoughness || 1, 0.10);
  }

  material.onBeforeCompile = (shader: CompileShader, renderer: CompileRenderer) => {
    sourceOriginalCompile.call(material, shader, renderer);
    shader.uniforms.uOceanTime = uniforms.uOceanTime;
    shader.uniforms.uOceanSource = uniforms.uOceanSource;
    shader.uniforms.uOceanWaterEnabled = uniforms.uOceanWaterEnabled;
    shader.uniforms.uOceanPolished = uniforms.uOceanPolished;
    shader.uniforms.uOceanNormalBlend = uniforms.uOceanNormalBlend;
    shader.uniforms.uOceanLightDirection = uniforms.uOceanLightDirection;
    shader.uniforms.uOceanLightColor = uniforms.uOceanLightColor;
    injectVertexShader(shader);
    injectFragmentShader(shader, physical);
  };
  material.customProgramCacheKey = () => `${originalCacheKey}|${FINISH_CACHE_KEY}`;
  material.needsUpdate = true;

  return {
    sourceMaterial,
    material,
    sourceOriginalCompile,
    sourceOriginalCacheKeyFn,
    originalCacheKey,
    activeOriginalCompile,
    activeOriginalCacheKeyFn,
    patched: true,
    physical,
    originalClearcoat,
    originalClearcoatRoughness,
    promoted,
  };
}

function buildFrontMask(
  geometry: THREE.BufferGeometry,
): {
  mask: Float32Array;
  normal: Float32Array;
  frontVertexCount: number;
  frontWeightedVertexCount: number;
  frontMaskMean: number;
  frontMaskBounds: OceanFinishInspection['frontMaskBounds'];
} {
  const positions = geometry.getAttribute('position');
  if (!positions) throw new Error('Ocean finish requires a position attribute.');
  const colours = geometry.getAttribute('color');
  const authoredNormals = geometry.getAttribute('measuredNormal') ?? geometry.getAttribute('normal');
  const count = positions.count;
  const mask = new Float32Array(count);
  const normal = new Float32Array(count * 3);

  // The measured export's raw body occupies the lower half of y. Derive the
  // thresholds from the local bounds so the finish still works after the
  // viewer's object scale and rotation are applied at the parent level.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const spanZ = Math.max(maxZ - minZ, 1e-6);
  const midZ = (minZ + maxZ) * 0.5;
  const halfZ = spanZ * 0.5;

  // Build the finish from a dense spatial field instead of making each
  // vertex colour decide independently. The measured colour is a sampled
  // albedo, so a single pale texel otherwise cuts a visible hole into the
  // lacquer. A 192x160 y/z field gives the body enough resolution to keep the
  // horns and waist separate while allowing a small dilation across those
  // samples. Positions stay untouched; this is only a shading attribute.
  const fieldWidth = 192;
  const fieldHeight = 160;
  const fieldSize = fieldWidth * fieldHeight;
  const fieldSeed = new Float32Array(fieldSize);
  const blueValues = new Float32Array(count);
  const spatialValues = new Float32Array(count);
  const eligibleValues = new Float32Array(count);

  const cellIndex = (y: number, z: number): number => y * fieldWidth + z;
  const fieldY = (value: number): number => Math.min(fieldHeight - 1, Math.max(0, Math.floor(value * fieldHeight)));
  const fieldZ = (value: number): number => Math.min(fieldWidth - 1, Math.max(0, Math.floor(value * fieldWidth)));

  // The first pass classifies samples and records only strong blue body
  // samples as seeds. Warm wood is excluded globally. Hardware is excluded by
  // the measured pickup/bridge/control footprints below; dark blue samples on
  // the outer body remain eligible so they do not become outlined islands.
  for (let index = 0; index < count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const yNormalised = (y - minY) / spanY;
    const xNormalised = (x - minX) / spanX;

    const zNormalised = (z - minZ) / spanZ;
    let blue = 0;
    let warmWood = false;
    let saturation = 1;
    let maxValue = 1;
    if (colours) {
      const r = clamp01(colours.getX(index));
      const g = clamp01(colours.getY(index));
      const b = clamp01(colours.getZ(index));
      maxValue = Math.max(r, g, b);
      const minValue = Math.min(r, g, b);
      saturation = maxValue - minValue;
      const dominance = b - Math.max(r * 1.18, g * 0.92);
      const chroma = b - Math.min(r, g);
      // Linear colour attributes preserve dominance relationships. Requiring
      // both blue dominance and blue chroma rejects warm wood and metal.
      // Keep deep blue samples eligible even when their linear values are
      // close to black. The neutral hardware path below still rejects metal
      // by its low saturation, while this wider blue ramp closes dark quilt
      // islands in the body field.
      blue = smoothstep(0.002, 0.032, dominance) * smoothstep(0.006, 0.050, chroma);
      warmWood = r > g * 1.16 && r > b * 1.16;
    }

    // These normalized footprints follow the measured hardware layout: the
    // two pickup/bridge plates and the two lower controls/selector. Only
    // neutral or dark samples inside a footprint are treated as hardware, so
    // dark blue quilt at the horns and side edges still receives the field.
    const pickupBridgeFootprint = yNormalised > 0.16 && yNormalised < 0.61
      && zNormalised > 0.34 && zNormalised < 0.66;
    const controlFootprint = insideEllipse(yNormalised, zNormalised, 0.17, 0.22, 0.105, 0.13)
      || insideEllipse(yNormalised, zNormalised, 0.17, 0.78, 0.105, 0.13)
      || insideEllipse(yNormalised, zNormalised, 0.27, 0.29, 0.09, 0.13);
    const hardwareFootprint = pickupBridgeFootprint || controlFootprint;
    // A low-value blue sample is still body lacquer. Only nearly neutral
    // samples inside the measured hardware footprints are withheld; using
    // maxValue here incorrectly erased the dark-blue centre and lower body.
    const hardwareSample = hardwareFootprint && saturation < 0.075 && blue < 0.10;
    // The pickup and bridge plates have a distinct raw y/z footprint. Keep
    // these exact raised parts out even when their sampled colour is blue;
    // using the old broad footprint alone either leaked plate colour or
    // removed too much of the surrounding dark lacquer.
    const actualPickupPlate = (y > -0.180 && y < -0.115 && Math.abs(z) < 0.060 && x > 0.043)
      || (y > -0.290 && y < -0.225 && Math.abs(z) < 0.060 && x > 0.049);
    const actualBridgePlate = y > -0.355 && y < -0.300 && Math.abs(z) < 0.055 && x > 0.050;
    const actualHardware = actualPickupPlate || actualBridgePlate;
    const hardwareSuppression = actualHardware || hardwareSample ? 1 : 0;

    const bodyBand = smoothstep(0.00, 0.065, yNormalised)
      * (1 - smoothstep(0.535, 0.66, yNormalised));
    const frontDepth = smoothstep(0.38, 0.62, xNormalised);
    const measuredX = authoredNormals?.getX(index) ?? 1;
    const measuredY = authoredNormals?.getY(index) ?? 0;
    const measuredZ = authoredNormals?.getZ(index) ?? 0;
    const normalLength = Math.hypot(measuredX, measuredY, measuredZ) || 1;
    const nx = measuredX / normalLength;
    // The measured normal contains the source's corrugated shading detail;
    // keep it as a soft back-face guard instead of making it decide whether a
    // front blue sample exists at all.
    const frontFace = smoothstep(0.04, 0.34, nx);
    const spatialGate = bodyBand * frontDepth * (0.72 + 0.28 * frontFace);

    blueValues[index] = blue;
    spatialValues[index] = spatialGate;
    eligibleValues[index] = warmWood ? 0 : 1 - hardwareSuppression;
    if (!warmWood && hardwareSuppression < 0.98 && spatialGate > 0.08 && blue > 0.035) {
      const yCell = fieldY(yNormalised);
      const zCell = fieldZ((z - minZ) / spanZ);
      const seedIndex = cellIndex(yCell, zCell);
      fieldSeed[seedIndex] = Math.max(fieldSeed[seedIndex], blue);
    }
  }

  // Dilate in y/z with a max filter so isolated source holes inherit the
  // nearby body colour. Two passes are intentionally small: the field bridges
  // texture sampling gaps without crossing the waist into hardware regions.
  const dilated = new Float32Array(fieldSize);
  let sourceField = fieldSeed;
  let targetField = dilated;
  const dilateY = 3;
  const dilateZ = 4;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let y = 0; y < fieldHeight; y += 1) {
      const yMin = Math.max(0, y - dilateY);
      const yMax = Math.min(fieldHeight - 1, y + dilateY);
      for (let z = 0; z < fieldWidth; z += 1) {
        const zMin = Math.max(0, z - dilateZ);
        const zMax = Math.min(fieldWidth - 1, z + dilateZ);
        let maximum = 0;
        for (let yy = yMin; yy <= yMax; yy += 1) {
          for (let zz = zMin; zz <= zMax; zz += 1) {
            maximum = Math.max(maximum, sourceField[cellIndex(yy, zz)]);
          }
        }
        // A slight falloff keeps the dilation local where seed density is low.
        targetField[cellIndex(y, z)] = maximum * 0.94;
      }
    }
    const swap = sourceField;
    sourceField = targetField;
    targetField = swap;
  }

  // A separable three-tap blur removes the square footprint of the max filter
  // while keeping the field bounded and cheap to sample per vertex.
  const blurScratch = new Float32Array(fieldSize);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let y = 0; y < fieldHeight; y += 1) {
      for (let z = 0; z < fieldWidth; z += 1) {
        const left = sourceField[cellIndex(y, Math.max(0, z - 1))];
        const centre = sourceField[cellIndex(y, z)];
        const right = sourceField[cellIndex(y, Math.min(fieldWidth - 1, z + 1))];
        blurScratch[cellIndex(y, z)] = (left + centre * 2 + right) * 0.25;
      }
    }
    for (let y = 0; y < fieldHeight; y += 1) {
      for (let z = 0; z < fieldWidth; z += 1) {
        const below = blurScratch[cellIndex(Math.max(0, y - 1), z)];
        const centre = blurScratch[cellIndex(y, z)];
        const above = blurScratch[cellIndex(Math.min(fieldHeight - 1, y + 1), z)];
        targetField[cellIndex(y, z)] = (below + centre * 2 + above) * 0.25;
      }
    }
    const swap = sourceField;
    sourceField = targetField;
    targetField = swap;
  }

  let frontVertexCount = 0;
  let frontWeightedVertexCount = 0;
  let frontMaskSum = 0;
  const boundsMin = [Infinity, Infinity, Infinity] as [number, number, number];
  const boundsMax = [-Infinity, -Infinity, -Infinity] as [number, number, number];

  for (let index = 0; index < count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const yNormalised = (y - minY) / spanY;
    const zNormalised = (z - minZ) / spanZ;
    const yCell = yNormalised * (fieldHeight - 1);
    const zCell = zNormalised * (fieldWidth - 1);
    const y0 = Math.max(0, Math.min(fieldHeight - 1, Math.floor(yCell)));
    const z0 = Math.max(0, Math.min(fieldWidth - 1, Math.floor(zCell)));
    const y1 = Math.min(fieldHeight - 1, y0 + 1);
    const z1 = Math.min(fieldWidth - 1, z0 + 1);
    const fy = clamp01(yCell - y0);
    const fz = clamp01(zCell - z0);
    const field00 = sourceField[cellIndex(y0, z0)];
    const field01 = sourceField[cellIndex(y0, z1)];
    const field10 = sourceField[cellIndex(y1, z0)];
    const field11 = sourceField[cellIndex(y1, z1)];
    const fieldValue = (field00 * (1 - fz) + field01 * fz) * (1 - fy)
      + (field10 * (1 - fz) + field11 * fz) * fy;
    const blue = blueValues[index];
    const sourceValue = Math.max(blue, fieldValue * 0.96);
    const fieldMask = smoothstep(0.020, 0.12, sourceValue);
    // Never let a spatially filled field tint the wood or sampled hardware.
    // The source blue signal is still required at the seed, so this remains
    // fail-closed when the mesh has no colour attribute.
    const value = clamp01(spatialValues[index] * fieldMask * eligibleValues[index]);

    const measuredX = authoredNormals?.getX(index) ?? 1;
    const measuredY = authoredNormals?.getY(index) ?? 0;
    const measuredZ = authoredNormals?.getZ(index) ?? 0;
    const normalLength = Math.hypot(measuredX, measuredY, measuredZ) || 1;
    const nx = measuredX / normalLength;
    mask[index] = value;

    // Use a broad convex target only as a shading normal. The source normal is
    // normalized and gently low-passed toward it; the geometry normal remains
    // untouched for parity and silhouette checks.
    const width = clamp01(Math.abs((z - midZ) / Math.max(halfZ, 1e-6))) * (z < midZ ? -1 : 1);
    const vertical = clamp01((yNormalised - 0.28) / 0.42) * 2 - 1;
    let targetX = 1 - width * width * 0.16 - vertical * vertical * 0.05;
    // The measured front faces +x. For a convex dome x=f(y,z), the outward
    // normal is proportional to (1, -df/dy, -df/dz): with the signed local
    // coordinates below that means the y/z components point toward the
    // vertical/width centre rather than away from it.
    let targetY = vertical * 0.075;
    let targetZ = width * 0.52;
    const targetLength = Math.hypot(targetX, targetY, targetZ) || 1;
    targetX /= targetLength;
    targetY /= targetLength;
    targetZ /= targetLength;
    if (nx * targetX + (measuredY / normalLength) * targetY + (measuredZ / normalLength) * targetZ < 0) {
      targetX = -targetX;
      targetY = -targetY;
      targetZ = -targetZ;
    }
    // The source normals carry the tiny corrugated highlight pattern visible
    // in the baseline. Bias strongly toward the broad convex target so those
    // highlights become one continuous lacquer sweep without changing shape.
    const lowPass = value;
    const finishX = (nx * (1 - lowPass)) + targetX * lowPass;
    const finishY = ((measuredY / normalLength) * (1 - lowPass)) + targetY * lowPass;
    const finishZ = ((measuredZ / normalLength) * (1 - lowPass)) + targetZ * lowPass;
    const finishLength = Math.hypot(finishX, finishY, finishZ) || 1;
    normal[index * 3] = finishX / finishLength;
    normal[index * 3 + 1] = finishY / finishLength;
    normal[index * 3 + 2] = finishZ / finishLength;

    frontMaskSum += value;
    if (value >= 0.5) {
      frontVertexCount += 1;
      boundsMin[0] = Math.min(boundsMin[0], x);
      boundsMin[1] = Math.min(boundsMin[1], y);
      boundsMin[2] = Math.min(boundsMin[2], z);
      boundsMax[0] = Math.max(boundsMax[0], x);
      boundsMax[1] = Math.max(boundsMax[1], y);
      boundsMax[2] = Math.max(boundsMax[2], z);
    }
    if (value > 0.001) frontWeightedVertexCount += 1;
  }

  return {
    mask,
    normal,
    frontVertexCount,
    frontWeightedVertexCount,
    frontMaskMean: count > 0 ? frontMaskSum / count : 0,
    frontMaskBounds: frontVertexCount > 0 ? { min: boundsMin, max: boundsMax } : null,
  };
}

/**
 * Attach the smooth-front/water experiment to the measured Ocean mesh.
 *
 * Water is opt-in (`setWaterEnabled(true)`). The polished, low-passed blue
 * front is optional; the viewer defaults to original measured shading.
 * Water re-samples a cache of the original measured colours.
 */
export function createOceanFinish(mesh: THREE.Mesh): OceanFinishHandle {
  const existing = activeFinishes.get(mesh);
  if (existing) return existing;

  const geometry = mesh.geometry;
  const positionAttribute = geometry.getAttribute('position');
  const indexAttribute = geometry.getIndex();
  const authoredNormalAttribute = geometry.getAttribute('normal');
  const positionArray = positionAttribute?.array;
  const positionCount = positionAttribute?.count ?? 0;
  const indexArray = indexAttribute?.array;
  const indexCount = indexAttribute?.count ?? 0;
  if (!positionAttribute) throw new Error('Ocean finish requires a mesh position attribute.');

  const maskData = buildFrontMask(geometry);
  geometry.setAttribute('oceanFrontMask', new THREE.BufferAttribute(maskData.mask, 1));
  geometry.setAttribute('oceanFinishNormal', new THREE.BufferAttribute(maskData.normal, 3));

  const uniforms = createUniforms();
  const sourceTexture = bakeSourceColours(geometry, maskData.mask);
  uniforms.uOceanSource.value = sourceTexture;
  const originalMeshMaterial = mesh.material;
  const originalMaterials = sourceMaterials(mesh);
  const activeBySource = new Map<THREE.Material, THREE.Material>();
  const records = [...new Set(originalMaterials)].map(sourceMaterial => {
    const promoted = promoteStandardMaterial(sourceMaterial);
    // Register the uniform texture with the viewer resource/context-loss walker.
    (promoted.material as THREE.Material & { oceanSourceTexture: THREE.Texture }).oceanSourceTexture = sourceTexture;
    activeBySource.set(sourceMaterial, promoted.material);
    // Carry the measured callback from the source onto the physical clone
    // through patchMaterial's composed callback; the source stays untouched.
    return patchMaterial(sourceMaterial, promoted.material, uniforms, promoted.promoted);
  });
  const activeMaterials = originalMaterials.map(sourceMaterial => {
    const activeMaterial = activeBySource.get(sourceMaterial);
    if (!activeMaterial) throw new Error('Ocean finish material mapping failed.');
    return activeMaterial;
  });
  mesh.material = Array.isArray(originalMeshMaterial) ? activeMaterials : activeMaterials[0];
  let disposed = false;

  const handle: OceanFinishHandle = {
    setWaterEnabled(enabled: boolean): void {
      if (disposed) return;
      uniforms.uOceanWaterEnabled.value = enabled ? 1 : 0;
      // Water transports the original colour while retaining the original normals.
    },
    setPolished(enabled: boolean): void {
      if (disposed) return;
      uniforms.uOceanPolished.value = enabled ? 1 : 0;
      uniforms.uOceanNormalBlend.value = enabled ? 0.15 : 0;
    },
    update(delta: number): void {
      if (disposed || !Number.isFinite(delta)) return;
      uniforms.uOceanTime.value += Math.max(0, Math.min(delta, 0.1));
    },
    inspect(): OceanFinishInspection {
      const samePosition = geometry.getAttribute('position') === positionAttribute
        && positionAttribute.array === positionArray
        && positionAttribute.count === positionCount;
      const sameIndex = geometry.getIndex() === indexAttribute
        && geometry.getIndex()?.array === indexArray
        && (geometry.getIndex()?.count ?? 0) === indexCount;
      const sameAuthoredNormal = geometry.getAttribute('normal') === authoredNormalAttribute;
      return {
        version: FINISH_CACHE_KEY,
        ready: !disposed,
        polished: uniforms.uOceanPolished.value > 0.5,
        waterEnabled: uniforms.uOceanWaterEnabled.value > 0.5,
        frontVertexCount: maskData.frontVertexCount,
        frontWeightedVertexCount: maskData.frontWeightedVertexCount,
        frontMaskMean: maskData.frontMaskMean,
        frontMaskBounds: maskData.frontMaskBounds,
        geometry: {
          positionCount,
          indexCount,
          unchanged: samePosition && sameIndex,
          authoredNormalUnchanged: sameAuthoredNormal,
        },
        material: {
          count: records.length,
          physicalCount: records.filter(record => record.physical).length,
          composedMeasuredShader: records.every(record => record.patched),
          runtimeTextures: 1,
        },
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sourceTexture.dispose();
      geometry.deleteAttribute('oceanFrontMask');
      geometry.deleteAttribute('oceanFinishNormal');
      records.forEach(record => {
        record.material.onBeforeCompile = record.activeOriginalCompile;
        record.material.customProgramCacheKey = record.activeOriginalCacheKeyFn;
        if (record.physical && record.material instanceof THREE.MeshPhysicalMaterial) {
          record.material.clearcoat = record.originalClearcoat ?? record.material.clearcoat;
          record.material.clearcoatRoughness = record.originalClearcoatRoughness ?? record.material.clearcoatRoughness;
        }
        record.material.needsUpdate = true;
        if (record.promoted) record.material.dispose();
      });
      mesh.material = originalMeshMaterial;
      activeFinishes.delete(mesh);
    },
  };

  activeFinishes.set(mesh, handle);
  return handle;
}
