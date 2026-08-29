import * as THREE from 'three';
import {
  buildClips,
  buildSkeleton,
  createStudioLights,
  decodeModel,
  preferredQuality,
  type BuildOptions,
  type EncodedModel,
  type Quality,
} from './meshCodec';
import type { EncodedRig } from './meshCodec';
import { separateGarment, type GarmentReport, type MeshPartition } from './garmentSeparation';
import { attachClothDrape, type ClothDrape } from './clothDrape';
import { createVanHiVfx, type VanHiVfx } from './vanHiVfx';

/**
 * Van Hi — a code-only Three.js character, built as TWO skinned meshes on one skeleton.
 *
 * The reference is a xianxia immortal in a floor-length lavender robe with two trailing sleeve
 * panels. Everything below follows from one fact about the source: the generated GLB fuses that
 * robe to the body as a single welded shell, and its auto-rig then hangs 78% of the robe's weight
 * off two calves and a foot. Played back untouched, the dress is dragged inside-out by the shins.
 *
 *   `garmentSeparation` cuts the gown out of the shell and rebinds it to the trunk. Measured over
 *   all 22 clips, the garment's mean edge elongation falls from 2.358 mm to 0.156 mm and its weight
 *   on any leg joint from 78.4% to zero. The costume is then issued as its own SkinnedMesh — the
 *   scene graph says so, not only the weights — which is also what lets it carry a fabric material
 *   and its own motion.
 *
 *   `clothDrape` gives back, as post-skinning displacement, the life that rigid binding gave up:
 *   drift, lag behind the body, and swing out of a turn. A displacement cannot tear a mesh, so it
 *   is free where a weight gradient was expensive.
 *
 *   `vanHiVfx` stages her — rune circle, petals, motes, aura and a ribbon off each hand — beside
 *   the model rather than inside it, so the parts inspector and the explode layout do not count an
 *   effect as a body part.
 *
 * Built by the img2threejs playground on 2026-08-29 08:05:46 UTC:
 *   1. reference image (upload)
 *   2. Tripo v3.1-20260211 measurement (task adb2039c-6460-47b5-8ac8-43fbd80fc8ca)
 *   3. Tripo mesh segmentation v2.0-20260430 (task 3f1edfef-1702-4896-a13b-7a8f75df8c33)
 *   4. img2threejs GLB fast lane: measured bounds -> part hypotheses -> embedded surfaces
 *
 * Nothing is fetched from a server: geometry, normals, per-vertex colour and every keyframe are
 * embedded in the modules that ship beside this file.
 */

export type VanHiOptions = BuildOptions;

/** Framing that fits the whole figure at a 30-degree FOV; matches the showcase registry entry. */
export const VAN_HI_CAMERA = {
  position: [1.7695, 1.045, 5.0558] as [number, number, number],
  target: [0, 0.95, 0] as [number, number, number],
  fov: 30,
};

/**
 * The clips, with the labels the viewer's animation panel shows.
 *
 * Twenty-two arrive on the rig; nine are offered. The full set is six near-identical dance loops
 * and several overlapping emotes, and a panel of twenty-two buttons is a list, not a choice. These
 * nine were chosen to exercise the repair from different directions — `run` and `walk` split the
 * legs under the skirt, `turn` and `dance_02` swing it, `greet_02` and `heart_pose` raise the arms
 * through the sleeve panels — plus the ones that simply read well on this character.
 */
const ACTIONS = [
  { id: 'idle-turn', clip: 'preset:turn', label: 'Turn', loop: true },
  { id: 'walk', clip: 'preset:walk', label: 'Walk', loop: true },
  { id: 'run', clip: 'preset:run', label: 'Run', loop: true },
  { id: 'greet', clip: 'preset:biped:greet_02', label: 'Greeting', loop: true },
  { id: 'heart', clip: 'preset:biped:heart_pose', label: 'Heart Pose', loop: true },
  { id: 'agree', clip: 'preset:biped:agree', label: 'Agree', loop: true },
  { id: 'dance-fan', clip: 'preset:biped:dance_02', label: 'Sleeve Dance', loop: true },
  { id: 'dance-slow', clip: 'preset:biped:dance_04', label: 'Slow Dance', loop: true },
  { id: 'sorrow', clip: 'preset:biped:depressed', label: 'Sorrow', loop: true },
] as const;

/** Bones the sleeve ribbons trail from. The hands lead every sleeve movement in the reference. */
const RIBBON_BONES = ['L_Hand', 'R_Hand'];

