import * as THREE from 'three';
import { buildModel, buildModelProgressive, createStudioLights, preferredQuality, buildRiggedModel, type BuildOptions, type EncodedModel, type EncodedRig, type ProgressiveOptions, type Quality, type RiggedModel } from './meshCodec';

/**
 * boxing-man — a code-only Three.js model with 1 named parts and 97,592 triangles.
 *
 * Built by the img2threejs playground on 2026-08-27 12:52:54 UTC:
 *   1. reference image (generated, prompt: "Full body Boxing character with T pose")
 *   2. Tripo v3.1-20260211 measurement (task 40ccfe41-46ff-4158-8833-86cdf9ede717)
 *   3. Tripo mesh segmentation v2.0-20260430 (task 571846b7-23c6-4424-bccc-c241439e3bf4)
 *   4. img2threejs GLB fast lane: measured bounds -> part hypotheses -> embedded surfaces
 *
 * Nothing is fetched from a server: geometry, normals and per-vertex colour are embedded in the
 * surfaceData modules that ship beside this file.
 *
 * LEVELS OF DETAIL: high 97,592 tris, 1,486 KB
 *
 * Each level is a separate module, imported dynamically, so a bundler splits them into separate
 * chunks and a viewer downloads ONLY the level it renders. Bundling all of them into one file
 * would make a phone pay for the desktop level, which is the whole reason the levels exist.
 * That import is why `prewarm` is async and must be awaited before `createBoxingManModel`.
 *
 * Part names are HYPOTHESES from measured bounds (see object-sculpt-spec.json), not confirmed labels:
 *
 *   body-shell               body-shell             conf 0.20     97,592 tris
 */

export type BoxingManOptions = BuildOptions;

export const BOXING_MAN_PARTS = ['body-shell'] as const;
export type BoxingManPart = (typeof BOXING_MAN_PARTS)[number];

