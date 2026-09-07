import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import {
  Zip,
  ZipPassThrough,
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from 'three/examples/jsm/libs/fflate.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Formats exposed by the showcase viewer. */
export type ExportFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'ply' | 'usdz';

export interface ExportFormatDefinition {
  format: ExportFormat;
  label: string;
  note: string;
  keeps: string;
  limits: string;
}

export const EXPORT_FORMATS: ReadonlyArray<ExportFormatDefinition> = [
  {
    format: 'glb',
    label: 'GLB',
    note: 'binary glTF — hierarchy, materials, textures, rig & clips',
    keeps: 'Mesh hierarchy and names, PBR materials, embedded textures, UVs, normals, vertex colours, morphs, skin weights, armatures and portable animation clips.',
    limits: 'Procedural JavaScript motion, runtime VFX, post-processing and custom shader behaviour cannot be reconstructed in Blender or other DCC tools.',
  },
  {
    format: 'gltf',
    label: 'glTF',
    note: 'same portable scene as readable JSON',
    keeps: 'The same scene data as GLB: hierarchy, names, materials, embedded textures, rigging, morphs and portable clips, stored as readable JSON.',
    limits: 'Runtime VFX, JavaScript controllers, post-processing and custom shader behaviour are outside the glTF interchange format.',
  },
  {
    format: 'obj',
    label: 'OBJ',
    note: 'named meshes + geometry + normals + UVs',
    keeps: 'Current posed geometry, named mesh boundaries, normals and UV coordinates.',
    limits: 'This single-file OBJ has no MTL, image textures, material graph, rig, skin weights, morph targets, clips or runtime VFX.',
  },
  {
    format: 'stl',
    label: 'STL',
    note: 'baked triangles — for 3D printing',
    keeps: 'Current posed surface as validated binary triangles.',
    limits: 'Hierarchy, part names, materials, textures, colours, UVs, rigging, morphs, animation and VFX are not represented.',
  },
  {
    format: 'ply',
    label: 'PLY',
    note: 'baked geometry + existing vertex colours',
    keeps: 'Current posed geometry, normals, UV coordinates and vertex colours that already exist on the source meshes.',
    limits: 'The assembly is flattened; named parts, material graphs, image textures, rigging, morphs, clips and VFX are omitted.',
  },
  {
    format: 'usdz',
    label: 'USDZ',
    note: 'posed AR preview with normalized materials',
    keeps: 'Current posed geometry plus Quick Look-compatible normalized PBR materials and portable image textures.',
    limits: 'Three.js r169 exports a posed preview, not editable armatures or clips; custom shaders, procedural motion and runtime VFX are approximated or omitted.',
  },
];

/** A deliberately declared, independently exportable model within a showcase assembly. */
export interface ExportModelScope {
  id: string;
  label: string;
  root: THREE.Object3D;
}

export interface ExportReport {
  format: ExportFormat;
  bytes: number;
  meshCount: number;
  triangleCount: number;
  namedPartCount: number;
  materialCount: number;
  portableMaterialCount: number;
  textureCount: number;
  portableTextureCount: number;
  texturedMaterialCount: number;
  textureBindingCount: number;
  uvMeshCount: number;
  vertexColourMeshCount: number;
  skinnedMeshCount: number;
  jointCount: number;
  sourceAnimationCount: number;
  animationCount: number;
  animationTrackCount: number;
  morphTargetCount: number;
  instanceCount: number;
  roundTripValidated: boolean;
  warnings: string[];
}

export interface ExportArtifact {
  blob: Blob;
  filenameExtension: ExportFormat;
  report: ExportReport;
}

export interface ExportBundleProgress {
  format: ExportFormat;
  label: string;
  index: number;
  total: number;
}

export interface ExportBundleArtifact {
  blob: Blob;
  filename: string;
  files: string[];
  reports: ExportReport[];
}

export interface ExportBundleOptions {
  assetId: string;
  scopeId: string;
  scopeLabel: string;
  snapshot?: ExportSnapshot;
  selectedRoot?: THREE.Object3D;
  onProgress?: (progress: ExportBundleProgress) => void;
}

/**
 * Viewer tools such as explode, isolate and rig-debug temporarily alter the live model. The viewer
 * supplies a synchronous snapshot boundary so cloning sees the authored assembly while animation
 * bones retain the pose currently displayed on stage.
 */
export type ExportSnapshot = <T>(snapshot: () => T) => T;

interface AssetInventory {
  meshCount: number;
  triangleCount: number;
  namedPartCount: number;
  materialCount: number;
  portableMaterialCount: number;
  textureCount: number;
  texturedMaterialCount: number;
  portableTextureCount: number;
  textureBindingCount: number;
  uvMeshCount: number;
  skinnedMeshCount: number;
  jointCount: number;
  morphTargetCount: number;
  vertexColourMeshCount: number;
  instancedMeshCount: number;
  instanceCount: number;
  unsupportedRenderableCount: number;
  nonPbrMaterialCount: number;
  namedParts: string[];
}

interface PreparedAnimations {
  clips: THREE.AnimationClip[];
  sourceCount: number;
  droppedTracks: number;
}

const ROUND_TRIP_TRIANGLE_LIMIT = 750_000;
const INSTANCE_SCALE_EPSILON = 1e-8;
const COMPONENT_INDEX: Readonly<Record<string, number>> = { x: 0, y: 1, z: 2, w: 3 };
const DIRECT_GLTF_TEXTURE_KEYS = [
  'map',
  'emissiveMap',
  'normalMap',
  'aoMap',
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'transmissionMap',
  'thicknessMap',
  'specularIntensityMap',
  'specularColorMap',
  'sheenRoughnessMap',
  'sheenColorMap',
  'anisotropyMap',
  'bumpMap',
] as const;

function isAnimationClip(value: unknown): value is THREE.AnimationClip {
  return value instanceof THREE.AnimationClip
    || (!!value && typeof value === 'object' && Array.isArray((value as THREE.AnimationClip).tracks));
}

/** Collect clips from every runtime contract used by the showcase, including lazy child rigs. */
export function animationsFor(root: THREE.Object3D): THREE.AnimationClip[] {
  const clips: THREE.AnimationClip[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const clip of value) {
      if (!isAnimationClip(clip)) continue;
      const key = clip.uuid || `${clip.name}:${clip.duration}:${clip.tracks.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clips.push(clip);
    }
  };

  root.traverse((node) => {
    add(node.animations);
    add(node.userData.animationClips);
    const rigged = node.userData.rigged as { clips?: unknown } | undefined;
    add(rigged?.clips);
    const runtime = node.userData.sculptRuntime as {
      animationClips?: unknown;
      clips?: unknown;
    } | undefined;
    add(runtime?.animationClips);
    add(runtime?.clips);
  });
  return clips;
}

function hasVisibleExportMesh(root: THREE.Object3D): boolean {
  let found = false;
  root.traverseVisible((node) => {
    if ((node as THREE.Mesh).isMesh) found = true;
  });
  return found;
}

function belongsToAssembly(assembly: THREE.Object3D, candidate: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = candidate;
  while (current) {
    if (current === assembly) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Read the explicit multi-model contract from a showcase root. This intentionally does not infer
 * models from child groups: characters and procedural objects often use the same structure for
 * bones, parts and VFX, so inference would present a destructive and misleading export choice.
 */
export function exportModelsFor(assembly: THREE.Group): ExportModelScope[] {
  const runtime = assembly.userData.sculptRuntime as { exportModels?: unknown } | undefined;
  const declared = assembly.userData.exportModels ?? runtime?.exportModels;
  if (!Array.isArray(declared)) return [];

  const result: ExportModelScope[] = [];
  const ids = new Set<string>();
  const roots = new Set<THREE.Object3D>();
  for (const value of declared) {
    if (!value || typeof value !== 'object') continue;
    const item = value as { id?: unknown; label?: unknown; root?: unknown };
    if (typeof item.id !== 'string' || typeof item.label !== 'string') continue;
    const root = item.root as THREE.Object3D | undefined;
    if (!root?.isObject3D || root === assembly || !belongsToAssembly(assembly, root)) continue;
    const id = item.id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const label = item.label.trim();
    if (!id || !label || ids.has(id) || roots.has(root) || !hasVisibleExportMesh(root)) continue;
    ids.add(id);
    roots.add(root);
    result.push({ id, label, root });
  }
  return result;
}

function materialList(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function usedMaterialList(mesh: THREE.Mesh): THREE.Material[] {
  if (!Array.isArray(mesh.material)) return [mesh.material];
  const materials = mesh.material;
  if (!mesh.geometry.groups.length) return [];
  const indices = new Set(mesh.geometry.groups.map((group) => group.materialIndex ?? 0));
  return [...indices]
    .map((index) => materials[index])
    .filter((material): material is THREE.Material => !!material);
}

function allMaterialTextures(material: THREE.Material): THREE.Texture[] {
  const textures = new Set<THREE.Texture>();
  const add = (value: unknown): void => {
    if (value instanceof THREE.Texture) textures.add(value);
    else if (Array.isArray(value)) for (const item of value) add(item);
  };
  const record = material as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) add(value);
  const shader = material as THREE.ShaderMaterial;
  if (shader.isShaderMaterial) {
    for (const uniform of Object.values(shader.uniforms)) add(uniform?.value);
  }
  return [...textures];
}

/** Texture slots which GLTFExporter r169 can map to core glTF or a registered material extension. */
function portableMaterialTextures(material: THREE.Material): {
  textures: THREE.Texture[];
  bindingCount: number;
} {
  const record = material as unknown as Record<string, unknown>;
  const textures = new Set<THREE.Texture>();
  let bindingCount = 0;
  for (const key of DIRECT_GLTF_TEXTURE_KEYS) {
    const value = record[key];
    if (!(value instanceof THREE.Texture)) continue;
    textures.add(value);
    bindingCount += 1;
  }
  // glTF packs these two scalar channels into one metallic-roughness texture binding.
  const metalness = record.metalnessMap;
  const roughness = record.roughnessMap;
  if (metalness instanceof THREE.Texture || roughness instanceof THREE.Texture) {
    if (metalness instanceof THREE.Texture) textures.add(metalness);
    if (roughness instanceof THREE.Texture) textures.add(roughness);
    bindingCount += 1;
  }
  return { textures: [...textures], bindingCount };
}

function dataTextureAsCanvas(texture: THREE.DataTexture): THREE.Texture {
  const image = texture.image as {
    data?: ArrayLike<number>;
    width?: number;
    height?: number;
  };
  const width = image.width ?? 0;
  const height = image.height ?? 0;
  const source = image.data;
  if (!source || width < 1 || height < 1 || typeof document === 'undefined') return texture;
  const pixels = width * height;
  const channels = Math.max(1, Math.min(4, Math.round(source.length / pixels)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return texture;
  const rgba = context.createImageData(width, height);
  const maximum = source instanceof Uint16Array ? 65535
    : source instanceof Float32Array ? 1
      : 255;
  const byte = (value: number): number => Math.round(THREE.MathUtils.clamp(value / maximum, 0, 1) * 255);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = pixel * channels;
    const out = pixel * 4;
    const r = byte(source[at] ?? 0);
    const g = channels > 1 ? byte(source[at + 1] ?? 0) : r;
    const b = channels > 2 ? byte(source[at + 2] ?? 0) : r;
    rgba.data[out] = r;
    rgba.data[out + 1] = g;
    rgba.data[out + 2] = b;
    rgba.data[out + 3] = channels > 3 ? byte(source[at + 3] ?? maximum) : 255;
  }
  context.putImageData(rgba, 0, 0);
  const converted = texture.clone();
  converted.source = new THREE.Source(canvas);
  converted.needsUpdate = true;
  return converted;
}

/** GLTFExporter r169 cannot draw raw DataTexture.image records while packing PBR channels. */
function normalizeMaterialTextures(
  material: THREE.Material,
  convertedTextures = new Map<THREE.DataTexture, THREE.Texture>(),
): void {
  const record = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (!(value instanceof THREE.DataTexture)) continue;
    let converted = convertedTextures.get(value);
    if (!converted) {
      converted = dataTextureAsCanvas(value);
      convertedTextures.set(value, converted);
    }
    record[key] = converted;
  }
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3;
}

/**
 * EXT_mesh_gpu_instancing decomposes every matrix to TRS. A valid zero-scale matrix has no
 * recoverable rotation, and Three's Matrix4.decompose() consequently emits a NaN quaternion.
 * Preserve translation/scale and choose the neutral rotation only for those singular instances.
 * Zero scale is raised to a visually inert epsilon because the exporter decomposes the matrix again.
 */
function stabilizeInstanceMatrices(root: THREE.Object3D): number {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const column = new THREE.Vector3();
  let stabilized = 0;
  root.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    let changed = false;
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, matrix);
      matrix.decompose(position, quaternion, scale);
      if ([...position.toArray(), ...quaternion.toArray(), ...scale.toArray()].every(Number.isFinite)) continue;
      const elements = matrix.elements;
      position.set(elements[12], elements[13], elements[14]);
      scale.set(
        Math.max(column.set(elements[0], elements[1], elements[2]).length(), INSTANCE_SCALE_EPSILON),
        Math.max(column.set(elements[4], elements[5], elements[6]).length(), INSTANCE_SCALE_EPSILON),
        Math.max(column.set(elements[8], elements[9], elements[10]).length(), INSTANCE_SCALE_EPSILON),
      );
      quaternion.identity();
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      stabilized += 1;
      changed = true;
    }
    if (changed) mesh.instanceMatrix.needsUpdate = true;
  });
  return stabilized;
}

function inventory(root: THREE.Object3D): AssetInventory {
  const meshNames: string[] = [];
  const bones = new Set<THREE.Bone>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const portableTextures = new Set<THREE.Texture>();
  let meshCount = 0;
  let triangles = 0;
  let uvMeshCount = 0;
  let skinnedMeshCount = 0;
  let morphTargetCount = 0;
  let vertexColourMeshCount = 0;
  let instancedMeshCount = 0;
  let instanceCount = 0;
  let unsupportedRenderableCount = 0;
  let textureBindingCount = 0;
  let texturedMaterialCount = 0;

  root.traverseVisible((node) => {
    if ((node as THREE.Points).isPoints || (node as THREE.Line).isLine || (node as THREE.Sprite).isSprite) {
      unsupportedRenderableCount += 1;
      return;
    }
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount += 1;
    if (mesh.name) meshNames.push(mesh.name);
    const instanced = mesh as THREE.InstancedMesh;
    const copies = instanced.isInstancedMesh ? instanced.count : 1;
    triangles += triangleCount(mesh.geometry) * copies;
    if (instanced.isInstancedMesh) {
      instancedMeshCount += 1;
      instanceCount += instanced.count;
    }
    const skinned = mesh as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      skinnedMeshCount += 1;
      for (const bone of skinned.skeleton.bones) bones.add(bone);
    }
    const targets = Object.values(mesh.geometry.morphAttributes)
      .reduce((max, attrs) => Math.max(max, attrs.length), 0);
    morphTargetCount += targets;
    if (mesh.geometry.getAttribute('uv')) uvMeshCount += 1;
    if (mesh.geometry.getAttribute('color')) vertexColourMeshCount += 1;
    for (const material of usedMaterialList(mesh)) materials.add(material);
  });

  let nonPbrMaterialCount = 0;
  let portableMaterialCount = 0;
  for (const material of materials) {
    const materialTextures = allMaterialTextures(material);
    if (materialTextures.length) texturedMaterialCount += 1;
    for (const texture of materialTextures) textures.add(texture);
    const portable = portableMaterialTextures(material);
    textureBindingCount += portable.bindingCount;
    for (const texture of portable.textures) portableTextures.add(texture);
    if (!(material as THREE.MeshStandardMaterial).isMeshStandardMaterial
      && !(material as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
      nonPbrMaterialCount += 1;
    }
    if (!(material as THREE.ShaderMaterial).isShaderMaterial) portableMaterialCount += 1;
  }

  return {
    meshCount,
    triangleCount: Math.round(triangles),
    namedPartCount: meshNames.length,
    materialCount: materials.size,
    portableMaterialCount,
    textureCount: textures.size,
    texturedMaterialCount,
    portableTextureCount: portableTextures.size,
    textureBindingCount,
    uvMeshCount,
    skinnedMeshCount,
    jointCount: bones.size,
    morphTargetCount,
    vertexColourMeshCount,
    instancedMeshCount,
    instanceCount,
    unsupportedRenderableCount,
    nonPbrMaterialCount,
    // Mesh names are the DCC-facing physical parts and must survive byte-for-byte (or through the
    // exporter's documented PropertyBinding sanitization). Named parent groups still contribute to
    // namedPartCount and hierarchy, but are not a reliable identity contract after importer grouping.
    namedParts: meshNames,
  };
}

function runtimeCapabilities(root: THREE.Object3D): {
  hasAnimationController: boolean;
  hasVfxRuntime: boolean;
} {
  let hasAnimationController = false;
  let hasVfxRuntime = false;
  root.traverse((node) => {
    const runtime = node.userData.sculptRuntime as {
      animationController?: unknown;
      strikeVfx?: unknown;
      vfx?: unknown;
    } | undefined;
    if (runtime?.animationController) hasAnimationController = true;
    if (runtime?.strikeVfx || runtime?.vfx) hasVfxRuntime = true;
    if ((node as THREE.Points).isPoints || (node as THREE.Line).isLine || (node as THREE.Sprite).isSprite) {
      hasVfxRuntime = true;
    }
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && materialList(mesh).some((material) => (material as THREE.ShaderMaterial).isShaderMaterial)) {
      hasVfxRuntime = true;
    }
  });
  return { hasAnimationController, hasVfxRuntime };
}

/** Fail before an exporter turns broken geometry or skinning into a plausible-looking file. */
function validateGeometry(root: THREE.Object3D): AssetInventory {
  root.updateMatrixWorld(true);
  let visibleMeshes = 0;
  const matrix = new THREE.Matrix4();
  const instancePosition = new THREE.Vector3();
  const instanceQuaternion = new THREE.Quaternion();
  const instanceScale = new THREE.Vector3();
  root.traverseVisible((node) => {
    if (!node.matrixWorld.elements.every(Number.isFinite)) {
      throw new Error(`Export failed: ${node.name || node.type} has a non-finite world transform`);
    }
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    visibleMeshes += 1;
    const position = mesh.geometry.getAttribute('position');
    if (!position || position.count < 3) {
      throw new Error(`Export failed: ${mesh.name || 'mesh'} has no triangle positions`);
    }
    for (let i = 0; i < position.count; i += 1) {
      for (let component = 0; component < position.itemSize; component += 1) {
        if (!Number.isFinite(position.getComponent(i, component))) {
          throw new Error(`Export failed: ${mesh.name || 'mesh'} contains a non-finite vertex`);
        }
      }
    }
    const index = mesh.geometry.getIndex();
    const count = index?.count ?? position.count;
    if (!count || count % 3 !== 0) {
      throw new Error(`Export failed: ${mesh.name || 'mesh'} is not triangle geometry`);
    }
    if (index) {
      for (let i = 0; i < index.count; i += 1) {
        const value = index.getX(i);
        if (!Number.isInteger(value) || value < 0 || value >= position.count) {
          throw new Error(`Export failed: ${mesh.name || 'mesh'} has an out-of-range index`);
        }
      }
    }
    for (const [name, attrs] of Object.entries(mesh.geometry.morphAttributes)) {
      for (const attribute of attrs) {
        if (attribute.count !== position.count) {
          throw new Error(`Export failed: ${mesh.name || 'mesh'} morph ${name} has the wrong vertex count`);
        }
      }
    }

    const instanced = mesh as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      if (!Number.isInteger(instanced.count) || instanced.count < 1) {
        throw new Error(`Export failed: ${mesh.name || 'instanced mesh'} has no instances`);
      }
      for (let i = 0; i < instanced.count; i += 1) {
        instanced.getMatrixAt(i, matrix);
        if (!matrix.elements.every(Number.isFinite)) {
          throw new Error(`Export failed: ${mesh.name || 'instanced mesh'} instance ${i} has an invalid transform`);
        }
        matrix.decompose(instancePosition, instanceQuaternion, instanceScale);
        if (![...instancePosition.toArray(), ...instanceQuaternion.toArray(), ...instanceScale.toArray()]
          .every(Number.isFinite)) {
          throw new Error(
            `Export failed: ${mesh.name || 'instanced mesh'} instance ${i} cannot be represented as glTF TRS`,
          );
        }
      }
    }

    const skinned = mesh as THREE.SkinnedMesh;
    if (!skinned.isSkinnedMesh) return;
    const skinIndex = mesh.geometry.getAttribute('skinIndex');
    const skinWeight = mesh.geometry.getAttribute('skinWeight');
    if (!skinIndex || !skinWeight || skinIndex.count !== position.count || skinWeight.count !== position.count) {
      throw new Error(`Export failed: ${mesh.name || 'skinned mesh'} has incomplete skin attributes`);
    }
    if (!skinned.skeleton.bones.length || skinned.skeleton.boneInverses.length !== skinned.skeleton.bones.length) {
      throw new Error(`Export failed: ${mesh.name || 'skinned mesh'} has an incomplete skeleton`);
    }
    for (let i = 0; i < skinIndex.count; i += 1) {
      let weight = 0;
      for (let component = 0; component < skinIndex.itemSize; component += 1) {
        const joint = skinIndex.getComponent(i, component);
        const influence = skinWeight.getComponent(i, component);
        if (!Number.isFinite(joint) || joint < 0 || joint >= skinned.skeleton.bones.length) {
          throw new Error(`Export failed: ${mesh.name || 'skinned mesh'} vertex ${i} targets an invalid joint`);
        }
        if (!Number.isFinite(influence) || influence < 0) {
          throw new Error(`Export failed: ${mesh.name || 'skinned mesh'} vertex ${i} has an invalid skin weight`);
        }
        weight += influence;
      }
      if (weight < 1e-6) {
        throw new Error(`Export failed: ${mesh.name || 'skinned mesh'} vertex ${i} has zero total skin weight`);
      }
    }
  });
  if (!visibleMeshes) throw new Error('Export failed: the authored model has no visible mesh');
  const result = inventory(root);
  if (!result.triangleCount) throw new Error('Export failed: the authored model contains zero triangles');
  return result;
}

/**
 * Clone without live mixers, closures or inspector overlays. UUIDs are intentionally retained on the
 * isolated clone so clips authored against UUID track targets can still resolve during serialization.
 */
function cloneForExport(source: THREE.Group, selectedRoot?: THREE.Object3D): THREE.Group {
  const saved = new Map<THREE.Object3D, Record<string, unknown>>();
  const sourceNodes: THREE.Object3D[] = [];
  source.traverse((node) => {
    sourceNodes.push(node);
    saved.set(node, node.userData);
    node.userData = {};
  });
  const selectedIndex = selectedRoot ? sourceNodes.indexOf(selectedRoot) : -1;
  if (selectedRoot && selectedIndex < 0) {
    for (const [node, data] of saved) node.userData = data;
    throw new Error('Export failed: the selected model is not part of this showcase assembly');
  }
  try {
    const clean = cloneSkeleton(source) as THREE.Group;
    const cleanNodes: THREE.Object3D[] = [];
    clean.traverse((node) => {
      cleanNodes.push(node);
      node.userData = {};
    });
    const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    const materials = new Map<THREE.Material, THREE.Material>();
    const convertedTextures = new Map<THREE.DataTexture, THREE.Texture>();
    for (let i = 0; i < Math.min(sourceNodes.length, cleanNodes.length); i += 1) {
      cleanNodes[i].uuid = sourceNodes[i].uuid;
      const sourceMesh = sourceNodes[i] as THREE.Mesh;
      const cleanMesh = cleanNodes[i] as THREE.Mesh;
      if (!sourceMesh.isMesh || !cleanMesh.isMesh) continue;
      let geometry = geometries.get(sourceMesh.geometry);
      if (!geometry) {
        geometry = sourceMesh.geometry.clone();
        geometries.set(sourceMesh.geometry, geometry);
      }
      cleanMesh.geometry = geometry;
      const cloneMaterial = (sourceMaterial: THREE.Material): THREE.Material => {
        let material = materials.get(sourceMaterial);
        if (!material) {
          material = sourceMaterial.clone();
          normalizeMaterialTextures(material, convertedTextures);
          materials.set(sourceMaterial, material);
        }
        return material;
      };
      cleanMesh.material = Array.isArray(sourceMesh.material)
        ? sourceMesh.material.map(cloneMaterial)
        : cloneMaterial(sourceMesh.material);
    }
    if (selectedRoot && selectedRoot !== source) {
      const cleanSelection = cleanNodes[selectedIndex];
      if (!cleanSelection) throw new Error('Export failed: the selected model could not be cloned');
      // Retain the complete selected subtree and its transform-bearing ancestor chain. Every sibling
      // branch is removed, preserving the selected model's scale/pose relative to the showcase root.
      let kept: THREE.Object3D = cleanSelection;
      while (kept !== clean) {
        const parent = kept.parent;
        if (!parent) throw new Error('Export failed: the selected model clone lost its parent chain');
        for (const sibling of [...parent.children]) {
          if (sibling !== kept) parent.remove(sibling);
        }
        kept = parent;
      }
    }
    // Viewer selection glows are removed synchronously by withAssetExportState() before cloning.
    // Authored VFX also use isHighlight to stay out of picking/framing, so filtering that flag here
    // incorrectly stripped real points, lines and effect meshes from exported GLB/glTF assets.
    clean.name ||= 'img2threejs-asset';
    clean.updateMatrixWorld(true);
    return clean;
  } finally {
    for (const [node, data] of saved) node.userData = data;
  }
}

function resolveTrackTarget(
  root: THREE.Object3D,
  binding: ReturnType<typeof THREE.PropertyBinding.parseTrackName>,
): THREE.Object3D | undefined {
  let target = THREE.PropertyBinding.findNode(root, binding.nodeName) as THREE.Object3D | undefined;
  if (binding.objectName === 'bones') {
    const skinned = target as THREE.SkinnedMesh | undefined;
    target = skinned?.isSkinnedMesh
      ? skinned.skeleton.getBoneByName(binding.objectIndex) ?? undefined
      : undefined;
  }
  return target;
}

function sampledTimes(tracks: THREE.KeyframeTrack[], duration: number): number[] {
  const values = new Set<number>([0, Math.max(0, duration)]);
  for (const track of tracks) for (const time of track.times) values.add(time);
  const frames = Math.ceil(Math.max(0, duration) * 60);
  for (let frame = 1; frame < frames; frame += 1) values.add(frame / 60);
  return [...values].filter(Number.isFinite).sort((a, b) => a - b);
}

function componentTrack(
  target: THREE.Object3D,
  property: 'position' | 'scale' | 'quaternion',
  tracks: THREE.KeyframeTrack[],
  duration: number,
): THREE.KeyframeTrack {
  const width = property === 'quaternion' ? 4 : 3;
  const base = property === 'quaternion'
    ? target.quaternion.toArray()
    : target[property].toArray();
  const times = sampledTimes(tracks, duration);
  const interpolants = tracks.map((track) => ({
    track,
    binding: THREE.PropertyBinding.parseTrackName(track.name),
    interpolant: track.createInterpolant(),
  }));
  const values: number[] = [];
  for (const time of times) {
    const current = [...base];
    for (const entry of interpolants) {
      const sampled = entry.interpolant.evaluate(time);
      const component = COMPONENT_INDEX[entry.binding.propertyIndex];
      if (component !== undefined) current[component] = sampled[0];
      else for (let i = 0; i < Math.min(width, sampled.length); i += 1) current[i] = sampled[i];
    }
    values.push(...current);
  }
  const name = `${target.uuid}.${property}`;
  return property === 'quaternion'
    ? new THREE.QuaternionKeyframeTrack(name, times, values)
    : new THREE.VectorKeyframeTrack(name, times, values);
}

/** Convert component/Euler tracks to glTF-native TRS tracks and remove non-portable runtime tracks. */
function prepareAnimations(root: THREE.Object3D, source: THREE.AnimationClip[]): PreparedAnimations {
  let droppedTracks = 0;
  const clips: THREE.AnimationClip[] = [];
  for (const sourceClip of source) {
    const duration = sourceClip.duration >= 0
      ? sourceClip.duration
      : sourceClip.clone().resetDuration().duration;
    const direct: THREE.KeyframeTrack[] = [];
    const grouped = new Map<string, {
      target: THREE.Object3D;
      property: 'rotation' | 'position' | 'scale' | 'quaternion';
      tracks: THREE.KeyframeTrack[];
    }>();
    for (const track of sourceClip.tracks) {
      let binding: ReturnType<typeof THREE.PropertyBinding.parseTrackName>;
      try {
        binding = THREE.PropertyBinding.parseTrackName(track.name);
      } catch {
        droppedTracks += 1;
        continue;
      }
      const target = resolveTrackTarget(root, binding);
      if (!target) {
        droppedTracks += 1;
        continue;
      }
      const property = binding.propertyName;
      if (property === 'rotation' || (
        (property === 'position' || property === 'scale' || property === 'quaternion')
        && binding.propertyIndex
      )) {
        const key = `${target.uuid}:${property}`;
        const entry = grouped.get(key) ?? {
          target,
          property,
          tracks: [],
        };
        entry.tracks.push(track);
        grouped.set(key, entry);
        continue;
      }
      if (property === 'position' || property === 'scale' || property === 'quaternion'
        || property === 'morphTargetInfluences') {
        direct.push(track.clone());
      } else {
        droppedTracks += 1;
      }
    }
    for (const entry of grouped.values()) {
      if (entry.property === 'rotation') {
        const times = sampledTimes(entry.tracks, duration);
        const interpolants = entry.tracks.map((track) => ({
          binding: THREE.PropertyBinding.parseTrackName(track.name),
          interpolant: track.createInterpolant(),
        }));
        const base = entry.target.rotation.clone();
        const values: number[] = [];
        const quaternion = new THREE.Quaternion();
        for (const time of times) {
          const euler = base.clone();
          for (const item of interpolants) {
            const sampled = item.interpolant.evaluate(time);
            const component = COMPONENT_INDEX[item.binding.propertyIndex];
            if (component === 0) euler.x = sampled[0];
            else if (component === 1) euler.y = sampled[0];
            else if (component === 2) euler.z = sampled[0];
            else if (sampled.length >= 3) euler.set(sampled[0], sampled[1], sampled[2], base.order);
          }
          quaternion.setFromEuler(euler).toArray(values, values.length);
        }
        direct.push(new THREE.QuaternionKeyframeTrack(
          `${entry.target.uuid}.quaternion`, times, values,
        ));
      } else {
        direct.push(componentTrack(entry.target, entry.property, entry.tracks, duration));
      }
    }
    if (direct.length) clips.push(new THREE.AnimationClip(sourceClip.name, duration, direct));
  }
  return { clips, sourceCount: source.length, droppedTracks };
}

function replaceChild(parent: THREE.Object3D, source: THREE.Object3D, replacement: THREE.Object3D): void {
  const index = parent.children.indexOf(source);
  parent.remove(source);
  parent.add(replacement);
  if (index >= 0) {
    parent.children.splice(parent.children.indexOf(replacement), 1);
    parent.children.splice(index, 0, replacement);
  }
}

/** Bake morphs and skinning into ordinary mesh positions for formats without rig support. */
function bakeDeformedMeshes(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const replacements: Array<{ source: THREE.Mesh; mesh: THREE.Mesh; parent: THREE.Object3D }> = [];
  const vertex = new THREE.Vector3();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const instanced = node as THREE.InstancedMesh;
    if (!mesh.isMesh || !mesh.parent || instanced.isInstancedMesh) return;
    const hasMorphs = !!mesh.morphTargetInfluences?.length;
    const skinned = mesh as THREE.SkinnedMesh;
    if (!skinned.isSkinnedMesh && !hasMorphs) return;
    if (skinned.isSkinnedMesh) skinned.skeleton.update();
    const geometry = mesh.geometry.clone();
    const input = mesh.geometry.getAttribute('position');
    const position = new Float32Array(input.count * 3);
    for (let i = 0; i < input.count; i += 1) {
      mesh.getVertexPosition(i, vertex);
      position[i * 3] = vertex.x;
      position[i * 3 + 1] = vertex.y;
      position[i * 3 + 2] = vertex.z;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.deleteAttribute('skinIndex');
    geometry.deleteAttribute('skinWeight');
    geometry.morphAttributes = {};
    geometry.computeVertexNormals();
    const baked = new THREE.Mesh(geometry, mesh.material);
    baked.name = mesh.name;
    baked.position.copy(mesh.position);
    baked.quaternion.copy(mesh.quaternion);
    baked.scale.copy(mesh.scale);
    baked.visible = mesh.visible;
    baked.castShadow = mesh.castShadow;
    baked.receiveShadow = mesh.receiveShadow;
    for (const child of [...mesh.children]) baked.add(child);
    replacements.push({ source: mesh, mesh: baked, parent: mesh.parent });
  });
  for (const item of replacements) replaceChild(item.parent, item.source, item.mesh);
  root.updateMatrixWorld(true);
  return root;
}

function tintedMaterial(material: THREE.Material, tint: THREE.Color | null): THREE.Material {
  if (!tint) return material;
  const clone = material.clone();
  const coloured = clone as THREE.Material & { color?: THREE.Color };
  if (coloured.color) coloured.color.multiply(tint);
  return clone;
}

/** Expand GPU instances so OBJ/STL/PLY/USDZ receive every physical copy. */
function expandInstances(root: THREE.Group): THREE.Group {
  const replacements: Array<{
    source: THREE.InstancedMesh;
    group: THREE.Group;
    parent: THREE.Object3D;
  }> = [];
  const matrix = new THREE.Matrix4();
  const tint = new THREE.Color();
  root.traverse((node) => {
    const source = node as THREE.InstancedMesh;
    if (!source.isInstancedMesh || !source.parent) return;
    const group = new THREE.Group();
    group.name = source.name || 'instances';
    group.position.copy(source.position);
    group.quaternion.copy(source.quaternion);
    group.scale.copy(source.scale);
    group.visible = source.visible;
    for (let i = 0; i < source.count; i += 1) {
      source.getMatrixAt(i, matrix);
      const instanceTint = source.instanceColor ? (source.getColorAt(i, tint), tint.clone()) : null;
      const materials = materialList(source).map((material) => tintedMaterial(material, instanceTint));
      const mesh = new THREE.Mesh(source.geometry, Array.isArray(source.material) ? materials : materials[0]);
      mesh.name = `${source.name || 'instance'}_${String(i + 1).padStart(3, '0')}`;
      // Inactive particle/VFX slots legitimately use a singular zero-scale matrix. Decomposing a
      // singular matrix divides by zero and produces a NaN quaternion, which then corrupts USDZ.
      // Keeping the authored local matrix verbatim is both lossless and safe for every static writer.
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.castShadow = source.castShadow;
      mesh.receiveShadow = source.receiveShadow;
      group.add(mesh);
    }
    for (const child of [...source.children]) group.add(child);
    replacements.push({ source, group, parent: source.parent });
  });
  for (const item of replacements) replaceChild(item.parent, item.source, item.group);
  root.updateMatrixWorld(true);
  return root;
}

function removeUnsupportedStaticRenderables(root: THREE.Group): THREE.Group {
  const remove: THREE.Object3D[] = [];
  root.traverse((node) => {
    if ((node as THREE.Points).isPoints || (node as THREE.Line).isLine || (node as THREE.Sprite).isSprite) {
      remove.push(node);
    }
  });
  for (const node of remove.reverse()) node.removeFromParent();
  root.updateMatrixWorld(true);
  return root;
}

/**
 * Three's OBJ/STL/PLY exporters traverse every mesh and do not honour Object3D.visible. Remove the
 * top-most hidden subtrees after deformation has been baked so a static "from stage" file contains
 * exactly the same renderable triangles as the inventory the visitor approved.
 */
function removeHiddenStaticSubtrees(root: THREE.Group): THREE.Group {
  const hidden: THREE.Object3D[] = [];
  root.traverse((node) => {
    if (node === root || node.visible) return;
    let ancestor = node.parent;
    while (ancestor && ancestor !== root) {
      if (!ancestor.visible) return;
      ancestor = ancestor.parent;
    }
    hidden.push(node);
  });
  for (const node of hidden) node.removeFromParent();
  root.updateMatrixWorld(true);
  return root;
}

function ownedBuffer(view: ArrayBufferView): ArrayBuffer {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function asBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * r169 writes two UV shader inputs with `token` types and omits the required scale/bias transform
 * for 8-bit normal maps. Repair those declarations and rebuild the uncompressed archive with
 * USDZ's required 64-byte file alignment.
 */
function repairUsdzShaderTypes(source: Uint8Array): Uint8Array {
  const files = unzipSync(source);
  const model = files['model.usda'];
  if (!model) throw new Error('USDZ validation failed: model.usda is missing');
  const original = strFromU8(model);
  const repaired = original
    .replace(/\btoken inputs:varname =/g, 'string inputs:varname =')
    .replace(/\btoken inputs:in\.connect =/g, 'float2 inputs:in.connect =')
    .replace(
      /(def Shader "[^"]+_normal"\s*\{\s*uniform token info:id = "UsdUVTexture"\s*\n)/g,
      '$1\t\t\tfloat4 inputs:scale = (2, 2, 2, 1)\n\t\t\tfloat4 inputs:bias = (-1, -1, -1, 0)\n',
    );
  if (repaired === original) return source;
  files['model.usda'] = strToU8(repaired);

  type AlignedFile = Uint8Array | [Uint8Array, { extra: Record<number, Uint8Array> }];
  const aligned: Record<string, AlignedFile> = {};
  let offset = 0;
  for (const [filename, file] of Object.entries(files)) {
    // Four bytes are reserved for the extra-field id/length header when padding is present.
    const headerSize = 34 + filename.length;
    offset += headerSize;
    const offsetMod64 = offset & 63;
    if (offsetMod64 !== 4) {
      const padLength = 64 - offsetMod64;
      aligned[filename] = [file, { extra: { 12345: new Uint8Array(padLength) } }];
    } else {
      aligned[filename] = file;
    }
    // Every payload starts at a 64-byte boundary, so only its length affects the next modulo.
    offset = file.length;
  }
  return zipSync(aligned, { level: 0 });
}

function gltfJsonFromGlb(buffer: ArrayBuffer): Record<string, unknown> {
  if (buffer.byteLength < 20) throw new Error('GLB validation failed: truncated header');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('GLB validation failed: wrong magic');
  if (view.getUint32(4, true) !== 2) throw new Error('GLB validation failed: unsupported version');
  if (view.getUint32(8, true) !== buffer.byteLength) {
    throw new Error('GLB validation failed: declared length differs from file size');
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > buffer.byteLength) {
    throw new Error('GLB validation failed: invalid JSON chunk');
  }
  const json = new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)).trimEnd();
  return JSON.parse(json) as Record<string, unknown>;
}

function expectedAnimationChannels(clip: THREE.AnimationClip): number {
  let channels = 0;
  const morphTargets = new Set<string>();
  for (const track of clip.tracks) {
    const binding = THREE.PropertyBinding.parseTrackName(track.name);
    if (binding.propertyName === 'morphTargetInfluences') {
      morphTargets.add(`${binding.nodeName}:${binding.objectName}:${binding.objectIndex}`);
    } else {
      channels += 1;
    }
  }
  return channels + morphTargets.size;
}

function gltfMaterialTextureIndices(materials: unknown[]): number[] {
  const indices: number[] = [];
  const visit = (value: unknown, key = ''): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (key.endsWith('Texture') && typeof record.index === 'number') {
      indices.push(record.index);
      return;
    }
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  for (const material of materials) visit(material);
  return indices;
}

function validateGltfDocument(
  document: Record<string, unknown>,
  expected: AssetInventory,
  animations: THREE.AnimationClip[],
): void {
  const asset = document.asset as { version?: string } | undefined;
  const scenes = document.scenes as unknown[] | undefined;
  const meshes = document.meshes as Array<{ primitives?: Array<{
    attributes?: Record<string, number>;
    material?: number;
    targets?: unknown[];
  }> }> | undefined;
  const nodes = document.nodes as Array<{ name?: string; mesh?: number; skin?: number }> | undefined;
  const materials = document.materials as unknown[] | undefined;
  const textures = document.textures as Array<{ source?: number }> | undefined;
  const images = document.images as unknown[] | undefined;
  const accessors = document.accessors as Array<{ min?: unknown[]; max?: unknown[] }> | undefined;
  const skins = document.skins as Array<{ joints?: number[]; inverseBindMatrices?: number }> | undefined;
  const encodedAnimations = document.animations as Array<{
    name?: string;
    channels?: unknown[];
    samplers?: unknown[];
  }> | undefined;
  if (asset?.version !== '2.0' || !scenes?.length || !meshes?.length || !nodes?.length) {
    throw new Error('glTF validation failed: asset, scene, mesh, or node table is missing');
  }
  const invalidAccessor = accessors?.findIndex((accessor) => (
    [...(accessor.min ?? []), ...(accessor.max ?? [])]
      .some((value) => typeof value !== 'number' || !Number.isFinite(value))
  )) ?? -1;
  if (invalidAccessor >= 0) {
    throw new Error(`glTF validation failed: accessor ${invalidAccessor} has non-finite bounds`);
  }
  const primitives = meshes.flatMap((mesh) => mesh.primitives ?? []);
  if (primitives.some((primitive) => primitive.attributes?.POSITION === undefined)) {
    throw new Error('glTF validation failed: a mesh primitive has no POSITION accessor');
  }
  const meshNodeCount = nodes.filter((node) => node.mesh !== undefined).length;
  if (meshNodeCount < expected.meshCount) {
    throw new Error(
      `glTF validation failed: expected at least ${expected.meshCount} mesh node(s), found ${meshNodeCount}`,
    );
  }
  const primitivesForNode = (node: { mesh?: number }): Array<{
    attributes?: Record<string, number>;
    material?: number;
    targets?: unknown[];
  }> => node.mesh === undefined ? [] : meshes[node.mesh]?.primitives ?? [];
  const colouredMeshNodes = nodes.filter((node) => primitivesForNode(node).some(
    (primitive) => primitive.attributes?.COLOR_0 !== undefined,
  )).length;
  if (colouredMeshNodes < expected.vertexColourMeshCount) {
    throw new Error(
      `glTF validation failed: expected vertex colours on at least ${expected.vertexColourMeshCount} `
      + `mesh node(s), found ${colouredMeshNodes}`,
    );
  }
  const uvMeshNodes = nodes.filter((node) => primitivesForNode(node).some(
    (primitive) => primitive.attributes?.TEXCOORD_0 !== undefined,
  )).length;
  if (uvMeshNodes < expected.uvMeshCount) {
    throw new Error(
      `glTF validation failed: expected UVs on at least ${expected.uvMeshCount} mesh node(s), `
      + `found ${uvMeshNodes}`,
    );
  }
  if ((materials?.length ?? 0) < expected.portableMaterialCount) {
    throw new Error(
      `glTF validation failed: expected at least ${expected.portableMaterialCount} portable material(s), `
      + `found ${materials?.length ?? 0}`,
    );
  }
  const textureIndices = gltfMaterialTextureIndices(materials ?? []);
  if (textureIndices.length < expected.textureBindingCount) {
    throw new Error(
      `glTF validation failed: expected at least ${expected.textureBindingCount} texture binding(s), `
      + `found ${textureIndices.length}`,
    );
  }
  if (textureIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= (textures?.length ?? 0))) {
    throw new Error('glTF validation failed: a material references a missing texture');
  }
  if (expected.portableTextureCount > 0 && (!(textures?.length) || !(images?.length))) {
    throw new Error('glTF validation failed: source texture images were lost');
  }
  if (textures?.some((texture) => (
    texture.source === undefined || texture.source < 0 || texture.source >= (images?.length ?? 0)
  ))) {
    throw new Error('glTF validation failed: a texture references a missing image');
  }
  if (expected.morphTargetCount > 0
    && !primitives.some((primitive) => (primitive.targets?.length ?? 0) > 0)) {
    throw new Error('glTF validation failed: source morph targets were lost');
  }
  if (expected.skinnedMeshCount > 0) {
    if (skins?.length !== expected.skinnedMeshCount
      || skins.some((skin) => !skin.joints?.length || skin.inverseBindMatrices === undefined)) {
      throw new Error('glTF validation failed: skin joints or inverse bind matrices are missing');
    }
    const weightedMeshNodes = nodes.filter((node) => node.skin !== undefined && primitivesForNode(node).some(
      (primitive) => primitive.attributes?.JOINTS_0 !== undefined
        && primitive.attributes?.WEIGHTS_0 !== undefined,
    )).length;
    if (weightedMeshNodes < expected.skinnedMeshCount) {
      throw new Error(
        `glTF validation failed: expected weights on at least ${expected.skinnedMeshCount} `
        + `mesh node(s), found ${weightedMeshNodes}`,
      );
    }
  }
  if ((encodedAnimations?.length ?? 0) !== animations.length) {
    throw new Error(
      `glTF validation failed: expected ${animations.length} animation(s), found ${encodedAnimations?.length ?? 0}`,
    );
  }
  for (const [index, animation] of (encodedAnimations ?? []).entries()) {
    const wantedChannels = expectedAnimationChannels(animations[index]);
    if (animation.channels?.length !== wantedChannels
      || animation.channels.length !== animation.samplers?.length) {
      throw new Error(`glTF validation failed: animation ${animation.name || 'unnamed'} has invalid channels`);
    }
  }
  if (expected.instancedMeshCount > 0) {
    const extensions = document.extensionsUsed as string[] | undefined;
    if (!extensions?.includes('EXT_mesh_gpu_instancing')) {
      throw new Error('glTF validation failed: GPU instances were not represented');
    }
  }
  const exportedNames = new Set(nodes.map((node) => node.name).filter((name): name is string => !!name));
  const missingNames = expected.namedParts.filter((name) => {
    const safe = THREE.PropertyBinding.sanitizeNodeName(name);
    return !exportedNames.has(name)
      && !exportedNames.has(safe)
      && ![...exportedNames].some((candidate) => candidate.startsWith(`${safe}_`));
  });
  if (missingNames.length) {
    throw new Error(
      `glTF validation failed: ${missingNames.length} named part(s) were lost (${missingNames.slice(0, 3).join(', ')})`,
    );
  }
}

async function validateGltfRoundTrip(
  payload: ArrayBuffer | string,
  expected: AssetInventory,
  animations: THREE.AnimationClip[],
): Promise<void> {
  const loaded = await new GLTFLoader().parseAsync(payload, '');
  const actual = inventory(loaded.scene);
  if (!actual.meshCount || actual.triangleCount !== expected.triangleCount) {
    throw new Error(
      `glTF round-trip failed: expected ${expected.triangleCount} triangles, found ${actual.triangleCount}`,
    );
  }
  if (actual.skinnedMeshCount < expected.skinnedMeshCount || actual.jointCount !== expected.jointCount) {
    throw new Error(
      `glTF round-trip failed: expected at least ${expected.skinnedMeshCount} skinned primitives/`
      + `${expected.jointCount} joints, `
      + `found ${actual.skinnedMeshCount}/${actual.jointCount}`,
    );
  }
  if (actual.morphTargetCount < expected.morphTargetCount) {
    throw new Error(
      `glTF round-trip failed: expected at least ${expected.morphTargetCount} morph targets, `
      + `found ${actual.morphTargetCount}`,
    );
  }
  if (expected.vertexColourMeshCount > 0 && !actual.vertexColourMeshCount) {
    throw new Error('glTF round-trip failed: vertex colours did not survive import');
  }
  if (actual.namedPartCount < expected.namedPartCount) {
    throw new Error(
      `glTF round-trip failed: expected at least ${expected.namedPartCount} named mesh part(s), `
      + `found ${actual.namedPartCount}`,
    );
  }
  if (actual.materialCount < expected.portableMaterialCount) {
    throw new Error(
      `glTF round-trip failed: expected at least ${expected.portableMaterialCount} portable material(s), `
      + `found ${actual.materialCount}`,
    );
  }
  if (actual.textureBindingCount < expected.textureBindingCount) {
    throw new Error(
      `glTF round-trip failed: expected at least ${expected.textureBindingCount} texture binding(s), `
      + `found ${actual.textureBindingCount}`,
    );
  }
  if (actual.uvMeshCount < expected.uvMeshCount) {
    throw new Error(
      `glTF round-trip failed: expected UVs on at least ${expected.uvMeshCount} mesh(es), `
      + `found ${actual.uvMeshCount}`,
    );
  }
  if (actual.instanceCount !== expected.instanceCount) {
    throw new Error(
      `glTF round-trip failed: expected ${expected.instanceCount} instances, found ${actual.instanceCount}`,
    );
  }
  if (loaded.animations.length !== animations.length
    || loaded.animations.some((clip, index) => clip.tracks.length !== expectedAnimationChannels(animations[index]))) {
    throw new Error('glTF round-trip failed: animation clips or tracks did not survive import');
  }
}

function validateStaticArtifact(
  format: Exclude<ExportFormat, 'glb' | 'gltf'>,
  bytes: Uint8Array,
  expected: AssetInventory,
  sourceText?: string,
): void {
  if (!bytes.byteLength) throw new Error(`${format.toUpperCase()} validation failed: empty file`);
  if (format === 'obj') {
    const vertices = sourceText?.match(/^v\s/gm)?.length ?? 0;
    const faces = sourceText?.match(/^f\s/gm)?.length ?? 0;
    const normals = sourceText?.match(/^vn\s/gm)?.length ?? 0;
    const objects = sourceText?.match(/^o\s/gm)?.length ?? 0;
    const uvs = sourceText?.match(/^vt\s/gm)?.length ?? 0;
    if (!vertices || faces !== expected.triangleCount) {
      throw new Error(`OBJ validation failed: expected ${expected.triangleCount} faces, found ${faces}`);
    }
    if (!normals) throw new Error('OBJ validation failed: normals were lost');
    if (objects < expected.meshCount) {
      throw new Error(
        `OBJ validation failed: expected ${expected.meshCount} named mesh record(s), found ${objects}`,
      );
    }
    if (expected.uvMeshCount > 0 && !uvs) {
      throw new Error('OBJ validation failed: source UV coordinates were lost');
    }
    return;
  }
  if (format === 'stl') {
    if (bytes.byteLength < 84) throw new Error('STL validation failed: truncated header');
    const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (triangles !== expected.triangleCount || bytes.byteLength !== 84 + triangles * 50) {
      throw new Error(`STL validation failed: expected ${expected.triangleCount} triangles, found ${triangles}`);
    }
    return;
  }
  if (format === 'ply') {
    const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
    const end = header.indexOf('end_header\n');
    const faces = Number(/element face (\d+)/.exec(header.slice(0, end))?.[1] ?? -1);
    if (!header.startsWith('ply\n') || end < 0 || faces !== expected.triangleCount) {
      throw new Error(`PLY validation failed: expected ${expected.triangleCount} faces, found ${faces}`);
    }
    if (expected.vertexColourMeshCount > 0 && !header.includes('property uchar red\n')) {
      throw new Error('PLY validation failed: source vertex colours were lost');
    }
    if (expected.uvMeshCount > 0 && !header.includes('property float s\n')) {
      throw new Error('PLY validation failed: source UV coordinates were lost');
    }
    return;
  }
  const signature = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const files = signature ? unzipSync(bytes) : {};
  const model = files['model.usda'];
  const modelText = model ? strFromU8(model) : '';
  const geometries = Object.keys(files).filter((name) => name.startsWith('geometries/Geometry_'));
  const textureFiles = Object.keys(files).filter((name) => name.startsWith('textures/Texture_'));
  const meshXforms = [...modelText.matchAll(/def Xform "Object_\d+"/g)].length;
  if (!signature || !modelText.startsWith('#usda 1.0') || !geometries.length) {
    throw new Error('USDZ validation failed: archive contains no renderable geometry');
  }
  if (meshXforms < expected.meshCount) {
    throw new Error(
      `USDZ validation failed: expected ${expected.meshCount} mesh transform(s), found ${meshXforms}`,
    );
  }
  if (expected.textureCount > 0 && !textureFiles.length) {
    throw new Error('USDZ validation failed: source material textures were lost');
  }
  if (/\btoken inputs:(?:varname|in\.connect) =/.test(modelText)) {
    throw new Error('USDZ validation failed: material UV inputs have invalid USD types');
  }
  const normalShaders = [...modelText.matchAll(/def Shader "[^"]+_normal"\s*\{([\s\S]*?)\n\t\t\}/g)];
  if (normalShaders.some(([, body]) => (
    body.includes('uniform token info:id = "UsdUVTexture"')
      && (!body.includes('float4 inputs:scale = (2, 2, 2, 1)')
        || !body.includes('float4 inputs:bias = (-1, -1, -1, 0)'))
  ))) {
    throw new Error('USDZ validation failed: an 8-bit normal map has no USD scale/bias transform');
  }
}

function toStandardMaterial(material: THREE.Material): THREE.MeshStandardMaterial {
  const standard = material as THREE.MeshStandardMaterial;
  if (standard.isMeshStandardMaterial) {
    const compatible = standard.clone();
    compatible.side = THREE.FrontSide;
    return compatible;
  }
  const source = material as THREE.Material & {
    color?: THREE.Color;
    map?: THREE.Texture | null;
    normalMap?: THREE.Texture | null;
    emissive?: THREE.Color;
    emissiveMap?: THREE.Texture | null;
    alphaMap?: THREE.Texture | null;
    aoMap?: THREE.Texture | null;
    vertexColors?: boolean;
    roughness?: number;
    metalness?: number;
  };
  const converted = new THREE.MeshStandardMaterial({
    color: source.color?.clone() ?? new THREE.Color(0xffffff),
    map: source.map ?? null,
    normalMap: source.normalMap ?? null,
    emissive: source.emissive?.clone() ?? new THREE.Color(0x000000),
    emissiveMap: source.emissiveMap ?? null,
    alphaMap: source.alphaMap ?? null,
    aoMap: source.aoMap ?? null,
    roughness: source.roughness ?? 0.72,
    metalness: source.metalness ?? 0,
    opacity: material.opacity,
    transparent: material.transparent,
    alphaTest: material.alphaTest,
    side: THREE.FrontSide,
    vertexColors: source.vertexColors ?? false,
  });
  converted.name = material.name ? `${material.name}-usdz` : 'USDZ material';
  return converted;
}

function sliceGeometry(source: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const flat = source.index ? source.toNonIndexed() : source;
  const available = flat.getAttribute('position')?.count ?? 0;
  const safeStart = Math.max(0, Math.min(start, available));
  const safeCount = Math.max(0, Math.min(count, available - safeStart));
  const result = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(flat.attributes)) {
    const values = new Float32Array(safeCount * attribute.itemSize);
    for (let i = 0; i < safeCount; i += 1) {
      for (let component = 0; component < attribute.itemSize; component += 1) {
        values[i * attribute.itemSize + component] = attribute.getComponent(safeStart + i, component);
      }
    }
    result.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

/** Normalize materials and split multi-material meshes for the stricter r169 USDZ exporter. */
function prepareUsdz(root: THREE.Group): THREE.Group {
  const multi: THREE.Mesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) multi.push(mesh);
    else mesh.material = toStandardMaterial(mesh.material);
  });
  for (const mesh of multi.reverse()) {
    const parent = mesh.parent;
    if (!parent) continue;
    const materials = mesh.material as THREE.Material[];
    const positionCount = mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count;
    const groups = mesh.geometry.groups.length
      ? mesh.geometry.groups
      : [{ start: 0, count: positionCount, materialIndex: 0 }];
    const container = new THREE.Group();
    container.name = mesh.name;
    container.position.copy(mesh.position);
    container.quaternion.copy(mesh.quaternion);
    container.scale.copy(mesh.scale);
    container.visible = mesh.visible;
    for (const [index, group] of groups.entries()) {
      const geometry = sliceGeometry(mesh.geometry, group.start, group.count);
      if ((geometry.getAttribute('position')?.count ?? 0) < 3) continue;
      const material = materials[group.materialIndex ?? 0] ?? materials[0];
      if (!material) continue;
      const part = new THREE.Mesh(geometry, toStandardMaterial(material));
      part.name = `${mesh.name || 'mesh'}-material-${index + 1}`;
      part.castShadow = mesh.castShadow;
      part.receiveShadow = mesh.receiveShadow;
      container.add(part);
    }
    for (const child of [...mesh.children]) container.add(child);
    replaceChild(parent, mesh, container);
  }
  root.updateMatrixWorld(true);
  return root;
}

function reportFor(
  format: ExportFormat,
  bytes: number,
  model: AssetInventory,
  prepared: PreparedAnimations,
  roundTripValidated: boolean,
  warnings: string[],
): ExportReport {
  return {
    format,
    bytes,
    meshCount: model.meshCount,
    triangleCount: model.triangleCount,
    namedPartCount: model.namedPartCount,
    materialCount: model.materialCount,
    portableMaterialCount: model.portableMaterialCount,
    textureCount: model.textureCount,
    portableTextureCount: model.portableTextureCount,
    texturedMaterialCount: model.texturedMaterialCount,
    textureBindingCount: model.textureBindingCount,
    uvMeshCount: model.uvMeshCount,
    vertexColourMeshCount: model.vertexColourMeshCount,
    skinnedMeshCount: model.skinnedMeshCount,
    jointCount: model.jointCount,
    sourceAnimationCount: prepared.sourceCount,
    animationCount: format === 'glb' || format === 'gltf' ? prepared.clips.length : 0,
    animationTrackCount: format === 'glb' || format === 'gltf'
      ? prepared.clips.reduce((sum, clip) => sum + clip.tracks.length, 0)
      : 0,
    morphTargetCount: model.morphTargetCount,
    instanceCount: model.instanceCount,
    roundTripValidated,
    warnings,
  };
}

/** Export a validated asset from the model currently mounted on stage. */
export async function exportModel(
  group: THREE.Group,
  format: ExportFormat,
  snapshot: ExportSnapshot = (work) => work(),
  selectedRoot?: THREE.Object3D,
): Promise<ExportArtifact> {
  const clean = snapshot(() => cloneForExport(group, selectedRoot));
  const stabilizedInstances = stabilizeInstanceMatrices(clean);
  const sourceAnimations = animationsFor(group);
  const capabilities = runtimeCapabilities(selectedRoot ?? group);
  const model = validateGeometry(clean);
  const prepared = prepareAnimations(clean, sourceAnimations);
  const warnings: string[] = [];
  if (stabilizedInstances) {
    warnings.push(
      `${stabilizedInstances} zero-scale instance transform(s) received neutral rotation and `
      + `${INSTANCE_SCALE_EPSILON} scale epsilon for DCC compatibility`,
    );
  }
  if (prepared.droppedTracks) {
    warnings.push(`${prepared.droppedTracks} non-portable animation track(s) were omitted`);
  }
  if (prepared.clips.length !== prepared.sourceCount) {
    warnings.push(`${prepared.sourceCount - prepared.clips.length} clip(s) had no portable TRS or morph tracks`);
  }
  if (model.unsupportedRenderableCount) {
    warnings.push(`${model.unsupportedRenderableCount} runtime point/line/sprite effect(s) may not match in DCC tools`);
  }
  if (model.nonPbrMaterialCount) {
    warnings.push(`${model.nonPbrMaterialCount} custom material(s) are approximated by destination formats`);
  }
  if ((format === 'glb' || format === 'gltf')
    && model.textureCount === 0 && model.vertexColourMeshCount > 0) {
    warnings.push(
      `the source has no image textures; appearance is carried by ${model.vertexColourMeshCount} `
      + 'vertex-colour mesh(es) and material values',
    );
  }
  if ((format === 'glb' || format === 'gltf')
    && model.textureCount > model.portableTextureCount) {
    warnings.push(
      `${model.textureCount - model.portableTextureCount} shader/runtime texture(s) have no portable glTF material slot`,
    );
  }
  if (capabilities.hasAnimationController && !sourceAnimations.length) {
    warnings.push('procedural runtime motion has no portable AnimationClip and is exported as the current pose');
  }
  if (capabilities.hasVfxRuntime) {
    warnings.push('procedural runtime VFX logic is not representable in these interchange formats');
  }

  if (format === 'glb' || format === 'gltf') {
    const binary = format === 'glb';
    const output = await new GLTFExporter().parseAsync(clean, {
      binary,
      animations: prepared.clips,
      trs: true,
      onlyVisible: true,
      truncateDrawRange: false,
      includeCustomExtensions: false,
    });
    let payload: ArrayBuffer | string;
    let blob: Blob;
    let document: Record<string, unknown>;
    if (binary) {
      if (!(output instanceof ArrayBuffer)) {
        throw new Error('GLB export failed: exporter returned non-binary data');
      }
      payload = output;
      document = gltfJsonFromGlb(output);
      blob = new Blob([output], { type: 'model/gltf-binary' });
    } else {
      const json = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      payload = json;
      document = JSON.parse(json) as Record<string, unknown>;
      blob = new Blob([json], { type: 'model/gltf+json' });
    }
    validateGltfDocument(document, model, prepared.clips);
    let roundTripValidated = false;
    if (model.triangleCount <= ROUND_TRIP_TRIANGLE_LIMIT) {
      await validateGltfRoundTrip(payload, model, prepared.clips);
      roundTripValidated = true;
    } else {
      warnings.push(
        `browser round-trip skipped above ${ROUND_TRIP_TRIANGLE_LIMIT.toLocaleString()} triangles to avoid exhausting memory`,
      );
    }
    return {
      blob,
      filenameExtension: format,
      report: reportFor(format, blob.size, model, prepared, roundTripValidated, warnings),
    };
  }

  const posed = removeUnsupportedStaticRenderables(
    expandInstances(removeHiddenStaticSubtrees(bakeDeformedMeshes(clean))),
  );
  const staticModel = validateGeometry(posed);
  if (staticModel.triangleCount !== model.triangleCount) {
    throw new Error(
      `Static export validation failed: expected ${model.triangleCount} triangles after baking, found ${staticModel.triangleCount}`,
    );
  }
  if (sourceAnimations.length || model.skinnedMeshCount) {
    warnings.push('this static format contains the current posed geometry, not the rig or animation clips');
  }
  if (format === 'obj') {
    warnings.push('OBJ keeps named mesh boundaries, UVs and normals, but this single-file export has no materials or textures');
  } else if (format === 'stl') {
    warnings.push('STL flattens the assembly to triangles; hierarchy, parts, materials, colours and UVs are not representable');
  } else if (format === 'ply') {
    warnings.push('PLY flattens the assembly; vertex colours survive, but hierarchy, named parts and materials do not');
  } else if (format === 'usdz') {
    warnings.push('USDZ contains a posed Quick Look asset; armatures and editable animation clips are not exported by Three.js r169');
  }
  if (format === 'obj') {
    const text = new OBJExporter().parse(posed);
    const bytes = new TextEncoder().encode(text);
    validateStaticArtifact(format, bytes, staticModel, text);
    const blob = new Blob([text], { type: 'text/plain' });
    return {
      blob,
      filenameExtension: format,
      report: reportFor(format, blob.size, staticModel, prepared, false, warnings),
    };
  }
  if (format === 'stl') {
    const data = new STLExporter().parse(posed, { binary: true });
    const buffer = ownedBuffer(data);
    validateStaticArtifact(format, new Uint8Array(buffer), staticModel);
    const blob = new Blob([buffer], { type: 'model/stl' });
    return {
      blob,
      filenameExtension: format,
      report: reportFor(format, blob.size, staticModel, prepared, false, warnings),
    };
  }
  if (format === 'ply') {
    const exporter = new PLYExporter();
    const result = exporter.parse(
      posed,
      () => undefined,
      { binary: true, littleEndian: true },
    );
    if (!(result instanceof ArrayBuffer)) throw new Error('PLY export could not represent this geometry');
    validateStaticArtifact(format, new Uint8Array(result), staticModel);
    const blob = new Blob([result], { type: 'application/octet-stream' });
    return {
      blob,
      filenameExtension: format,
      report: reportFor(format, blob.size, staticModel, prepared, false, warnings),
    };
  }
  const usdzRoot = prepareUsdz(posed);
  const usdzModel = validateGeometry(usdzRoot);
  const usdz = await new USDZExporter().parseAsync(usdzRoot, { quickLookCompatible: true });
  const repairedUsdz = repairUsdzShaderTypes(asBytes(usdz));
  const buffer = ownedBuffer(repairedUsdz);
  validateStaticArtifact(format, new Uint8Array(buffer), usdzModel);
  const blob = new Blob([buffer], { type: 'model/vnd.usdz+zip' });
  return {
    blob,
    filenameExtension: format,
    report: reportFor(format, blob.size, usdzModel, prepared, false, warnings),
  };
}

function safeFilenamePart(value: string, fallback: string): string {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

async function addBlobToZip(archive: Zip, filename: string, blob: Blob): Promise<void> {
  const entry = new ZipPassThrough(filename);
  archive.add(entry);
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      entry.push(value);
    }
    entry.push(new Uint8Array(0), true);
  } finally {
    reader.releaseLock();
  }
}

/** Export every supported format into one streamed ZIP plus a machine-readable validation manifest. */
export async function exportAllFormatsZip(
  group: THREE.Group,
  options: ExportBundleOptions,
): Promise<ExportBundleArtifact> {
  const assetId = safeFilenamePart(options.assetId, 'img2threejs-asset');
  const scopeId = safeFilenamePart(options.scopeId, 'all');
  const baseName = scopeId === 'all' ? assetId : `${assetId}--${scopeId}`;
  const outputChunks: ArrayBuffer[] = [];
  let archiveError: Error | undefined;
  let resolveArchive!: (blob: Blob) => void;
  let rejectArchive!: (error: Error) => void;
  const completed = new Promise<Blob>((resolve, reject) => {
    resolveArchive = resolve;
    rejectArchive = reject;
  });
  const archive = new Zip((error, data, final) => {
    if (error) {
      archiveError = error;
      rejectArchive(error);
      return;
    }
    if (data.byteLength) outputChunks.push(ownedBuffer(data));
    if (final) resolveArchive(new Blob(outputChunks, { type: 'application/zip' }));
  });

  const reports: ExportReport[] = [];
  const files: string[] = [];
  try {
    for (const [index, definition] of EXPORT_FORMATS.entries()) {
      options.onProgress?.({
        format: definition.format,
        label: definition.label,
        index: index + 1,
        total: EXPORT_FORMATS.length,
      });
      const artifact = await exportModel(
        group,
        definition.format,
        options.snapshot,
        options.selectedRoot,
      );
      if (archiveError) throw archiveError;
      const filename = `${baseName}.${artifact.filenameExtension}`;
      await addBlobToZip(archive, filename, artifact.blob);
      if (archiveError) throw archiveError;
      files.push(filename);
      reports.push(artifact.report);
    }

    const manifest = {
      schemaVersion: 1,
      generator: 'img2threejs-showcase',
      createdAt: new Date().toISOString(),
      assetId: options.assetId,
      scope: {
        id: options.scopeId,
        label: options.scopeLabel,
        kind: options.selectedRoot ? 'declared-model' : 'full-assembly',
      },
      files: reports.map((report, index) => ({
        filename: files[index],
        format: report.format,
        bytes: report.bytes,
        report,
      })),
      portability: EXPORT_FORMATS.map(({ format, keeps, limits }) => ({ format, keeps, limits })),
    };
    await addBlobToZip(
      archive,
      'manifest.json',
      new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
    );
    files.push('manifest.json');
    if (archiveError) throw archiveError;
    archive.end();
    const blob = await completed;
    return { blob, filename: `${baseName}-all-formats.zip`, files, reports };
  } catch (error) {
    archive.terminate();
    throw error;
  }
}

/** Hand an already validated blob to the browser as a named download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
