import * as THREE from 'three';
import type { AnimationClipJSON } from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { assignRobotSegments, ROBOT_SEGMENTS, type RobotSegmentBucket, type RobotSegmentId, type RobotSegmentation } from './segments';
import { getRobotAnimationProfile, loadRobotExportedAnimationClips, loadRobotGreetingClips, ROBOT_ANIMATION_PROFILE } from './animationProfile';
export type { RobotSegmentId } from './segments';
export const ROBOT_ASSET_URL = import.meta.env.BASE_URL + 'robot/robot3d-threejs-scene-v152.json.gz';
const ROBOT_SOURCE_ANIMATIONS_URL = import.meta.env.BASE_URL + 'robot/robot3d-source-animations-v152.json.gz';
const ROBOT_TEXTURE_URL = import.meta.env.BASE_URL + 'robot/robot3d-texture-v152.jpg';
const ROBOT_SOURCE_GLB_SHA256 = 'bbf93dbfd845c1d4b15e4e6bf75135606e8c8566e26dcba8d78d8b6e9741d344';
const ROBOT_TEXTURE_BYTES = 12_429_546;
const NAMASTE_REFERENCE_BODY_URL = import.meta.env.BASE_URL + 'robot/namaste-reference-body.json';
export const ROBOT_SOURCE_CONTRACT = {
  meshCount: 1,
  jointCount: 65,
  clipCount: 17,
  tracksPerClip: 195,
} as const;

export interface RobotPaintTarget extends RobotSegmentBucket {
  tint: string | null;
  tintColor: THREE.Color | null;
}

export interface RobotRuntime {
  displayRoot: THREE.Group;
  model: THREE.Group;
  meshes: THREE.SkinnedMesh[];
  clips: THREE.AnimationClip[];
  mixer: THREE.AnimationMixer;
  segments: Map<RobotSegmentId, RobotPaintTarget>;
  segmentation: RobotSegmentation;
  originalVertexColors: Map<THREE.SkinnedMesh, Float32Array>;
  triangleCount: number;
}
export interface RobotLoadProgress {
  loaded: number;
  total: number;
}

