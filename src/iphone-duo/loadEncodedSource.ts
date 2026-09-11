import * as THREE from 'three';
import { LinearSRGBColorSpace, ObjectLoader, type ColorSpace } from 'three';
import { IPHONE_DUO_ENCODED_SOURCE } from './encodedSource';

type ExactMaterial = Record<string, unknown> & {
  scalars?: Record<string, number | boolean | number[]>;
};
type ExactTransform = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  matrix: number[];
  matrixAutoUpdate: boolean;
  matrixWorldAutoUpdate: boolean;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  frustumCulled: boolean;
  renderOrder: number;
};
type ExactTexture = {
  matrixAutoUpdate: boolean;
  matrix: number[];
  colorSpace: ColorSpace;
  flipY: boolean;
  premultiplyAlpha: boolean;
  unpackAlignment: number;
  sourceUuid: string;
  sourceName: string;
};
type EncodedScene = Record<string, unknown> & {
  images?: Array<{ uuid: string; url: string }>;
  textures?: Array<{ uuid: string; image: string }>;
};
type EncodedSource = {
  scene: EncodedScene;
  exactTransforms: Record<string, ExactTransform>;
  exactMaterials: Record<string, ExactMaterial>;
  exactTextures: Record<string, ExactTexture>;
};

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function typedArrayFromBase64(type: string, value: string): ArrayBufferView {
  const bytes = decodeBase64(value);
  const constructors: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
  };
  const Constructor = constructors[type];
  if (!Constructor) throw new Error(`Unsupported encoded attribute type: ${type}`);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return new Constructor(arrayBuffer);
}

function expandGeometryArrays(scene: Record<string, unknown>): void {
  const geometries = (scene.geometries ?? []) as Array<{ data: {
    attributes?: Record<string, Record<string, unknown>>;
    index?: Record<string, unknown>;
    morphAttributes?: Record<string, Array<Record<string, unknown>>>;
  } }>;
  const expand = (descriptor: Record<string, unknown>): void => {
    if (descriptor.arrayEncoding !== 'base64' || typeof descriptor.array !== 'string') return;
    descriptor.array = typedArrayFromBase64(String(descriptor.type), descriptor.array);
    delete descriptor.arrayEncoding;
  };
  for (const geometry of geometries) {
    for (const descriptor of Object.values(geometry.data.attributes ?? {})) expand(descriptor);
    if (geometry.data.index) expand(geometry.data.index);
    for (const morph of Object.values(geometry.data.morphAttributes ?? {})) {
      for (const descriptor of morph) expand(descriptor);
    }
  }
}

function restoreExactTransforms(root: THREE.Object3D, exactTransforms: EncodedSource['exactTransforms']): void {
  root.traverse((object) => {
    const exact = exactTransforms[object.uuid] as ExactTransform | undefined;
    if (!exact) return;
    object.matrixAutoUpdate = exact.matrixAutoUpdate;
    object.matrixWorldAutoUpdate = exact.matrixWorldAutoUpdate;
    // ObjectLoader only decomposes the serialized matrix when matrixAutoUpdate is
    // true. Keep the source transform components intact for fixed-matrix nodes as
    // well: callers can inspect or re-enable matrix updates without losing them.
    object.position.fromArray(exact.position);
    object.quaternion.fromArray(exact.quaternion);
    object.scale.fromArray(exact.scale);
    if (exact.matrixAutoUpdate) {
      object.updateMatrix();
    } else {
      object.matrix.fromArray(exact.matrix);
    }
    object.visible = exact.visible;
    object.castShadow = exact.castShadow;
    object.receiveShadow = exact.receiveShadow;
    object.frustumCulled = exact.frustumCulled;
    object.renderOrder = exact.renderOrder;
  });
}

function restoreExactMaterials(root: THREE.Object3D, exactMaterials: EncodedSource['exactMaterials']): void {
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const materials = Array.isArray((object as THREE.Mesh).material)
      ? (object as THREE.Mesh).material as THREE.Material[]
      : [(object as THREE.Mesh).material as THREE.Material];
    for (const material of materials) {
      const values = exactMaterials[material.uuid] as ExactMaterial | undefined;
      if (!values) continue;
      for (const [key, rgb] of Object.entries(values)) {
        if (key === 'scalars' || !Array.isArray(rgb) || rgb.length !== 3) continue;
        const color = (material as unknown as Record<string, unknown>)[key];
        if ((color as THREE.Color | undefined)?.isColor) {
          (color as THREE.Color).setRGB(rgb[0], rgb[1], rgb[2], LinearSRGBColorSpace);
        }
      }
      for (const [key, value] of Object.entries(values.scalars ?? {})) {
        const current = (material as unknown as Record<string, unknown>)[key];
        if (typeof value === 'number' || typeof value === 'boolean') {
          if (typeof current === typeof value) (material as unknown as Record<string, unknown>)[key] = value;
        } else if (Array.isArray(value) && Array.isArray(current) && current.length === value.length) {
          (material as unknown as Record<string, unknown>)[key] = [...value];
        }
      }
      material.needsUpdate = true;
    }
  });
}

