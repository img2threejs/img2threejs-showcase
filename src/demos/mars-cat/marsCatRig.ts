import * as THREE from 'three';
import { MARS_CAT_RIG, MARS_CAT_SKIN } from './rig/rigData';
import { MARS_CAT_GAME_SKIN } from './rig/rigDataGame';
import {
  MARS_CAT_SOURCE_ANIMATION_PROVENANCE,
  MARS_CAT_SOURCE_CLIPS,
} from './rig/sourceAnimationData';

export interface MarsCatAnimationController {
  actions: ReadonlyArray<{ id: string; label: string; loop: boolean }>;
  readonly active: string;
  play(name: string): void;
  seek(name: string, timeSeconds: number): void;
  stop(): void;
  update(deltaSeconds: number): void;
  subscribe(listener: (active: string) => void): () => void;
}

export interface MarsCatRigRuntime {
  skeleton: THREE.Skeleton;
  bones: readonly THREE.Bone[];
  clips: readonly THREE.AnimationClip[];
  animationController: MarsCatAnimationController;
  update(deltaSeconds: number): void;
}

const decodeBytes = (encoded: string): Uint8Array => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const decodeWeights = (encoded: string): Uint16Array => {
  const bytes = decodeBytes(encoded);
  const weights = new Uint16Array(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < weights.length; i += 1) weights[i] = view.getUint16(i * 2, true);
  return weights;
};

const decodeFloat32 = (encoded: string): Float32Array => {
  const bytes = decodeBytes(encoded);
  const values = new Float32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < values.length; i += 1) values[i] = view.getFloat32(i * 4, true);
  return values;
};

interface SourceAnimationClip extends THREE.AnimationClip {
  userData: {
    readonly label: string;
    readonly loop: boolean;
    readonly inferred: boolean;
    readonly measured: string;
    readonly source: 'R3-identified-from-GLB-animation-pack';
    readonly sourceName: string;
    readonly sourceSha256: string;
    readonly scaleNormalization: typeof MARS_CAT_SOURCE_ANIMATION_PROVENANCE.scaleNormalization;
    readonly trackProvenance: ReadonlyArray<{
      readonly channelIndex: number;
      readonly samplerIndex: number;
      readonly timeHash: string;
      readonly valueHash: string;
    }>;
  };
}

const createSourceClips = (bones: readonly THREE.Bone[]): SourceAnimationClip[] => (
  MARS_CAT_SOURCE_CLIPS.map((record) => {
    const timingSets = record.timingSets.map((timing) => decodeFloat32(timing.dataBase64));
    const values = decodeFloat32(record.valuesBase64);
    const tracks = record.tracks.map((sourceTrack) => {
      const times = timingSets[sourceTrack.timingSet];
      const samples = values.subarray(
        sourceTrack.valueOffset,
        sourceTrack.valueOffset + sourceTrack.valueCount,
      );
      const target = `${bones[sourceTrack.slot].name}.${sourceTrack.path}`;
      const animationTrack = sourceTrack.path === 'position'
        ? new THREE.VectorKeyframeTrack(target, times, samples, THREE.InterpolateLinear)
        : new THREE.QuaternionKeyframeTrack(target, times, samples, THREE.InterpolateLinear);
      (animationTrack as THREE.KeyframeTrack & { userData?: object }).userData = {
        sourceChannelIndex: sourceTrack.channelIndex,
        sourceSamplerIndex: sourceTrack.samplerIndex,
        timeAccessorSha256: sourceTrack.timeHash,
        valueAccessorSha256: sourceTrack.valueHash,
      };
      return animationTrack;
    });
    const clip = new THREE.AnimationClip(record.id, record.duration, tracks) as SourceAnimationClip;
    clip.userData = {
      label: record.label,
      loop: record.loop,
      inferred: record.inferred,
      measured: record.measured,
      source: 'R3-identified-from-GLB-animation-pack',
      sourceName: record.sourceName,
      sourceSha256: MARS_CAT_SOURCE_ANIMATION_PROVENANCE.sourceSha256,
      scaleNormalization: MARS_CAT_SOURCE_ANIMATION_PROVENANCE.scaleNormalization,
      trackProvenance: record.tracks.map((sourceTrack) => ({
        channelIndex: sourceTrack.channelIndex,
        samplerIndex: sourceTrack.samplerIndex,
        timeHash: sourceTrack.timeHash,
        valueHash: sourceTrack.valueHash,
      })),
    };
    return clip;
  })
);

