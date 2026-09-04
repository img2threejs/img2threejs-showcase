import * as THREE from 'three';
import { buildModel, buildModelProgressive, createStudioLights, preferredQuality, buildRiggedModel, type BuildOptions, type EncodedModel, type EncodedRig, type ProgressiveOptions, type Quality, type RiggedModel } from './meshCodec';

/**
 * raz — a code-only Three.js model with 1 named parts and 286,108 triangles.
 *
 * Built by the img2threejs playground on 2026-08-29 05:39:11 UTC:
 *   1. reference image (upload)
 *   2. Tripo measurement (task a3cc7738-a345-4e3d-80bb-2bdf9638dc94)
 *   3. Tripo mesh segmentation v2.0-20260430 (task 07135220-5309-42e5-bd56-955e81d2ba09)
 *   4. img2threejs GLB fast lane: measured bounds -> part hypotheses -> embedded surfaces
 *
 * Nothing is fetched from a server: geometry, normals and per-vertex colour are embedded in the
 * surfaceData modules that ship beside this file.
 *
 * LEVELS OF DETAIL: high 286,108 tris, 4,366 KB
 *
 * Each level is a separate module, imported dynamically, so a bundler splits them into separate
 * chunks and a viewer downloads ONLY the level it renders. Bundling all of them into one file
 * would make a phone pay for the desktop level, which is the whole reason the levels exist.
 * That import is why `prewarm` is async and must be awaited before `createRazModel`.
 *
 * Part names are HYPOTHESES from measured bounds (see object-sculpt-spec.json), not confirmed labels:
 *
 *   body-shell               body-shell             conf 0.20    286,108 tris
 */

export type RazOptions = BuildOptions;

export const RAZ_PARTS = ['body-shell'] as const;
export type RazPart = (typeof RAZ_PARTS)[number];

