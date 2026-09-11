import * as THREE from 'three';
import {
  IPHONE_DUO_FINISHES,
  IPHONE_DUO_FINISH_PALETTES,
  createFinishWeights,
  isIphoneDuoFinish,
  normalizeFinishWeights,
  type IphoneDuoFinish,
  type IphoneDuoFinishPalette,
  type IphoneDuoFinishWeights,
} from './palette';
import { loadEncodedIphoneDuoSource } from './loadEncodedSource';

export type { IphoneDuoFinish, IphoneDuoFinishWeights } from './palette';

export type IphoneDuoScreen = 'desert' | 'architecture';

export function isIphoneDuoScreen(value: string | undefined): value is IphoneDuoScreen {
  return value === 'desert' || value === 'architecture';
}

type DuoParts = Record<string, THREE.Object3D>;

const EMBEDDED_SOURCE_PROVENANCE = 'embedded://iphone-duo/source';
const COVER_SHARP_URL = '/iphone-duo/animation/cover-sharp.png';
const COVER_RELEASE_URL = '/iphone-duo/animation/cover-release.png';
const INNER_RELEASE_URL = '/iphone-duo/animation/inner-release.png';
const ARCHITECTURE_COVER_URL = '/iphone-duo/animation/architecture-cover.png';
const ARCHITECTURE_INNER_URL = '/iphone-duo/animation/architecture-inner.png';
const GHOST_NAME = 'lJPfQMFXvvcmdtA';
const HINGE_PARENT_NAME = 'AKVZtTmuRolfwyf';
const STATIONARY_LEAF_NAME = 'SiftyleUEEZwLhF';
const MOVING_LEAF_NAME = 'upTUAKvMVkPOMKq';
const INNER_SURFACE_GROUP_NAME = 'JMNlJLaRJqsIYOv';
const CENTER_STRIP_NAME = 'MvKPXGSdYDVvSpk';
const CENTER_OCCLUDER_NAME = 'xdyyaajWsatVNxN';
const NATIVE_COVER_SCREEN_NAME = 'hhgAIoCGsHXeDPY';
const NATIVE_COVER_SCREEN_MATERIAL = 'bVtHVUZGvQeXwdh';
const NATIVE_FOLDED_DISPLAY_MATERIAL = 'UBwioVSWewZpuRX';

// The supplied Apple source contains the complete rear-camera stack, but its glTF export carries
// a few preview-surface values that wash out the camera plate and flash under the runtime's ACES
// room lighting. Keep the source geometry and node ownership intact, and translate only these
// camera materials at load time so the native stack reads like the supplied rear reference crop.
const REAR_CAMERA_MATERIAL_NODES = {
  capsule: ['XziVXUmXQoAudpp'],
  lensRim: ['gCGRiYiWIxXRhXE', 'SxeyDDoPvaCZQxB'],
  lensInnerRing: ['zKTkIrxcXzWwBYK', 'TjnQASEQBIHreGe'],
  lensCavity: ['PkkUoNvpaBExwuc', 'iUykZAiNlEUXJDD'],
  lensGlass: ['ieHYvKnnzuKBgyJ', 'pYcHgppzzKEphCf'],
  lensTransmission: ['zukXlhkizWJIDav', 'MeQNhtSdEDLOoXj'],
  microphone: ['hMQYrwNoNcNjoRj', 'itODWJLNRbBbHzD', 'FafuGBBSaHXLqhj'],
  flash: ['msUTSJTbdlDoNLs', 'zdStWfgHXiitQgl', 'ONfbMSsVikXcwwp'],
} as const;
const REAR_CAMERA_FLASH_PARENT_NAME = 'EuKPpVegcQBiQbq';
// In the converted source the circular flash sits just behind the capsule's zero-thickness
// backing plane. Register it a measured 0.065 source units toward the rear-facing camera so the
// native disk remains visible after the capsule preview material is made opaque.
const REAR_CAMERA_FLASH_DEPTH_OFFSET = 0.065;

// Measurements are in the converted source scene's metres, before presentation normalization.
// Match the final film's 568 x 399 active-pixel aspect while keeping the display inside
// the native glass's 78.845 mm leaf footprint. The registration overlap preserves the flex.
const INNER_SCREEN_WIDTH = 0.0785;
const INNER_SCREEN_HINGE_OVERLAP = 0.0008;
const INNER_SCREEN_HEIGHT = (2 * INNER_SCREEN_WIDTH + INNER_SCREEN_HINGE_OVERLAP) * 399 / 568;
const INNER_SCREEN_DEPTH = 0.00030;
// The source's four open corners fit a circle at about 8% of active height.
// Apply that contour in geometry so artwork without a baked border has the same corners.
const INNER_SCREEN_RADIUS = INNER_SCREEN_HEIGHT * 0.080;
const SCREEN_CORNER_SEGMENTS = 24;
const INNER_SCREEN_INNER_RADIUS = 0.00045;
const INNER_SCREEN_UV_EPSILON = 0.0005;
const DISPLAY_SPAN =
  (INNER_SCREEN_WIDTH + INNER_SCREEN_HINGE_OVERLAP) /
  (2 * INNER_SCREEN_WIDTH + INNER_SCREEN_HINGE_OVERLAP);
const DISPLAY_RIGHT_OFFSET = 1 - DISPLAY_SPAN;

const HINGE_AXIS = new THREE.Vector3(0, 0, 1);

interface ScreenMaterialUniforms {
  [uniform: string]: THREE.IUniform;
  uTexture: { value: THREE.Texture };
  uBlur: { value: number };
  uFinishMix: { value: number };
  uOffset: { value: number };
  uSpan: { value: number };
  uMirrorX: { value: number };
  uMirrorY: { value: number };
  uArtworkScale: { value: THREE.Vector2 };
  uBlurFine: { value: THREE.Texture };
  uBlurMedium: { value: THREE.Texture };
  uBlurWide: { value: THREE.Texture };
}

interface ScreenMaterial extends THREE.ShaderMaterial {
  uniforms: ScreenMaterialUniforms;
}

interface DisplayBlurTextures {
  fine: THREE.Texture;
  medium: THREE.Texture;
  wide: THREE.Texture;
}

interface IphoneDuoScreenTextures extends DisplayBlurTextures {
  coverSharp: THREE.Texture;
  coverBlur: THREE.Texture;
  innerSharp: THREE.Texture;
}

interface FinishMaterialValues {
  color?: THREE.Color;
  roughness?: number;
  metalness?: number;
  transmission?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  envMapIntensity?: number;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
}

interface FinishMaterialBinding {
  material: THREE.Material;
  endpoints: Record<IphoneDuoFinish, FinishMaterialValues>;
}

const FINISH_BODY_NODES = [
  'fapSTOypmavuPic',
  'MnPSgwdtGmrkVcg',
  'UPeNpLgJbcWzHun',
  'tLtsGCMtMAZfCYN',
] as const;
const FINISH_LOGO_NODES = ['tYVfzVmYBKhfUhm', 'tnxsltexVWtEjsz'] as const;
const FINISH_ENCLOSURE_NODES = [
  'jJermpgmctotTSe',
  'qyiwePzfWzVHIDO',
  'UXtkILReLwCJaov',
  'AjfIgUpXxKaENDl',
  'FcJBPLgEScWGyXd',
  'YhaSRqOjDUQrQTc',
  'tkSBzAjLTdhANqx',
  'VNIQJMrwFmXgrBf',
] as const;
const FINISH_ANCILLARY_METAL_NODES = ['bsNHOLGaZbhIluH', 'pmvwSuCeZpxeLmT'] as const;
const FINISH_ANCILLARY_INSERT_NODES = ['jnMRBCmgCrfRBeG', 'fdaipPEGAeomuPG'] as const;
const FINISH_BUTTON_NODES = ['fbvEqfwjsAMSDkr', 'ejUvJHtjfcqjSvM'] as const;
const FINISH_CENTER_STRIP_NODES = ['MvKPXGSdYDVvSpk'] as const;

const FINISH_NUMERIC_KEYS = [
  'roughness',
  'metalness',
  'transmission',
  'clearcoat',
  'clearcoatRoughness',
  'envMapIntensity',
  'emissiveIntensity',
] as const;

function readFinishValues(material: THREE.Material): FinishMaterialValues {
  const values: FinishMaterialValues = {};
  const candidate = material as unknown as Record<string, unknown>;
  if (candidate.color instanceof THREE.Color) values.color = candidate.color.clone();
  FINISH_NUMERIC_KEYS.forEach((key) => {
    const value = candidate[key];
    if (typeof value === 'number') values[key] = value;
  });
  if (candidate.emissive instanceof THREE.Color) values.emissive = candidate.emissive.clone();
  return values;
}

function makeFinishVariantValues(
  white: FinishMaterialValues,
  overrides: FinishMaterialValues,
): FinishMaterialValues {
  const variant: FinishMaterialValues = { ...white };
  if (white.color && overrides.color) variant.color = overrides.color.clone();
  FINISH_NUMERIC_KEYS.forEach((key) => {
    const override = overrides[key];
    if (typeof white[key] === 'number' && typeof override === 'number') variant[key] = override;
  });
  if (white.emissive && overrides.emissive) variant.emissive = overrides.emissive.clone();
  return variant;
}

function applyFinishValues(binding: FinishMaterialBinding, weights: IphoneDuoFinishWeights): void {
  const candidate = binding.material as unknown as Record<string, unknown>;
  const candidateColor = candidate.color;
  if (candidateColor instanceof THREE.Color) {
    candidateColor.setRGB(0, 0, 0);
    IPHONE_DUO_FINISHES.forEach((finish) => {
      const color = binding.endpoints[finish].color;
      if (!color) return;
      const weight = weights[finish];
      candidateColor.r += color.r * weight;
      candidateColor.g += color.g * weight;
      candidateColor.b += color.b * weight;
    });
  }
  FINISH_NUMERIC_KEYS.forEach((key) => {
    if (typeof candidate[key] !== 'number') return;
    candidate[key] = IPHONE_DUO_FINISHES.reduce((value, finish) => {
      const endpoint = binding.endpoints[finish][key];
      return value + (typeof endpoint === 'number' ? endpoint * weights[finish] : 0);
    }, 0);
  });
  const candidateEmissive = candidate.emissive;
  if (candidateEmissive instanceof THREE.Color) {
    candidateEmissive.setRGB(0, 0, 0);
    IPHONE_DUO_FINISHES.forEach((finish) => {
      const emissive = binding.endpoints[finish].emissive;
      if (!emissive) return;
      const weight = weights[finish];
      candidateEmissive.r += emissive.r * weight;
      candidateEmissive.g += emissive.g * weight;
      candidateEmissive.b += emissive.b * weight;
    });
  }
}