/**
 * Material for the gown, over the measured vertex colour.
 *
 * The source records one median pair for the whole shell — roughness 0.27, metalness 0.03 — because
 * it had one mesh to describe. Now that the robe is its own mesh it can say what silk is: rougher
 * than the median so the highlight is a sheen rather than a specular dot, no metalness at all, and
 * drawn double-sided because the split leaves the hem and the sleeve edges open and a single-sided
 * cloth disappears when the wind lifts it.
 */
const GARMENT_MATERIAL = { roughness: 0.52, metalness: 0.0 } as const;

/**
 * Material for the body, which is skin, hair, silver bodice and tiara in one mesh.
 *
 * Kept near the measurement: 0.34 is the source's median nudged rougher, because the median was
 * pulled down by the polished bodice and applying a bodice's roughness to skin makes it look wet.
 */
const BODY_MATERIAL = { roughness: 0.34, metalness: 0.06 } as const;

function loadLevel(quality: Quality): Promise<{ SURFACE_MODEL: EncodedModel; SURFACE_STREAM: string }> {
  switch (quality) {
    case 'high':
    default:
      return import('./surfaceData.high');
  }
}

let loaded: { quality: Quality; model: EncodedModel; stream: string; rig: EncodedRig } | null = null;
let inFlight: Promise<Quality> | null = null;
/** A group handed out by `createVanHiModel` that is still waiting for its payload. */
let pending: { group: THREE.Group; scene: THREE.Object3D; options: VanHiOptions } | null = null;

/**
 * Fetch and hold one level, and the rig beside it.
 *
 * Both are dynamic imports and both have to be. The surfaces are 4.6 MB and the rig — 41 bones and
 * 22 clips of Float32 keyframes — is 13.7 MB, and a static import of either puts it in the entry
 * chunk, where every visitor to the gallery pays for a character they may never open. Imported here
 * they are two chunks of their own, fetched the first time this demo is asked for and never again.
 * That is also why `prewarm` is async and must be awaited before anything is built.
 */