/** Framing that fits the whole figure at a 30-degree FOV; matches the showcase registry entry. */
export const RAZ_CAMERA = {
  position: [1.8088, 1.045, 5.168] as [number, number, number],
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
 * The rig is its own chunk too, and a deliberately large one: 41 bones and 24 clips of Float32
 * keyframes. A visitor who only ever sees the static turntable should not pay for keyframes they
 * never play, so it is imported beside the level rather than at module scope.
 */
let rig: EncodedRig | null = null;
const inFlight: Partial<Record<Quality, Promise<Quality>>> = {};

/**
 * Fetch and hold one level, plus the rig. Await this before building — both live in their own
 * chunks, so neither is in memory until it has been imported.
 *
 * With no argument the level is chosen for the device: `?quality=` if the URL asks, otherwise the
 * cheap level on a small touch screen and the full one on a desktop.
 */
export async function prewarmRaz(quality: Quality = preferredQuality('high')): Promise<Quality> {
  if (loaded?.quality === quality && rig) return quality;
  // One in-flight fetch per level, shared by every caller. The gallery's own `prewarm` hook and the
  // demo's build both call this, and without the shared promise the second caller re-enters the
  // body and the two race over which one assigns `loaded`.
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
 * The two pages that host this demo disagree on the order: the demo route calls `build()` first and
 * awaits `prewarm` afterwards, while the landing workbench awaits `prewarm` and only then calls
 * `build()`. A build that always deferred its geometry to a `.then` hands the workbench an empty
 * group — which it reads its parts and triangle counts off, once, in the same task. Ask this, and
 * bind in the same task when the answer is yes.
 */
export function razReady(): boolean {
  return loaded !== null && rig !== null;
}

/** The level currently held in memory, or null before the first prewarm. */
export function razQuality(): Quality | null {
  return loaded?.quality ?? null;
}

export function createRazModel(options: RazOptions = {}): THREE.Group {
  if (!loaded) {
    throw new Error('call prewarmRaz() and await it before createRazModel() — the level of detail is loaded on demand');
  }
  const group = buildModel(loaded.model, loaded.stream, {
    animation: 'turntable',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  group.name = 'raz';
  return group;
}

/**
 * Build across frames instead of in one block: the group comes back empty and fills part by part,
 * so the model appears as it decodes and the page keeps responding. Same geometry as
 * `createRazModel`, different timing.
 *
 *     const { group, done } = createRazModelProgressive({ onPart: (n, total) => setLabel(`${n}/${total}`) });
 *     scene.add(group);   // already safe to add — it fills itself in
 *     await done;         // resolves once every part has landed
 */
export function createRazModelProgressive(
  options: ProgressiveOptions = {},
): { group: THREE.Group; done: Promise<THREE.Group> } {
  if (!loaded) {
    throw new Error('call prewarmRaz() and await it before createRazModelProgressive() — the level of detail is loaded on demand');
  }
  const built = buildModelProgressive(loaded.model, loaded.stream, {
    animation: 'turntable',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  built.group.name = 'raz';
  return built;
}


/**
 * Build the model with its skeleton and clips. The keyframes are embedded like the geometry is —
 * nothing is fetched — so this works offline and in a bundle with no asset pipeline.
 *
 *     await prewarmRaz();
 *     const rigged = createRazRigged();
 *     scene.add(rigged.group);
 *     rigged.play('preset:jump');
 *     renderer.setAnimationLoop(() => { rigged.update(clock.getDelta()); renderer.render(scene, camera); });
 *
 * The clips shipped here: preset:jump (1.80s), preset:biped:jump (1.80s), preset:biped:run (1.03s), preset:biped:sit (5.77s), preset:biped:walk (1.90s), preset:biped:box_01 (2.25s), preset:biped:box_02 (2.83s), preset:biped:box_03 (2.58s), preset:biped:defeat_03 (5.58s), preset:biped:front_kick_01 (2.54s), preset:biped:front_kick_02 (1.42s), preset:biped:hit_to_body_01 (1.33s), preset:biped:angry_01 (3.54s), preset:biped:angry_03 (3.63s), preset:biped:jump_rope_01 (9.71s), preset:biped:jump_rope_02 (9.71s), preset:biped:dance_01 (23.21s), preset:biped:dance_02 (12.83s), preset:biped:dance_03 (12.83s), preset:biped:dance_04 (10.83s), preset:biped:dance_05 (2.92s), preset:biped:dance_06 (10.92s), preset:biped:dig (16.42s), preset:biped:fold_arms (17.13s), preset:biped:uppercut (1.30s).
 * Rigging merges the surface, so this model is ONE skinned mesh rather than the named parts a
 * static model carries — the 41 bone names are the rig's own.
 */
export function createRazRigged(options: RazOptions = {}): RiggedModel {
  if (!loaded || !rig) {
    throw new Error('call prewarmRaz() and await it before createRazRigged() — the level of detail and the rig are both loaded on demand');
  }
  const rigged = buildRiggedModel(loaded.model, loaded.stream, rig, {
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  rigged.group.name = 'raz';
  return rigged;
}

/** Clip names, in the order they were retargeted. */
export const RAZ_CLIPS = ['preset:jump', 'preset:biped:jump', 'preset:biped:run', 'preset:biped:sit', 'preset:biped:walk', 'preset:biped:box_01', 'preset:biped:box_02', 'preset:biped:box_03', 'preset:biped:defeat_03', 'preset:biped:front_kick_01', 'preset:biped:front_kick_02', 'preset:biped:hit_to_body_01', 'preset:biped:angry_01', 'preset:biped:angry_03', 'preset:biped:jump_rope_01', 'preset:biped:jump_rope_02', 'preset:biped:dance_01', 'preset:biped:dance_02', 'preset:biped:dance_03', 'preset:biped:dance_04', 'preset:biped:dance_05', 'preset:biped:dance_06', 'preset:biped:dig', 'preset:biped:fold_arms', 'preset:biped:uppercut'] as const;

/** Pivot group for one part — rotate or translate it without touching geometry. */
export function razPivot(group: THREE.Group, part: RazPart): THREE.Group {
  const pivots = group.userData.pivots as Record<string, THREE.Group>;
  return pivots[part];
}

/** Neutral three-point studio rig scaled to the figure. Replace with a look-dev rig when you have one. */
export function createRazLookDevLights(): THREE.Group {
  return createStudioLights(loaded?.model.height ?? 1);
}

/** Call once per frame with the elapsed time in seconds to run the built-in idle motion. */
export function updateRaz(group: THREE.Group, elapsedSeconds: number): void {
  const update = group.userData.update as ((t: number) => void) | undefined;
  update?.(elapsedSeconds);
}