type FinishMaterialKey = keyof IphoneDuoFinishPalette['material'];

function makeFinishMaterialOverrides(
  key: FinishMaterialKey,
  shared: FinishMaterialValues = {},
  perFinish: Partial<Record<IphoneDuoFinish, FinishMaterialValues>> = {},
): Partial<Record<IphoneDuoFinish, FinishMaterialValues>> {
  const overrides: Partial<Record<IphoneDuoFinish, FinishMaterialValues>> = {};
  IPHONE_DUO_FINISHES.forEach((finish) => {
    if (finish === 'white') return;
    overrides[finish] = {
      ...shared,
      ...perFinish[finish],
      color: new THREE.Color(IPHONE_DUO_FINISH_PALETTES[finish].material[key]),
    };
  });
  return overrides;
}

function cloneFinishMaterialNodes(
  sourceRoot: THREE.Object3D,
  nodeNames: readonly string[],
  overrides: Partial<Record<IphoneDuoFinish, FinishMaterialValues>>,
  bindings: FinishMaterialBinding[],
  translatedSourceMaterials: Set<THREE.Material>,
): void {
  nodeNames.forEach((nodeName) => {
    const object = sourceRoot.getObjectByName(nodeName) as THREE.Mesh | undefined;
    if (!object?.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const cloned = materials.map((material) => {
      translatedSourceMaterials.add(material);
      const copy = material.clone();
      const white = readFinishValues(copy);
      const endpoints = {} as Record<IphoneDuoFinish, FinishMaterialValues>;
      IPHONE_DUO_FINISHES.forEach((finish) => {
        endpoints[finish] = finish === 'white'
          ? white
          : makeFinishVariantValues(white, overrides[finish] ?? {});
      });
      bindings.push({ material: copy, endpoints });
      return copy;
    });
    object.material = Array.isArray(object.material) ? cloned : cloned[0];
  });
}

interface NativeEmissiveScreenBinding {
  originalEmissiveMap: THREE.Texture | null;
  setTexture(texture: THREE.Texture | null): void;
}

function bindNativeEmissiveFinishMaterial(
  object: THREE.Object3D | undefined,
  materialName: string,
  finishUniforms: Array<{ value: number }>,
  translatedSourceMaterials: Set<THREE.Material>,
): NativeEmissiveScreenBinding[] {
  const bindings: NativeEmissiveScreenBinding[] = [];
  const mesh = object as THREE.Mesh | undefined;
  if (!mesh?.isMesh) return bindings;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let changed = false;
  const cloned = materials.map((material) => {
    if (material.name !== materialName) return material;
    const source = material as THREE.MeshPhysicalMaterial;
    if (!source.emissiveMap) return material;

    const finishUniform = { value: 0 };
    const copy = material.clone() as THREE.MeshPhysicalMaterial;
    translatedSourceMaterials.add(material);
    const originalEmissiveMap = source.emissiveMap;
    bindings.push({
      originalEmissiveMap,
      setTexture(texture) {
        copy.emissiveMap = texture;
        copy.needsUpdate = true;
      },
    });
    copy.onBeforeCompile = (shader) => {
      shader.uniforms.uFinishMix = finishUniform;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <emissivemap_pars_fragment>',
          '#include <emissivemap_pars_fragment>\nuniform float uFinishMix;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `
            #include <emissivemap_fragment>
            float nightSky = smoothstep(0.34, 0.82, vEmissiveMapUv.y);
            vec3 nightMultiplier = mix(vec3(0.17, 0.12, 0.18), vec3(0.02, 0.035, 0.065), nightSky);
            vec3 nightEmissive = totalEmissiveRadiance * nightMultiplier + vec3(0.002, 0.003, 0.006);
            totalEmissiveRadiance = mix(totalEmissiveRadiance, nightEmissive, clamp(uFinishMix, 0.0, 1.0));
          `,
        );
    };
    copy.needsUpdate = true;
    finishUniforms.push(finishUniform);
    changed = true;
    return copy;
  });
  if (changed) mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
  return bindings;
}

function collectOwnedResources(
  roots: readonly THREE.Object3D[],
  extraTextures: Iterable<THREE.Texture> = [],
  extraMaterials: Iterable<THREE.Material> = [],
): {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
  images: Set<ImageBitmap>;
} {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<ImageBitmap>();
  const registerTexture = (value: unknown): void => {
    if (!value || typeof value !== 'object' || !('isTexture' in value)) return;
    const texture = value as THREE.Texture & { image?: unknown };
    if (texture.isTexture !== true) return;
    textures.add(texture);
    const image = texture.image;
    if (image && typeof image === 'object' && 'close' in image && typeof image.close === 'function') {
      images.add(image as ImageBitmap);
    }
  };

  for (const texture of extraTextures) registerTexture(texture);
  for (const material of extraMaterials) {
    materials.add(material);
    Object.values(material as unknown as Record<string, unknown>).forEach(registerTexture);
    if (material instanceof THREE.ShaderMaterial) {
      Object.values(material.uniforms).forEach((uniform) => registerTexture(uniform.value));
    }
  }

  roots.forEach((root) => {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      geometries.add(mesh.geometry);
      const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materialList.forEach((material) => {
        materials.add(material);
        Object.values(material as unknown as Record<string, unknown>).forEach(registerTexture);
        if (material instanceof THREE.ShaderMaterial) {
          Object.values(material.uniforms).forEach((uniform) => registerTexture(uniform.value));
        }
      });
    });
  });

  return { geometries, materials, textures, images };
}

function disposeOwnedResources(
  roots: readonly THREE.Object3D[],
  extraTextures: Iterable<THREE.Texture> = [],
  extraMaterials: Iterable<THREE.Material> = [],
): void {
  const resources = collectOwnedResources(roots, extraTextures, extraMaterials);
  resources.textures.forEach((texture) => texture.dispose());
  resources.images.forEach((image) => image.close());
  resources.geometries.forEach((geometry) => geometry.dispose());
  resources.materials.forEach((material) => material.dispose());
}

function clampFold(value: number): number {
  return THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 180);
}

function clampBlur(value: number): number {
  return THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function makeRoundedPanelGeometry(width: number, height: number, outerRadius: number): THREE.BufferGeometry {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const r = Math.min(outerRadius, halfWidth, halfHeight);
  const inner = Math.min(INNER_SCREEN_INNER_RADIUS, halfWidth * 0.5, halfHeight * 0.5);
  const shape = new THREE.Shape();

  // The hinge-facing edge is nearly square; only the two outer corners receive the measured
  // phone radius. This avoids drawing a rounded black seam over the real hinge.
  shape.moveTo(-halfWidth + inner, halfHeight);
  shape.lineTo(halfWidth - r, halfHeight);
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth, halfHeight - r);
  shape.lineTo(halfWidth, -halfHeight + r);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth - r, -halfHeight);
  shape.lineTo(-halfWidth + inner, -halfHeight);
  shape.lineTo(-halfWidth, -halfHeight + inner);
  shape.lineTo(-halfWidth, halfHeight - inner);
  shape.lineTo(-halfWidth + inner, halfHeight);

  const geometry = new THREE.ShapeGeometry(shape, 12);
  geometry.computeVertexNormals();
  const positions = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  if (positions && uv) {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    for (let index = 0; index < positions.count; index += 1) {
      uv.setXY(
        index,
        THREE.MathUtils.clamp((positions.getX(index) + halfWidth) / width, 0, 1),
        THREE.MathUtils.clamp((positions.getY(index) + halfHeight) / height, 0, 1),
      );
    }
    uv.needsUpdate = true;
  }
  return geometry;
}

/** One indexed display surface, including the flexible center, so no raster edge crosses the image. */
function makeContinuousDisplayGeometry(width: number, height: number, radius: number, thickness = 0, hingeHeight = height): {
  geometry: THREE.BufferGeometry;
  update(left: THREE.Matrix4, right: THREE.Matrix4): void;
} {
  const halfSpan = width / 2;
  const bend = 0.0024;
  const columns: number[] = [];
  for (let i = 0; i <= SCREEN_CORNER_SEGMENTS; i += 1) {
    const angle = Math.PI / 2 * i / SCREEN_CORNER_SEGMENTS;
    columns.push(-halfSpan + radius * (1 - Math.cos(angle)));
  }
  if (hingeHeight > height) columns.push(-0.006, -0.0045);
  columns.push(-bend);
  for (let i = 1; i <= 24; i += 1) columns.push(-bend + 2 * bend * i / 24);
  if (hingeHeight > height) columns.push(0.0045, 0.006);
  for (let i = 0; i <= SCREEN_CORNER_SEGMENTS; i += 1) {
    const angle = Math.PI / 2 * i / SCREEN_CORNER_SEGMENTS;
    columns.push(halfSpan - radius + radius * Math.sin(angle));
  }
  const layerVertices = columns.length * 2;
  const layers = thickness > 0 ? 2 : 1;
  const positions = new Float32Array(layerVertices * layers * 3);
  const uv = new Float32Array(layerVertices * layers * 2);
  const indices: number[] = [];
  columns.forEach((x, column) => {
    const cornerX = Math.max(0, Math.abs(x) - (halfSpan - radius));
    const y = height / 2 - radius + Math.sqrt(Math.max(0, radius * radius - cornerX * cornerX))
      + (hingeHeight - height) / 2 * (1 - THREE.MathUtils.smoothstep(Math.abs(x), 0.0045, 0.006));
    for (let row = 0; row < 2; row += 1) {
      const vertex = column * 2 + row;
      uv[vertex * 2] = (x + halfSpan) / width;
      uv[vertex * 2 + 1] = (row === 0 ? -y : y) / height + 0.5;
    }
    if (column > 0) {
      const a = (column - 1) * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  });
  if (layers === 2) {
    const frontIndices = indices.slice();
    for (let i = 0; i < frontIndices.length; i += 3) {
      indices.push(frontIndices[i + 2] + layerVertices, frontIndices[i + 1] + layerVertices, frontIndices[i] + layerVertices);
    }
    const connect = (a: number, b: number): void => {
      indices.push(a, a + layerVertices, b, b, a + layerVertices, b + layerVertices);
    };
    for (let column = 1; column < columns.length; column += 1) {
      connect((column - 1) * 2, column * 2);
      connect(column * 2 + 1, (column - 1) * 2 + 1);
    }
    connect(1, 0);
    connect(layerVertices - 2, layerVertices - 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  const point = new THREE.Vector3();
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const leftDirection = new THREE.Vector3();
  const rightDirection = new THREE.Vector3();
  return {
    geometry,
    update(left, right) {
      // These matrices map the original measured leaf overlays into the common hinge frame.
      // Mirror the left Y coordinate exactly as its source texture mapping did.
      leftDirection.set(-1, 0, 0).transformDirection(left).multiplyScalar(2 * bend / 3);
      rightDirection.set(1, 0, 0).transformDirection(right).multiplyScalar(2 * bend / 3);
      const scaleLeft = new THREE.Vector3().setFromMatrixScale(left).x;
      const scaleRight = new THREE.Vector3().setFromMatrixScale(right).x;
      leftDirection.multiplyScalar(scaleLeft);
      rightDirection.multiplyScalar(scaleRight);
      columns.forEach((x, column) => {
        const cornerX = Math.max(0, Math.abs(x) - (halfSpan - radius));
        const halfY = height / 2 - radius + Math.sqrt(Math.max(0, radius * radius - cornerX * cornerX))
          + (hingeHeight - height) / 2 * (1 - THREE.MathUtils.smoothstep(Math.abs(x), 0.0045, 0.006));
        for (let layer = 0; layer < layers; layer += 1) for (let row = 0; row < 2; row += 1) {
          const y = row === 0 ? -halfY : halfY;
          const z = -layer * thickness;
          if (x <= -bend) {
            point.set(-x - INNER_SCREEN_WIDTH / 2, -y, z).applyMatrix4(left);
          } else if (x >= bend) {
            point.set(x - INNER_SCREEN_WIDTH / 2, y, z).applyMatrix4(right);
          } else {
            p0.set(bend - INNER_SCREEN_WIDTH / 2, -y, z).applyMatrix4(left);
            p3.set(bend - INNER_SCREEN_WIDTH / 2, y, z).applyMatrix4(right);
            p1.copy(p0).add(leftDirection);
            p2.copy(p3).sub(rightDirection);
            const t = (x + bend) / (2 * bend);
            const s = 1 - t;
            point.copy(p0).multiplyScalar(s * s * s)
              .addScaledVector(p1, 3 * s * s * t)
              .addScaledVector(p2, 3 * s * t * t)
              .addScaledVector(p3, t * t * t);
          }
          point.toArray(positions, (layer * layerVertices + column * 2 + row) * 3);
        }
      });
      geometry.attributes.position.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
    },
  };
}

function attachAtWorldTransform(
  object: THREE.Object3D,
  parent: THREE.Object3D,
  worldPosition: THREE.Vector3,
  worldQuaternion: THREE.Quaternion,
): void {
  parent.updateMatrixWorld(true);
  const worldMatrix = new THREE.Matrix4().compose(
    worldPosition,
    worldQuaternion,
    new THREE.Vector3(1, 1, 1),
  );
  const localMatrix = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(worldMatrix);
  localMatrix.decompose(object.position, object.quaternion, object.scale);
  parent.add(object);
}

function configureReleaseTexture(texture: THREE.Texture): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(8, texture.anisotropy || 1);
  texture.needsUpdate = true;
}

function makeRearFlashTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The rear flash canvas could not be created');

  const base = context.createRadialGradient(46, 42, 2, 64, 64, 72);
  base.addColorStop(0, '#fffdf7');
  base.addColorStop(0.25, '#eee9df');
  base.addColorStop(0.62, '#d7d0c3');
  base.addColorStop(1, '#b7aea0');
  context.fillStyle = base;
  context.fillRect(0, 0, 128, 128);

  context.save();
  context.translate(64, 64);
  context.rotate(-0.65);
  const reflection = context.createLinearGradient(-15, -50, 15, 50);
  reflection.addColorStop(0, 'rgba(255, 255, 255, 0)');
  reflection.addColorStop(0.46, 'rgba(255, 255, 255, 0)');
  reflection.addColorStop(0.56, 'rgba(255, 255, 255, 0.80)');
  reflection.addColorStop(0.63, 'rgba(255, 255, 255, 0.10)');
  reflection.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = reflection;
  context.fillRect(-20, -70, 40, 140);
  context.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 2;
  texture.needsUpdate = true;
  return texture;
}

interface RearCameraMaterialTranslation {
  role: keyof typeof REAR_CAMERA_MATERIAL_NODES | 'enclosure';
  nodes: readonly string[];
  change: string;
}

function applyRearCameraMaterialTranslation(
  sourceRoot: THREE.Object3D,
  translatedSourceMaterials?: Set<THREE.Material>,
): RearCameraMaterialTranslation[] {
  const translations: RearCameraMaterialTranslation[] = [];
  let rearFlashTexture: THREE.CanvasTexture | undefined;
  const getRearFlashTexture = (): THREE.CanvasTexture => {
    rearFlashTexture ??= makeRearFlashTexture();
    return rearFlashTexture;
  };
  const cloneMaterials = (nodeNames: readonly string[], configure: (material: THREE.Material) => void): void => {
    nodeNames.forEach((nodeName) => {
      const object = sourceRoot.getObjectByName(nodeName) as THREE.Mesh | undefined;
      if (!object?.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => translatedSourceMaterials?.add(material));
      const cloned = materials.map((material) => {
        const copy = material.clone();
        configure(copy);
        copy.needsUpdate = true;
        return copy;
      });
      object.material = Array.isArray(object.material) ? cloned : cloned[0];
    });
  };
  const setColor = (material: THREE.Material, color: string): void => {
    const withColor = material as THREE.Material & { color?: THREE.Color };
    withColor.color?.set(color);
  };
  const setPhysical = (
    material: THREE.Material,
    values: { color: string; roughness: number; metalness: number; transmission?: number; clearcoat?: number; clearcoatRoughness?: number },
  ): void => {
    setColor(material, values.color);
    const physical = material as THREE.MeshPhysicalMaterial;
    if ('roughness' in physical) physical.roughness = values.roughness;
    if ('metalness' in physical) physical.metalness = values.metalness;
    if ('transmission' in physical && values.transmission !== undefined) physical.transmission = values.transmission;
    if ('clearcoat' in physical && values.clearcoat !== undefined) physical.clearcoat = values.clearcoat;
    if ('clearcoatRoughness' in physical && values.clearcoatRoughness !== undefined) {
      physical.clearcoatRoughness = values.clearcoatRoughness;
    }
  };

  cloneMaterials(REAR_CAMERA_MATERIAL_NODES.capsule, (material) => {
    setPhysical(material, {
      color: '#fffaf2',
      roughness: 0.34,
      metalness: 0.04,
      transmission: 0,
      clearcoat: 0.08,
      clearcoatRoughness: 0.22,
    });
    const physical = material as THREE.MeshPhysicalMaterial;
    physical.emissive.set('#c4bdb2');
    physical.emissiveIntensity = 0.10;
  });
  translations.push({
    role: 'capsule',
    nodes: REAR_CAMERA_MATERIAL_NODES.capsule,
    change: 'opaque warm-white camera capsule; source transmission preview disabled so the raised plate keeps its measured silhouette and white reference tone',
  });

  cloneMaterials(REAR_CAMERA_MATERIAL_NODES.lensInnerRing, (material) => {
    setPhysical(material, {
      color: '#dedbd5',
      roughness: 0.075,
      metalness: 1,
      transmission: 0,
      clearcoat: 0,
      clearcoatRoughness: 0.075,
    });
  });
  translations.push({
    role: 'lensInnerRing',
    nodes: REAR_CAMERA_MATERIAL_NODES.lensInnerRing,
    change: 'polished metallic inner rings, metalness 1 and roughness 0.075; runtime fit, not Apple-published shader values',
  });

  cloneMaterials(REAR_CAMERA_MATERIAL_NODES.lensRim, (material) => {
    setPhysical(material, {
      color: '#dedbd5',
      roughness: 0.075,
      metalness: 1,
      transmission: 0,
      clearcoat: 0,
      clearcoatRoughness: 0.075,
    });
  });
  translations.push({
    role: 'lensRim',
    nodes: REAR_CAMERA_MATERIAL_NODES.lensRim,
    change: 'polished metallic lens rims with environment-driven reflections and no painted texture',
  });

  [...REAR_CAMERA_MATERIAL_NODES.lensRim, ...REAR_CAMERA_MATERIAL_NODES.lensInnerRing].forEach((name) => {
    const object = sourceRoot.getObjectByName(name) as THREE.Mesh | undefined;
    if (!object?.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const metal = material as THREE.MeshStandardMaterial;
      metal.map = null;
      metal.roughnessMap = null;
      metal.metalnessMap = null;
      metal.emissiveMap = null;
      metal.emissive.set(0x000000);
      metal.envMapIntensity = 1;
      metal.needsUpdate = true;
    }
  });

  // Native enclosure rails and button surrounds share the source polished-metal material.
  // Use neutral metal reflectance; the studio environment supplies all visible highlights.
  const enclosureNodes = ['jJermpgmctotTSe', 'qyiwePzfWzVHIDO', 'UXtkILReLwCJaov',
    'AjfIgUpXxKaENDl', 'FcJBPLgEScWGyXd', 'YhaSRqOjDUQrQTc',
    'tkSBzAjLTdhANqx', 'VNIQJMrwFmXgrBf'];
  cloneMaterials(enclosureNodes, (material) => {
    const metal = material as THREE.MeshPhysicalMaterial;
    metal.color.set('#c9ccd0');
    metal.metalness = 1;
    metal.roughness = 0.14;
    metal.map = null;
    metal.roughnessMap = null;
    metal.metalnessMap = null;
    metal.emissiveMap = null;
    metal.emissive.set(0);
    metal.envMapIntensity = 0.95;
    if ('transmission' in metal) metal.transmission = 0;
    if ('clearcoat' in metal) metal.clearcoat = 0;
  });
  translations.push({ role: 'enclosure', nodes: enclosureNodes,
    change: 'neutral brushed-polished metal with restrained studio reflections and no painted highlight texture' });

  cloneMaterials(REAR_CAMERA_MATERIAL_NODES.lensCavity, (material) => {
    setColor(material, '#07080c');
    const standard = material as THREE.MeshStandardMaterial;
    standard.roughness = 0.12;
    standard.metalness = 0.52;
  });
  translations.push({
    role: 'lensCavity',
    nodes: REAR_CAMERA_MATERIAL_NODES.lensCavity,
    change: 'near-black metallic lens cavity retained as the dark separation behind the optics',
  });

  cloneMaterials(REAR_CAMERA_MATERIAL_NODES.lensGlass, (material) => {
    setColor(material, '#0c1015');
    const standard = material as THREE.MeshStandardMaterial;
    standard.map = null;
    standard.roughness = 0.25;
    standard.metalness = 1;
    standard.envMapIntensity = 1.4;
    if ('emissive' in standard) {
      standard.emissive.set('#1b1a39');
      standard.emissiveIntensity = 0;
    }
  });
  translations.push({
    role: 'lensGlass',
    nodes: REAR_CAMERA_MATERIAL_NODES.lensGlass,
    change: 'dark optical surface with no painted reflection texture; lighting comes from the runtime environment',
  });

  cloneMaterials(REAR_CAMERA_MATERIAL_NODES.lensTransmission, (material) => {
    setPhysical(material, {
      color: '#20242a',
      roughness: 0.10,
      metalness: 0.05,
      transmission: 0.05,
      clearcoat: 0.45,
      clearcoatRoughness: 0.10,
    });
    const physical = material as THREE.MeshPhysicalMaterial;
    physical.opacity = 0.18;
    physical.transparent = true;
    physical.depthWrite = false;
    physical.emissive.set('#000000');
    physical.emissiveIntensity = 0;
  });
  translations.push({
    role: 'lensTransmission',
    nodes: REAR_CAMERA_MATERIAL_NODES.lensTransmission,
    change: 'source repaired transmission layers translated to a subtle dark optical tint so they read as lens glass instead of white rings',
  });

  cloneMaterials(REAR_CAMERA_MATERIAL_NODES.microphone, (material) => {
    setPhysical(material, {
      color: '#68645e',
      roughness: 0.34,
      metalness: 0.16,
      transmission: 0,
    });
  });
  translations.push({
    role: 'microphone',
    nodes: REAR_CAMERA_MATERIAL_NODES.microphone,
    change: 'small warm-gray microphone pill preserved at its source position with a neutral rear-view swatch',
  });

  // The microphone is a very small front-facing pill. A neutral basic swatch keeps its measured
  // silhouette legible from the rear inspection camera, whose room-light direction would make the
  // native physical material read almost black.
  REAR_CAMERA_MATERIAL_NODES.microphone.forEach((nodeName) => {
    const object = sourceRoot.getObjectByName(nodeName) as THREE.Mesh | undefined;
    if (!object?.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const flatMaterials = materials.map((material) => {
      const flat = new THREE.MeshBasicMaterial({
        color: '#77736e',
        side: material.side,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      flat.name = material.name;
      return flat;
    });
    object.material = Array.isArray(object.material) ? flatMaterials : flatMaterials[0];
    materials.forEach((material) => material.dispose());
    object.renderOrder = 2;
  });

  cloneMaterials(REAR_CAMERA_MATERIAL_NODES.flash, (material) => {
    setPhysical(material, {
      color: '#d6cec2',
      roughness: 0.36,
      metalness: 0.10,
      transmission: 0,
      clearcoat: 0.16,
      clearcoatRoughness: 0.24,
    });
  });
  translations.push({
    role: 'flash',
    nodes: REAR_CAMERA_MATERIAL_NODES.flash,
    change: 'opaque warm pearl flash layers retain the source circular geometry while separating it from the white capsule; a generated radial swatch adds the small reference highlight and basic shading removes source-layer grain',
  });

  // The three source flash shells overlap at near-identical depths and produce a stippled disk
  // under the orthographic back view. A flat, tone-mapped-free translation keeps the measured
  // source disk and its depth registration while removing that export-only interference pattern.
  REAR_CAMERA_MATERIAL_NODES.flash.forEach((nodeName, layerIndex) => {
    const object = sourceRoot.getObjectByName(nodeName) as THREE.Mesh | undefined;
    if (!object?.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const flatMaterials = materials.map((material) => {
      const flat = new THREE.MeshBasicMaterial({
        color: '#e5ddd2',
        map: getRearFlashTexture(),
        side: material.side,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -6 - layerIndex,
        polygonOffsetUnits: -6 - layerIndex,
      });
      flat.name = material.name;
      return flat;
    });
    object.material = Array.isArray(object.material) ? flatMaterials : flatMaterials[0];
    materials.forEach((material) => material.dispose());
    object.renderOrder = 3;
    const flashMaterials = Array.isArray(object.material) ? object.material : [object.material];
    flashMaterials.forEach((material) => {
      // The flash must be visible over its registered rear capsule, but normal depth testing
      // prevents it from leaking through the chassis when the user orbits to the front/side.
      material.depthTest = true;
      material.depthWrite = false;
    });
  });

  // Light the camera island physically, like its raised surround. Depth bias separates the
  // almost coplanar exported layers without moving the source geometry.
  REAR_CAMERA_MATERIAL_NODES.capsule.forEach((nodeName) => {
    const object = sourceRoot.getObjectByName(nodeName) as THREE.Mesh | undefined;
    if (!object?.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const flatMaterials = materials.map((material) => {
      const flat = new THREE.MeshPhysicalMaterial({
        color: '#eeeae3',
        roughness: 0.32,
        metalness: 0.08,
        clearcoat: 0.18,
        clearcoatRoughness: 0.24,
        side: material.side,
        depthTest: true,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      flat.name = material.name;
      return flat;
    });
    object.material = Array.isArray(object.material) ? flatMaterials : flatMaterials[0];
    materials.forEach((material) => material.dispose());
    object.renderOrder = 1;
  });

  // Coincident rear-coating/backing triangles caused rectangular interference around the
  // camera shoulder. Bias depth, retaining the native surface, normals and texture ownership.
  cloneMaterials(['tLtsGCMtMAZfCYN'], (material) => {
    const coating = material as THREE.MeshPhysicalMaterial;
    coating.color.set('#fffdf8');
    coating.transmission = 0.08;
    coating.metalness = 0;
    coating.roughness = 0.5;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
  });

  return translations;
}

// Pre-filter once at load so a wide blur is continuous, without sparse repeated clock samples.
function makeBlurredDisplayTexture(texture: THREE.Texture, radius: number): THREE.CanvasTexture {
  const source = texture.image as HTMLImageElement;
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The display blur canvas could not be created');
  // Extend edge pixels before filtering to avoid dark transparent borders.
  const pad = Math.ceil(radius * 3);
  const padded = document.createElement('canvas');
  padded.width = source.width + pad * 2;
  padded.height = source.height + pad * 2;
  const paddedContext = padded.getContext('2d');
  if (!paddedContext) throw new Error('The display blur padding canvas could not be created');
  paddedContext.drawImage(source, pad, pad);
  paddedContext.drawImage(source, 0, 0, 1, source.height, 0, pad, pad, source.height);
  paddedContext.drawImage(source, source.width - 1, 0, 1, source.height, pad + source.width, pad, pad, source.height);
  paddedContext.drawImage(padded, 0, pad, padded.width, 1, 0, 0, padded.width, pad);
  paddedContext.drawImage(padded, 0, pad + source.height - 1, padded.width, 1, 0, pad + source.height, padded.width, pad);
  context.filter = `blur(${radius}px)`;
  context.drawImage(padded, -pad, -pad);
  const blurred = new THREE.CanvasTexture(canvas);
  blurred.colorSpace = texture.colorSpace;
  blurred.flipY = texture.flipY;
  blurred.wrapS = THREE.ClampToEdgeWrapping;
  blurred.wrapT = THREE.ClampToEdgeWrapping;
  blurred.minFilter = THREE.LinearMipmapLinearFilter;
  blurred.magFilter = THREE.LinearFilter;
  blurred.anisotropy = Math.min(8, texture.anisotropy || 1);
  blurred.needsUpdate = true;
  return blurred;
}

function makeDisplayBlurTextures(texture: THREE.Texture): DisplayBlurTextures {
  const image = texture.image as { width?: number } | undefined;
  const blurScale = (image?.width ?? 568) / 568;
  return {
    fine: makeBlurredDisplayTexture(texture, 4 * blurScale),
    medium: makeBlurredDisplayTexture(texture, 12 * blurScale),
    wide: makeBlurredDisplayTexture(texture, 24 * blurScale),
  };
}

function innerArtworkScale(texture: THREE.Texture): THREE.Vector2 {
  const image = texture.image as { width: number; height: number };
  const imageAspect = image.width / image.height;
  const displayAspect = (2 * INNER_SCREEN_WIDTH + INNER_SCREEN_HINGE_OVERLAP) / INNER_SCREEN_HEIGHT;
  // Fill the measured display by cropping, never stretching the artwork to another aspect.
  return imageAspect < displayAspect
    ? new THREE.Vector2(1, imageAspect / displayAspect)
    : new THREE.Vector2(displayAspect / imageAspect, 1);
}

function makeInnerScreenMaterial(
  texture: THREE.Texture,
  offset: number,
  span: number,
  mirrorX: boolean,
  mirrorY: boolean,
  blur: number,
  blurTextures: DisplayBlurTextures,
): ScreenMaterial {
  const uniforms: ScreenMaterialUniforms = {
    uTexture: { value: texture },
    uBlur: { value: blur },
    uFinishMix: { value: 0 },
    uOffset: { value: offset },
    uSpan: { value: span },
    uMirrorX: { value: mirrorX ? 1 : 0 },
    uMirrorY: { value: mirrorY ? 1 : 0 },
    uArtworkScale: { value: innerArtworkScale(texture) },
    uBlurFine: { value: blurTextures.fine },
    uBlurMedium: { value: blurTextures.medium },
    uBlurWide: { value: blurTextures.wide },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTexture;
      uniform float uBlur;
      uniform float uFinishMix;
      uniform float uOffset;
      uniform float uSpan;
      uniform float uMirrorX;
      uniform float uMirrorY;
      uniform vec2 uArtworkScale;
      uniform sampler2D uBlurFine;
      uniform sampler2D uBlurMedium;
      uniform sampler2D uBlurWide;
      varying vec2 vUv;

      vec2 releaseUv() {
        float panelU = uMirrorX > 0.5 ? 1.0 - vUv.x : vUv.x;
        float u = clamp(uOffset + panelU * uSpan, ${INNER_SCREEN_UV_EPSILON.toFixed(4)}, ${(
          1 - INNER_SCREEN_UV_EPSILON
        ).toFixed(4)});
        float panelV = uMirrorY > 0.5 ? 1.0 - vUv.y : vUv.y;
        vec2 artworkUv = (vec2(u, panelV) - 0.5) * uArtworkScale + 0.5;
        return clamp(artworkUv, vec2(${INNER_SCREEN_UV_EPSILON.toFixed(4)}), vec2(${(1 - INNER_SCREEN_UV_EPSILON).toFixed(4)}));
      }

      void main() {
        vec2 uv = releaseUv();
        // Both halves sample one continuous spatial field; it reaches zero beyond the hinge.
        float radius = 24.0 * clamp(uBlur, 0.0, 1.0) * (1.0 - smoothstep(0.06, 0.57, uv.x));
        vec4 sharp = texture2D(uTexture, uv);
        vec4 fine = texture2D(uBlurFine, uv);
        vec4 medium = texture2D(uBlurMedium, uv);
        vec4 wide = texture2D(uBlurWide, uv);
        vec4 display = radius < 4.0 ? mix(sharp, fine, radius / 4.0)
          : radius < 12.0 ? mix(fine, medium, (radius - 4.0) / 8.0)
          : mix(medium, wide, (radius - 12.0) / 12.0);
        // Night keeps the supplied display artwork but shifts its sky toward navy and its lower
        // terrain toward muted plum, matching the supplied Night reference without replacing the
        // source pixels. At mix 0 this path is an exact pass-through of the White endpoint.
        float sky = smoothstep(0.34, 0.82, uv.y);
        vec3 nightMultiplier = mix(vec3(0.17, 0.12, 0.18), vec3(0.02, 0.035, 0.065), sky);
        vec3 nightDisplay = display.rgb * nightMultiplier + vec3(0.002, 0.003, 0.006);
        display.rgb = mix(display.rgb, nightDisplay, clamp(uFinishMix, 0.0, 1.0));
        gl_FragColor = display;
        #include <colorspace_fragment>
      }
    `,
    side: THREE.FrontSide,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  }) as ScreenMaterial;
  material.transparent = false;
  return material;
}

function makeReleaseScreen(
  name: string,
  texture: THREE.Texture,
  width: number,
  height: number,
  offset: number,
  span: number,
  mirrorX: boolean,
  mirrorY: boolean,
  blur: number,
  blurTextures: DisplayBlurTextures,
): THREE.Mesh<THREE.BufferGeometry, ScreenMaterial> {
  const mesh = new THREE.Mesh(
    makeRoundedPanelGeometry(width, height, INNER_SCREEN_RADIUS),
    makeInnerScreenMaterial(texture, offset, span, mirrorX, mirrorY, blur, blurTextures),
  );
  mesh.name = name;
  mesh.renderOrder = 4;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Decodes Apple's supplied source payload and adds the smallest measured runtime layer needed for
 * the release interaction. All original source meshes, UVs, materials, and transforms remain in
 * the graph. The source has no authored animation clip, so the hinge is applied deterministically
 * to the native `upTUAKvMVkPOMKq` leaf around its `AKVZtTmuRolfwyf` parent-space +Z axis. The
 * connected release display surface is a measured overlay using the supplied release pixels; the
 * blank native inner surfaces remain underneath for source ownership and silhouette fidelity.
 */
export async function createIphoneDuoModel(): Promise<THREE.Group> {
  const sourceRoot = await loadEncodedIphoneDuoSource();
  let ghost: THREE.Object3D | undefined;
  const initializedTextures = new Set<THREE.Texture>();
  const translatedSourceMaterials = new Set<THREE.Material>();
  const finishBindings: FinishMaterialBinding[] = [];
  const nativeScreenFinishUniforms: Array<{ value: number }> = [];
  let nativeCoverScreenBindings: NativeEmissiveScreenBinding[] = [];
  let nativeFoldedDisplayBindings: NativeEmissiveScreenBinding[] = [];

  try {
    const originalSourceName = sourceRoot.name;

  const hingeParent = sourceRoot.getObjectByName(HINGE_PARENT_NAME);
  const stationaryLeaf = sourceRoot.getObjectByName(STATIONARY_LEAF_NAME);
  const movingLeaf = sourceRoot.getObjectByName(MOVING_LEAF_NAME);
  const nativeInnerGroup = sourceRoot.getObjectByName(INNER_SURFACE_GROUP_NAME);
  const centerStrip = sourceRoot.getObjectByName(CENTER_STRIP_NAME);
  const centerOccluder = sourceRoot.getObjectByName(CENTER_OCCLUDER_NAME);
  const nativeFoldedDisplayLayer = sourceRoot.getObjectByName('UXtsBZYlaUvHoEh');
  const nativeCoverScreen = sourceRoot.getObjectByName(NATIVE_COVER_SCREEN_NAME);
  if (!hingeParent || !stationaryLeaf || !movingLeaf || !nativeInnerGroup) {
    throw new Error('The Apple source model is missing its measured Duo hinge hierarchy');
  }
  if (!(nativeCoverScreen instanceof THREE.Mesh) || !nativeCoverScreen.parent) {
    throw new Error('The Apple source model is missing its native cover display');
  }

    ghost = sourceRoot.getObjectByName(GHOST_NAME);
    if (ghost) {
      ghost.visible = false;
      ghost.userData.iphoneDuoGhost = true;
      ghost.removeFromParent();
    }

    const rearCameraMaterialTranslation = applyRearCameraMaterialTranslation(sourceRoot, translatedSourceMaterials);

    // The closed cover and the imported folded-display layer are native emissive meshes. The
    // release overlay is intentionally hidden once the fold opens far enough, so keep the
    // authored screen maps and tint their emissive output through the same reversible Night
    // finish uniform instead of forcing the overlay to remain visible.
    nativeCoverScreenBindings = bindNativeEmissiveFinishMaterial(
      sourceRoot.getObjectByName(NATIVE_COVER_SCREEN_NAME),
      NATIVE_COVER_SCREEN_MATERIAL,
      nativeScreenFinishUniforms,
      translatedSourceMaterials,
    );
    nativeFoldedDisplayBindings = bindNativeEmissiveFinishMaterial(
      nativeFoldedDisplayLayer,
      NATIVE_FOLDED_DISPLAY_MATERIAL,
      nativeScreenFinishUniforms,
      translatedSourceMaterials,
    );

    // Finish studies are material adaptations over the same native mesh. Clone each
    // finish-sensitive source material once, after the existing camera/rail translation, so the
    // White endpoint remains exactly the current authored runtime state and shared source
    // materials cannot be recoloured outside this model instance.
    cloneFinishMaterialNodes(sourceRoot, ['fapSTOypmavuPic'], makeFinishMaterialOverrides('body', {
      metalness: 0.08,
      roughness: 0.40,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, FINISH_BODY_NODES.slice(1), makeFinishMaterialOverrides('bodyGlass', {
      metalness: 0.08,
      roughness: 0.40,
      transmission: 0.16,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, FINISH_ENCLOSURE_NODES, makeFinishMaterialOverrides('enclosure', {
      metalness: 1,
      roughness: 0.18,
      envMapIntensity: 1.18,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, FINISH_ANCILLARY_METAL_NODES, makeFinishMaterialOverrides('ancillaryMetal', {
      metalness: 0.86,
      roughness: 0.11,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, FINISH_ANCILLARY_INSERT_NODES, makeFinishMaterialOverrides('ancillaryInsert', {
      metalness: 0.45,
      roughness: 0.20,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, FINISH_BUTTON_NODES, makeFinishMaterialOverrides('button', {
      metalness: 0.40,
      roughness: 0.18,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, FINISH_CENTER_STRIP_NODES, makeFinishMaterialOverrides('ancillaryMetal', {
      metalness: 0.86,
      roughness: 0.12,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, FINISH_LOGO_NODES, makeFinishMaterialOverrides('logo', {
      metalness: 0.24,
      roughness: 0.14,
      transmission: 0.08,
      clearcoat: 0.35,
      clearcoatRoughness: 0.12,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, REAR_CAMERA_MATERIAL_NODES.capsule, makeFinishMaterialOverrides('capsule', {
      roughness: 0.38,
      metalness: 0.06,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, REAR_CAMERA_MATERIAL_NODES.lensRim, makeFinishMaterialOverrides('lensRing', {
      metalness: 0.86,
      roughness: 0.10,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, REAR_CAMERA_MATERIAL_NODES.lensInnerRing, makeFinishMaterialOverrides('lensInnerRing', {
      metalness: 0.76,
      roughness: 0.12,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, REAR_CAMERA_MATERIAL_NODES.lensCavity, makeFinishMaterialOverrides('lensCavity', {
      metalness: 0.48,
      roughness: 0.16,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, REAR_CAMERA_MATERIAL_NODES.lensGlass, makeFinishMaterialOverrides('lensGlass', {
      metalness: 0.12,
      roughness: 0.28,
    }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, REAR_CAMERA_MATERIAL_NODES.lensTransmission, makeFinishMaterialOverrides('lensTransmission', {
      emissiveIntensity: 0.08,
      roughness: 0.10,
      transmission: 0.06,
      clearcoat: 0.40,
      clearcoatRoughness: 0.10,
    }, { night: { emissive: new THREE.Color('#161438') } }), finishBindings, translatedSourceMaterials);
    cloneFinishMaterialNodes(sourceRoot, REAR_CAMERA_MATERIAL_NODES.microphone, makeFinishMaterialOverrides('microphone'), finishBindings, translatedSourceMaterials);

    // Keep the local camera shadow on native geometry. Only the raised capsule and outer lens
    // hardware cast; the main body/coating receives it after presentation fitting. Internal
    // optical layers stay out of the shadow map so coincident source surfaces cannot acne.
    [...REAR_CAMERA_MATERIAL_NODES.capsule,
      ...REAR_CAMERA_MATERIAL_NODES.lensRim,
      ...REAR_CAMERA_MATERIAL_NODES.lensInnerRing].forEach((nodeName) => {
      const object = sourceRoot.getObjectByName(nodeName);
      if (object) object.userData.iphoneDuoCameraShadowCaster = true;
    });
    FINISH_BODY_NODES.forEach((nodeName) => {
      const object = sourceRoot.getObjectByName(nodeName);
      if (object) object.userData.iphoneDuoCameraShadowReceiver = true;
    });
    const rearCameraFlashParent = sourceRoot.getObjectByName(REAR_CAMERA_FLASH_PARENT_NAME);
    if (rearCameraFlashParent) {
      rearCameraFlashParent.position.z += REAR_CAMERA_FLASH_DEPTH_OFFSET;
    }

  // Capture authored closed transforms before adding runtime overlays. setFold always starts from
  // this quaternion, so arbitrary seek/replay cycles cannot accumulate rotation drift.
  const closedNativeInnerVisibility = nativeInnerGroup.visible;
  const closedMovingQuaternion = movingLeaf.quaternion.clone();
  const closedStationaryQuaternion = stationaryLeaf.quaternion.clone();
  const closedCenterStripVisibility = centerStrip?.visible ?? true;
  const closedCenterOccluderVisibility = centerOccluder?.visible ?? true;
  const closedNativeFoldedDisplayVisibility = nativeFoldedDisplayLayer?.visible ?? true;
  sourceRoot.updateMatrixWorld(true);
  // AKVZ is the shared rotation frame and has an identity transform. The actual hinge line is
  // carried by each native leaf origin, so use the leaf world position for display registration.
  const hingeWorldPosition = new THREE.Vector3().setFromMatrixPosition(movingLeaf.matrixWorld);
  // The native metal spine is independent of the static folded glass. Follow the
  // bisector of the moving leaf while retaining its exact source shape and closed transform.
  const centerHingePivot = new THREE.Group();
  centerHingePivot.name = 'nativeCenterHingePivot';
  const closedHingePosition = movingLeaf.position.clone();
  centerHingePivot.position.copy(closedHingePosition);
  hingeParent.add(centerHingePivot);
  if (centerStrip) centerHingePivot.attach(centerStrip);
  const centerRecess = 0.0008 / hingeParent.getWorldScale(new THREE.Vector3()).x;
  const sourceScaleMatrix = sourceRoot.matrixWorld.clone();
  const sourceBounds = new THREE.Box3().setFromObject(sourceRoot);
  const sourceHeight = sourceBounds.getSize(new THREE.Vector3()).y;
  const nativeCoverSize = new THREE.Box3().setFromObject(nativeCoverScreen).getSize(new THREE.Vector3());

  const textureLoader = new THREE.TextureLoader();
  const [coverTextureResult, innerTextureResult, sharpTextureResult, architectureCoverResult, architectureInnerResult] = await Promise.allSettled([
    textureLoader.loadAsync(COVER_RELEASE_URL),
    textureLoader.loadAsync(INNER_RELEASE_URL),
    textureLoader.loadAsync(COVER_SHARP_URL),
    textureLoader.loadAsync(ARCHITECTURE_COVER_URL),
    textureLoader.loadAsync(ARCHITECTURE_INNER_URL),
  ]);
  for (const result of [coverTextureResult, innerTextureResult, sharpTextureResult, architectureCoverResult, architectureInnerResult]) {
    if (result.status === 'fulfilled') initializedTextures.add(result.value);
  }
  if (coverTextureResult.status === 'rejected') throw coverTextureResult.reason;
  if (innerTextureResult.status === 'rejected') throw innerTextureResult.reason;
  if (sharpTextureResult.status === 'rejected') throw sharpTextureResult.reason;
  if (architectureCoverResult.status === 'rejected') throw architectureCoverResult.reason;
  if (architectureInnerResult.status === 'rejected') throw architectureInnerResult.reason;
  const sharpTexture = sharpTextureResult.value;
  configureReleaseTexture(sharpTexture);
  const coverTexture = coverTextureResult.value;
  const innerTexture = innerTextureResult.value;
  const architectureCoverTexture = architectureCoverResult.value;
  const architectureInnerTexture = architectureInnerResult.value;
  configureReleaseTexture(coverTexture);
  configureReleaseTexture(innerTexture);
  configureReleaseTexture(architectureCoverTexture);
  configureReleaseTexture(architectureInnerTexture);
  // Native emissive maps in the Apple GLB use the opposite Y convention from release overlays.
  // Keep dedicated clones so switching screens never mutates the overlay textures' UV contract.
  const architectureNativeCoverTexture = architectureCoverTexture.clone();
  architectureNativeCoverTexture.flipY = false;
  configureReleaseTexture(architectureNativeCoverTexture);
  const architectureNativeInnerTexture = architectureInnerTexture.clone();
  architectureNativeInnerTexture.flipY = false;
  configureReleaseTexture(architectureNativeInnerTexture);
  initializedTextures.add(architectureNativeCoverTexture);
  initializedTextures.add(architectureNativeInnerTexture);

  const desertInnerBlurTextures = makeDisplayBlurTextures(innerTexture);
  const architectureInnerBlurTextures = makeDisplayBlurTextures(architectureInnerTexture);
  const architectureCoverBlurTexture = makeBlurredDisplayTexture(
    architectureCoverTexture,
    12 * ((architectureCoverTexture.image as { width?: number } | undefined)?.width ?? 568) / 568,
  );
  initializedTextures.add(desertInnerBlurTextures.fine);
  initializedTextures.add(desertInnerBlurTextures.medium);
  initializedTextures.add(desertInnerBlurTextures.wide);
  initializedTextures.add(architectureInnerBlurTextures.fine);
  initializedTextures.add(architectureInnerBlurTextures.medium);
  initializedTextures.add(architectureInnerBlurTextures.wide);
  initializedTextures.add(architectureCoverBlurTexture);

  const screenTextures: Record<IphoneDuoScreen, IphoneDuoScreenTextures> = {
    desert: {
      coverSharp: sharpTexture,
      coverBlur: coverTexture,
      innerSharp: innerTexture,
      ...desertInnerBlurTextures,
    },
    architecture: {
      coverSharp: architectureCoverTexture,
      coverBlur: architectureCoverBlurTexture,
      innerSharp: architectureInnerTexture,
      ...architectureInnerBlurTextures,
    },
  };

  const root = new THREE.Group();
  root.name = 'iphoneDuoOfficial';
  root.add(sourceRoot);

  // The panels intentionally use the measured source screen footprint rather than a separate
  // fabricated chassis. They are created in source world coordinates, then attached to native
  // leaves before presentation normalization so the authored source scale applies uniformly.
  const rightScreenWidth = INNER_SCREEN_WIDTH + INNER_SCREEN_HINGE_OVERLAP;
  const leftScreenWidth = INNER_SCREEN_WIDTH + INNER_SCREEN_HINGE_OVERLAP;
  const rightScreenCenter = new THREE.Vector3(
    hingeWorldPosition.x + INNER_SCREEN_WIDTH / 2,
    hingeWorldPosition.y,
    hingeWorldPosition.z + INNER_SCREEN_DEPTH,
  );
  const movingScreenCenter = new THREE.Vector3(
    hingeWorldPosition.x + INNER_SCREEN_WIDTH / 2,
    hingeWorldPosition.y,
    hingeWorldPosition.z - INNER_SCREEN_DEPTH,
  );
  const rightScreen = makeReleaseScreen(
    'innerDisplayRightRelease',
    innerTexture,
    rightScreenWidth,
    INNER_SCREEN_HEIGHT,
    DISPLAY_RIGHT_OFFSET,
    DISPLAY_SPAN,
    false,
    false,
    0,
    desertInnerBlurTextures,
  );
  const movingInnerQuaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI,
  );
  const leftScreen = makeReleaseScreen(
    'innerDisplayLeftRelease',
    innerTexture,
    leftScreenWidth,
    INNER_SCREEN_HEIGHT,
    0,
    DISPLAY_SPAN,
    true,
    true,
    1,
    desertInnerBlurTextures,
  );
  attachAtWorldTransform(rightScreen, stationaryLeaf, rightScreenCenter, new THREE.Quaternion());
  attachAtWorldTransform(leftScreen, movingLeaf, movingScreenCenter, movingInnerQuaternion);

  // Retain the measured leaf frames as registration anchors. A single connected mesh owns
  // the visible image; the former independent planes cannot leave an antialiased center edge.
  leftScreen.visible = false;
  rightScreen.visible = false;
  const continuousSurface = makeContinuousDisplayGeometry(
    2 * INNER_SCREEN_WIDTH + INNER_SCREEN_HINGE_OVERLAP,
    INNER_SCREEN_HEIGHT,
    INNER_SCREEN_RADIUS,
  );
  const continuousMaterial = rightScreen.material;
  continuousMaterial.uniforms.uOffset.value = 0;
  continuousMaterial.uniforms.uSpan.value = 1;
  continuousMaterial.depthWrite = true;
  const continuousScreen = new THREE.Mesh(continuousSurface.geometry, continuousMaterial);
  continuousScreen.name = 'innerDisplayContinuousRelease';
  continuousScreen.renderOrder = 4;
  continuousScreen.frustumCulled = false;
  hingeParent.add(continuousScreen);
  // The source inner glass footprint is 78.845 x 113.270 mm per leaf. Carry its
  // black border through the same flex, reaching 116.95 mm inside the 117.95 mm native outer bezel
  // at the center so its metal spine cannot show through a notch at the top or bottom.
  const continuousGlass = makeContinuousDisplayGeometry(
    2 * 0.078845 + INNER_SCREEN_HINGE_OVERLAP,
    0.113270,
    INNER_SCREEN_RADIUS + 0.0011175,
    0.0008,
    0.11695,
  );
  const glassBacking = new THREE.Mesh(continuousGlass.geometry, new THREE.MeshStandardMaterial({
    color: '#050505', roughness: 0.24, metalness: 0.05, side: THREE.DoubleSide,
  }));
  glassBacking.name = 'innerDisplayContinuousBacking';
  glassBacking.renderOrder = 3;
  glassBacking.frustumCulled = false;
  hingeParent.add(glassBacking);
  const glassInset = new THREE.Matrix4().makeTranslation(0, 0, -0.000035);
  const leftGlassMatrix = new THREE.Matrix4();
  const rightGlassMatrix = new THREE.Matrix4();
  const hingeInverse = new THREE.Matrix4();
  const leftDisplayMatrix = new THREE.Matrix4();
  const rightDisplayMatrix = new THREE.Matrix4();
  const updateContinuousDisplay = (): void => {
    hingeParent.updateWorldMatrix(true, true);
    hingeInverse.copy(hingeParent.matrixWorld).invert();
    leftDisplayMatrix.multiplyMatrices(hingeInverse, leftScreen.matrixWorld);
    rightDisplayMatrix.multiplyMatrices(hingeInverse, rightScreen.matrixWorld);
    continuousSurface.update(leftDisplayMatrix, rightDisplayMatrix);
    continuousGlass.update(
      leftGlassMatrix.multiplyMatrices(leftDisplayMatrix, glassInset),
      rightGlassMatrix.multiplyMatrices(rightDisplayMatrix, glassInset),
    );
  };
  updateContinuousDisplay();

  let coverFinishUniform: { value: number } | null = null;
  let screenFinishMix = 0;
  const coverReflectionUniform = { value: 1 };
  const coverBlurUniform = { value: 0 };
  const coverSharpUniform = { value: sharpTexture };
  const coverMaterial = new THREE.MeshBasicMaterial({
    map: coverTexture,
    color: 0xffffff,
    toneMapped: false,
    side: THREE.FrontSide,
    depthWrite: false,
    depthTest: true,
  });
  // Keep the derived sharp cover binding inspectable for the focused screen QA. The
  // renderer's internal shader record is unavailable until the material has rendered,
  // while this public metadata remains stable across renderer implementations.
  coverMaterial.userData.iphoneDuoCoverSharp = coverSharpUniform;
  coverMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uGlassReflection = coverReflectionUniform;
    shader.uniforms.uCoverBlur = coverBlurUniform;
    shader.uniforms.uCoverSharp = coverSharpUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vGlassFacing;')
      .replace('#include <project_vertex>', `
        #include <project_vertex>
        vGlassFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mvPosition.xyz)));
      `);
    shader.uniforms.uFinishMix = { value: screenFinishMix };
    coverFinishUniform = shader.uniforms.uFinishMix as { value: number };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'uniform vec3 diffuse;',
        'uniform vec3 diffuse;\nuniform float uFinishMix;\nuniform float uGlassReflection;\nuniform float uCoverBlur;\nuniform sampler2D uCoverSharp;\nvarying float vGlassFacing;',
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
          #include <map_fragment>
          diffuseColor.rgb = mix(texture2D(uCoverSharp, vMapUv).rgb, diffuseColor.rgb, uCoverBlur);
          if (uFinishMix > 0.0) {
            float nightSky = smoothstep(0.34, 0.82, vMapUv.y);
            vec3 nightMultiplier = mix(vec3(0.17, 0.12, 0.18), vec3(0.02, 0.035, 0.065), nightSky);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * nightMultiplier + vec3(0.002, 0.003, 0.006), clamp(uFinishMix, 0.0, 1.0));
          }
        `,
      )
      .replace('#include <opaque_fragment>', `
        // The bright studio card dominates the cover glass at grazing angles in Film 01.
        float reflectedStudio = (1.0 - smoothstep(0.10, 0.48, vGlassFacing)) * uGlassReflection;
        outgoingLight = mix(outgoingLight, vec3(0.78, 0.80, 0.80), reflectedStudio);
        #include <opaque_fragment>
      `);
  };
  // Follow the source's actual cover contour and camera opening, rather than fitting a
  // generic panel across its asymmetric corners. Clone geometry so source UVs stay intact.
  const coverGeometry = nativeCoverScreen.geometry.clone();
  coverGeometry.computeBoundingBox();
  const coverBounds = coverGeometry.boundingBox!;
  const coverPositions = coverGeometry.getAttribute('position');
  const coverUv = new Float32Array(coverPositions.count * 2);
  for (let i = 0; i < coverPositions.count; i += 1) {
    // The authored cover is rotated 180 degrees in its leaf. Release images use flipY=true,
    // while the original glTF emissive map uses flipY=false: register in visible screen space.
    coverUv[i * 2] = (coverBounds.max.x - coverPositions.getX(i)) / (coverBounds.max.x - coverBounds.min.x);
    coverUv[i * 2 + 1] = (coverBounds.max.y - coverPositions.getY(i)) / (coverBounds.max.y - coverBounds.min.y);
  }
  coverGeometry.setAttribute('uv', new THREE.BufferAttribute(coverUv, 2));
  const coverScreen = new THREE.Mesh(coverGeometry, coverMaterial);
  coverScreen.name = 'coverReleaseOverlay';
  coverScreen.renderOrder = 5;
  coverScreen.frustumCulled = false;
  coverScreen.position.copy(nativeCoverScreen.position);
  coverScreen.quaternion.copy(nativeCoverScreen.quaternion);
  coverScreen.scale.copy(nativeCoverScreen.scale);
  // A 20-micron registration offset avoids coplanar z-fighting without moving the contour.
  coverScreen.translateZ(0.00002 / nativeCoverScreen.getWorldScale(new THREE.Vector3()).z);
  nativeCoverScreen.parent.add(coverScreen);

  // Preserve the exact authored closed pose, including source leaf rotations and positions.
  movingLeaf.quaternion.copy(closedMovingQuaternion);
  stationaryLeaf.quaternion.copy(closedStationaryQuaternion);
  sourceRoot.updateMatrixWorld(true);

  // Normalize only the imported root, after measured overlays are attached. The original source
  // geometry and material graph is otherwise untouched.
  const sourceScale = sourceHeight > 1e-6 ? 3 / sourceHeight : 1;
  sourceRoot.scale.multiplyScalar(sourceScale);
  sourceRoot.updateMatrixWorld(true);

  const rootParts: DuoParts = { root };
  root.traverse((object) => {
    if (object.name) rootParts[object.name] = object;
  });
  if (ghost) rootParts[GHOST_NAME] = ghost;
  rootParts.cameraLeaf = stationaryLeaf;
  rootParts.displayLeaf = movingLeaf;
  rootParts.cameraPivot = stationaryLeaf;
  rootParts.displayPivot = movingLeaf;
  rootParts.hingeParent = hingeParent;
  rootParts.nativeInnerSurfaceGroup = nativeInnerGroup;
  rootParts.innerDisplayLeft = leftScreen;
  rootParts.innerDisplayRight = rightScreen;
  rootParts.innerDisplayContinuous = continuousScreen;
  rootParts.coverRelease = coverScreen;
  if (nativeFoldedDisplayLayer) rootParts.nativeFoldedDisplayLayer = nativeFoldedDisplayLayer;
  if (centerStrip) rootParts.centerStrip = centerStrip;
  if (centerOccluder) rootParts.centerOccludingStrip = centerOccluder;

  let fold = 0;
  let finish: IphoneDuoFinish = 'white';
  let finishWeights = createFinishWeights('white');
  let finishMix = 0;
  let screen: IphoneDuoScreen = 'desert';
  let displayBlur = 1;
  let disposed = false;

  const applyScreenTextureSet = (selected: IphoneDuoScreen): void => {
    const assets = screenTextures[selected];
    [leftScreen.material, rightScreen.material].forEach((material) => {
      material.uniforms.uTexture.value = assets.innerSharp;
      material.uniforms.uArtworkScale.value.copy(innerArtworkScale(assets.innerSharp));
      material.uniforms.uBlurFine.value = assets.fine;
      material.uniforms.uBlurMedium.value = assets.medium;
      material.uniforms.uBlurWide.value = assets.wide;
    });
    coverMaterial.map = assets.coverBlur;
    coverSharpUniform.value = assets.coverSharp;
    coverMaterial.needsUpdate = true;

    // The source-native display meshes remain in the graph for fidelity and fallback angles.
    // Give them the selected artwork with their own non-flipped texture clones, then restore the
    // authored emissive maps when returning to Desert.
    const nativeCoverTexture = selected === 'architecture' ? architectureNativeCoverTexture : null;
    nativeCoverScreenBindings.forEach((binding) => {
      binding.setTexture(nativeCoverTexture ?? binding.originalEmissiveMap);
    });
    const nativeInnerTexture = selected === 'architecture' ? architectureNativeInnerTexture : null;
    nativeFoldedDisplayBindings.forEach((binding) => {
      binding.setTexture(nativeInnerTexture ?? binding.originalEmissiveMap);
    });

    // Night grading belongs to the Desert reference artwork. Architecture keeps its measured
    // orange/blue source pixels across every finish, including native fallback materials.
    screenFinishMix = selected === 'desert' ? finishMix : 0;
    leftScreen.material.uniforms.uFinishMix.value = screenFinishMix;
    rightScreen.material.uniforms.uFinishMix.value = screenFinishMix;
    if (coverFinishUniform) coverFinishUniform.value = screenFinishMix;
    nativeScreenFinishUniforms.forEach((uniform) => {
      uniform.value = screenFinishMix;
    });
    const duoState = root.userData.duo as {
      screen?: IphoneDuoScreen;
      screenFinishMix?: number;
      displayMapping?: { screen?: IphoneDuoScreen };
    } | undefined;
    if (duoState) {
      duoState.screen = selected;
      duoState.screenFinishMix = screenFinishMix;
      if (duoState.displayMapping) duoState.displayMapping.screen = selected;
    }
  };

  const setScreen = (value: IphoneDuoScreen): void => {
    if (disposed) return;
    const nextScreen = isIphoneDuoScreen(value) ? value : 'desert';
    if (nextScreen === screen && (root.userData.duo as { screen?: IphoneDuoScreen } | undefined)?.screen === nextScreen) return;
    screen = nextScreen;
    applyScreenTextureSet(screen);
  };

  const setFold = (degrees: number): void => {
    if (disposed) return;
    fold = clampFold(degrees);
    // This is intentionally a parent-space rotation. The authored upTU quaternion is preserved,
    // and AKVZ's raw +Z maps to the runtime/world hinge axis. Rotating the leaf's local Z axis
    // would spin the panel in-plane and is physically incorrect.
    const hingeRotation = new THREE.Quaternion().setFromAxisAngle(HINGE_AXIS, THREE.MathUtils.degToRad(fold));
    movingLeaf.quaternion.copy(closedMovingQuaternion).premultiply(hingeRotation);
    stationaryLeaf.quaternion.copy(closedStationaryQuaternion);
    coverScreen.visible = fold < 104;
    // JMN contains the complete static, curved closed-pose display stack, including
    // JnJdTkxbQgUtLwU (glass backing) and UXtsBZYlaUvHoEh (display layer).
    // Neither deforms with the articulated leaves. The measured release panels take over
    // as soon as opening begins; keeping any part of JMN visible produces raised loops
    // above the hinge in profile. Restore the authored assembly only in the closed pose.
    nativeInnerGroup.visible = closedNativeInnerVisibility && fold === 0;
    // Follow the hinge bisector and recess the native spine behind the connected display.
    // Leaving this strip in its closed transform would occlude the artwork while opening.
    const halfFold = THREE.MathUtils.degToRad(fold / 2);
    centerHingePivot.quaternion.setFromAxisAngle(HINGE_AXIS, halfFold);
    centerHingePivot.position.copy(closedHingePosition).add(new THREE.Vector3(
      -Math.cos(halfFold), -Math.sin(halfFold), 0,
    ).multiplyScalar(centerRecess * Math.sin(halfFold)));
    if (centerStrip) centerStrip.visible = closedCenterStripVisibility;
    // xdy is the narrow black JMN center bezel that otherwise occludes the continuous release
    // artwork at open. It remains source-visible in the closed pose and is hidden only at the
    // open threshold, alongside the authored center strip above.
    if (centerOccluder) centerOccluder.visible = closedCenterOccluderVisibility && fold < 90;
    // UX is the curved native folded-display layer that sits in front of the measured release
    // surfaces at open. Keep its authored closed visibility and suppress only the unarticulated
    // layer once the supplied two-panel screens face the viewer.
    if (nativeFoldedDisplayLayer) {
      nativeFoldedDisplayLayer.visible = closedNativeFoldedDisplayVisibility && fold < 90;
    }
    updateContinuousDisplay();
    root.userData.duo.fold = fold;
    root.updateMatrixWorld(true);
  };

  const setDisplayBlur = (amount: number): void => {
    if (disposed) return;
    displayBlur = clampBlur(amount);
    coverReflectionUniform.value = displayBlur > 0 ? 1 : 0;
    leftScreen.material.uniforms.uBlur.value = displayBlur;
    // Shared UV-space falloff keeps the center continuous and the right side sharp.
    rightScreen.material.uniforms.uBlur.value = displayBlur;
    root.userData.duo.displayBlur = displayBlur;
  };

  const setCoverBlur = (amount: number): void => {
    if (!disposed) coverBlurUniform.value = clampBlur(amount);
  };

  const setFinishWeights = (input: Partial<IphoneDuoFinishWeights>): void => {
    if (disposed) return;
    finishWeights = normalizeFinishWeights(input);
    finishMix = finishWeights.night;
    screenFinishMix = screen === 'desert' ? finishMix : 0;
    finishBindings.forEach((binding) => applyFinishValues(binding, finishWeights));
    leftScreen.material.uniforms.uFinishMix.value = screenFinishMix;
    rightScreen.material.uniforms.uFinishMix.value = screenFinishMix;
    if (coverFinishUniform) coverFinishUniform.value = screenFinishMix;
    nativeScreenFinishUniforms.forEach((uniform) => {
      uniform.value = screenFinishMix;
    });
    root.userData.duo.finishMix = finishMix;
    root.userData.duo.screenFinishMix = screenFinishMix;
    root.userData.duo.finishWeights = { ...finishWeights };
  };

  const setFinishMix = (amount: number): void => {
    const mix = THREE.MathUtils.clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
    setFinishWeights({ white: 1 - mix, night: mix });
  };

  const setFinish = (value: IphoneDuoFinish): void => {
    if (disposed) return;
    finish = isIphoneDuoFinish(value) ? value : 'white';
    setFinishWeights(createFinishWeights(finish));
    root.userData.duo.finish = finish;
    root.userData.duo.finishPalette = {
      label: IPHONE_DUO_FINISH_PALETTES[finish].label,
      hex: IPHONE_DUO_FINISH_PALETTES[finish].hex,
      study: IPHONE_DUO_FINISH_PALETTES[finish].study,
    };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    disposeOwnedResources(ghost ? [root, ghost] : [root], initializedTextures, translatedSourceMaterials);
    root.userData.duo.disposed = true;
  };

  root.userData.duo = {
    setFold,
    setFinish,
    setFinishMix,
    setFinishWeights,
    setScreen,
    setDisplayBlur,
    setCoverBlur,
    dispose,
    getParts: (): DuoParts => ({ ...rootParts }),
    fold,
    finish,
    screen,
    finishWeights: { ...finishWeights },
    finishMix,
    screenFinishMix,
    finishPalette: {
      label: IPHONE_DUO_FINISH_PALETTES[finish].label,
      hex: IPHONE_DUO_FINISH_PALETTES[finish].hex,
      study: IPHONE_DUO_FINISH_PALETTES[finish].study,
    },
    displayBlur,
    source:
      'Apple official USDZ converted to GLB; native geometry, UVs, transforms, and blank inner surfaces preserved. Runtime articulation uses the measured AKVZ +Z parent-space hinge because the source has no authored animation track. Release pixels come from the supplied Apple reference crops; one connected display surface flexes between two measured leaf frames; the native metal spine follows their bisector.',
    sourceUrl: EMBEDDED_SOURCE_PROVENANCE,
    sourceSceneName: originalSourceName,
    approximate: false,
    materialTranslation: {
      format: 'glTF',
      material: 'VnRXIqfJGJZbeXY',
      change: 'rear optics black diffuse tint translated to a white transmission tint; transmission 0.99 retained',
      rearCamera: rearCameraMaterialTranslation,
      flashDepthRegistration: {
        parent: REAR_CAMERA_FLASH_PARENT_NAME,
        sourceUnits: REAR_CAMERA_FLASH_DEPTH_OFFSET,
        reason: 'converted backing plane otherwise occluded the source-visible flash disk once the capsule was opaque',
      },
    },
    capabilities: { fold: true, finish: true, screen: true },
    nativePose: 'closed',
    nativeFinish: 'white',
    finishAdaptation: {
      name: 'Night',
      reference: 'codex-clipboard-68da2eb7-dd93-48e8-8a3f-629ac8e17700.png',
      sameGeometry: true,
      body: 'cool blue-black physical finish with preserved source maps and reflections',
      logo: 'near-black blue-gray native logo stack',
      camera: 'dark reflective capsule and optical layers; native flash remains pearl for legibility',
      screen: 'source release artwork receives a restrained dusk-purple tint',
    },
    ghostName: GHOST_NAME,
    normalizedHeight: 3,
    animation: {
      sourceMotion: 'work/iphone-duo/animation/reference-motion.json',
      hingeParent: HINGE_PARENT_NAME,
      movingLeaf: MOVING_LEAF_NAME,
      stationaryLeaf: STATIONARY_LEAF_NAME,
      axis: 'AKVZ local +Z in parent space; raw +Z maps to runtime/world -Y',
      reset: 'moving leaf quaternion is restored from its authored closed quaternion before every sample',
      closedPose: 'source-authored leaf transforms at fold 0',
      openFold: 180,
    },
    displayMapping: {
      texture: INNER_RELEASE_URL,
      screen,
      screens: {
        desert: { cover: COVER_RELEASE_URL, coverSharp: COVER_SHARP_URL, inner: INNER_RELEASE_URL },
        architecture: { cover: ARCHITECTURE_COVER_URL, inner: ARCHITECTURE_INNER_URL, crop: 'figure-led' },
      },
      projection: 'one indexed surface with continuous full-image UVs and a cubic hinge flex',
      continuousMesh: continuousScreen.name,
      activeFootprint: {
        width: 2 * INNER_SCREEN_WIDTH + INNER_SCREEN_HINGE_OVERLAP,
        height: INNER_SCREEN_HEIGHT,
        cornerRadius: INNER_SCREEN_RADIUS,
        cornerSegments: SCREEN_CORNER_SEGMENTS,
        referenceAspect: '568 / 399 active pixels in final Display reveal frame',
      },
      flexWidthMetres: 0.0048,
      left: { offset: 0, span: DISPLAY_SPAN, movingWith: MOVING_LEAF_NAME, mirroredAtRest: true, blur: 'setDisplayBlur only' },
      right: { offset: DISPLAY_RIGHT_OFFSET, span: DISPLAY_SPAN, movingWith: STATIONARY_LEAF_NAME, blur: 'shared UV falloff reaches zero beyond the hinge' },
      sourceSurfaceGroup: INNER_SURFACE_GROUP_NAME,
      nativeUnderlyingPreserved: true,
      nativeClosedDisplayStack: {
        sourceName: INNER_SURFACE_GROUP_NAME,
        closedVisible: closedNativeInnerVisibility,
        openSuppressed: 'fold > 0; complete static closed-pose stack replaced by the connected flexible display',
      },
      centerStrip: {
        sourceName: CENTER_STRIP_NAME,
        closedVisible: closedCenterStripVisibility,
        motion: 'native spine follows half the leaf angle and recesses 0.8 mm behind the flat display',
      },
      centerOccluder: {
        sourceName: CENTER_OCCLUDER_NAME,
        closedVisible: closedCenterOccluderVisibility,
        openSuppressed: 'fold >= 90 while continuous inner release artwork faces the viewer',
      },
      nativeFoldedDisplayLayer: {
        sourceName: 'UXtsBZYlaUvHoEh',
        closedVisible: closedNativeFoldedDisplayVisibility,
        openSuppressed:
          'fold >= 90; measured connected release screen replaces the unarticulated folded display layer',
      },
    },
    vfx: {
      coverTexture: COVER_RELEASE_URL,
      innerTexture: INNER_RELEASE_URL,
      effect: 'source display pixels with left-panel blur resolving after full opening; no particles or body emission',
    },
    // Keep these values available to runtime probes without changing the imported source graph.
    sourceScaleMatrix: sourceScaleMatrix.elements.slice(),
    measuredScreen: {
      width: INNER_SCREEN_WIDTH,
      height: INNER_SCREEN_HEIGHT,
      hingeOverlap: INNER_SCREEN_HINGE_OVERLAP,
      depth: INNER_SCREEN_DEPTH,
      coverWidth: nativeCoverSize.x,
      coverHeight: nativeCoverSize.y,
      coverReference: 'hhgAIoCGsHXeDPY native display contour and camera opening',
    },
  };

  setFold(0);
  setDisplayBlur(1);
  setFinishMix(0);
  setScreen('desert');
  return root;
  } catch (error) {
    // The GLB graph and any release texture that resolved before initialization failed are owned
    // by this factory. Promise.allSettled above ensures a sibling texture cannot resolve after
    // this cleanup has already run.
    disposeOwnedResources(ghost ? [sourceRoot, ghost] : [sourceRoot], initializedTextures, translatedSourceMaterials);
    throw error;
  }
}
