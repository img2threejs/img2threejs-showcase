import {
  AnimationClip,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Group,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Object3D,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  VectorKeyframeTrack,
  ClampToEdgeWrapping,
  RepeatWrapping,
  MirroredRepeatWrapping,
  NearestFilter,
  LinearFilter,
  NearestMipmapNearestFilter,
  NearestMipmapLinearFilter,
  LinearMipmapNearestFilter,
  LinearMipmapLinearFilter,
  FrontSide,
  BackSide,
  DoubleSide,
} from "three";
import type { NativeAsset } from "./schema";

/** Decoded image objects supplied to native scene construction, keyed by glTF image index. */
export type NativeDecodedImages = Readonly<Record<number, ImageBitmap>>;

/** All owned GPU-side resources made by one construction call. ImageBitmaps are caller-owned. */
export interface NativeResourceOwnership {
  readonly geometries: readonly BufferGeometry[];
  readonly materials: readonly (MeshStandardMaterial | MeshPhysicalMaterial | MeshBasicMaterial)[];
  readonly textures: readonly Texture[];
  readonly skeletons: readonly Skeleton[];
  /** Disposes geometries, materials, textures, and skeletons once. Deliberately never closes ImageBitmaps. */
  dispose(): void;
}

export interface NativeModel {
  readonly root: Group;
  readonly objects: ReadonlyMap<number, Object3D>;
  readonly ownership: NativeResourceOwnership;
}

const HYPER3D_MESH_PREFIX = 'hyper3d_mesh_';
const PROCEDURAL_MESH_PREFIX = 'procedural-img2threejs_mesh_';
// Preserve these two authored meshes; Three appends the primitive suffix (for example, :0).
const PRESERVED_HYPER3D_MESH_NAMES = new Set([
  'hyper3d_mesh_297a4bb9-ceab-4c9f-940d-fd78631b1cec',
  'hyper3d_mesh_f5ae0d3a-9839-44ac-a100-c4761df806a5',
]);

