import * as THREE from 'three';
import { buildModel, buildModelProgressive, createStudioLights, preferredQuality, buildRiggedModel, type BuildOptions, type EncodedModel, type EncodedRig, type ProgressiveOptions, type Quality, type RiggedModel } from './meshCodec';

/**
 * Monster Cute — a code-only Three.js model with 1 named parts and 192,082 triangles.
 *
 * Built by the img2threejs playground on 2026-08-29 13:55:33 UTC:
 *   1. reference image (upload)
 *   2. Tripo v3.1-20260211 measurement (task d3739c6f-34c9-4839-8643-5ff04570f966)
 *   3. Tripo mesh segmentation v2.0-20260430 (task c6ace206-9c3c-4eed-ad2f-c7e887938c70)
 *   4. img2threejs GLB fast lane: measured bounds -> part hypotheses -> embedded surfaces
 *
 * Nothing is fetched from a server: geometry, normals and per-vertex colour are embedded in the
 * surfaceData modules that ship beside this file.
 *
 * LEVELS OF DETAIL: high 192,082 tris, 2,854 KB
 *
 * Each level is a separate module, imported dynamically, so a bundler splits them into separate
 * chunks and a viewer downloads ONLY the level it renders. Bundling all of them into one file
 * would make a phone pay for the desktop level, which is the whole reason the levels exist.
 * That import is why `prewarm` is async and must be awaited before `createMonsterCuteModel`.
 *
 * Part names are HYPOTHESES from measured bounds (see object-sculpt-spec.json), not confirmed labels:
 *
 *   body-shell               body-shell             conf 0.20    192,082 tris
 */

export type MonsterCuteOptions = BuildOptions;

export const MONSTER_CUTE_PARTS = ['body-shell'] as const;
export type MonsterCutePart = (typeof MONSTER_CUTE_PARTS)[number];

/** Framing that fits the whole figure at a 30-degree FOV; matches the showcase registry entry. */
export const MONSTER_CUTE_CAMERA = {
  position: [2.3958, 1.045, 6.8453] as [number, number, number],
  target: [0, 0.95, 0] as [number, number, number],
  fov: 30,
};

function loadLevel(quality: Quality): Promise<{ SURFACE_MODEL: EncodedModel; SURFACE_STREAM: string }> {
  switch (quality) {
    case 'high':
      return import('./surfaceData.high');
    default:
      return import('./surfaceData.high');
  }
}

let loaded: { quality: Quality; model: EncodedModel; stream: string } | null = null;
let loadedRig: EncodedRig | null = null;

/**
 * Fetch and hold the skeleton, the skin weights and every clip.
 *
 * Separate from `prewarmMonsterCute`, and imported dynamically, for the same reason the levels of
 * detail are: the rig payload is 15 MB of keyframes, and a static import puts all of it in
 * whatever bundle references this module. In a gallery of demos that means every visitor
 * downloads and parses this character's animation data to look at something else.
 *
 * Await this before `createMonsterCuteRigged`. The static `createMonsterCuteModel` path never
 * needs it and never pays for it.
 */
export async function prewarmMonsterCuteRig(): Promise<void> {
  if (loadedRig) return;
  loadedRig = (await import('./rigData')).RIG;
}

/** The rig payload, or null before the first `prewarmMonsterCuteRig`. */
export function monsterCuteRigLoaded(): boolean {
  return loadedRig !== null;
}

/**
 * Fetch and hold one level. Await this before building — the level lives in its own chunk, so the
 * data is not in memory until it has been imported.
 *
 * With no argument the level is chosen for the device: `?quality=` if the URL asks, otherwise the
 * cheap level on a small touch screen and the full one on a desktop.
 */
export async function prewarmMonsterCute(quality: Quality = preferredQuality('high')): Promise<Quality> {
  if (loaded?.quality === quality) return quality;
  const module = await loadLevel(quality);
  loaded = { quality, model: module.SURFACE_MODEL, stream: module.SURFACE_STREAM };
  return quality;
}

/** The level currently held in memory, or null before the first prewarm. */
export function monsterCuteQuality(): Quality | null {
  return loaded?.quality ?? null;
}

