import * as THREE from 'three';
import { buildModel, buildModelProgressive, createStudioLights, preferredQuality, buildRiggedModel, type BuildOptions, type EncodedModel, type EncodedRig, type ProgressiveOptions, type Quality, type RiggedModel } from './meshCodec';

/**
 * crep — a code-only Three.js model with 1 named parts and 115,745 triangles.
 *
 * Built by the img2threejs playground on 2026-08-27 15:11:06 UTC:
 *   1. reference image (generated, prompt: "Giúp tôi tạo 1 nhân vật high-poly có nắm đấm tay, nhân vật này là quái vật có dáng đứng T pose, đây là quái vật mạnh mẽ có cơ bắp, đây là quái vật trong game, và nó có xung quanh là các lớp vẩy và xương, đôi mắt đáng sợ hung dữ, có răng nanh và đôi cánh, và khổng lồ. background là transparent.")
 *   2. Tripo v3.1-20260211 measurement (task 49aab5cc-46d8-4bc4-96a8-afe8dbb27ef0)
 *   3. Tripo mesh segmentation v2.0-20260430 (task 0477b2f8-3723-44c3-a4bb-9291386bace2)
 *   4. img2threejs GLB fast lane: measured bounds -> part hypotheses -> embedded surfaces
 *
 * Nothing is fetched from a server: geometry, normals and per-vertex colour are embedded in the
 * surfaceData modules that ship beside this file.
 *
 * LEVELS OF DETAIL: high 115,745 tris, 1,777 KB
 *
 * Each level is a separate module, imported dynamically, so a bundler splits them into separate
 * chunks and a viewer downloads ONLY the level it renders. Bundling all of them into one file
 * would make a phone pay for the desktop level, which is the whole reason the levels exist.
 * That import is why `prewarm` is async and must be awaited before `createMonsterModel`.
 *
 * Part names are HYPOTHESES from measured bounds (see object-sculpt-spec.json), not confirmed labels:
 *
 *   body-shell               body-shell             conf 0.20    115,745 tris
 */

export type MonsterOptions = BuildOptions;

export const MONSTER_PARTS = ['body-shell'] as const;
export type MonsterPart = (typeof MONSTER_PARTS)[number];

