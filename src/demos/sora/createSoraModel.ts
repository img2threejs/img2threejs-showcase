/**
 * sora — a code-only Three.js rig with two skin outfits, designed for the
 * img2threejs showcase gallery.
 *
 * Two compressed surface streams ship side by side:
 *   - skin-a: the "default" look, the reference image in the supplied folder
 *   - skin-b: "Kingdom Key", the second v2 references
 *
 * Geometry and skeletons are embedded from the playground's measured surfaces;
 * no source model file is loaded at runtime. Original UVs and bundled 4K material
 * maps restore details lost by the initial vertex-colour-only export.
 *
 * The gallery lazy-loads this runtime. prewarmSora validates both encoded
 * payloads and loads their local texture images before the rig factory is used.
 */
import * as THREE from 'three';
import { applySoraSurfaceAppearance, prewarmSoraSurfaceAppearance } from './surfaceAppearance';
import {
  applyVfx,
  applyIdle,
  buildRiggedModel,
  createStudioLights,
  preferredQuality,
  type EncodedModel,
  type EncodedRig,
  type IdleName,
  type Quality,
  type RiggedModel,
} from './meshCodec';
import { RIG as RIG_SKIN_A } from './rigData.skin-a';
import { RIG as RIG_SKIN_B } from './rigData.skin-b';
import {
  SURFACE_MODEL as SURFACE_MODEL_A,
  SURFACE_STREAM as SURFACE_STREAM_A,
} from './surfaceData.skin-a';
import {
  SURFACE_MODEL as SURFACE_MODEL_B,
  SURFACE_STREAM as SURFACE_STREAM_B,
} from './surfaceData.skin-b';

/**
 * Selectable anatomical regions derived from the shared rig's skin weights.
 * The visible surface stays continuous; only triangle indices are partitioned.
 */
export const SORA_PARTS = [
  'head',
  'torso',
  'hips',
  'left-upper-arm',
  'left-forearm',
  'left-hand',
  'right-upper-arm',
  'right-forearm',
  'right-hand',
  'left-thigh',
  'left-lower-leg',
  'left-foot',
  'right-thigh',
  'right-lower-leg',
  'right-foot',
] as const;
export type SoraPart = (typeof SORA_PARTS)[number];

/**
 * Skin identifiers. `default` and `kingdom-key` map 1:1 to the surface/rig
 * pair; `custom-1` is reserved for the radial-shield VFX created at runtime
 * by the showcase adapter and is not backed by a separate stream.
 */
export const SORA_SKINS = ['default', 'kingdom-key'] as const;
export type SoraSkinId = (typeof SORA_SKINS)[number];

/** Framing for the figure, matching the supplied SORA_CAMERA proposal. */
export const SORA_CAMERA: {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fov: number;
} = {
  position: [1.7695, 1.045, 5.0558],
  target: [0, 0.95, 0],
  fov: 30,
};

interface SkinPayload {
  surface: EncodedModel;
  stream: string;
  rig: EncodedRig;
}

const SKIN_A: SkinPayload = {
  surface: SURFACE_MODEL_A,
  stream: SURFACE_STREAM_A,
  rig: RIG_SKIN_A,
};
const SKIN_B: SkinPayload = {
  surface: SURFACE_MODEL_B,
  stream: SURFACE_STREAM_B,
  rig: RIG_SKIN_B,
};

function loadSkinPayload(skinId: SoraSkinId): SkinPayload {
  return skinId === 'default' ? SKIN_A : SKIN_B;
}

/** Tracks validated skin payloads; texture loading is shared across both outfits. */
type PrewarmBag = Record<SoraSkinId, boolean>;
let prewarmedSkinIds: PrewarmBag | null = null;

export async function prewarmSora(
  quality: Quality = preferredQuality('high'),
): Promise<Quality> {
  if (quality !== 'high' && quality !== 'medium' && quality !== 'low') {
    throw new Error(`Sora: unsupported quality ${String(quality)}`);
  }
  await prewarmSoraSurfaceAppearance();
  const bag: PrewarmBag = {
    default: prewarmedSkinIds?.['default'] ?? false,
    'kingdom-key': prewarmedSkinIds?.['kingdom-key'] ?? false,
  };
  for (const skinId of SORA_SKINS) {
    if (bag[skinId]) continue;
    const payload = loadSkinPayload(skinId);
    buildRiggedModel(payload.surface, payload.stream, payload.rig, {
      castShadow: true,
      receiveShadow: true,
    });
    bag[skinId] = true;
  }
  prewarmedSkinIds = bag;
  return quality;
}
/**
 * Build the rig for one skin. Geometry and rigs are embedded; material images
 * are local bundled assets loaded by prewarmSora, with no provider dependency.
 *
 *     await prewarmSora();
 *     const rigged = createSoraRigged();
 *     scene.add(rigged.group);
 *     rigged.play('preset:biped:climb');
 *     renderer.setAnimationLoop(() => { rigged.update(clock.getDelta()); renderer.render(scene, camera); });
 *
 * The clips shipped here: 44 retargeted clips spanning biped locomotion,
 * dance and combat — see the rig data header for the full list.
 *
 * Rigging merges the surface, so this model is one skinned mesh rather than
 * the named parts a static model carries — the 41 bone names are the rig's.
 */
export function createSoraRigged(
  options: {
    skinId?: SoraSkinId;
    animation?: IdleName;
    vfx?: 'none' | 'pulse' | 'stagger' | 'drift';
    castShadow?: boolean;
    receiveShadow?: boolean;
  } = {},
): RiggedModel {
  if (!prewarmedSkinIds) {
    throw new Error(
      'Sora: call prewarmSora() and await it before createSoraRigged() — the level of detail is loaded on demand',
    );
  }
  const payload = loadSkinPayload(options.skinId ?? 'default');
  const rigged = buildRiggedModel(payload.surface, payload.stream, payload.rig, {
    castShadow: options.castShadow ?? true,
    receiveShadow: options.receiveShadow ?? true,
  });
  applySoraSurfaceAppearance(rigged.mesh, options.skinId ?? 'default');
  return rigged;
}

/** Studio rig from the supplied mesh codec, scaled to the figure. */
export function createSoraLookDevLights(): THREE.Group {
  return createStudioLights(SURFACE_MODEL_A.height);
}

/**
 * Per-frame driver. The viewer calls `group.userData.tick` once per frame;
 * this shim keeps a delta even when callers pass only an elapsed value, so
 * the rig's mixer advanced under any consumer wiring.
 */
export function updateSora(
  group: THREE.Group,
  elapsedSeconds: number,
  deltaSeconds?: number,
): void {
  const previous = group.userData.updateElapsed as number | undefined;
  const delta =
    deltaSeconds ??
    (previous === undefined
      ? 1 / 60
      : Math.max(0, elapsedSeconds - previous));
  group.userData.updateElapsed = elapsedSeconds;
  const tick = group.userData.tick as
    | ((delta: number, elapsed: number) => void)
    | undefined;
  tick?.(delta, elapsedSeconds);
}

export { applyIdle, applyVfx };