export function createMonsterCuteModel(options: MonsterCuteOptions = {}): THREE.Group {
  if (!loaded) {
    throw new Error('call prewarmMonsterCute() and await it before createMonsterCuteModel() — the level of detail is loaded on demand');
  }
  const group = buildModel(loaded.model, loaded.stream, {
    animation: 'breathe',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  group.name = 'monster-cute';
  return group;
}

/**
 * Build across frames instead of in one block: the group comes back empty and fills part by part,
 * so the model appears as it decodes and the page keeps responding. Same geometry as
 * `createMonsterCuteModel`, different timing.
 *
 *     const { group, done } = createMonsterCuteModelProgressive({ onPart: (n, total) => setLabel(`${n}/${total}`) });
 *     scene.add(group);   // already safe to add — it fills itself in
 *     await done;         // resolves once every part has landed
 */
export function createMonsterCuteModelProgressive(
  options: ProgressiveOptions = {},
): { group: THREE.Group; done: Promise<THREE.Group> } {
  if (!loaded) {
    throw new Error('call prewarmMonsterCute() and await it before createMonsterCuteModelProgressive() — the level of detail is loaded on demand');
  }
  const built = buildModelProgressive(loaded.model, loaded.stream, {
    animation: 'breathe',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  built.group.name = 'monster-cute';
  return built;
}


/**
 * Build the model with its skeleton and clips. The keyframes are embedded like the geometry is —
 * nothing is fetched — so this works offline and in a bundle with no asset pipeline.
 *
 *     await prewarmMonsterCute();
 *     const rigged = createMonsterCuteRigged();
 *     scene.add(rigged.group);
 *     rigged.play('preset:climb');
 *     renderer.setAnimationLoop(() => { rigged.update(clock.getDelta()); renderer.render(scene, camera); });
 *
 * The clips shipped here: preset:climb (3.50s), preset:dive (2.75s), preset:hurt (13.88s), preset:jump (2.25s), preset:shoot (9.08s), preset:turn (3.88s), preset:walk (2.38s), preset:biped:jump_down (3.75s), preset:biped:look_around (15.63s), preset:biped:run (1.29s), preset:biped:sit (5.77s), preset:biped:afraid (2.10s), preset:biped:agree (3.23s), preset:biped:angry_01 (2.83s), preset:biped:angry_02 (1.77s), preset:biped:angry_03 (2.90s), preset:biped:cry (6.33s), preset:biped:depressed (3.70s), preset:biped:freaky (0.67s), preset:biped:frustrated_01 (2.87s), preset:biped:frustrated_02 (10.83s), preset:biped:greet_01 (3.54s), preset:biped:greet_02 (5.63s), preset:biped:greet_03 (9.13s), preset:biped:greet_04 (2.83s), preset:biped:heart_pose (5.42s), preset:biped:scared_02 (3.33s), preset:biped:dance_01 (23.21s), preset:biped:dance_02 (12.83s), preset:biped:dance_03 (12.83s), preset:biped:dance_04 (10.83s), preset:biped:dance_05 (2.92s), preset:biped:dance_06 (10.92s).
 * Rigging merges the surface, so this model is ONE skinned mesh rather than the named parts a
 * static model carries — the 41 bone names are the rig's own.
 */
export function createMonsterCuteRigged(options: MonsterCuteOptions = {}): RiggedModel {
  if (!loaded) {
    throw new Error('call prewarmMonsterCute() and await it before createMonsterCuteRigged() — the level of detail is loaded on demand');
  }
  if (!loadedRig) {
    throw new Error('call prewarmMonsterCuteRig() and await it before createMonsterCuteRigged() — the 15 MB rig payload is a separate chunk and is not loaded by prewarmMonsterCute()');
  }
  const rigged = buildRiggedModel(loaded.model, loaded.stream, loadedRig, {
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  rigged.group.name = 'monster-cute';
  return rigged;
}

/** Clip names, in the order they were retargeted. */
export const MONSTER_CUTE_CLIPS = ['preset:climb', 'preset:dive', 'preset:hurt', 'preset:jump', 'preset:shoot', 'preset:turn', 'preset:walk', 'preset:biped:jump_down', 'preset:biped:look_around', 'preset:biped:run', 'preset:biped:sit', 'preset:biped:afraid', 'preset:biped:agree', 'preset:biped:angry_01', 'preset:biped:angry_02', 'preset:biped:angry_03', 'preset:biped:cry', 'preset:biped:depressed', 'preset:biped:freaky', 'preset:biped:frustrated_01', 'preset:biped:frustrated_02', 'preset:biped:greet_01', 'preset:biped:greet_02', 'preset:biped:greet_03', 'preset:biped:greet_04', 'preset:biped:heart_pose', 'preset:biped:scared_02', 'preset:biped:dance_01', 'preset:biped:dance_02', 'preset:biped:dance_03', 'preset:biped:dance_04', 'preset:biped:dance_05', 'preset:biped:dance_06'] as const;

/** Pivot group for one part — rotate or translate it without touching geometry. */
export function monsterCutePivot(group: THREE.Group, part: MonsterCutePart): THREE.Group {
  const pivots = group.userData.pivots as Record<string, THREE.Group>;
  return pivots[part];
}

/** Neutral three-point studio rig scaled to the figure. Replace with a look-dev rig when you have one. */
export function createMonsterCuteLookDevLights(): THREE.Group {
  return createStudioLights(loaded?.model.height ?? 1);
}

/** Call once per frame with the elapsed time in seconds to run the built-in idle motion. */
export function updateMonsterCute(group: THREE.Group, elapsedSeconds: number): void {
  const update = group.userData.update as ((t: number) => void) | undefined;
  update?.(elapsedSeconds);
}