/** Framing that fits the whole figure at a 30-degree FOV; matches the showcase registry entry. */
export const MONSTER_CAMERA = {
  position: [1.8931, 1.045, 5.4088] as [number, number, number],
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
 * The rig is fetched WITH the level, not imported beside it.
 *
 * 41 bones and 27 clips of Float32 keyframes are 15 MB of module, and a static import puts all of
 * it in whichever chunk imports this file — for the showcase that is the gallery's own entry chunk,
 * which every visitor downloads just to see the demo INDEX. Behind the same dynamic import as the
 * surfaces it becomes its own chunk, and only this demo's page pays for it.
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
export async function prewarmMonster(quality: Quality = preferredQuality('high')): Promise<Quality> {
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
 * `build()`. A build that always deferred its geometry to a `.then` hands the workbench an empty
 * group — which it reads its parts and triangle counts off, once, in the same task. Ask this, and
 * bind in the same task when the answer is yes.
 */
export function monsterReady(): boolean {
  return loaded !== null && rig !== null;
}

/** The level currently held in memory, or null before the first prewarm. */
export function monsterQuality(): Quality | null {
  return loaded?.quality ?? null;
}

export function createMonsterModel(options: MonsterOptions = {}): THREE.Group {
  if (!loaded) {
    throw new Error('call prewarmMonster() and await it before createMonsterModel() — the level of detail is loaded on demand');
  }
  const group = buildModel(loaded.model, loaded.stream, {
    animation: 'turntable',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  group.name = 'monster';
  return group;
}

/**
 * Build across frames instead of in one block: the group comes back empty and fills part by part,
 * so the model appears as it decodes and the page keeps responding. Same geometry as
 * `createMonsterModel`, different timing.
 *
 *     const { group, done } = createMonsterModelProgressive({ onPart: (n, total) => setLabel(`${n}/${total}`) });
 *     scene.add(group);   // already safe to add — it fills itself in
 *     await done;         // resolves once every part has landed
 */
export function createMonsterModelProgressive(
  options: ProgressiveOptions = {},
): { group: THREE.Group; done: Promise<THREE.Group> } {
  if (!loaded) {
    throw new Error('call prewarmMonster() and await it before createMonsterModelProgressive() — the level of detail is loaded on demand');
  }
  const built = buildModelProgressive(loaded.model, loaded.stream, {
    animation: 'turntable',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  built.group.name = 'monster';
  return built;
}


/**
 * Build the model with its skeleton and clips. The keyframes are embedded like the geometry is —
 * nothing is fetched — so this works offline and in a bundle with no asset pipeline.
 *
 *     await prewarmMonster();
 *     const rigged = createMonsterRigged();
 *     scene.add(rigged.group);
 *     rigged.play('preset:biped:jump_down');
 *     renderer.setAnimationLoop(() => { rigged.update(clock.getDelta()); renderer.render(scene, camera); });
 *
 * The clips shipped here: preset:biped:jump_down (3.00s), preset:biped:look_around (12.50s), preset:biped:run (1.03s), preset:biped:sit (5.77s), preset:biped:walk (1.90s), preset:biped:box_01 (1.80s), preset:biped:box_02 (2.27s), preset:biped:box_03 (2.07s), preset:biped:defeat_03 (4.47s), preset:biped:fire (1.23s), preset:biped:front_kick_01 (2.54s), preset:biped:front_kick_02 (1.42s), preset:biped:hit_to_body_01 (1.33s), preset:biped:hit_to_body_02 (1.75s), preset:biped:slash (6.63s), preset:biped:dance_01 (18.57s), preset:biped:dance_02 (10.27s), preset:biped:dance_03 (10.27s), preset:biped:dance_04 (8.67s), preset:biped:dance_05 (2.33s), preset:biped:dance_06 (10.92s), preset:biped:idle (15.38s), preset:biped:make_a_call_01 (17.63s), preset:biped:play_video_game (15.83s), preset:biped:shovel (15.54s), preset:biped:sing_01 (15.54s), preset:biped:sing_03 (13.54s).
 * Rigging merges the surface, so this model is ONE skinned mesh rather than the named parts a
 * static model carries — the 41 bone names are the rig's own.
 */
export function createMonsterRigged(options: MonsterOptions = {}): RiggedModel {
  if (!loaded || !rig) {
    throw new Error('call prewarmMonster() and await it before createMonsterRigged() — the level of detail and the rig are loaded on demand');
  }
  const rigged = buildRiggedModel(loaded.model, loaded.stream, rig, {
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  rigged.group.name = 'monster';
  return rigged;
}

/** Clip names, in the order they were retargeted. */
export const MONSTER_CLIPS = ['preset:biped:jump_down', 'preset:biped:look_around', 'preset:biped:run', 'preset:biped:sit', 'preset:biped:walk', 'preset:biped:box_01', 'preset:biped:box_02', 'preset:biped:box_03', 'preset:biped:defeat_03', 'preset:biped:fire', 'preset:biped:front_kick_01', 'preset:biped:front_kick_02', 'preset:biped:hit_to_body_01', 'preset:biped:hit_to_body_02', 'preset:biped:slash', 'preset:biped:dance_01', 'preset:biped:dance_02', 'preset:biped:dance_03', 'preset:biped:dance_04', 'preset:biped:dance_05', 'preset:biped:dance_06', 'preset:biped:idle', 'preset:biped:make_a_call_01', 'preset:biped:play_video_game', 'preset:biped:shovel', 'preset:biped:sing_01', 'preset:biped:sing_03'] as const;

/** Pivot group for one part — rotate or translate it without touching geometry. */
export function monsterPivot(group: THREE.Group, part: MonsterPart): THREE.Group {
  const pivots = group.userData.pivots as Record<string, THREE.Group>;
  return pivots[part];
}

/** Neutral three-point studio rig scaled to the figure. Replace with a look-dev rig when you have one. */
export function createMonsterLookDevLights(): THREE.Group {
  return createStudioLights(loaded?.model.height ?? 1);
}

/** Call once per frame with the elapsed time in seconds to run the built-in idle motion. */
export function updateMonster(group: THREE.Group, elapsedSeconds: number): void {
  const update = group.userData.update as ((t: number) => void) | undefined;
  update?.(elapsedSeconds);
}