const createController = (
  root: THREE.Group,
  bones: readonly THREE.Bone[],
  clips: readonly SourceAnimationClip[],
): MarsCatAnimationController => {
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map(clips.map((clip) => [clip.name, mixer.clipAction(clip)]));
  for (const [name, action] of actions) {
    const loop = clips.find((clip) => clip.name === name)?.userData.loop !== false;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
  }
  const bindPose = bones.map((bone) => ({
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
    scale: bone.scale.clone(),
  }));
  const restoreBindPose = () => {
    bones.forEach((bone, index) => {
      bone.position.copy(bindPose[index].position);
      bone.quaternion.copy(bindPose[index].quaternion);
      bone.scale.copy(bindPose[index].scale);
    });
    root.updateMatrixWorld(true);
  };
  const idleId = 'idle';
  let active = idleId;
  actions.get(idleId)!.reset().play();
  mixer.update(0);
  const listeners = new Set<(id: string) => void>();
  const transition = (id: string) => {
    const next = actions.get(id);
    if (!next) return;
    const loop = clips.find((clip) => clip.name === id)?.userData.loop !== false;
    mixer.stopAllAction();
    restoreBindPose();
    next.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1).play();
    next.clampWhenFinished = !loop;
    mixer.update(0);
    active = id;
    listeners.forEach((listener) => listener(active));
  };
  return {
    actions: clips
      .filter((clip) => clip.name !== idleId)
      .map((clip) => ({
        id: clip.name,
        label: String(clip.userData.label ?? clip.name),
        loop: clip.userData.loop !== false,
      })),
    get active() { return active; },
    play: transition,
    seek: (id, timeSeconds) => {
      const next = actions.get(id);
      if (!next) throw new Error(`Mars Cat animation clip ${id} is absent`);
      const loop = clips.find((clip) => clip.name === id)?.userData.loop !== false;
      mixer.stopAllAction();
      restoreBindPose();
      next.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1).play();
      next.paused = true;
      next.time = THREE.MathUtils.clamp(timeSeconds, 0, next.getClip().duration);
      mixer.update(0);
      active = id;
      listeners.forEach((listener) => listener(active));
    },
    stop: () => {
      mixer.stopAllAction();
      restoreBindPose();
      mixer.update(0);
      active = idleId;
      listeners.forEach((listener) => listener(active));
    },
    update: (deltaSeconds) => mixer.update(THREE.MathUtils.clamp(deltaSeconds, 0, 0.05)),
    subscribe: (listener) => {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };
};

export function bindMarsCatRig(
  root: THREE.Group,
  skinTier: 'fidelity' | 'game' = 'fidelity',
): MarsCatRigRuntime {
  const bones = MARS_CAT_RIG.runtimeNames.map((name, slot) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.userData.sourceNodeIndex = MARS_CAT_RIG.jointNodes[slot];
    bone.userData.sourceName = MARS_CAT_RIG.sourceNames[slot];
    const matrix = new THREE.Matrix4().fromArray(MARS_CAT_RIG.localMatricesColumnMajor[slot]);
    matrix.decompose(bone.position, bone.quaternion, bone.scale);
    return bone;
  });
  MARS_CAT_RIG.parents.forEach((parent, slot) => {
    if (parent === null) root.add(bones[slot]);
    else bones[parent].add(bones[slot]);
  });
  root.updateMatrixWorld(true);
  const inverses = MARS_CAT_RIG.inverseBindMatricesColumnMajor.map(
    (matrix) => new THREE.Matrix4().fromArray(matrix),
  );
  const skeleton = new THREE.Skeleton(bones, inverses);

  const skinRecords: Record<string, {
    readonly vertexCount: number;
    readonly sourceNode: number;
    readonly indicesBase64: string;
    readonly weightsBase64: string;
  }> = skinTier === 'game' ? MARS_CAT_GAME_SKIN : MARS_CAT_SKIN;
  const sourceMeshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) sourceMeshes.push(object);
  });
  const parts = root.userData.parts as Record<string, THREE.Mesh> | undefined;
  for (const source of sourceMeshes) {
    const record = skinRecords[source.name];
    if (!record) throw new Error(`Mars Cat rig has no measured skin record for ${source.name}`);
    const vertexCount = source.geometry.getAttribute('position').count;
    if (record.vertexCount !== vertexCount) {
      throw new Error(`${source.name}: rig has ${record.vertexCount} vertices, geometry has ${vertexCount}`);
    }
    source.geometry.setAttribute(
      'skinIndex',
      new THREE.Uint8BufferAttribute(decodeBytes(record.indicesBase64), 4),
    );
    source.geometry.setAttribute(
      'skinWeight',
      new THREE.Uint16BufferAttribute(decodeWeights(record.weightsBase64), 4, true),
    );
    const mesh = new THREE.SkinnedMesh(source.geometry, source.material);
    mesh.name = source.name;
    mesh.position.copy(source.position);
    mesh.quaternion.copy(source.quaternion);
    mesh.scale.copy(source.scale);
    mesh.castShadow = source.castShadow;
    mesh.receiveShadow = source.receiveShadow;
    mesh.frustumCulled = false;
    mesh.userData = source.userData;
    const parent = source.parent;
    if (!parent) throw new Error(`${source.name}: mesh has no parent during rig bind`);
    const childIndex = parent.children.indexOf(source);
    parent.remove(source);
    parent.add(mesh);
    if (childIndex >= 0) {
      parent.children.splice(parent.children.indexOf(mesh), 1);
      parent.children.splice(childIndex, 0, mesh);
    }
    mesh.bindMode = 'attached';
    mesh.bind(skeleton, new THREE.Matrix4());
    if (parts?.[source.name] === source) parts[source.name] = mesh;
  }

  const clips = createSourceClips(bones);
  root.animations = [...clips];
  const animationController = createController(root, bones, clips);
  return {
    skeleton,
    bones,
    clips,
    animationController,
    update: (deltaSeconds) => {
      animationController.update(deltaSeconds);
      root.updateMatrixWorld(true);
      skeleton.update();
    },
  };
}