export function prewarmVanHi(quality: Quality = preferredQuality('high')): Promise<Quality> {
  if (loaded?.quality === quality && !pending) return Promise.resolve(quality);
  // Memoised: the demo page awaits this from two places, and a second fetch of 18 MB would be paid
  // for twice. Cleared on rejection so a failed load can be retried rather than cached as broken.
  inFlight ??= (async () => {
    if (loaded?.quality !== quality) {
      const [surfaces, rigModule] = await Promise.all([loadLevel(quality), import('./rigData')]);
      loaded = { quality, model: surfaces.SURFACE_MODEL, stream: surfaces.SURFACE_STREAM, rig: rigModule.RIG };
    }
    // Populating HERE rather than in a `.then` the caller attaches is what makes the page's contract
    // hold: it mounts the animation panel and re-collects the per-frame tickers when this resolves,
    // so the runtime has to exist by then or the clips play silently and no buttons appear.
    if (pending) {
      const waiting = pending;
      pending = null;
      populate(waiting.group, waiting.scene, waiting.options);
    }
    return quality;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** The level currently held in memory, or null before the first prewarm. */
export function vanHiQuality(): Quality | null {
  return loaded?.quality ?? null;
}

export interface VanHiAction { id: string; label: string; loop: boolean }

export interface VanHiAnimationController {
  actions: ReadonlyArray<VanHiAction>;
  readonly active: string;
  play: (id: string) => void;
  stop: () => void;
  subscribe: (listener: (active: string) => void) => () => void;
}

/**
 * Hold the figure over the same spot, keeping the vertical.
 *
 * Every locomotion clip on this rig carries real root travel, and it is on the HIP, not the root
 * node: `preset:run` moves the hip 2.921 figure heights over its cycle, `preset:walk` 1.496, and
 * even `preset:turn` — the gallery's default — drifts 0.247. In a fixed-camera gallery the subject
 * has to stay in the shot, so the horizontal part of the hip's translation is replaced by its first
 * key. The VERTICAL is kept: that is the bob of the stride, 0.037 heights on the run, and
 * flattening it turns a run into a glide.
 *
 * WHICH AXIS IS VERTICAL IS MEASURED, NOT ASSUMED. The hip's translation is expressed in its
 * parent's frame, and this rig's root carries a quarter turn — its local Z is world up and its
 * local Y is world forward, which is why the run's travel reads as `dy 2.921`. So the vertical
 * component is found by asking which column of the parent's rest rotation points most nearly along
 * world up, and a rig without that quarter turn answers with the ordinary one.
 *
 * Only the hip's own position track is touched; every other joint, and every rotation, plays as it
 * was measured.
 */
function pinInPlace(clip: THREE.AnimationClip, rig: EncodedRig): THREE.AnimationClip {
  for (const track of clip.tracks) {
    const bone = rig.bones.find((candidate) => track.name === `${candidate.name}.position`);
    if (!bone || bone.parent < 0) continue;
    const parent = rig.bones[bone.parent];
    // Column c of the parent's rest rotation is where its local axis c points.
    const basis = new THREE.Matrix4().compose(
      new THREE.Vector3(...parent.position),
      new THREE.Quaternion(...parent.quaternion),
      new THREE.Vector3(...parent.scale),
    );
    let vertical = 1;
    let best = -1;
    for (let axis = 0; axis < 3; axis += 1) {
      const upwards = Math.abs(basis.elements[axis * 4 + 1]);
      if (upwards > best) { best = upwards; vertical = axis; }
    }
    const values = track.values as Float32Array;
    for (let axis = 0; axis < 3; axis += 1) {
      if (axis === vertical) continue;
      const first = values[axis];
      for (let i = axis; i < values.length; i += 3) values[i] = first;
    }
  }
  return clip;
}

/** Turn one partition into a SkinnedMesh sharing the given skeleton. */
function buildPartition(
  partition: MeshPartition,
  source: { position: Float32Array; normal: Float32Array; colour: Float32Array },
  material: THREE.MeshStandardMaterial,
  name: string,
): THREE.SkinnedMesh {
  const count = partition.sourceVertex.length;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const colour = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const v = partition.sourceVertex[i];
    for (let c = 0; c < 3; c += 1) {
      position[i * 3 + c] = source.position[v * 3 + c];
      normal[i * 3 + c] = source.normal[v * 3 + c];
      colour[i * 3 + c] = source.colour[v * 3 + c];
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colour, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(partition.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(partition.skinWeight, 4));
  // Uint16 only when it fits: the garment carries 115,772 vertices and would silently wrap.
  geometry.setIndex(new THREE.BufferAttribute(
    count <= 65535 ? new Uint16Array(partition.index) : partition.index, 1,
  ));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name;
  return mesh;
}

export interface VanHiModel {
  group: THREE.Group;
  body: THREE.SkinnedMesh;
  garment: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  mixer: THREE.AnimationMixer;
  controller: VanHiAnimationController;
  cloth: ClothDrape;
  vfx: VanHiVfx;
  report: GarmentReport;
  dispose: () => void;
}

/**
 * Build the figure, its rig, its clips, the cloth motion and the effects.
 *
 * The VFX group is returned rather than added: it belongs beside the model in the scene, not under
 * it, and only the caller knows what the model's parent is.
 */
export function createVanHiRigged(options: VanHiOptions = {}, into?: THREE.Group): VanHiModel {
  if (!loaded) {
    throw new Error('call prewarmVanHi() and await it before createVanHiRigged() — the level of detail is loaded on demand');
  }
  const { rig } = loaded;
  const decoded = decodeModel(loaded.model, loaded.stream)[0];
  const split = separateGarment(decoded.position, decoded.srgb, decoded.index, rig);

  const source = { position: decoded.position, normal: decoded.normal, colour: decoded.colour };
  const bodyMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true, ...BODY_MATERIAL, side: THREE.FrontSide,
  });
  bodyMaterial.name = 'van-hi-body-material';
  const garmentMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true, ...GARMENT_MATERIAL, side: THREE.DoubleSide,
  });
  garmentMaterial.name = 'van-hi-garment-material';

  const body = buildPartition(split.body, source, bodyMaterial, 'van-hi-body');
  const garment = buildPartition(split.garment, source, garmentMaterial, 'van-hi-garment');
  for (const mesh of [body, garment]) {
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
  }

  const { bones, skeleton, root } = buildSkeleton(rig);
  // The skeleton hangs under the BODY, and the garment binds to the same one. Two copies would
  // drift the moment either mesh's world matrix updated a frame apart from the other's.
  body.add(root);
  body.bind(skeleton);
  garment.bind(skeleton, body.matrixWorld);

  // Built INTO the caller's group when there is one: `createVanHiModel` handed that group to the
  // scene before the payload existed, and the page holds a reference to it. Re-parenting children
  // out of a fresh group instead would leave this function's own `tick` updating an orphan.
  const group = into ?? new THREE.Group();
  group.name = 'van-hi';
  group.add(body, garment);
  // Scale on the MESHES so the bones parented to them scale with the skin, and offset on the group
  // so the figure lands feet-at-zero: the offset is already in normalised units.
  body.scale.setScalar(rig.normalise.scale);
  garment.scale.setScalar(rig.normalise.scale);
  group.position.set(rig.normalise.offset[0], rig.normalise.offset[1], rig.normalise.offset[2]);
  group.updateMatrixWorld(true);

  const mixer = new THREE.AnimationMixer(body);
  const clips = new Map(buildClips(rig).map((clip) => [clip.name, pinInPlace(clip, rig)]));
  const actions = ACTIONS.filter((action) => clips.has(action.clip));
  let current: THREE.AnimationAction | null = null;
  let active = 'idle';
  const listeners = new Set<(id: string) => void>();
  const announce = (): void => { for (const listener of listeners) listener(active); };

  const play = (id: string): void => {
    const entry = actions.find((action) => action.id === id);
    if (!entry) return;
    const next = mixer.clipAction(clips.get(entry.clip)!);
    next.enabled = true;
    next.setLoop(entry.loop ? THREE.LoopRepeat : THREE.LoopOnce, entry.loop ? Infinity : 1);
    next.clampWhenFinished = !entry.loop;
    next.reset();
    // Cross-fade rather than cut: a hard switch between two looping clips pops on the first frame.
    if (current && current !== next) next.crossFadeFrom(current, 0.28, false).play();
    else next.play();
    current = next;
    active = id;
    announce();
  };
  const stop = (): void => {
    mixer.stopAllAction();
    current = null;
    active = 'idle';
    skeleton.pose();
    announce();
  };

  const controller: VanHiAnimationController = {
    actions: actions.map(({ id, label, loop }) => ({ id, label, loop })),
    get active(): string { return active; },
    play,
    stop,
    subscribe: (listener) => { listeners.add(listener); listener(active); return () => listeners.delete(listener); },
  };

  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  const cloth = attachClothDrape(garment, split.garment.drape, byName.get('Hip') ?? root);
  const height = loaded.model.height * rig.normalise.scale;
  const vfx = createVanHiVfx({
    height,
    ribbonBones: RIBBON_BONES.map((name) => byName.get(name)).filter((bone): bone is THREE.Bone => !!bone),
  });

  group.userData.height = height;
  // Read by the showcase viewer's provenance panel: this is a measured surface rebuilt from a
  // generated GLB, then re-rigged here, and the part names are hypotheses.
  group.userData.sculptRuntime = {
    route: 'playground: provider measurement -> embedded measured surfaces -> garment separation and rebind',
    exactnessTier: 'measured-surface',
    inferred: [
      `garment: ${split.report.garmentVertices} vertices identified as drapery by colour and reach (hypothesis)`,
    ],
    garmentRepair: split.report,
    animationController: controller,
  };
  group.userData.tick = (delta: number): void => {
    // A stall — decoding the payload, a background tab — hands the first frame afterwards a delta
    // worth the whole pause. Clamping keeps one long frame from teleporting the pose.
    const step = Math.min(delta, 1 / 20);
    mixer.update(step);
    // After the mixer, so the cloth reads the pose this frame will actually draw.
    group.updateMatrixWorld(true);
    cloth.update(step);
    vfx.update(step);
  };

  return {
    group, body, garment, skeleton, mixer, controller, cloth, vfx,
    report: split.report,
    dispose: () => {
      cloth.dispose();
      vfx.dispose();
      mixer.stopAllAction();
      body.geometry.dispose();
      garment.geometry.dispose();
      bodyMaterial.dispose();
      garmentMaterial.dispose();
    },
  };
}