function nativePrimitiveName(meshName: string, primitiveIndex: number): string {
  const name = meshName.startsWith(HYPER3D_MESH_PREFIX) && !PRESERVED_HYPER3D_MESH_NAMES.has(meshName)
    ? PROCEDURAL_MESH_PREFIX + meshName.slice(HYPER3D_MESH_PREFIX.length)
    : meshName;
  return name + ':' + primitiveIndex;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
type NumericArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;
type ArrayConstructor = { new (buffer: ArrayBuffer, byteOffset: number, length: number): NumericArray; BYTES_PER_ELEMENT: number };
const ARRAY_TYPES: Record<string, ArrayConstructor> = { Int8Array, Uint8Array, Int16Array, Uint16Array, Uint32Array, Float32Array };

/** Decode an exported accessor without changing its component representation. */
function accessorArray(asset: NativeAsset, accessorIndex: number): { array: ArrayBufferView; count: number; itemSize: number; normalized: boolean } {
  const accessor = asset.raw.accessors[accessorIndex];
  if (!accessor) throw new Error(`Native ${asset.role}: missing accessor ${accessorIndex}`);
  const payload = asset.payloads.accessors[accessor.sha256];
  if (!payload) throw new Error(`Native ${asset.role}: missing accessor payload ${accessor.sha256}`);
  const Constructor = ARRAY_TYPES[accessor.componentArrayType];
  if (!Constructor) throw new Error(`Native ${asset.role}: unsupported component array ${accessor.componentArrayType}`);
  const bytes = decodeBase64(payload.base64);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const itemSize = COMPONENTS[accessor.type];
  if (!itemSize || buffer.byteLength % Constructor.BYTES_PER_ELEMENT !== 0) throw new Error(`Native ${asset.role}: invalid accessor ${accessorIndex}`);
  const array = new Constructor(buffer, 0, buffer.byteLength / Constructor.BYTES_PER_ELEMENT);
  if (array.length !== accessor.count * itemSize) throw new Error(`Native ${asset.role}: accessor ${accessorIndex} has unexpected element count`);
  return { array, count: accessor.count, itemSize, normalized: accessor.normalized };
}

function decodeBase64(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
    return result;
  }
  const BufferCtor = (globalThis as typeof globalThis & { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
  if (BufferCtor) return new Uint8Array(BufferCtor.from(base64, 'base64'));
  throw new Error('Native assets require atob or Node Buffer for base64 decoding');
}

/** Decode one native embedded image using the per-image ImageBitmap options from the exporter. */
export async function decodeNativeImage(asset: NativeAsset, imageIndex: number): Promise<ImageBitmap> {
  const image = asset.effective.images[imageIndex];
  if (!image) throw new Error(`Native ${asset.role}: missing image ${imageIndex} payload`);
  const payload = asset.payloads.images[image.sha256];
  if (!payload) throw new Error(`Native ${asset.role}: missing image ${imageIndex} payload`);
  if (payload.sha256 !== image.sha256 || payload.mimeType !== image.mimeType || payload.byteLength !== image.byteLength) {
    throw new Error(`Native ${asset.role}: image ${imageIndex} payload metadata mismatch`);
  }
  if (typeof createImageBitmap !== 'function' || typeof Blob !== 'function') {
    throw new Error('Native image decoding requires browser ImageBitmap APIs (createImageBitmap and Blob)');
  }
  const bytes = decodeBase64(payload.base64);
  if (bytes.byteLength !== image.byteLength) throw new Error(`Native ${asset.role}: image ${imageIndex} payload length mismatch`);
  const imageBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(imageBuffer).set(bytes);
  const blob = new Blob([imageBuffer], { type: image.mimeType });
  return createImageBitmap(blob, { ...image.decodeOptions });
}

function enumValue(value: number, values: Record<number, number>, fallback: number, label: string): number {
  const mapped = values[value];
  if (mapped === undefined) throw new Error(`Unsupported native ${label} value ${value}`);
  return mapped ?? fallback;
}
const WRAPS: Record<number, number> = { 33071: ClampToEdgeWrapping, 33648: MirroredRepeatWrapping, 10497: RepeatWrapping };
const FILTERS: Record<number, number> = {
  9728: NearestFilter, 9729: LinearFilter, 9984: NearestMipmapNearestFilter,
  9985: LinearMipmapNearestFilter, 9986: NearestMipmapLinearFilter, 9987: LinearMipmapLinearFilter,
};

function textureFor(asset: NativeAsset, map: Record<string, any>, images: NativeDecodedImages, textures: Texture[]): Texture | null {
  if (!map || map.textureIndex == null) return null;
  const bitmap = images[map.imageIndex];
  if (!bitmap) throw new Error(`Native ${asset.role}: decoded image ${map.imageIndex} required by texture ${map.textureIndex} is missing`);
  const sampler = map.sampler ?? {};
  const texture = new Texture(bitmap);
  texture.name = `native-${asset.role}-texture-${map.textureIndex}`;
  texture.flipY = false;
  texture.colorSpace = map.colorSpace === 'SRGBColorSpace' ? SRGBColorSpace : '';
  texture.wrapS = enumValue(sampler.wrapS ?? 10497, WRAPS, RepeatWrapping, 'wrapS') as typeof texture.wrapS;
  texture.wrapT = enumValue(sampler.wrapT ?? 10497, WRAPS, RepeatWrapping, 'wrapT') as typeof texture.wrapT;
  texture.magFilter = enumValue(sampler.magFilter ?? 9729, FILTERS, LinearFilter, 'magFilter') as typeof texture.magFilter;
  texture.minFilter = enumValue(sampler.minFilter ?? 9987, FILTERS, LinearMipmapLinearFilter, 'minFilter') as typeof texture.minFilter;
  texture.generateMipmaps = texture.minFilter !== NearestFilter && texture.minFilter !== LinearFilter;
  texture.channel = map.channel ?? map.texCoord ?? 0;
  if (map.transform) {
    texture.offset.fromArray(map.transform.offset ?? [0, 0]);
    texture.repeat.fromArray(map.transform.repeat ?? [1, 1]);
    texture.rotation = map.transform.rotation ?? 0;
    texture.updateMatrix();
  }
  texture.needsUpdate = true;
  textures.push(texture);
  return texture;
}

function makeMaterial(asset: NativeAsset, record: Record<string, any>, variant: Record<string, any> | undefined, images: NativeDecodedImages, owned: (MeshStandardMaterial | MeshPhysicalMaterial | MeshBasicMaterial)[], textures: Texture[]) {
  const maps = record.maps ?? {};
  const material = record.class === 'MeshPhysicalMaterial' ? new MeshPhysicalMaterial() : record.class === 'MeshBasicMaterial' ? new MeshBasicMaterial() : new MeshStandardMaterial();
  material.name = record.name ?? '';
  const color = record.baseColorFactor ?? [1, 1, 1, 1];
  material.color.setRGB(color[0], color[1], color[2], LinearSRGBColorSpace);
  material.opacity = color[3];
  if (material instanceof MeshStandardMaterial) {
    material.metalness = record.metallicFactor ?? 1;
    material.roughness = record.roughnessFactor ?? 1;
  }
  const emissive = record.emissiveFactor ?? [0, 0, 0];
  if (material instanceof MeshStandardMaterial || material instanceof MeshPhysicalMaterial) {
    material.emissive.setRGB(emissive[0], emissive[1], emissive[2], LinearSRGBColorSpace);
    material.emissiveIntensity = record.emissiveStrength ?? 1;
  }
  material.transparent = Boolean(record.transparent);
  material.alphaTest = record.alphaMode === 'MASK' ? record.alphaCutoff ?? 0.5 : 0;
  material.depthWrite = record.alphaMode !== 'BLEND';
  material.side = record.side === 'double' ? DoubleSide : record.side === 'back' ? BackSide : FrontSide;
  if (variant?.vertexColors != null) material.vertexColors = variant.vertexColors;
  if (variant?.flatShading != null && material instanceof MeshStandardMaterial) material.flatShading = variant.flatShading;
  const base = textureFor(asset, maps.baseColor, images, textures);
  if (base) material.map = base;
  const mr = textureFor(asset, maps.metallicRoughness, images, textures);
  if (mr && material instanceof MeshStandardMaterial) { material.metalnessMap = mr; material.roughnessMap = mr; }
  const normal = textureFor(asset, maps.normal, images, textures);
  if (normal && material instanceof MeshStandardMaterial) {
    material.normalMap = normal;
    const scale = variant?.normalScale ?? record.normalScale ?? [1, 1];
    material.normalScale.set(scale[0], scale[1]);
  }
  const occlusion = textureFor(asset, maps.occlusion, images, textures);
  if (occlusion && material instanceof MeshStandardMaterial) { material.aoMap = occlusion; material.aoMapIntensity = record.occlusionStrength ?? 1; }
  const emissiveMap = textureFor(asset, maps.emissive, images, textures);
  if (emissiveMap && (material instanceof MeshStandardMaterial || material instanceof MeshPhysicalMaterial)) material.emissiveMap = emissiveMap;
  owned.push(material);
  return material;
}

function nativeGeometry(asset: NativeAsset, primitive: Record<string, any>, weightRecord: Record<string, any> | undefined, owned: BufferGeometry[]): BufferGeometry {
  const geometry = new BufferGeometry();
  const attributes = primitive.attributes as Record<string, number>;
  for (const [name, index] of Object.entries(attributes)) {
    const data = accessorArray(asset, index);
    const attributeName = name === 'POSITION' ? 'position' : name === 'NORMAL' ? 'normal' : name === 'TANGENT' ? 'tangent' : name === 'TEXCOORD_0' ? 'uv' : name === 'TEXCOORD_1' ? 'uv1' : name === 'COLOR_0' ? 'color' : name === 'JOINTS_0' ? 'skinIndex' : name === 'WEIGHTS_0' ? 'skinWeight' : name.toLowerCase();
    geometry.setAttribute(attributeName, new BufferAttribute(data.array as unknown as BufferAttribute['array'], data.itemSize, data.normalized));
  }
  if (primitive.indices != null) {
    const data = accessorArray(asset, primitive.indices);
    geometry.setIndex(new BufferAttribute(data.array as any, data.itemSize, data.normalized));
  }
  if (weightRecord) {
    const payload = asset.payloads.effective[weightRecord.payloadSha256];
    if (!payload) throw new Error(`Native ${asset.role}: missing effective skin weights ${weightRecord.payloadSha256}`);
    const weights = decodeBase64(payload.base64);
    const array = new Float32Array(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
    if (array.length !== weightRecord.vertexCount * 4) throw new Error(`Native ${asset.role}: invalid effective skin weights`);
    geometry.setAttribute('skinWeight', new BufferAttribute(array, 4));
  }
  const mode = primitive.mode ?? 4;
  if (mode !== 4) throw new Error('Only TRIANGLES primitive mode is supported');
  owned.push(geometry);
  return geometry;
}

/** Construct the complete native node hierarchy synchronously; decoded ImageBitmaps are supplied by caller. */
export function createNativeModel(asset: NativeAsset, decodedImages: NativeDecodedImages = {}): NativeModel {
  const geometries: BufferGeometry[] = [];
  const materials: (MeshStandardMaterial | MeshPhysicalMaterial | MeshBasicMaterial)[] = [];
  const textures: Texture[] = [];
  const ownedSkeletons: Skeleton[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const item of geometries) item.dispose();
    for (const item of materials) item.dispose();
    for (const item of textures) item.dispose();
    for (const item of ownedSkeletons) item.dispose();
  };
  const ownership: NativeResourceOwnership = { geometries, materials, textures, skeletons: ownedSkeletons, dispose };
  const nodes = new Map<number, Object3D>();
  const skeletons = new Map<number, Skeleton>();
  const variants = asset.effective.materialVariants;
  const jointIndices = new Set<number>();
  for (const skin of asset.effective.skins) for (const index of skin.joints as number[]) jointIndices.add(index);
  try {
    for (const node of asset.effective.nodes) {
      const index = node.sourceIndex as number;
      const object = jointIndices.has(index) ? new Bone() : node.mesh != null ? new Group() : (node.name && /bone|joint|armature/i.test(node.name as string) ? new Bone() : new Object3D());
      object.name = (node.name as string | undefined) ?? '';
      if (node.matrix) object.matrix.fromArray(node.matrix as number[]).decompose(object.position, object.quaternion, object.scale);
      else {
        if (node.translation) object.position.fromArray(node.translation as number[]);
        if (node.rotation) object.quaternion.fromArray(node.rotation as number[]);
        if (node.scale) object.scale.fromArray(node.scale as number[]);
      }
      object.updateMatrix();
      nodes.set(index, object);
    }
    for (const node of asset.effective.nodes) {
      const parent = nodes.get(node.sourceIndex as number)!;
      for (const childIndex of (node.children as number[] | undefined) ?? []) {
        const child = nodes.get(childIndex);
        if (!child) throw new Error(`Native ${asset.role}: missing child node ${childIndex}`);
        parent.add(child);
      }
      if (node.mesh != null) {
        const mesh = asset.effective.meshes[node.mesh as number];
        if (!mesh) throw new Error(`Native ${asset.role}: missing mesh ${node.mesh}`);
        const skinned = node.skin != null;
        const weight = asset.effective.skinWeights[`${node.sourceIndex}:${node.mesh}:0`];
        for (const primitive of mesh.primitives as Record<string, any>[]) {
          const geometry = nativeGeometry(asset, primitive, skinned ? weight : undefined, geometries);
          const vkey = `${node.sourceIndex}:${node.mesh}:${primitive.sourceIndex}`;
          const variant = variants[vkey];
          const matRec = primitive.material == null ? null : asset.effective.materials[primitive.material as number];
          const material = matRec ? makeMaterial(asset, matRec, variant, decodedImages, materials, textures) : new MeshStandardMaterial();
          if (!matRec) materials.push(material);
          const primitiveObject = skinned ? new SkinnedMesh(geometry, material) : new Mesh(geometry, material);
          primitiveObject.name = mesh.name ? nativePrimitiveName(String(mesh.name), primitive.sourceIndex as number) : '';
          (parent as Group).add(primitiveObject);
        }
      }
    }
    for (const skin of asset.effective.skins) {
      const bones = (skin.joints as number[]).map((idx) => {
        const joint = nodes.get(idx);
        if (!joint) throw new Error(`Native ${asset.role}: missing skin joint node ${idx}`);
        if (!(joint instanceof Bone)) {
          const bone = new Bone(); bone.name = joint.name; bone.position.copy(joint.position); bone.quaternion.copy(joint.quaternion); bone.scale.copy(joint.scale);
          for (const child of [...joint.children]) bone.add(child);
          nodes.set(idx, bone);
        }
        return nodes.get(idx) as Bone;
      });
      let inverses: Matrix4[] | undefined;
      if (skin.inverseBindMatrices != null) {
        const data = accessorArray(asset, skin.inverseBindMatrices as number);
        if (data.itemSize !== 16) throw new Error(`Native ${asset.role}: inverse bind matrices must be MAT4`);
        if (!(data.array instanceof Float32Array)) throw new Error('Inverse bind matrix accessor must use FLOAT components');
        const values = data.array;
        inverses = Array.from({ length: data.count }, (_, i) => new Matrix4().fromArray(values.subarray(i * 16, i * 16 + 16)));
      }
      const skeleton = new Skeleton(bones, inverses);
      ownedSkeletons.push(skeleton);
      skeletons.set(skin.sourceIndex as number, skeleton);
    }
    for (const node of asset.effective.nodes) {
      if (node.skin == null || node.mesh == null) continue;
      const skeleton = skeletons.get(node.skin as number);
      const parent = nodes.get(node.sourceIndex as number)!;
      if (!skeleton) throw new Error(`Native ${asset.role}: missing skin ${node.skin}`);
      parent.traverse((object) => { if (object instanceof SkinnedMesh) object.bind(skeleton, new Matrix4()); });
    }
    const root = new Group(); root.name = `native-${asset.role}`;
    const sceneIndex = typeof asset.raw.gltf.scene === 'number' ? asset.raw.gltf.scene : 0;
    const scenes = asset.raw.gltf.scenes as { nodes?: number[] }[] | undefined;
    const scene = scenes?.[sceneIndex];
    const rootIndices = scene?.nodes ?? asset.effective.nodes.filter((n) => !asset.effective.nodes.some((p) => (p.children as number[] | undefined)?.includes(n.sourceIndex as number))).map((n) => n.sourceIndex as number);
    for (const index of rootIndices) { const object = nodes.get(index); if (!object) throw new Error(`Native ${asset.role}: missing root node ${index}`); root.add(object); }
    return { root, objects: nodes, ownership };
  } catch (error) { ownership.dispose(); throw error; }
}

/** Construct native animation clips from accessor-backed sampler keyframes. */
export function createNativeAnimationClips(asset: NativeAsset): AnimationClip[] {
  const clips: AnimationClip[] = [];
  for (const animation of asset.effective.animations) {
    const tracks = [];
    for (const channel of animation.channels as Record<string, any>[]) {
      const sampler = (animation.samplers as Record<string, any>[])[channel.sampler];
      if (!sampler) throw new Error(`Native ${asset.role}: missing animation sampler ${channel.sampler}`);
      const time = accessorArray(asset, sampler.input).array as any;
      const value = accessorArray(asset, sampler.output).array as any;
      const node = asset.effective.nodes[channel.target.node];
      if (!node) throw new Error(`Native ${asset.role}: missing animation target node ${channel.target.node}`);
      const targetName = node.name || `node${node.sourceIndex}`;
      const property = channel.target.path === 'translation' ? 'position' : channel.target.path === 'rotation' ? 'quaternion' : channel.target.path;
      const trackName = `${targetName}.${property}`;
      let track;
      if (channel.target.path === 'rotation') track = new QuaternionKeyframeTrack(trackName, time, value);
      else if (channel.target.path === 'translation' || channel.target.path === 'scale') track = new VectorKeyframeTrack(trackName, time, value);
      else if (channel.target.path === 'weights') track = new NumberKeyframeTrack(trackName, time, value);
      else throw new Error(`Native ${asset.role}: unsupported animation path ${channel.target.path}`);
      if (sampler.interpolation === 'STEP') track.setInterpolation(2300);
      else if (sampler.interpolation !== 'LINEAR' && sampler.interpolation !== 'CUBICSPLINE') throw new Error('Unsupported animation interpolation');
      if (sampler.interpolation === 'CUBICSPLINE') throw new Error('Cubic spline animation is unsupported');
      tracks.push(track);
    }
    clips.push(new AnimationClip(typeof animation.name === 'string' ? animation.name : '', -1, tracks));
  }
  return clips;
}
