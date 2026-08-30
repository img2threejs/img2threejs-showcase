import * as THREE from 'three';
import { buildModel, buildModelProgressive, createStudioLights, preferredQuality, buildRiggedModel, type BuildOptions, type EncodedModel, type ProgressiveOptions, type Quality, type RiggedModel } from './meshCodec';
import { RIG } from './rigData';

/**
 * Monster 1 — a code-only Three.js model with 1 named parts and 113,338 triangles.
 *
 * Built by the img2threejs playground on 2026-08-29 13:53:42 UTC:
 *   1. reference image (upload)
 *   2. Tripo v3.1-20260211 measurement (task 40329e23-fc34-4d89-bd29-87402c3c0d6f)
 *   3. Tripo mesh segmentation v2.0-20260430 (task 0451a43e-bebe-4645-9744-27d6f0b37713)
 *   4. img2threejs GLB fast lane: measured bounds -> part hypotheses -> embedded surfaces
 *
 * Nothing is fetched from a server: geometry, normals and per-vertex colour are embedded in the
 * surfaceData modules that ship beside this file.
 *
 * LEVELS OF DETAIL: high 113,338 tris, 1,746 KB
 *
 * Each level is a separate module, imported dynamically, so a bundler splits them into separate
 * chunks and a viewer downloads ONLY the level it renders. Bundling all of them into one file
 * would make a phone pay for the desktop level, which is the whole reason the levels exist.
 * That import is why `prewarm` is async and must be awaited before `createMonster1Model`.
 *
 * Part names are HYPOTHESES from measured bounds (see object-sculpt-spec.json), not confirmed labels:
 *
 *   body-shell               body-shell             conf 0.20    113,338 tris
 */

export type Monster1Options = BuildOptions;

export const MONSTER_1_PARTS = ['body-shell'] as const;
export type Monster1Part = (typeof MONSTER_1_PARTS)[number];

/** Framing that fits the whole figure at a 30-degree FOV; matches the showcase registry entry. */
export const MONSTER_1_CAMERA = {
  position: [1.9677, 1.045, 5.6221] as [number, number, number],
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
export async function prewarmMonster1(quality: Quality = preferredQuality('high')): Promise<Quality> {
  if (loaded?.quality === quality) return quality;
  const module = await loadLevel(quality);
  loaded = { quality, model: module.SURFACE_MODEL, stream: module.SURFACE_STREAM };
  return quality;
}

/** The level currently held in memory, or null before the first prewarm. */
export function monster1Quality(): Quality | null {
  return loaded?.quality ?? null;
}

export function createMonster1Model(options: Monster1Options = {}): THREE.Group {
  if (!loaded) {
    throw new Error('call prewarmMonster1() and await it before createMonster1Model() — the level of detail is loaded on demand');
  }
  const group = buildModel(loaded.model, loaded.stream, {
    animation: 'breathe',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  group.name = 'monster-1';
  return group;
}

/**
 * Build across frames instead of in one block: the group comes back empty and fills part by part,
 * so the model appears as it decodes and the page keeps responding. Same geometry as
 * `createMonster1Model`, different timing.
 *
 *     const { group, done } = createMonster1ModelProgressive({ onPart: (n, total) => setLabel(`${n}/${total}`) });
 *     scene.add(group);   // already safe to add — it fills itself in
 *     await done;         // resolves once every part has landed
 */
export function createMonster1ModelProgressive(
  options: ProgressiveOptions = {},
): { group: THREE.Group; done: Promise<THREE.Group> } {
  if (!loaded) {
    throw new Error('call prewarmMonster1() and await it before createMonster1ModelProgressive() — the level of detail is loaded on demand');
  }
  const built = buildModelProgressive(loaded.model, loaded.stream, {
    animation: 'breathe',
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  built.group.name = 'monster-1';
  return built;
}


/**
 * Build the model with its skeleton and clips. The keyframes are embedded like the geometry is —
 * nothing is fetched — so this works offline and in a bundle with no asset pipeline.
 *
 *     await prewarmMonster1();
 *     const rigged = createMonster1Rigged();
 *     scene.add(rigged.group);
 *     rigged.play('preset:biped:run_upstairs');
 *     renderer.setAnimationLoop(() => { rigged.update(clock.getDelta()); renderer.render(scene, camera); });
 *
 * The clips shipped here: preset:biped:run_upstairs (0.83s), preset:biped:standing_relax (17.63s), preset:biped:box_01 (2.25s), preset:biped:box_02 (2.83s), preset:biped:box_03 (2.58s), preset:biped:defeat_03 (5.58s), preset:biped:fire (1.54s), preset:biped:front_kick_01 (2.54s), preset:biped:front_kick_02 (1.42s), preset:biped:dance_01 (23.21s), preset:biped:dance_02 (12.83s), preset:biped:dance_03 (12.83s), preset:biped:dance_04 (10.83s), preset:biped:dance_05 (2.92s), preset:biped:dance_06 (10.92s), preset:biped:idle (15.38s).
 * Rigging merges the surface, so this model is ONE skinned mesh rather than the named parts a
 * static model carries — the 41 bone names are the rig's own.
 */
export function createMonster1Rigged(options: Monster1Options = {}): RiggedModel {
  if (!loaded) {
    throw new Error('call prewarmMonster1() and await it before createMonster1Rigged() — the level of detail is loaded on demand');
  }
  const rigged = buildRiggedModel(loaded.model, loaded.stream, RIG, {
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  rigged.group.name = 'monster-1';
  return rigged;
}

/** Clip names, in the order they were retargeted. */
export const MONSTER_1_CLIPS = ['preset:biped:run_upstairs', 'preset:biped:standing_relax', 'preset:biped:box_01', 'preset:biped:box_02', 'preset:biped:box_03', 'preset:biped:defeat_03', 'preset:biped:fire', 'preset:biped:front_kick_01', 'preset:biped:front_kick_02', 'preset:biped:dance_01', 'preset:biped:dance_02', 'preset:biped:dance_03', 'preset:biped:dance_04', 'preset:biped:dance_05', 'preset:biped:dance_06', 'preset:biped:idle'] as const;

/** Pivot group for one part — rotate or translate it without touching geometry. */
export function monster1Pivot(group: THREE.Group, part: Monster1Part): THREE.Group {
  const pivots = group.userData.pivots as Record<string, THREE.Group>;
  return pivots[part];
}

/** Neutral three-point studio rig scaled to the figure. Replace with a look-dev rig when you have one. */
export function createMonster1LookDevLights(): THREE.Group {
  return createStudioLights(loaded?.model.height ?? 1);
}

/** Call once per frame with the elapsed time in seconds to run the built-in idle motion. */
export function updateMonster1(group: THREE.Group, elapsedSeconds: number): void {
  const update = group.userData.update as ((t: number) => void) | undefined;
  update?.(elapsedSeconds);
}