interface RobotSourceAsset {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

interface RobotEncodedScenePayload {
  formatVersion: number;
  sourceGlbSha256: string;
  scene: { images?: Array<{ url: string }> };
}

interface RobotEncodedAnimationPayload {
  formatVersion: number;
  sourceGlbSha256: string;
  clips: AnimationClipJSON[];
}

let assetPromise: Promise<RobotSourceAsset> | null = null;
let loadedAsset: RobotSourceAsset | null = null;
let namasteReferencePromise: Promise<THREE.AnimationClip> | null = null;
interface NamasteReferencePoseState {
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  duration: number;
}

const namasteReferencePoseStates = new WeakMap<RobotRuntime, NamasteReferencePoseState>();
// Decode the exact Three.js scene serialization generated from the source GLB; no geometry is generated at runtime.
export function loadRobotAsset(onProgress?: (progress: RobotLoadProgress) => void): Promise<RobotSourceAsset> {
  if (loadedAsset) return Promise.resolve(loadedAsset);
  if (!assetPromise) {
    assetPromise = (async () => {
      const loadEncodedJson = async (url: string): Promise<{ payload: unknown; bytes: number }> => {
        const buffer = await new THREE.FileLoader()
          .setResponseType('arraybuffer')
          .loadAsync(url) as ArrayBuffer;
        const encoded = new Uint8Array(buffer);
        const isGzip = encoded[0] === 0x1f && encoded[1] === 0x8b;
        const text = isGzip
          ? await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
          : new TextDecoder().decode(buffer);
        return { payload: JSON.parse(text) as unknown, bytes: buffer.byteLength };
      };

      const [sceneFile, animationFile] = await Promise.all([
        loadEncodedJson(ROBOT_ASSET_URL),
        loadEncodedJson(ROBOT_SOURCE_ANIMATIONS_URL),
      ]);
      const scenePayload = sceneFile.payload as RobotEncodedScenePayload;
      const animationPayload = animationFile.payload as RobotEncodedAnimationPayload;
      if (scenePayload.formatVersion !== 1 || animationPayload.formatVersion !== 1
        || scenePayload.sourceGlbSha256 !== ROBOT_SOURCE_GLB_SHA256
        || animationPayload.sourceGlbSha256 !== ROBOT_SOURCE_GLB_SHA256
        || !Array.isArray(animationPayload.clips)) {
        throw new Error('Encoded robot scene and animation data do not match the source GLB contract.');
      }
      const images = scenePayload.scene.images;
      if (!Array.isArray(images) || images.length !== 1) {
        throw new Error('Encoded robot scene must reference its single source texture.');
      }
      for (const image of images) image.url = ROBOT_TEXTURE_URL;

      const transferBytes = sceneFile.bytes + animationFile.bytes;
      const totalBytes = transferBytes + ROBOT_TEXTURE_BYTES;
      onProgress?.({ loaded: transferBytes, total: totalBytes });
      const parsedScene = await new THREE.ObjectLoader().parseAsync(scenePayload.scene);
      if (!(parsedScene as THREE.Group).isGroup) throw new Error('Encoded robot scene root is not a Three.js Group.');
      const animations = animationPayload.clips.map((clip) => THREE.AnimationClip.parse(clip));
      loadedAsset = { scene: parsedScene as THREE.Group, animations };
      onProgress?.({ loaded: totalBytes, total: totalBytes });
      return loadedAsset;
    })().catch((error: unknown) => {
      assetPromise = null;
      throw error;
    });
  }
  return assetPromise;
}
function loadRobotNamasteReferenceBodyClip(): Promise<THREE.AnimationClip> {
  if (!namasteReferencePromise) {
    namasteReferencePromise = new THREE.FileLoader()
      .setResponseType('json')
      .loadAsync(NAMASTE_REFERENCE_BODY_URL)
      .then((data: unknown) => {
        const payload = data as {
          formatVersion: number;
          sourceDurationSeconds: number;
          targetDurationSeconds: number;
          timeScale: number;
          clip: AnimationClipJSON;
        };
        if (payload.formatVersion !== 1 || payload.sourceDurationSeconds !== 5
          || payload.targetDurationSeconds !== 4 || Math.abs(payload.timeScale - 0.8) > 1e-6) {
          throw new Error('Namaste reference clip metadata does not match the retimed source profile.');
        }
        const clip = THREE.AnimationClip.parse(payload.clip);
        const trackNames = new Set(clip.tracks.map((track) => track.name));
        const wristPositionTracks = ['mixamorigLeftHand.position', 'mixamorigRightHand.position'];
        if (clip.duration !== 4 || clip.tracks.length !== 71 || trackNames.size !== clip.tracks.length
          || !wristPositionTracks.every((name) => trackNames.has(name))
          || clip.tracks.some((track) => /^mixamorig(?:Left|Right)Hand/.test(track.name)
            && !/^mixamorig(?:Left|Right)Hand\.position$/.test(track.name))
          || !clip.validate()) {
          throw new Error('Namaste reference clip must contain 69 body tracks and two wrist-position tracks.');
        }
        return clip;
    }).catch((error: unknown) => {
      namasteReferencePromise = null;
      throw error;
    });
  }
  return namasteReferencePromise;
}

export function prewarmRobotModel(): Promise<void> {
  return Promise.all([loadRobotAsset(), loadRobotGreetingClips(), loadRobotExportedAnimationClips(), loadRobotNamasteReferenceBodyClip()]).then(() => undefined);
}

function colorOf(material: THREE.Material): THREE.Color | null {
  if (!('color' in material)) return null;
  const color = (material as THREE.Material & { color?: THREE.Color }).color;
  return color?.isColor ? color : null;
}

function materialsOf(mesh: THREE.SkinnedMesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function cloneMeshMaterials(mesh: THREE.SkinnedMesh): void {
  mesh.geometry = mesh.geometry.clone();
  mesh.material = Array.isArray(mesh.material)
    ? mesh.material.map((material) => material.clone())
    : mesh.material.clone();
  for (const material of materialsOf(mesh)) {
    const vertexMaterial = material as THREE.Material & { vertexColors?: boolean };
    if (vertexMaterial.vertexColors !== undefined) {
      vertexMaterial.vertexColors = true;
      vertexMaterial.needsUpdate = true;
    }
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

/** Adds a one-second electric-green scan only to green texels in the source albedo. */
function attachRobotGreenEnergyVfx(mesh: THREE.SkinnedMesh): void {
  const timeUniform = { value: 0 };
  let patched = false;
  for (const material of materialsOf(mesh)) {
    const standard = material as THREE.MeshStandardMaterial;
    if (!standard.isMeshStandardMaterial || !standard.map) continue;

    const previousOnBeforeCompile = standard.onBeforeCompile;
    standard.onBeforeCompile = (shader, renderer) => {
      previousOnBeforeCompile.call(standard, shader, renderer);
      shader.uniforms.uRobotGreenVfxTime = timeUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vRobotGreenVfxPosition;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvRobotGreenVfxPosition = position;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uRobotGreenVfxTime;\nvarying vec3 vRobotGreenVfxPosition;',
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
float robotGreenVfxMask = 0.0;
#ifdef USE_MAP
  float robotGreenVfxChroma = sampledDiffuseColor.g - max(sampledDiffuseColor.r, sampledDiffuseColor.b);
  robotGreenVfxMask = smoothstep(0.055, 0.18, robotGreenVfxChroma)
    * smoothstep(0.10, 0.30, sampledDiffuseColor.g);
#endif`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
float robotGreenVfxCycle = fract(uRobotGreenVfxTime);
float robotGreenVfxProgress = 1.0 - (1.0 - robotGreenVfxCycle) * (1.0 - robotGreenVfxCycle);
float robotGreenVfxScanY = mix(-0.06, 1.06, robotGreenVfxProgress);
float robotGreenVfxHead = 1.0 - smoothstep(0.012, 0.075, abs(vRobotGreenVfxPosition.y - robotGreenVfxScanY));
float robotGreenVfxTrail = exp(-max(robotGreenVfxScanY - vRobotGreenVfxPosition.y, 0.0) * 7.0)
  * step(vRobotGreenVfxPosition.y, robotGreenVfxScanY);
float robotGreenVfxArc = 0.5 + 0.5 * sin(dot(vRobotGreenVfxPosition, vec3(41.0, 63.0, 29.0))
  - uRobotGreenVfxTime * 42.0 + sin(vRobotGreenVfxPosition.y * 39.0 + uRobotGreenVfxTime * 8.0));
float robotGreenVfxSpark = pow(robotGreenVfxArc, 16.0);
vec3 robotGreenVfxColor = mix(vec3(0.08, 0.52, 0.015), vec3(0.48, 1.45, 0.12),
  clamp(robotGreenVfxHead + robotGreenVfxTrail * 0.55, 0.0, 1.0));
totalEmissiveRadiance += robotGreenVfxMask * robotGreenVfxColor
  * (0.08 + robotGreenVfxHead * 1.15 + robotGreenVfxTrail * 0.32 + robotGreenVfxSpark * 0.18);`,
        );
    };
    const previousProgramCacheKey = standard.customProgramCacheKey;
    standard.customProgramCacheKey = () => `${previousProgramCacheKey.call(standard)}|robot-green-energy-vfx-v1`;
    standard.needsUpdate = true;
    patched = true;
  }

  if (!patched) return;
  const previousOnBeforeRender = mesh.onBeforeRender;
  mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
    timeUniform.value = performance.now() * 0.001;
    previousOnBeforeRender.call(mesh, renderer, scene, camera, geometry, material, group);
  };
}

function preserveRobotBeltSkinning(mesh: THREE.SkinnedMesh): void {
  const position = mesh.geometry.getAttribute('position');
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  if (!position || !skinIndex || !skinWeight) {
    throw new Error('Robot waist skinning requires source positions and skin weights.');
  }

  const hipsIndex = mesh.skeleton.bones.findIndex((bone) => bone.name === 'mixamorigHips');
  const leftUpLegIndex = mesh.skeleton.bones.findIndex((bone) => bone.name === 'mixamorigLeftUpLeg');
  const rightUpLegIndex = mesh.skeleton.bones.findIndex((bone) => bone.name === 'mixamorigRightUpLeg');
  if (hipsIndex < 0 || leftUpLegIndex < 0 || rightUpLegIndex < 0) {
    throw new Error('Robot waist skinning bones do not match the source rig.');
  }

  // Belt fabric, bright buckle and side fittings share one narrow band on this continuous mesh.
  const coreMinY = 0.595;
  const coreMaxY = 0.640;
  const feather = 0.004;
  const smoothstep = (edge0: number, edge1: number, value: number): number => {
    const amount = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return amount * amount * (3 - 2 * amount);
  };
  let correctedVertices = 0;
  let reassignedHipSlots = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const y = position.getY(vertex);
    if (y < coreMinY - feather || y > coreMaxY + feather) continue;
    const blend = smoothstep(coreMinY - feather, coreMinY, y)
      * (1 - smoothstep(coreMaxY, coreMaxY + feather, y));
    if (blend <= 1e-3) continue;

    let hipsSlot = -1;
    let hipsWeight = 0;
    let thighWeight = 0;
    let firstThighSlot = -1;
    for (let influence = 0; influence < 4; influence++) {
      const boneIndex = skinIndex.getComponent(vertex, influence);
      const weight = skinWeight.getComponent(vertex, influence);
      if (boneIndex === hipsIndex) {
        if (hipsSlot < 0) hipsSlot = influence;
        hipsWeight += weight;
      } else if (boneIndex === leftUpLegIndex || boneIndex === rightUpLegIndex) {
        if (firstThighSlot < 0) firstThighSlot = influence;
        thighWeight += weight;
      }
    }
    if (thighWeight <= 0) continue;
    if (hipsSlot < 0) {
      if (firstThighSlot < 0) continue;
      hipsSlot = firstThighSlot;
      skinIndex.setComponent(vertex, hipsSlot, hipsIndex);
      reassignedHipSlots++;
    }

    const transferredWeight = thighWeight * blend;
    for (let influence = 0; influence < 4; influence++) {
      const boneIndex = skinIndex.getComponent(vertex, influence);
      const weight = skinWeight.getComponent(vertex, influence);
      if (boneIndex === hipsIndex) {
        skinWeight.setComponent(vertex, influence, influence === hipsSlot ? hipsWeight + transferredWeight : 0);
      } else if (boneIndex === leftUpLegIndex || boneIndex === rightUpLegIndex) {
        skinWeight.setComponent(vertex, influence, weight * (1 - blend));
      }
    }
    correctedVertices++;
  }
  if (reassignedHipSlots > 0) skinIndex.needsUpdate = true;


  if (correctedVertices === 0) throw new Error('No source waist-band vertices matched the robot belt skinning mask.');
  skinWeight.needsUpdate = true;
}

const WHITE_VERTEX_COLOR = new THREE.Color(1, 1, 1);

function sourceVertexColors(mesh: THREE.SkinnedMesh): Float32Array {
  const positions = mesh.geometry.getAttribute('position');
  const source = mesh.geometry.getAttribute('color');
  const colors = new Float32Array(positions.count * 3);
  if (!source) {
    colors.fill(1);
  } else {
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const offset = vertex * 3;
      colors[offset] = source.getX(vertex);
      colors[offset + 1] = source.getY(vertex);
      colors[offset + 2] = source.getZ(vertex);
    }
  }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  return colors;
}

function updateVertexColors(runtime: RobotRuntime, mesh: THREE.SkinnedMesh): void {
  const segmentation = runtime.segmentation.byMesh.get(mesh);
  const base = runtime.originalVertexColors.get(mesh);
  const attribute = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!segmentation || !base || !attribute) return;

  const output = attribute.array as Float32Array;
  for (let vertex = 0; vertex < segmentation.segmentIds.length; vertex++) {
    const colorOffset = vertex * 3;
    const owner = ROBOT_SEGMENTS[segmentation.segmentIds[vertex]];
    const tint = runtime.segments.get(owner.id)!.tintColor ?? WHITE_VERTEX_COLOR;
    output[colorOffset] = base[colorOffset] * tint.r;
    output[colorOffset + 1] = base[colorOffset + 1] * tint.g;
    output[colorOffset + 2] = base[colorOffset + 2] * tint.b;
  }
  attribute.needsUpdate = true;
}

function createRuntime(
  displayRoot: THREE.Group,
  gltf: RobotSourceAsset,
  greetingClips: THREE.AnimationClip[],
  exportedClips: THREE.AnimationClip[],
  namasteReferenceBodyClip: THREE.AnimationClip,
): RobotRuntime {
  const model = cloneSkeleton(gltf.scene) as THREE.Group;
  const meshes: THREE.SkinnedMesh[] = [];
  model.traverse((object) => {
    const candidate = object as THREE.SkinnedMesh;
    if (!candidate.isMesh) return;
    if (!candidate.isSkinnedMesh || !candidate.skeleton) {
      throw new Error('Source mesh ' + (candidate.name || '(unnamed)') + ' is not bound to the source robot skin.');
    }
    if (candidate.skeleton.bones.length !== ROBOT_SOURCE_CONTRACT.jointCount) {
      throw new Error('Source mesh ' + candidate.name + ' has an unexpected joint count.');
    }
    cloneMeshMaterials(candidate);
    preserveRobotBeltSkinning(candidate);
    attachRobotGreenEnergyVfx(candidate);
    meshes.push(candidate);
  });

  if (meshes.length !== ROBOT_SOURCE_CONTRACT.meshCount) {
    throw new Error('Robot source contract expected ' + ROBOT_SOURCE_CONTRACT.meshCount + ' skinned meshes, received ' + meshes.length + '.');
  }
  if (gltf.animations.length !== ROBOT_SOURCE_CONTRACT.clipCount) {
    throw new Error('Robot source contract expected ' + ROBOT_SOURCE_CONTRACT.clipCount + ' clips, received ' + gltf.animations.length + '.');
  }
  if (ROBOT_ANIMATION_PROFILE.length !== gltf.animations.length) {
    throw new Error('Robot clip profile does not cover the source animation set.');
  }
  for (const clip of gltf.animations) {
    const profile = getRobotAnimationProfile(clip.name);
    if (!profile) throw new Error('Clip ' + clip.name + ' has no measured playback profile.');
    if (clip.tracks.length !== ROBOT_SOURCE_CONTRACT.tracksPerClip || clip.tracks.length !== profile.tracks) {
      throw new Error('Clip ' + clip.name + ' lost source tracks: expected ' + profile.tracks + ', received ' + clip.tracks.length + '.');
    }
  }
  const namasteSourceClip = gltf.animations.find((clip) => clip.name.startsWith('India — Namaste with Palms Together'));
  if (!namasteSourceClip) throw new Error('Source Namaste clip is required for the reference body pose.');
  const sourceTrackNames = new Set(namasteSourceClip.tracks.map((track) => track.name));
  const referenceTrackNames = new Set(namasteReferenceBodyClip.tracks.map((track) => track.name));
  if (referenceTrackNames.size !== 71 || [...referenceTrackNames].some((name) => !sourceTrackNames.has(name))) {
    throw new Error('Namaste reference body/wrist tracks do not match the source robot rig.');
  }

  displayRoot.add(model);
  model.updateMatrixWorld(true);
  const sourceBounds = new THREE.Box3().setFromObject(model, true);
  if (sourceBounds.isEmpty()) throw new Error('Robot source meshes have empty world bounds.');
  const center = sourceBounds.getCenter(new THREE.Vector3());
  const presentationScale = 2.15;
  displayRoot.scale.setScalar(presentationScale);
  displayRoot.position.set(
    -center.x * presentationScale,
    -sourceBounds.min.y * presentationScale,
    -center.z * presentationScale,
  );
  displayRoot.updateMatrixWorld(true);

  const segmentation = assignRobotSegments(model, meshes);
  const segments = new Map<RobotSegmentId, RobotPaintTarget>();
  for (const definition of ROBOT_SEGMENTS) {
    const bucket = segmentation.segments.get(definition.id)!;
    segments.set(definition.id, { ...bucket, tint: null, tintColor: null });
  }

  const originalVertexColors = new Map<THREE.SkinnedMesh, Float32Array>();
  for (const mesh of meshes) originalVertexColors.set(mesh, sourceVertexColors(mesh));
  const runtimeSourceClips = gltf.animations.filter((clip) =>
    !clip.name.startsWith('Vietnam — Folded Arms and Respectful Head Bow'));
  const runtimeGreetingClips = greetingClips.filter((clip) => clip.name !== "Japan's Greeting");
  const runtimeBase = {
    displayRoot,
    model,
    meshes,
    clips: [...runtimeSourceClips, ...exportedClips, ...runtimeGreetingClips],
    mixer: new THREE.AnimationMixer(model),
    segments,
    segmentation,
    originalVertexColors,
    triangleCount: 0,
  } satisfies RobotRuntime;
  for (const mesh of meshes) updateVertexColors(runtimeBase, mesh);

  let triangleCount = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    triangleCount += (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3;
  }
  const runtime = { ...runtimeBase, triangleCount: Math.round(triangleCount) };
  const namasteReferenceMixer = new THREE.AnimationMixer(runtime.model);
  const namasteReferenceAction = namasteReferenceMixer.clipAction(namasteReferenceBodyClip);
  namasteReferenceAction.setLoop(THREE.LoopOnce, 1);
  namasteReferenceAction.clampWhenFinished = true;
  namasteReferencePoseStates.set(runtime, {
    mixer: namasteReferenceMixer,
    action: namasteReferenceAction,
    duration: namasteReferenceBodyClip.duration,
  });
  const gongshouRestClip = gltf.animations.find((clip) => clip.name.startsWith("China — Traditional Gongshou Greeting"));
  if (!gongshouRestClip) throw new Error("Source Gongshou clip is required for the shared robot rest pose.");
  const bones = runtime.meshes[0]?.skeleton.bones ?? [];
  const sourcePose = bones.map((bone) => ({
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
    scale: bone.scale.clone(),
  }));
  let gongshouRestPose: typeof sourcePose = [];
  const restMixer = new THREE.AnimationMixer(runtime.model);
  try {
    const action = restMixer.clipAction(gongshouRestClip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    restMixer.setTime(gongshouRestClip.duration);
    gongshouRestPose = bones.map((bone) => ({
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone(),
    }));
  } finally {
    restMixer.stopAllAction();
    restMixer.uncacheRoot(runtime.model);
    bones.forEach((bone, index) => {
      bone.position.copy(sourcePose[index].position);
      bone.quaternion.copy(sourcePose[index].quaternion);
      bone.scale.copy(sourcePose[index].scale);
    });
  }
  if (gongshouRestPose.length !== bones.length) throw new Error("Could not sample Gongshou rest pose.");
  bones.forEach((bone, index) => {
    bone.position.copy(gongshouRestPose[index].position);
    bone.quaternion.copy(gongshouRestPose[index].quaternion);
    bone.scale.copy(gongshouRestPose[index].scale);
  });
  runtime.displayRoot.updateMatrixWorld(true);
  runtime.meshes.forEach((mesh) => mesh.skeleton.update());
  const restTimes = [0, 1];
  const restTracks: THREE.KeyframeTrack[] = [];
  for (let index = 0; index < bones.length; index++) {
    const bone = bones[index];
    const pose = gongshouRestPose[index];
    restTracks.push(new THREE.QuaternionKeyframeTrack(bone.name + ".quaternion", restTimes, [
      ...pose.quaternion.toArray(), ...pose.quaternion.toArray(),
    ]));
    restTracks.push(new THREE.VectorKeyframeTrack(bone.name + ".position", restTimes, [
      ...pose.position.toArray(), ...pose.position.toArray(),
    ]));
    restTracks.push(new THREE.VectorKeyframeTrack(bone.name + ".scale", restTimes, [
      ...pose.scale.toArray(), ...pose.scale.toArray(),
    ]));
  }
  runtime.model.userData.sharedGongshouRestClip = new THREE.AnimationClip("shared-gongshou-rest", 1, restTracks);
  return runtime;
}

export function createRobotModel(
  scene: THREE.Scene,
  onProgress?: (progress: RobotLoadProgress) => void,
): THREE.Group {
  const displayRoot = new THREE.Group();
  displayRoot.name = 'robot-showcase-display-root';
  scene.add(displayRoot);

  const ready = Promise.all([loadRobotAsset(onProgress), loadRobotGreetingClips(), loadRobotExportedAnimationClips(), loadRobotNamasteReferenceBodyClip()])
    .then(([gltf, greetingClips, exportedClips, namasteReferenceBodyClip]) => {
      if (displayRoot.userData.disposed === true) return null;
      const runtime = createRuntime(displayRoot, gltf, greetingClips, exportedClips, namasteReferenceBodyClip);
      displayRoot.userData.robotRuntime = runtime;
      return runtime;
    });
  displayRoot.userData.robotReady = ready;
  return displayRoot;
}

export function waitForRobotModel(displayRoot: THREE.Group): Promise<RobotRuntime | null> {
  const ready = displayRoot.userData.robotReady as Promise<RobotRuntime | null> | undefined;
  if (!ready) return Promise.reject(new Error('Robot model was not initialized through createRobotModel().'));
  return ready;
}

export function setRobotSegmentColor(runtime: RobotRuntime, id: RobotSegmentId, color: string): void {
  const segment = runtime.segments.get(id);
  if (!segment) return;
  segment.tint = color;
  segment.tintColor = new THREE.Color(color);
  for (const mesh of runtime.meshes) updateVertexColors(runtime, mesh);
}

export function resetRobotSegmentColor(runtime: RobotRuntime, id: RobotSegmentId): void {
  const segment = runtime.segments.get(id);
  if (!segment) return;
  segment.tint = null;
  segment.tintColor = null;
  for (const mesh of runtime.meshes) updateVertexColors(runtime, mesh);
}

export function robotSegmentColor(segment: RobotPaintTarget): string {
  if (segment.tint) return segment.tint;
  for (const mesh of segment.meshes) {
    for (const material of materialsOf(mesh)) {
      const color = colorOf(material);
      if (color) return '#' + color.getHexString();
    }
  }
  return '#f4f4f2';
}
const ROBOT_GAIT_CLEARANCE = 0.001;
const NAMASTE_FINGER_NAMES = ["Index", "Middle", "Ring", "Pinky", "Thumb"] as const;
/** Keeps a straight thumb chain on the outer edge of each palm. */
const NAMASTE_THUMB_RADIAL_OFFSET = 0.008;
/** Gentle forward bow synchronized to the Namaste palm contact. */
const NAMASTE_TORSO_BOW_DEGREES = 5;
/** Neck pitch required to bring the head to the fixed Namaste fingertips. */
const NAMASTE_HEAD_BOW_DEGREES = 45;
/** Source-model half-span for nonpenetrating Namaste palm contact. */
const NAMASTE_WRIST_HALF_SPACING = 0.018485;
/** The current hand correction keeps extra width until palms align. */
const NAMASTE_APPROACH_HALF_SPACING = 0.03915;
/** Model-space palm-core bias keeps contact close without crossing triangles. */
const NAMASTE_WRIST_X_BIAS = 0.000193;
const NAMASTE_WRIST_Y_BIAS = 0.0000816;
const NAMASTE_WRIST_Z_BIAS = 0.0009971;
/** Vietnamese greeting hand targets are localized to the hip anchor. */
/** Crossed wrists bring the hands together at the abdomen with softly bent elbows. */
const VIETNAMESE_HAND_APPROACH_HALF_SPAN = 0.05;
const VIETNAMESE_HAND_HALF_SPAN = 0.017;
const VIETNAMESE_HAND_BELLY_DROP = 0.085;
const VIETNAMESE_HAND_BELLY_FRONT = 0.175;
/** Small vertical offset stacks the hands as the wrists cross. */
const VIETNAMESE_HAND_STACK_HEIGHT = 0.01;
const VIETNAMESE_MIN_ELBOW_FLEX_DEGREES = 25;

/** Model-space offsets from each live thigh bone to the front/outer thigh contact. */
const JAPAN_GREETING_HAND_TARGET_OFFSETS = {
  Left: new THREE.Vector3(0.0449, -0.0206, 0.0919),
  Right: new THREE.Vector3(-0.0175, -0.0318, 0.0759),
};
/** Palm normals face opposite the measured thigh surface normals. */
const JAPAN_GREETING_PALM_NORMALS = {
  Left: new THREE.Vector3(-0.489, -0.439, -0.754),
  Right: new THREE.Vector3(0.343, -0.275, -0.916),
};
const JAPAN_GREETING_THIGH_SLIDE_LIMIT_RATIO = 0.4;
const JAPAN_GREETING_STRAIGHT_ARM_SLACK = 0.0008;
/** Measured source-model offsets that keep Walk arm vertices at least 1.2mm from torso/thigh samples. */
const WALK_ARM_CLEARANCE_PROFILE = [
  [0, 0.000127266068, -0.00030005114, -0.000367049839, 0, 0, 0],
  [0.059375, -0.000144434314, -0.000123537122, 0.000091455432, 0, 0, 0],
  [0.11875, 0.000102375345, 0.000151071772, -0.000236859383, 0, 0, 0],
  [0.178125, 0, 0, 0, 0, 0, 0],
  [0.2375, 0, 0, 0, 0, 0, 0],
  [0.296875, 0, 0, 0, 0, 0, 0],
  [0.35625, 0, 0, 0, 0, 0, 0],
  [0.415625, 0, 0, 0, 0, 0, 0],
  [0.475, 0, 0, 0, -0.000252624405, 0.000201975108, -0.000263099857],
  [0.534375, 0, 0, 0, 0, 0, 0],
  [0.59375, -0.000617937639, 0.000263361764, 0.0000528951461, 0.0000633570998, 0.000162369744, 0.0000769267529],
  [0.653125, 0.00012232509, -0.000112754468, -0.000365508633, 0, 0, 0],
  [0.7125, 0, 0, 0, 0, 0, 0],
  [0.771875, 0, 0, 0, 0, 0, 0],
  [0.83125, 0, 0, 0, 0, 0, 0],
  [0.890625, 0, 0, 0, 0, 0, 0],
  [0.95, 0, 0, 0, 0, 0, 0],
  [1.009375, 0, 0, 0, 0, 0, 0],
  [1.06875, 0, 0, 0, 0, 0, 0],
  [1.128125, -0.000308937788, 0.000474461496, -0.000383937353, 0, 0, 0],
  [1.1875, -0.000136216305, 0.0000468626971, 0.0000492681268, 0, 0, 0],
  [1.246875, 0, 0, 0, 0, 0, 0],
  [1.30625, 0, 0, 0, 0, 0, 0],
  [1.365625, 0, 0, 0, 0, 0, 0],
  [1.425, 0, 0, 0, 0, 0, 0],
  [1.484375, 0, 0, 0, 0, 0, 0],
  [1.54375, 0, 0, 0, 0, 0, 0],
  [1.603125, -0.0000802405867, -0.0000969097141, -0.000138326578, 0, 0, 0],
  [1.6625, 0, 0, 0, 0, 0, 0],
  [1.721875, -0.0000924272588, -0.000368389305, 0.0000580273026, 0, 0, 0],
  [1.78125, 0.00013155816, -0.0000818311352, -0.000546764484, 0, 0, 0],
  [1.840625, 0, 0, 0, 0, 0, 0],
  [1.9, 0, 0, 0, 0.000219804495, -0.000060592765, -0.000189608108],
  [1.959375, 0, 0, 0, 0, 0, 0],
  [2.01875, 0, 0, 0, 0, 0, 0],
  [2.078125, 0, 0, 0, 0, 0, 0],
  [2.1375, 0, 0, 0, 0, 0, 0],
  [2.196875, 0, 0, 0, 0, 0, 0],
  [2.25625, 0.000146080281, 0.0000132678502, 0.0000454466945, 0, 0, 0],
  [2.315625, 0, 0, 0, 0, 0, 0],
  [2.363125, 0.000041575513, -0.00129833682, 0.000339590214, 0, 0, 0],
  [2.375, 0.000127266068, -0.00030005114, -0.000367049839, 0, 0, 0],
] as const;

const ROBOT_POSE_SCRATCH = {
  origin: new THREE.Vector3(),
  offset: new THREE.Vector3(),
  position: new THREE.Vector3(),
  hipPosition: new THREE.Vector3(),
  target: new THREE.Vector3(),
  targetLocal: new THREE.Vector3(),
  forearmOffset: new THREE.Vector3(),
  handOffset: new THREE.Vector3(),
  shoulder: new THREE.Vector3(),
  elbow: new THREE.Vector3(),
  elbowTarget: new THREE.Vector3(),
  wrist: new THREE.Vector3(),
  namasteLeftWrist: new THREE.Vector3(),
  namasteRightWrist: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  namastePitchAxis: new THREE.Vector3(),
  namastePitch: new THREE.Quaternion(),
  pole: new THREE.Vector3(),
  elbowOffset: new THREE.Vector3(),
  currentPerpendicular: new THREE.Vector3(),
  targetPerpendicular: new THREE.Vector3(),
  perpendicular: new THREE.Vector3(),
  fingerDirection: new THREE.Vector3(),
  widthDirection: new THREE.Vector3(),
  palmNormal: new THREE.Vector3(),
  targetFingerDirection: new THREE.Vector3(),
  targetWidthDirection: new THREE.Vector3(),
  targetPalmNormal: new THREE.Vector3(),
  directionRotation: new THREE.Quaternion(),
  worldRotation: new THREE.Quaternion(),
  parentRotation: new THREE.Quaternion(),
  localRotation: new THREE.Quaternion(),
  currentFrame: new THREE.Matrix4(),
  targetFrame: new THREE.Matrix4(),
  currentFrameRotation: new THREE.Quaternion(),
  targetFrameRotation: new THREE.Quaternion(),
  palmRotation: new THREE.Quaternion(),
  fingerCurl: new THREE.Quaternion(),
  thumbCurl: new THREE.Quaternion(),
  localY: new THREE.Vector3(0, 1, 0),
  localZ: new THREE.Vector3(0, 0, 1),
};

function robotPoseRamp(start: number, end: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

function robotGestureWeight(time: number, start: number, end: number, fade: number): number {
  return robotPoseRamp(start, start + fade, time) * (1 - robotPoseRamp(end - fade, end, time));
}
function applyNamasteReferenceBodyPose(runtime: RobotRuntime, time: number, contactBlend: number): void {
  const referencePose = namasteReferencePoseStates.get(runtime);
  if (!referencePose) return;
  referencePose.action.reset().play();
  referencePose.action.time = Math.max(0, Math.min(referencePose.duration, time));
  referencePose.mixer.update(0);
  runtime.displayRoot.updateMatrixWorld(true);

  if (contactBlend <= 1e-3) return;
  const spine = findRobotBone(runtime, "Spine");
  const neck = findRobotBone(runtime, "Neck");
  if (spine) applyNamasteForwardPitch(runtime, spine, NAMASTE_TORSO_BOW_DEGREES * contactBlend);
  if (neck) applyNamasteForwardPitch(runtime, neck, NAMASTE_HEAD_BOW_DEGREES * contactBlend);
}

function applyNamasteForwardPitch(runtime: RobotRuntime, bone: THREE.Bone, degrees: number): void {
  if (degrees <= 1e-3 || !bone.parent) return;
  const scratch = ROBOT_POSE_SCRATCH;
  runtime.model.getWorldQuaternion(scratch.worldRotation);
  // Model +X pitches the torso and head toward the model's forward +Z direction.
  scratch.namastePitchAxis.set(1, 0, 0).applyQuaternion(scratch.worldRotation);
  bone.parent.getWorldQuaternion(scratch.parentRotation).invert();
  scratch.namastePitchAxis.applyQuaternion(scratch.parentRotation);
  scratch.namastePitch.setFromAxisAngle(scratch.namastePitchAxis, THREE.MathUtils.degToRad(degrees));
  saveRobotBoneQuaternion(runtime, bone);
  bone.quaternion.premultiply(scratch.namastePitch).normalize();
  runtime.displayRoot.updateMatrixWorld(true);
}

function findRobotBone(runtime: RobotRuntime, name: string): THREE.Bone | undefined {
  return runtime.meshes[0]?.skeleton.bones.find((bone) => bone.name === "mixamorig" + name);
}
interface RobotPoseCorrectionEntry {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  positionSaved: boolean;
  quaternionSaved: boolean;
}

const robotPoseCorrections = new WeakMap<RobotRuntime, Map<THREE.Bone, RobotPoseCorrectionEntry>>();

function robotPoseCorrectionEntry(runtime: RobotRuntime, bone: THREE.Bone): RobotPoseCorrectionEntry {
  let entries = robotPoseCorrections.get(runtime);
  if (!entries) {
    entries = new Map();
    robotPoseCorrections.set(runtime, entries);
  }
  let entry = entries.get(bone);
  if (!entry) {
    entry = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      positionSaved: false,
      quaternionSaved: false,
    };
    entries.set(bone, entry);
  }
  return entry;
}

function saveRobotBonePosition(runtime: RobotRuntime, bone: THREE.Bone): void {
  const entry = robotPoseCorrectionEntry(runtime, bone);
  if (entry.positionSaved) return;
  entry.position.copy(bone.position);
  entry.positionSaved = true;
}

function saveRobotBoneQuaternion(runtime: RobotRuntime, bone: THREE.Bone): void {
  const entry = robotPoseCorrectionEntry(runtime, bone);
  if (entry.quaternionSaved) return;
  entry.quaternion.copy(bone.quaternion);
  entry.quaternionSaved = true;
}

/** Restores the source mixer pose before its next update, preventing correction offsets from accumulating. */
export function resetRobotAnimationCorrection(runtime: RobotRuntime): void {
  const entries = robotPoseCorrections.get(runtime);
  if (!entries) return;
  let restored = false;
  for (const [bone, entry] of entries) {
    if (entry.positionSaved) {
      bone.position.copy(entry.position);
      entry.positionSaved = false;
      restored = true;
    }
    if (entry.quaternionSaved) {
      bone.quaternion.copy(entry.quaternion);
      entry.quaternionSaved = false;
      restored = true;
    }
  }
  if (restored) runtime.displayRoot.updateMatrixWorld(true);
}
function sampleWalkArmClearance(
  time: number,
  forearmOffset: THREE.Vector3,
  handOffset: THREE.Vector3,
): void {
  const profile = WALK_ARM_CLEARANCE_PROFILE;
  const boundedTime = Math.max(profile[0][0], Math.min(profile[profile.length - 1][0], time));
  let index = 0;
  while (index < profile.length - 2 && boundedTime > profile[index + 1][0]) index++;
  const start = profile[index];
  const end = profile[index + 1];
  const amount = end[0] === start[0] ? 0 : (boundedTime - start[0]) / (end[0] - start[0]);
  forearmOffset.set(
    start[1] + (end[1] - start[1]) * amount,
    start[2] + (end[2] - start[2]) * amount,
    start[3] + (end[3] - start[3]) * amount,
  );
  handOffset.set(
    start[4] + (end[4] - start[4]) * amount,
    start[5] + (end[5] - start[5]) * amount,
    start[6] + (end[6] - start[6]) * amount,
  );
}

function applyRobotBoneOffset(runtime: RobotRuntime, boneName: string, modelOffset: THREE.Vector3): void {
  if (modelOffset.lengthSq() <= 1e-12) return;
  const bone = findRobotBone(runtime, boneName);
  if (!bone?.parent) return;
  const scratch = ROBOT_POSE_SCRATCH;
  scratch.origin.set(0, 0, 0);
  scratch.position.copy(modelOffset);
  runtime.model.localToWorld(scratch.origin);
  runtime.model.localToWorld(scratch.position).sub(scratch.origin);
  bone.getWorldPosition(scratch.target).add(scratch.position);
  bone.parent.worldToLocal(scratch.target);
  saveRobotBonePosition(runtime, bone);
  bone.position.copy(scratch.target);
  runtime.displayRoot.updateMatrixWorld(true);
}

function rotateRobotBoneToward(
  runtime: RobotRuntime,
  bone: THREE.Bone,
  child: THREE.Bone,
  childTarget: THREE.Vector3,
): void {
  const scratch = ROBOT_POSE_SCRATCH;
  bone.getWorldPosition(scratch.shoulder);
  child.getWorldPosition(scratch.elbow);
  scratch.direction.subVectors(scratch.elbow, scratch.shoulder).normalize();
  scratch.pole.subVectors(childTarget, scratch.shoulder).normalize();
  scratch.directionRotation.setFromUnitVectors(scratch.direction, scratch.pole);
  bone.getWorldQuaternion(scratch.worldRotation);
  if (bone.parent) bone.parent.getWorldQuaternion(scratch.parentRotation);
  else scratch.parentRotation.identity();
  scratch.localRotation.copy(scratch.parentRotation).invert()
    .multiply(scratch.directionRotation.multiply(scratch.worldRotation));
  saveRobotBoneQuaternion(runtime, bone);
  bone.quaternion.copy(scratch.localRotation).normalize();
  runtime.displayRoot.updateMatrixWorld(true);
}

function solveRobotArm(
  runtime: RobotRuntime,
  side: "Left" | "Right",
  wristTarget: THREE.Vector3,
  weight: number,
  minimumElbowFlexDegrees = 0,
  elbowDrop = 0,
): THREE.Bone | undefined {
  const upper = findRobotBone(runtime, side + "Arm");
  const forearm = findRobotBone(runtime, side + "ForeArm");
  const hand = findRobotBone(runtime, side + "Hand");
  if (!upper || !forearm || !hand) return undefined;
  const scratch = ROBOT_POSE_SCRATCH;
  upper.getWorldPosition(scratch.shoulder);
  forearm.getWorldPosition(scratch.elbow);
  hand.getWorldPosition(scratch.wrist);
  const upperLength = scratch.shoulder.distanceTo(scratch.elbow);
  const forearmLength = scratch.elbow.distanceTo(scratch.wrist);
  scratch.targetLocal.copy(wristTarget);
  runtime.model.worldToLocal(scratch.wrist);
  scratch.targetLocal.lerp(scratch.wrist, 1 - weight);
  scratch.target.copy(scratch.targetLocal);
  runtime.model.localToWorld(scratch.target);
  scratch.direction.subVectors(scratch.target, scratch.shoulder);
  let reach = scratch.direction.length();
  if (reach <= 1e-6) return hand;
  scratch.direction.multiplyScalar(1 / reach);
  const minimumReach = Math.abs(upperLength - forearmLength) + 1e-4;
  const maximumReach = upperLength + forearmLength - 1e-4;
  const bendLimitedReach = Math.sqrt(Math.max(0,
    upperLength * upperLength + forearmLength * forearmLength
      + 2 * upperLength * forearmLength * Math.cos(THREE.MathUtils.degToRad(minimumElbowFlexDegrees)),
  ));
  reach = Math.max(minimumReach, Math.min(maximumReach, bendLimitedReach, reach));
  scratch.target.copy(scratch.shoulder).addScaledVector(scratch.direction, reach);
  const along = (upperLength * upperLength - forearmLength * forearmLength + reach * reach) / (2 * reach);
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
  const sideSign = side === "Left" ? 1 : -1;
  scratch.origin.set(0, 0, 0);
  runtime.model.localToWorld(scratch.origin);
  scratch.pole.set(sideSign, -elbowDrop, 0);
  runtime.model.localToWorld(scratch.pole).sub(scratch.origin).normalize();
  scratch.elbowOffset.subVectors(scratch.elbow, scratch.shoulder);
  scratch.currentPerpendicular.copy(scratch.elbowOffset)
    .addScaledVector(scratch.direction, -scratch.elbowOffset.dot(scratch.direction));
  scratch.targetPerpendicular.copy(scratch.pole)
    .addScaledVector(scratch.direction, -scratch.pole.dot(scratch.direction));
  if (scratch.currentPerpendicular.lengthSq() <= 1e-8) {
    scratch.currentPerpendicular.copy(scratch.targetPerpendicular);
  }
  scratch.currentPerpendicular.normalize();
  scratch.targetPerpendicular.normalize();
  scratch.perpendicular.copy(scratch.currentPerpendicular)
    .lerp(scratch.targetPerpendicular, weight).normalize();
  scratch.elbowTarget.copy(scratch.shoulder)
    .addScaledVector(scratch.direction, along)
    .addScaledVector(scratch.perpendicular, height);
  rotateRobotBoneToward(runtime, upper, forearm, scratch.elbowTarget);
  rotateRobotBoneToward(runtime, forearm, hand, scratch.target);
  return hand;
}

function alignRobotPalm(
  runtime: RobotRuntime,
  side: "Left" | "Right",
  hand: THREE.Bone,
  weight: number,
  targetFingerLocal: THREE.Vector3 = ROBOT_POSE_SCRATCH.localY,
  targetPalmNormalLocal?: THREE.Vector3,
  forearmRollWeight = 0,
): void {
  const scratch = ROBOT_POSE_SCRATCH;
  const index = findRobotBone(runtime, side + "HandIndex1");
  const pinky = findRobotBone(runtime, side + "HandPinky1");
  const middleBase = findRobotBone(runtime, side + "HandMiddle1");
  const middleTip = findRobotBone(runtime, side + "HandMiddle4");
  if (!index || !pinky || !middleBase || !middleTip) return;
  index.getWorldPosition(scratch.position);
  pinky.getWorldPosition(scratch.offset);
  middleBase.getWorldPosition(scratch.origin);
  middleTip.getWorldPosition(scratch.target);
  scratch.fingerDirection.subVectors(scratch.target, scratch.origin).normalize();
  scratch.widthDirection.subVectors(scratch.position, scratch.offset).normalize();
  scratch.palmNormal.crossVectors(scratch.fingerDirection, scratch.widthDirection).normalize();
  scratch.widthDirection.crossVectors(scratch.palmNormal, scratch.fingerDirection).normalize();
  scratch.currentFrame.makeBasis(scratch.fingerDirection, scratch.widthDirection, scratch.palmNormal);
  scratch.currentFrameRotation.setFromRotationMatrix(scratch.currentFrame);
  scratch.targetFingerDirection.copy(targetFingerLocal).transformDirection(runtime.model.matrixWorld);
  if (targetPalmNormalLocal) {
    scratch.targetPalmNormal.copy(targetPalmNormalLocal).transformDirection(runtime.model.matrixWorld).normalize();
    scratch.targetWidthDirection.crossVectors(scratch.targetPalmNormal, scratch.targetFingerDirection).normalize();
    scratch.targetPalmNormal.crossVectors(scratch.targetFingerDirection, scratch.targetWidthDirection).normalize();
  } else {
    scratch.targetWidthDirection.set(0, 0, side === "Left" ? -1 : 1)
      .transformDirection(runtime.model.matrixWorld);
    scratch.targetPalmNormal.crossVectors(scratch.targetFingerDirection, scratch.targetWidthDirection).normalize();
  }
  scratch.targetFrame.makeBasis(scratch.targetFingerDirection, scratch.targetWidthDirection, scratch.targetPalmNormal);
  scratch.targetFrameRotation.setFromRotationMatrix(scratch.targetFrame);
  scratch.palmRotation.copy(scratch.targetFrameRotation)
    .multiply(scratch.currentFrameRotation.invert());
  if (forearmRollWeight > 0) {
    const forearm = findRobotBone(runtime, side + "ForeArm");
    if (forearm) {
      forearm.getWorldPosition(scratch.shoulder);
      hand.getWorldPosition(scratch.wrist);
      scratch.direction.subVectors(scratch.wrist, scratch.shoulder).normalize();
      const twistProjection = scratch.palmRotation.x * scratch.direction.x
        + scratch.palmRotation.y * scratch.direction.y
        + scratch.palmRotation.z * scratch.direction.z;
      scratch.directionRotation.set(
        scratch.direction.x * twistProjection,
        scratch.direction.y * twistProjection,
        scratch.direction.z * twistProjection,
        scratch.palmRotation.w,
      ).normalize();
      scratch.palmRotation.identity().slerp(scratch.directionRotation, forearmRollWeight * weight);
      forearm.getWorldQuaternion(scratch.currentFrameRotation);
      forearm.parent?.getWorldQuaternion(scratch.parentRotation);
      if (!forearm.parent) scratch.parentRotation.identity();
      scratch.localRotation.copy(scratch.parentRotation).invert()
        .multiply(scratch.palmRotation.multiply(scratch.currentFrameRotation));
      saveRobotBoneQuaternion(runtime, forearm);
      forearm.quaternion.copy(scratch.localRotation).normalize();
      runtime.displayRoot.updateMatrixWorld(true);

      index.getWorldPosition(scratch.position);
      pinky.getWorldPosition(scratch.offset);
      middleBase.getWorldPosition(scratch.origin);
      middleTip.getWorldPosition(scratch.target);
      scratch.fingerDirection.subVectors(scratch.target, scratch.origin).normalize();
      scratch.widthDirection.subVectors(scratch.position, scratch.offset).normalize();
      scratch.palmNormal.crossVectors(scratch.fingerDirection, scratch.widthDirection).normalize();
      scratch.widthDirection.crossVectors(scratch.palmNormal, scratch.fingerDirection).normalize();
      scratch.currentFrame.makeBasis(scratch.fingerDirection, scratch.widthDirection, scratch.palmNormal);
      scratch.currentFrameRotation.setFromRotationMatrix(scratch.currentFrame);
      scratch.palmRotation.copy(scratch.targetFrameRotation)
        .multiply(scratch.currentFrameRotation.invert());
    }
  }
  scratch.directionRotation.identity().slerp(scratch.palmRotation, weight);
  hand.getWorldQuaternion(scratch.worldRotation);
  hand.parent?.getWorldQuaternion(scratch.parentRotation);
  scratch.localRotation.copy(scratch.parentRotation).invert()
    .multiply(scratch.directionRotation.multiply(scratch.worldRotation));
  saveRobotBoneQuaternion(runtime, hand);
  hand.quaternion.copy(scratch.localRotation).normalize();
  runtime.displayRoot.updateMatrixWorld(true);
}

function alignNamasteFingerChain(
  runtime: RobotRuntime,
  side: "Left" | "Right",
  finger: typeof NAMASTE_FINGER_NAMES[number],
  hand: THREE.Bone,
  targetFingerLocal: THREE.Vector3,
  weight: number,
): void {
  if (weight <= 1e-3) return;
  const base = findRobotBone(runtime, side + "Hand" + finger + "1");
  const joint = findRobotBone(runtime, side + "Hand" + finger + "2");
  const middle = findRobotBone(runtime, side + "Hand" + finger + "3");
  const tip = findRobotBone(runtime, side + "Hand" + finger + "4");
  if (!base || !joint || !middle || !tip) return;

  const scratch = ROBOT_POSE_SCRATCH;
  hand.getWorldQuaternion(scratch.palmRotation);
  // Aim and roll are separate: axis-only alignment leaves pad corners and the thumb web crossing the seam.
  const sideSign = side === "Left" ? 1 : -1;
  scratch.worldRotation.copy(scratch.palmRotation).multiply(base.quaternion);
  scratch.direction.copy(joint.position).applyQuaternion(scratch.worldRotation).normalize();
  // Keep all digit shafts straight; thumb radial placement and axial roll remain separate.
  scratch.fingerDirection.copy(targetFingerLocal);
  scratch.fingerDirection.transformDirection(runtime.model.matrixWorld);
  scratch.fingerCurl.setFromUnitVectors(scratch.direction, scratch.fingerDirection);
  scratch.thumbCurl.setFromAxisAngle(scratch.fingerDirection, sideSign * THREE.MathUtils.degToRad(finger === "Thumb" ? 55 : 30));
  scratch.targetFrameRotation.copy(scratch.thumbCurl).multiply(scratch.fingerCurl).multiply(scratch.worldRotation);
  scratch.localRotation.copy(scratch.palmRotation).invert().multiply(scratch.targetFrameRotation);
  saveRobotBoneQuaternion(runtime, base);
  base.quaternion.slerp(scratch.localRotation, weight).normalize();

  scratch.parentRotation.copy(scratch.palmRotation).multiply(base.quaternion);
  scratch.worldRotation.copy(scratch.parentRotation).multiply(joint.quaternion);
  scratch.direction.copy(joint.position).applyQuaternion(scratch.parentRotation).normalize();
  scratch.fingerDirection.copy(middle.position).applyQuaternion(scratch.worldRotation).normalize();
  if (scratch.direction.dot(scratch.fingerDirection) <= 0.999999) {
    scratch.fingerCurl.setFromUnitVectors(scratch.fingerDirection, scratch.direction);
    scratch.targetFrameRotation.copy(scratch.fingerCurl).multiply(scratch.worldRotation);
    scratch.localRotation.copy(scratch.parentRotation).invert().multiply(scratch.targetFrameRotation);
    saveRobotBoneQuaternion(runtime, joint);
    joint.quaternion.slerp(scratch.localRotation, weight).normalize();
  }

  scratch.worldRotation.copy(scratch.parentRotation).multiply(joint.quaternion);
  scratch.parentRotation.copy(scratch.worldRotation);
  scratch.worldRotation.multiply(middle.quaternion);
  scratch.direction.copy(middle.position).applyQuaternion(scratch.parentRotation).normalize();
  scratch.fingerDirection.copy(tip.position).applyQuaternion(scratch.worldRotation).normalize();
  if (scratch.direction.dot(scratch.fingerDirection) <= 0.999999) {
    scratch.fingerCurl.setFromUnitVectors(scratch.fingerDirection, scratch.direction);
    scratch.targetFrameRotation.copy(scratch.fingerCurl).multiply(scratch.worldRotation);
    scratch.localRotation.copy(scratch.parentRotation).invert().multiply(scratch.targetFrameRotation);
    saveRobotBoneQuaternion(runtime, middle);
    middle.quaternion.slerp(scratch.localRotation, weight).normalize();
  }
}

interface JapanGreetingContactScratch {
  mesh: THREE.SkinnedMesh;
  skinIndex: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  skinWeight: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  handVertices: Record<"Left" | "Right", number[]>;
  raycaster: THREE.Raycaster;
  intersections: THREE.Intersection[];
  inverseModel: THREE.Matrix4;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  surfacePoint: THREE.Vector3;
  surfaceNormal: THREE.Vector3;
  fittedNormal: THREE.Vector3;
  palmNormal: THREE.Vector3;
  outward: THREE.Vector3;
  vertex: THREE.Vector3;
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  delta: THREE.Vector3;
  tangent: THREE.Vector3;
}

const japanGreetingContactScratchByRuntime = new WeakMap<RobotRuntime, JapanGreetingContactScratch>();

function getJapanGreetingContactScratch(runtime: RobotRuntime): JapanGreetingContactScratch | null {
  const cached = japanGreetingContactScratchByRuntime.get(runtime);
  if (cached) return cached;
  const mesh = runtime.meshes[0];
  if (!mesh) return null;
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  if (!skinIndex || !skinWeight) return null;
  const handVertices: Record<"Left" | "Right", number[]> = { Left: [], Right: [] };
  const prefixes = { Left: "mixamorigLeftHand", Right: "mixamorigRightHand" };
  const bones = mesh.skeleton.bones;
  for (let vertex = 0; vertex < skinIndex.count; vertex++) {
    for (const side of ["Left", "Right"] as const) {
      let handWeight = 0;
      for (let influence = 0; influence < 4; influence++) {
        const bone = bones[skinIndex.getComponent(vertex, influence)];
        if (bone?.name.startsWith(prefixes[side])) handWeight += skinWeight.getComponent(vertex, influence);
      }
      if (handWeight > 0.1) handVertices[side].push(vertex);
    }
  }
  const scratch: JapanGreetingContactScratch = {
    mesh,
    skinIndex,
    skinWeight,
    handVertices,
    raycaster: new THREE.Raycaster(),
    intersections: [],
    inverseModel: new THREE.Matrix4(),
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    surfacePoint: new THREE.Vector3(),
    surfaceNormal: new THREE.Vector3(),
    fittedNormal: new THREE.Vector3(),
    palmNormal: new THREE.Vector3(),
    outward: new THREE.Vector3(),
    vertex: new THREE.Vector3(),
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    c: new THREE.Vector3(),
    delta: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
  };
  japanGreetingContactScratchByRuntime.set(runtime, scratch);
  return scratch;
}

function findJapanGreetingThighSurface(
  runtime: RobotRuntime,
  scratch: JapanGreetingContactScratch,
  side: "Left" | "Right",
  outward: THREE.Vector3,
): boolean {
  const wrist = findRobotBone(runtime, side + "Hand");
  if (!wrist) return false;
  const { mesh } = scratch;
  scratch.inverseModel.copy(runtime.model.matrixWorld).invert();
  wrist.getWorldPosition(scratch.origin);
  runtime.model.worldToLocal(scratch.origin).addScaledVector(outward, 0.25);
  runtime.model.localToWorld(scratch.origin);
  scratch.direction.copy(outward).negate().transformDirection(runtime.model.matrixWorld);
  scratch.raycaster.set(scratch.origin, scratch.direction);
  scratch.intersections.length = 0;
  scratch.raycaster.intersectObject(mesh, false, scratch.intersections);
  for (const hit of scratch.intersections) {
    const face = hit.face;
    if (!face) continue;
    let thighWeight = 0;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = corner === 0 ? face.a : corner === 1 ? face.b : face.c;
      for (let influence = 0; influence < 4; influence++) {
        const bone = mesh.skeleton.bones[scratch.skinIndex.getComponent(vertex, influence)];
        if (bone?.name === "mixamorig" + side + "UpLeg" || bone?.name === "mixamorig" + side + "Leg") {
          thighWeight += scratch.skinWeight.getComponent(vertex, influence) / 3;
        }
      }
    }
    if (thighWeight <= 0.3) continue;
    scratch.surfacePoint.copy(hit.point);
    runtime.model.worldToLocal(scratch.surfacePoint);
    mesh.getVertexPosition(face.a, scratch.a).applyMatrix4(mesh.matrixWorld).applyMatrix4(scratch.inverseModel);
    mesh.getVertexPosition(face.b, scratch.b).applyMatrix4(mesh.matrixWorld).applyMatrix4(scratch.inverseModel);
    mesh.getVertexPosition(face.c, scratch.c).applyMatrix4(mesh.matrixWorld).applyMatrix4(scratch.inverseModel);
    scratch.surfaceNormal.crossVectors(scratch.b.sub(scratch.a), scratch.c.sub(scratch.a)).normalize();
    if (scratch.surfaceNormal.dot(outward) < 0) scratch.surfaceNormal.negate();
    scratch.surfaceNormal.y = 0;
    if (scratch.surfaceNormal.lengthSq() < 1e-8) scratch.surfaceNormal.copy(outward).setY(0);
    scratch.surfaceNormal.normalize();
    return true;
  }
  return false;
}

function minimumJapanGreetingHandGap(
  runtime: RobotRuntime,
  scratch: JapanGreetingContactScratch,
  side: "Left" | "Right",
): number | null {
  scratch.inverseModel.copy(runtime.model.matrixWorld).invert();
  let minimumGap = Infinity;
  for (const vertexIndex of scratch.handVertices[side]) {
    scratch.mesh.getVertexPosition(vertexIndex, scratch.vertex)
      .applyMatrix4(scratch.mesh.matrixWorld).applyMatrix4(scratch.inverseModel);
    scratch.delta.subVectors(scratch.vertex, scratch.surfacePoint);
    const gap = scratch.delta.dot(scratch.fittedNormal);
    scratch.tangent.copy(scratch.delta).addScaledVector(scratch.fittedNormal, -gap);
    if (scratch.tangent.lengthSq() <= 0.04 * 0.04) minimumGap = Math.min(minimumGap, gap);
  }
  return Number.isFinite(minimumGap) ? minimumGap : null;
}

function extendJapanGreetingArmTarget(
  runtime: RobotRuntime,
  targetLocal: THREE.Vector3,
  thigh: THREE.Bone,
  knee: THREE.Bone,
  upper: THREE.Bone,
  forearm: THREE.Bone,
  hand: THREE.Bone,
  maximumSlide: number,
): void {
  const scratch = ROBOT_POSE_SCRATCH;
  thigh.getWorldPosition(scratch.origin);
  knee.getWorldPosition(scratch.position);
  scratch.pole.subVectors(scratch.position, scratch.origin).normalize();
  upper.getWorldPosition(scratch.shoulder);
  forearm.getWorldPosition(scratch.elbow);
  hand.getWorldPosition(scratch.wrist);
  const straightReach = scratch.shoulder.distanceTo(scratch.elbow)
    + scratch.elbow.distanceTo(scratch.wrist) - JAPAN_GREETING_STRAIGHT_ARM_SLACK;
  scratch.target.copy(targetLocal);
  runtime.model.localToWorld(scratch.target);
  scratch.direction.subVectors(scratch.target, scratch.shoulder);
  const reachSquared = scratch.direction.lengthSq();
  if (reachSquared >= straightReach * straightReach) return;
  scratch.origin.set(0, 0, 0);
  runtime.model.localToWorld(scratch.origin);
  scratch.offset.copy(scratch.pole);
  runtime.model.localToWorld(scratch.offset).sub(scratch.origin).normalize();
  const alongThigh = scratch.direction.dot(scratch.offset);
  const discriminant = alongThigh * alongThigh + straightReach * straightReach - reachSquared;
  if (discriminant <= 0) return;
  const slide = Math.min(-alongThigh + Math.sqrt(discriminant), maximumSlide);
  if (slide <= 0) return;
  scratch.target.addScaledVector(scratch.offset, slide);
  runtime.model.worldToLocal(scratch.target);
  targetLocal.copy(scratch.target);
}

/** Applies small runtime-only gesture and clearance corrections after the untouched source clip updates. */
export function applyRobotAnimationCorrection(runtime: RobotRuntime, clipName: string, time: number): void {
  const scratch = ROBOT_POSE_SCRATCH;
  runtime.displayRoot.updateMatrixWorld(true);
  if (clipName === "walk.001") {
    sampleWalkArmClearance(time, scratch.forearmOffset, scratch.handOffset);
    applyRobotBoneOffset(runtime, "LeftForeArm", scratch.forearmOffset);
    applyRobotBoneOffset(runtime, "LeftHand", scratch.handOffset);
    return;
  }
  if (clipName === "run.001") {
    scratch.offset.set(ROBOT_GAIT_CLEARANCE, 0, 0);
    applyRobotBoneOffset(runtime, "LeftForeArm", scratch.offset);
    scratch.offset.set(-ROBOT_GAIT_CLEARANCE, 0, 0);
    applyRobotBoneOffset(runtime, "RightForeArm", scratch.offset);
    return;
  }

  if (clipName.startsWith("China — Traditional Gongshou Greeting")) {
    const weight = robotGestureWeight(time, 0.9, 3.15, 0.35);
    if (weight <= 1e-3) return;
    scratch.fingerCurl.setFromAxisAngle(scratch.localZ, 1.0 * weight);
    for (const finger of ["Index", "Middle", "Ring", "Pinky"]) {
      for (let joint = 1; joint <= 3; joint++) {
        const bone = findRobotBone(runtime, "RightHand" + finger + joint);
        if (!bone) continue;
        saveRobotBoneQuaternion(runtime, bone);
        bone.quaternion.multiply(scratch.fingerCurl).normalize();
      }
    }
    scratch.thumbCurl.setFromAxisAngle(scratch.localZ, -0.85 * weight);
    for (let joint = 1; joint <= 3; joint++) {
      const bone = findRobotBone(runtime, "RightHandThumb" + joint);
      if (!bone) continue;
      saveRobotBoneQuaternion(runtime, bone);
      bone.quaternion.multiply(scratch.thumbCurl).normalize();
    }
    runtime.displayRoot.updateMatrixWorld(true);
    return;
  }

  if (clipName.startsWith("Vietnam — Folded Arms and Respectful Head Bow")) {
    const armWeight = time >= 0.675 && time <= 2.9 ? 1 : 0;
    const palmWeight = robotGestureWeight(time, 0, 4, 0.35);
    const hips = findRobotBone(runtime, "Hips");
    if ((armWeight <= 1e-3 && palmWeight <= 1e-3) || !hips) return;
    hips.getWorldPosition(scratch.position);
    runtime.model.worldToLocal(scratch.position);
    scratch.hipPosition.copy(scratch.position);
    const contactBlend = robotPoseRamp(1.25, 1.95, time) * (1 - robotPoseRamp(2.4, 2.9, time));
    const handHalfSpan = VIETNAMESE_HAND_APPROACH_HALF_SPAN
      + (VIETNAMESE_HAND_HALF_SPAN - VIETNAMESE_HAND_APPROACH_HALF_SPAN) * contactBlend;
    for (const side of ["Left", "Right"] as const) {
      const sideSign = side === "Left" ? 1 : -1;
      scratch.targetLocal.set(
        scratch.hipPosition.x - sideSign * handHalfSpan,
        scratch.hipPosition.y - VIETNAMESE_HAND_BELLY_DROP + sideSign * VIETNAMESE_HAND_STACK_HEIGHT * contactBlend,
        scratch.hipPosition.z + VIETNAMESE_HAND_BELLY_FRONT,
      );
      const hand = findRobotBone(runtime, side + "Hand");
      if (!hand) continue;
      if (armWeight > 1e-3) solveRobotArm(runtime, side, scratch.targetLocal, armWeight, VIETNAMESE_MIN_ELBOW_FLEX_DEGREES);
      scratch.direction.set(0, -1, 0);
      scratch.pole.set(sideSign, 0, 0);
      if (palmWeight > 1e-3) alignRobotPalm(runtime, side, hand, palmWeight, scratch.direction, scratch.pole);
    }
    runtime.displayRoot.updateMatrixWorld(true);
    return;
  }

  if (clipName === "Stand upright with your feet close together, knees relaxed, and") {
    const bowWeight = robotPoseRamp(0.7, 1.35, time) * (1 - robotPoseRamp(2.65, 3.35, time));
    if (bowWeight <= 1e-3) return;
    const leftHand = findRobotBone(runtime, "LeftHand");
    const rightHand = findRobotBone(runtime, "RightHand");
    if (!leftHand || !rightHand) return;
    leftHand.getWorldPosition(scratch.namasteLeftWrist);
    rightHand.getWorldPosition(scratch.namasteRightWrist);
    runtime.model.worldToLocal(scratch.namasteLeftWrist);
    runtime.model.worldToLocal(scratch.namasteRightWrist);
    // Keep the source hand/finger animation; only separate the two wrist targets in depth.
    const handFrontZ = Math.max(0.16, scratch.namasteLeftWrist.z, scratch.namasteRightWrist.z);
    const handDepthSeparation = 0.027 * bowWeight;
    for (const side of ["Left", "Right"] as const) {
      const wrist = side === "Left" ? scratch.namasteLeftWrist : scratch.namasteRightWrist;
      scratch.targetLocal.copy(wrist);
      scratch.targetLocal.z = handFrontZ + (side === "Left" ? -handDepthSeparation : handDepthSeparation);
      solveRobotArm(runtime, side, scratch.targetLocal, bowWeight, 0, 3);
    }
    runtime.displayRoot.updateMatrixWorld(true);
    return;
  }
  if (clipName === "Japan's Greeting") {
    for (const side of ["Left", "Right"] as const) {
      const thigh = findRobotBone(runtime, side + "UpLeg");
      const knee = findRobotBone(runtime, side + "Leg");
      const upper = findRobotBone(runtime, side + "Arm");
      const forearm = findRobotBone(runtime, side + "ForeArm");
      const hand = findRobotBone(runtime, side + "Hand");
      if (!thigh || !knee || !upper || !forearm || !hand) continue;
      thigh.getWorldPosition(scratch.hipPosition);
      runtime.model.worldToLocal(scratch.hipPosition);
      scratch.targetLocal.copy(scratch.hipPosition).add(JAPAN_GREETING_HAND_TARGET_OFFSETS[side]);
      thigh.getWorldPosition(scratch.origin);
      knee.getWorldPosition(scratch.position);
      const maximumSlide = scratch.origin.distanceTo(scratch.position) * JAPAN_GREETING_THIGH_SLIDE_LIMIT_RATIO;
      const contact = getJapanGreetingContactScratch(runtime);
      let contactNormalLocked = false;
      if (contact) {
        contact.palmNormal.copy(JAPAN_GREETING_PALM_NORMALS[side]).normalize();
        contact.fittedNormal.set(0, 0, 0);
      }
      for (let pass = 0; pass < 3; pass++) {
        extendJapanGreetingArmTarget(runtime, scratch.targetLocal, thigh, knee, upper, forearm, hand, maximumSlide);
        solveRobotArm(runtime, side, scratch.targetLocal, 1);
        scratch.direction.set(0, -1, 0);
        scratch.pole.copy(contact?.palmNormal ?? JAPAN_GREETING_PALM_NORMALS[side]);
        alignRobotPalm(runtime, side, hand, 1, scratch.direction, scratch.pole);
        if (!contact) break;
        runtime.displayRoot.updateMatrixWorld(true);
        contact.mesh.skeleton.update();
        if (!contactNormalLocked) {
          contact.outward.copy(contact.palmNormal).negate();
          if (!findJapanGreetingThighSurface(runtime, contact, side, contact.outward)) break;
          contact.fittedNormal.copy(contact.surfaceNormal);
          contact.palmNormal.copy(contact.fittedNormal).negate();
          contactNormalLocked = true;
        }
        contact.surfaceNormal.copy(contact.fittedNormal);
        scratch.pole.copy(contact.palmNormal);
        alignRobotPalm(runtime, side, hand, 1, scratch.direction, scratch.pole);
        runtime.displayRoot.updateMatrixWorld(true);
        contact.mesh.skeleton.update();
        const handGap = minimumJapanGreetingHandGap(runtime, contact, side);
        if (handGap === null) break;
        const contactAdjustment = 0.001 - handGap;
        if (Math.abs(contactAdjustment) <= 0.001) break;
        scratch.targetLocal.addScaledVector(contact.fittedNormal, contactAdjustment);
      }
      solveRobotArm(runtime, side, scratch.targetLocal, 1);
      scratch.direction.set(0, -1, 0);
      scratch.pole.copy(contact?.palmNormal ?? JAPAN_GREETING_PALM_NORMALS[side]);
      alignRobotPalm(runtime, side, hand, 1, scratch.direction, scratch.pole);
    }
    runtime.displayRoot.updateMatrixWorld(true);
    return;
  }

  if (clipName.startsWith("India — Namaste with Palms Together")) {
    const contactBlend = robotPoseRamp(0.45, 1.05, time) * (1 - robotPoseRamp(2.4, 3.05, time));
    applyNamasteReferenceBodyPose(runtime, time, contactBlend);
    const armWeight = robotGestureWeight(time, 0.45, 3.6, 0.55);
    const palmWeight = robotGestureWeight(time, 0, 4, 0.45);
    const thumbBlend = contactBlend;
    if (armWeight <= 1e-3 && palmWeight <= 1e-3) return;
    const leftHand = findRobotBone(runtime, 'LeftHand');
    const rightHand = findRobotBone(runtime, 'RightHand');
    if (!leftHand || !rightHand) return;
    leftHand.getWorldPosition(scratch.namasteLeftWrist);
    rightHand.getWorldPosition(scratch.namasteRightWrist);
    runtime.model.worldToLocal(scratch.namasteLeftWrist);
    runtime.model.worldToLocal(scratch.namasteRightWrist);
    const sharedWristY = (scratch.namasteLeftWrist.y + scratch.namasteRightWrist.y) * 0.5;
    const sharedWristZ = (scratch.namasteLeftWrist.z + scratch.namasteRightWrist.z) * 0.5;
    for (const side of ["Left", "Right"] as const) {
      const sideSign = side === "Left" ? 1 : -1;
      const hand = side === "Left" ? leftHand : rightHand;
      const referenceWrist = side === "Left" ? scratch.namasteLeftWrist : scratch.namasteRightWrist;
      const halfSpacing = NAMASTE_APPROACH_HALF_SPACING
        + (NAMASTE_WRIST_HALF_SPACING - NAMASTE_APPROACH_HALF_SPACING) * contactBlend;
      scratch.targetLocal.set(
        sideSign * (halfSpacing - NAMASTE_WRIST_X_BIAS * contactBlend),
        referenceWrist.y + (sharedWristY - referenceWrist.y + sideSign * NAMASTE_WRIST_Y_BIAS) * contactBlend,
        referenceWrist.z + (sharedWristZ - referenceWrist.z - sideSign * NAMASTE_WRIST_Z_BIAS) * contactBlend,
      );
      if (armWeight > 1e-3) solveRobotArm(runtime, side, scratch.targetLocal, armWeight, 0, 3);
      // Calibrated against opposing skinned surfaces, not the wrist-to-finger bone plane alone.
      const palmTilt = THREE.MathUtils.degToRad(21) * contactBlend;
      const palmYaw = THREE.MathUtils.degToRad(-6) * contactBlend;
      const sinTilt = Math.sin(palmTilt), cosTilt = Math.cos(palmTilt);
      const sinYaw = Math.sin(palmYaw), cosYaw = Math.cos(palmYaw);
      scratch.direction.set(-sideSign * sinTilt * cosYaw, cosTilt, sinTilt * sinYaw);
      // Both source palm bases use the same pole after accounting for the mirrored right hand.
      scratch.pole.set(-cosTilt * cosYaw, -sideSign * sinTilt, sideSign * cosTilt * sinYaw);
      if (palmWeight > 1e-3) alignRobotPalm(runtime, side, hand, palmWeight, scratch.direction, scratch.pole, 0.5);
      for (const finger of NAMASTE_FINGER_NAMES) {
        if (finger === "Thumb") {
          const thumbSplay = 1 - thumbBlend;
          scratch.targetFingerDirection.set(sideSign * 0.35 * thumbSplay, 1, -0.1 * thumbSplay);
          scratch.offset.set(sideSign * NAMASTE_THUMB_RADIAL_OFFSET * thumbBlend, 0, 0);
          applyRobotBoneOffset(runtime, side + "HandThumb1", scratch.offset);
          alignNamasteFingerChain(runtime, side, finger, hand, scratch.targetFingerDirection, thumbBlend);
        } else {
          alignNamasteFingerChain(runtime, side, finger, hand, scratch.localY, contactBlend);
        }
      }
      runtime.displayRoot.updateMatrixWorld(true);
    }
  }
}

export function robotSegmentForFace(
  runtime: RobotRuntime,
  mesh: THREE.SkinnedMesh,
  face: { a: number; b: number; c: number } | null,
): RobotSegmentId | null {
  const segmentation = runtime.segmentation.byMesh.get(mesh);
  if (!face || !segmentation) return null;
  const votes = new Float64Array(ROBOT_SEGMENTS.length);
  for (const vertex of [face.a, face.b, face.c]) {
    if (vertex < 0 || vertex >= segmentation.segmentIds.length) continue;
    const offset = vertex * ROBOT_SEGMENTS.length;
    for (let index = 0; index < ROBOT_SEGMENTS.length; index++) {
      votes[index] += segmentation.segmentWeights[offset + index];
    }
  }
  let winner = 0;
  for (let index = 1; index < votes.length; index++) {
    if (votes[index] > votes[winner]) winner = index;
  }
  return ROBOT_SEGMENTS[winner]?.id ?? null;
}

export function disposeRobotModel(displayRoot: THREE.Group, runtime: RobotRuntime | null): void {
  displayRoot.userData.disposed = true;
  if (runtime) {
    resetRobotAnimationCorrection(runtime);
    runtime.mixer.stopAllAction();
    runtime.mixer.uncacheRoot(runtime.model);
    const namasteReferencePose = namasteReferencePoseStates.get(runtime);
    if (namasteReferencePose) {
      namasteReferencePose.mixer.stopAllAction();
      namasteReferencePose.mixer.uncacheRoot(runtime.model);
      namasteReferencePoseStates.delete(runtime);
    }
    for (const mesh of runtime.meshes) {
      mesh.geometry.dispose();
      for (const material of materialsOf(mesh)) material.dispose();
    }
  }
  displayRoot.removeFromParent();
}