/** Framing that fits the whole figure at a 30-degree FOV; matches the showcase registry entry. */
export const BOXING_MAN_CAMERA = {
  position: [1.7695, 1.045, 5.0558] as [number, number, number],
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
/**
 * The rig is fetched with the level, not imported beside it.
 *
 * 41 bones and 19 clips of Float32 keyframes are 10 MB of module, and a static import puts all of it
 * in whichever chunk imports this file — for the showcase that is the gallery's own entry chunk,
 * which every visitor downloads to see the demo INDEX. Behind the same dynamic import as the
 * surfaces, it becomes its own chunk that only this demo's page pays for.
 */
let rig: EncodedRig | null = null;
const inFlight: Partial<Record<Quality, Promise<Quality>>> = {};

/**
 * Fetch and hold one level. Await this before building — the level lives in its own chunk, so the
 * data is not in memory until it has been imported.
 *
 * With no argument the level is chosen for the device: `?quality=` if the URL asks, otherwise the
 * cheap level on a small touch screen and the full one on a desktop.
 */
export async function prewarmBoxingMan(quality: Quality = preferredQuality('high')): Promise<Quality> {
  if (loaded?.quality === quality && rig) return quality;
  // One in-flight fetch per level, shared by every caller. Both the gallery's own `prewarm` hook and
  // the demo's build call this, and without the shared promise the second caller re-enters the body
  // and the two race over which one assigns `loaded`.
  inFlight[quality] ??= (async () => {
    const [level, rigModule] = await Promise.all([loadLevel(quality), import('./rigData')]);
    loaded = { quality, model: level.SURFACE_MODEL, stream: level.SURFACE_STREAM };
    rig = rigModule.RIG;
    return quality;
  })();
  return inFlight[quality]!;
}

/**
 * Whether a build can happen RIGHT NOW, with no await.
 *
 * The two pages that host this demo do not agree on the order: the demo route calls `build()` first
 * and awaits `prewarm` afterwards, while the landing workbench awaits `prewarm` and only then calls
 * `build()`. A build that always deferred its geometry to a `.then` therefore handed the workbench
 * an empty group — which it reads its parts and triangle counts off, once, in the same task — and
 * the readout said 0 parts for a figure that was on screen. Ask this, and bind in the same task
 * when the answer is yes.
 */
export function boxingManReady(): boolean {
  return loaded !== null && rig !== null;
}

/** The level currently held in memory, or null before the first prewarm. */
export function boxingManQuality(): Quality | null {
  return loaded?.quality ?? null;
}

export function createBoxingManModel(options: BoxingManOptions = {}): THREE.Group {
  if (!loaded) {
    throw new Error('call prewarmBoxingMan() and await it before createBoxingManModel() — the level of detail is loaded on demand');
  }
  const group = buildModel(loaded.model, loaded.stream, {
    animation: 'turntable',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  group.name = 'boxing-man';
  return group;
}

/**
 * Build across frames instead of in one block: the group comes back empty and fills part by part,
 * so the model appears as it decodes and the page keeps responding. Same geometry as
 * `createBoxingManModel`, different timing.
 *
 *     const { group, done } = createBoxingManModelProgressive({ onPart: (n, total) => setLabel(`${n}/${total}`) });
 *     scene.add(group);   // already safe to add — it fills itself in
 *     await done;         // resolves once every part has landed
 */
export function createBoxingManModelProgressive(
  options: ProgressiveOptions = {},
): { group: THREE.Group; done: Promise<THREE.Group> } {
  if (!loaded) {
    throw new Error('call prewarmBoxingMan() and await it before createBoxingManModelProgressive() — the level of detail is loaded on demand');
  }
  const built = buildModelProgressive(loaded.model, loaded.stream, {
    animation: 'turntable',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  built.group.name = 'boxing-man';
  return built;
}


/**
 * Build the model with its skeleton and clips. The keyframes are embedded like the geometry is —
 * nothing is fetched — so this works offline and in a bundle with no asset pipeline.
 *
 *     await prewarmBoxingMan();
 *     const rigged = createBoxingManRigged();
 *     scene.add(rigged.group);
 *     rigged.play('preset:jump');
 *     renderer.setAnimationLoop(() => { rigged.update(clock.getDelta()); renderer.render(scene, camera); });
 *
 * The clips shipped here: preset:jump (1.80s), preset:run (1.03s), preset:walk (1.90s), preset:biped:box_01 (1.80s), preset:biped:box_02 (2.27s), preset:biped:box_03 (2.07s), preset:biped:defeat_02 (6.80s), preset:biped:front_kick_01 (2.03s), preset:biped:front_kick_02 (1.13s), preset:biped:hit_to_body_01 (1.07s), preset:biped:wave_goodbye_01 (5.30s), preset:biped:lift_heavy (15.63s), preset:biped:warm_up (14.67s), preset:biped:dance_01 (18.57s), preset:biped:dance_02 (10.27s), preset:biped:dance_03 (10.27s), preset:biped:dance_04 (8.67s), preset:biped:dance_05 (2.33s), preset:biped:dance_06 (8.73s).
 * Rigging merges the surface, so this model is ONE skinned mesh rather than the named parts a
 * static model carries — the 41 bone names are the rig's own.
 */
export function createBoxingManRigged(options: BoxingManOptions = {}): RiggedModel {
  if (!loaded || !rig) {
    throw new Error('call prewarmBoxingMan() and await it before createBoxingManRigged() — the level of detail and the rig are both loaded on demand');
  }
  const rigged = buildRiggedModel(loaded.model, loaded.stream, rig, {
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  rigged.group.name = 'boxing-man';
  return rigged;
}

/** Clip names, in the order they were retargeted. */
export const BOXING_MAN_CLIPS = ['preset:jump', 'preset:run', 'preset:walk', 'preset:biped:box_01', 'preset:biped:box_02', 'preset:biped:box_03', 'preset:biped:defeat_02', 'preset:biped:front_kick_01', 'preset:biped:front_kick_02', 'preset:biped:hit_to_body_01', 'preset:biped:wave_goodbye_01', 'preset:biped:lift_heavy', 'preset:biped:warm_up', 'preset:biped:dance_01', 'preset:biped:dance_02', 'preset:biped:dance_03', 'preset:biped:dance_04', 'preset:biped:dance_05', 'preset:biped:dance_06'] as const;

/** Pivot group for one part — rotate or translate it without touching geometry. */
export function boxingManPivot(group: THREE.Group, part: BoxingManPart): THREE.Group {
  const pivots = group.userData.pivots as Record<string, THREE.Group>;
  return pivots[part];
}

/** Neutral three-point studio rig scaled to the figure. Replace with a look-dev rig when you have one. */
export function createBoxingManLookDevLights(): THREE.Group {
  return createStudioLights(loaded?.model.height ?? 1);
}

/** Call once per frame with the elapsed time in seconds to run the built-in idle motion. */
export function updateBoxingMan(group: THREE.Group, elapsedSeconds: number): void {
  const update = group.userData.update as ((t: number) => void) | undefined;
  update?.(elapsedSeconds);
}
