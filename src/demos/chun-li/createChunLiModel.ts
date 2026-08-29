import * as THREE from 'three';
import { buildModel, buildModelProgressive, createStudioLights, preferredQuality, buildRiggedModel, type BuildOptions, type EncodedModel, type ProgressiveOptions, type Quality, type RiggedModel } from './meshCodec';
import { RIG } from './rigData';

/**
 * Chun Li — a code-only Three.js model with 1 named parts and 244,468 triangles.
 *
 * Built by the img2threejs playground on 2026-08-29 06:33:05 UTC:
 *   1. reference image (upload)
 *   2. Tripo v3.1-20260211 measurement (task f0a5aea5-20fe-411a-a88e-c2dde39fdf59)
 *   3. Tripo mesh segmentation v2.0-20260430 (task 5e3282d4-802a-4863-9c4b-f53e74c3e30c)
 *   4. img2threejs GLB fast lane: measured bounds -> part hypotheses -> embedded surfaces
 *
 * Nothing is fetched from a server: geometry, normals and per-vertex colour are embedded in the
 * surfaceData modules that ship beside this file.
 *
 * LEVELS OF DETAIL: high 244,468 tris, 3,711 KB
 *
 * Each level is a separate module, imported dynamically, so a bundler splits them into separate
 * chunks and a viewer downloads ONLY the level it renders. Bundling all of them into one file
 * would make a phone pay for the desktop level, which is the whole reason the levels exist.
 * That import is why `prewarm` is async and must be awaited before `createChunLiModel`.
 *
 * Part names are HYPOTHESES from measured bounds (see object-sculpt-spec.json), not confirmed labels:
 *
 *   body-shell               body-shell             conf 0.20    244,468 tris
 */

export type ChunLiOptions = BuildOptions;

export const CHUN_LI_PARTS = ['body-shell'] as const;
export type ChunLiPart = (typeof CHUN_LI_PARTS)[number];