/** Fill a group that `createVanHiModel` already handed out, and stage its effects beside it. */
function populate(group: THREE.Group, scene: THREE.Object3D, options: VanHiOptions): void {
  const model = createVanHiRigged(options, group);
  scene.add(model.vfx.group);
}

/**
 * The registry's entry point.
 *
 * `build()` is synchronous by the registry's contract and runs BEFORE `prewarm` — so this returns
 * an EMPTY group and lets `prewarmVanHi` fill it. Building here instead would need the 18 MB
 * payload to already be in memory, which on a first visit it is not.
 *
 * The effects are staged in the scene beside the model rather than inside it, which is why this
 * takes the scene: the parts inspector and the explode layout walk the returned group and would
 * otherwise list a rune circle as a body part and fling it away on explode.
 */
export function createVanHiModel(scene: THREE.Object3D, options: VanHiOptions = {}): THREE.Group {
  const group = new THREE.Group();
  group.name = 'van-hi';
  scene.add(group);
  if (loaded) populate(group, scene, options);
  else pending = { group, scene, options };
  return group;
}

/** Neutral three-point studio rig scaled to the figure. */
export function createVanHiLookDevLights(): THREE.Group {
  return createStudioLights((loaded?.model.height ?? 1) * (loaded?.rig.normalise.scale ?? 1));
}

/** Action ids, in the order the viewer shows them. */
export const VAN_HI_ACTIONS = ACTIONS.map((action) => action.id);