function restoreExactTextures(root: THREE.Object3D, exactTextures: EncodedSource['exactTextures']): void {
  const seen = new Set<string>();
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const materials = Array.isArray((object as THREE.Mesh).material)
      ? (object as THREE.Mesh).material as THREE.Material[]
      : [(object as THREE.Mesh).material as THREE.Material];
    for (const material of materials) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (!(value as THREE.Texture | undefined)?.isTexture) continue;
        const texture = value as THREE.Texture;
        if (seen.has(texture.uuid)) continue;
        seen.add(texture.uuid);
        const exact = exactTextures[texture.uuid] as ExactTexture | undefined;
        if (!exact) continue;
        texture.matrixAutoUpdate = exact.matrixAutoUpdate;
        texture.matrix.fromArray(exact.matrix);
        // ObjectLoader creates a fresh Source for each parse, so its UUID is not
        // the UUID serialized by the original source parse. Restore that
        // identity before the embedded image bytes are reattached.
        texture.source.uuid = exact.sourceUuid;
        texture.colorSpace = exact.colorSpace;
        texture.flipY = exact.flipY;
        texture.premultiplyAlpha = exact.premultiplyAlpha;
        texture.unpackAlignment = exact.unpackAlignment;
        texture.needsUpdate = true;
      }
    }
  });
}

async function replaceImagesWithSourceBitmaps(
  root: THREE.Object3D,
  scene: EncodedScene,
): Promise<void> {
  const imageUuidByTextureUuid = new Map(
    ((scene as { textures?: Array<{ uuid: string; image: string }> }).textures ?? [])
      .map((texture) => [texture.uuid, texture.image] as const),
  );
  const sources = new Map<string, THREE.Source>();
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const materials = Array.isArray((object as THREE.Mesh).material)
      ? (object as THREE.Mesh).material as THREE.Material[]
      : [(object as THREE.Mesh).material as THREE.Material];
    for (const material of materials) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        const texture = value as THREE.Texture | undefined;
        if (!texture?.isTexture || !texture.source) continue;
        // Prefer the serialized texture -> image relationship. It remains stable
        // even if a future Three.js ObjectLoader changes Source UUID generation.
        const imageUuid = imageUuidByTextureUuid.get(texture.uuid) ?? texture.source.uuid;
        if (imageUuid) sources.set(imageUuid, texture.source);
      }
    }
  });
  const imageByUuid = new Map((scene.images ?? []).map((image) => [image.uuid, image.url]));
  if (typeof createImageBitmap !== 'function') return;
  await Promise.all([...sources.entries()].map(async ([uuid, source]) => {
    const url = imageByUuid.get(uuid);
    if (!url) throw new Error(`Encoded source image ${uuid} is missing`);
    const blob = await fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`Encoded source image ${uuid} failed: ${response.status}`);
      return response.blob();
    });
    const bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    source.data = bitmap;
    source.needsUpdate = true;
  }));
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const materials = Array.isArray((object as THREE.Mesh).material)
      ? (object as THREE.Mesh).material as THREE.Material[]
      : [(object as THREE.Mesh).material as THREE.Material];
    for (const material of materials) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        const texture = value as THREE.Texture | undefined;
        if (texture?.isTexture) texture.needsUpdate = true;
      }
    }
  });
}

async function decodeEncodedSource(payload: EncodedSource): Promise<THREE.Group> {
  // ObjectLoader assigns userData and descriptor objects directly from its input;
  // decode a private scene copy so retries or multiple model instances cannot
  // mutate the generated singleton payload.
  const scene = (typeof structuredClone === 'function'
    ? structuredClone(payload.scene)
    : JSON.parse(JSON.stringify(payload.scene))) as Record<string, unknown> & {
      images?: Array<{ uuid: string; url: string }>;
      textures?: Array<{ uuid: string; image: string }>;
    };
  expandGeometryArrays(scene);
  const root = await new ObjectLoader().parseAsync(scene as never) as THREE.Group;
  restoreExactTransforms(root, payload.exactTransforms);
  restoreExactMaterials(root, payload.exactMaterials);
  restoreExactTextures(root, payload.exactTextures);
  await replaceImagesWithSourceBitmaps(root, scene);
  root.updateMatrixWorld(true);
  return root;
}

/** Decode the build-time measured Apple source without a runtime model-loader import. */
export async function loadEncodedIphoneDuoSource(): Promise<THREE.Group> {
  return decodeEncodedSource(IPHONE_DUO_ENCODED_SOURCE as EncodedSource);
}

/** Decode the optional provider source only when that provider is selected. */
export async function loadEncodedIphoneDuoHyper3dSource(): Promise<THREE.Group> {
  const { IPHONE_DUO_HYPER3D_ENCODED_SOURCE } = await import('./encodedHyper3d');
  return decodeEncodedSource(IPHONE_DUO_HYPER3D_ENCODED_SOURCE as EncodedSource);
}