/** Framing that fits the whole figure at a 30-degree FOV; matches the showcase registry entry. */
export const CHUN_LI_CAMERA = {
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
 * Fetch and hold one level. Await this before building — the level lives in its own chunk, so the
 * data is not in memory until it has been imported.
 *
 * With no argument the level is chosen for the device: `?quality=` if the URL asks, otherwise the
 * cheap level on a small touch screen and the full one on a desktop.
 */
export async function prewarmChunLi(quality: Quality = preferredQuality('high')): Promise<Quality> {
  if (loaded?.quality === quality) return quality;
  const module = await loadLevel(quality);
  loaded = { quality, model: module.SURFACE_MODEL, stream: module.SURFACE_STREAM };
  return quality;
}

/** The level currently held in memory, or null before the first prewarm. */
export function chunLiQuality(): Quality | null {
  return loaded?.quality ?? null;
}

export function createChunLiModel(options: ChunLiOptions = {}): THREE.Group {
  if (!loaded) {
    throw new Error('call prewarmChunLi() and await it before createChunLiModel() — the level of detail is loaded on demand');
  }
  const group = buildModel(loaded.model, loaded.stream, {
    animation: 'turntable',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  group.name = 'chun-li';
  return group;
}

/**
 * Build across frames instead of in one block: the group comes back empty and fills part by part,
 * so the model appears as it decodes and the page keeps responding. Same geometry as
 * `createChunLiModel`, different timing.
 *
 *     const { group, done } = createChunLiModelProgressive({ onPart: (n, total) => setLabel(`${n}/${total}`) });
 *     scene.add(group);   // already safe to add — it fills itself in
 *     await done;         // resolves once every part has landed
 */
export function createChunLiModelProgressive(
  options: ProgressiveOptions = {},
): { group: THREE.Group; done: Promise<THREE.Group> } {
  if (!loaded) {
    throw new Error('call prewarmChunLi() and await it before createChunLiModelProgressive() — the level of detail is loaded on demand');
  }
  const built = buildModelProgressive(loaded.model, loaded.stream, {
    animation: 'turntable',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  built.group.name = 'chun-li';
  return built;
}


/**
 * Build the model with its skeleton and clips. The keyframes are embedded like the geometry is —
 * nothing is fetched — so this works offline and in a bundle with no asset pipeline.
 *
 *     await prewarmChunLi();
 *     const rigged = createChunLiRigged();
 *     scene.add(rigged.group);
 *     rigged.play('preset:biped:box_01');
 *     renderer.setAnimationLoop(() => { rigged.update(clock.getDelta()); renderer.render(scene, camera); });
 *
 * The clips shipped here: preset:biped:box_01 (2.25s), preset:biped:box_02 (2.83s), preset:biped:box_03 (2.58s), preset:biped:cast_a_spell (5.42s), preset:biped:chop (6.63s), preset:biped:defeat_02 (8.50s), preset:biped:defeat_03 (5.58s), preset:biped:fire (1.54s), preset:biped:flee_01 (2.71s), preset:biped:flee_02 (3.71s), preset:biped:front_kick_01 (2.54s), preset:biped:front_kick_02 (1.42s), preset:biped:hit_to_body_01 (1.33s), preset:biped:shoot (9.08s), preset:biped:agree (4.04s), preset:biped:angry_01 (3.54s), preset:biped:angry_02 (2.21s), preset:biped:angry_03 (3.63s), preset:biped:cry (7.92s), preset:biped:wave_goodbye_01 (6.63s), preset:biped:wave_goodbye_02 (5.92s), preset:biped:dance_01 (23.21s), preset:biped:dance_02 (12.83s), preset:biped:dance_03 (12.83s), preset:biped:dance_04 (10.83s), preset:biped:dance_05 (2.92s), preset:biped:dance_06 (10.92s).
 * Rigging merges the surface, so this model is ONE skinned mesh rather than the named parts a
 * static model carries — the 41 bone names are the rig's own.
 */
export function createChunLiRigged(options: ChunLiOptions = {}): RiggedModel {
  if (!loaded) {
    throw new Error('call prewarmChunLi() and await it before createChunLiRigged() — the level of detail is loaded on demand');
  }
  const rigged = buildRiggedModel(loaded.model, loaded.stream, RIG, {
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  rigged.group.name = 'chun-li';
  return rigged;
}

/** Clip names, in the order they were retargeted. */
export const CHUN_LI_CLIPS = ['preset:biped:box_01', 'preset:biped:box_02', 'preset:biped:box_03', 'preset:biped:cast_a_spell', 'preset:biped:chop', 'preset:biped:defeat_02', 'preset:biped:defeat_03', 'preset:biped:fire', 'preset:biped:flee_01', 'preset:biped:flee_02', 'preset:biped:front_kick_01', 'preset:biped:front_kick_02', 'preset:biped:hit_to_body_01', 'preset:biped:shoot', 'preset:biped:agree', 'preset:biped:angry_01', 'preset:biped:angry_02', 'preset:biped:angry_03', 'preset:biped:cry', 'preset:biped:wave_goodbye_01', 'preset:biped:wave_goodbye_02', 'preset:biped:dance_01', 'preset:biped:dance_02', 'preset:biped:dance_03', 'preset:biped:dance_04', 'preset:biped:dance_05', 'preset:biped:dance_06'] as const;

/** Pivot group for one part — rotate or translate it without touching geometry. */
export function chunLiPivot(group: THREE.Group, part: ChunLiPart): THREE.Group {
  const pivots = group.userData.pivots as Record<string, THREE.Group>;
  return pivots[part];
}

/** Neutral three-point studio rig scaled to the figure. Replace with a look-dev rig when you have one. */
export function createChunLiLookDevLights(): THREE.Group {
  return createStudioLights(loaded?.model.height ?? 1);
}

/** Call once per frame with the elapsed time in seconds to run the built-in idle motion. */
export function updateChunLi(group: THREE.Group, elapsedSeconds: number): void {
  const update = group.userData.update as ((t: number) => void) | undefined;
  update?.(elapsedSeconds);
}
