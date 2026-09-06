import type { EncodedModel, EncodedRig } from './meshCodec';
import { buildMonsterTreeRig, type MonsterTreeRig, type RigOptions } from './rig';

/**
 * Y'bneth — the treant from `public/references/monster-tree.jpg`, built on the img2threejs
 * playground export and finished under the `animated-character` profile.
 *
 * ONE level of detail, deliberately. The export ships a single `high` level and no lower one, and
 * that is correct for a rigged figure: `skinIndex`/`skinWeight` address vertices by position in
 * the buffer, so a decimation pass that collapses vertices leaves the binding pointing at
 * vertices that no longer exist and the figure tears open the moment a clip runs. Decimating a
 * skinned shell is not a quality trade here — it is a correctness bug.
 */

let loaded: { model: EncodedModel; stream: string; rig: EncodedRig } | null = null;

/**
 * Fetch and hold the surface and the rig. Await this before building.
 *
 * Both are imported dynamically so a bundler splits them into their own chunks — the surface is
 * 1.8 MB and the rig, which carries the skin binding for all 64,307 vertices plus 16 clips of
 * unquantised keyframes, is 9.4 MB. Importing them statically welds both into the page's entry
 * chunk, so nothing renders until all 11 MB has arrived. Split, they download in parallel with
 * the rest of the page and the two requests are visible in the network panel as what they are.
 */
export async function prewarmMonsterTree(): Promise<void> {
  if (loaded) return;
  const [surface, rig] = await Promise.all([import('./surfaceData.high'), import('./rigData')]);
  loaded = { model: surface.SURFACE_MODEL, stream: surface.SURFACE_STREAM, rig: rig.RIG };
}

/** Build the figure: skinned bark shell, four rigid costume pieces, skeleton, sockets, clips. */
export function createMonsterTree(options: RigOptions = {}): MonsterTreeRig {
  if (!loaded) {
    throw new Error('call prewarmMonsterTree() and await it before createMonsterTree() — the surface level is loaded on demand');
  }
  return buildMonsterTreeRig(loaded.model, loaded.stream, loaded.rig, options);
}

/**
 * Review framing for both the gesture and its consequence.
 *
 * Y'bneth faces +X. Most of the camera offset stays on +Z so Vine Lash travels across the shot;
 * the smaller +X component separates the raised arms in Nature's Call. The target leads the
 * measured torso slightly downrange, leaving room for the catch point and the young grove without
 * pushing the figure behind the details panel.
 */
export const MONSTER_TREE_CAMERA = {
  position: [1.8, 1.72, 5.8] as [number, number, number],
  target: [0.52, 0.98, 0.03] as [number, number, number],
  fov: 32,
};

/**
 * The figure's measured frame, which is NOT what `object-sculpt-spec.json` claims.
 *
 * The spec's `coordinateFrame` says "subject faces -z". The geometry says otherwise: the two
 * green-dominant vertex clusters on the head (the eyes) sit at x = +0.091, forward of the head
 * centroid at x = +0.034, and the arms run along +/-Z rather than +/-X. So the figure faces +X
 * with the lateral axis on Z.
 *
 * That also settles chirality, which matters because every socket comes in a left/right pair.
 * With forward = +X and up = +Y, right = forward x up = +Z. The rig puts `R_Hand` at z = +0.33
 * and `L_Hand` at z = -0.35, and the measured eye clusters land at z = +0.021 and z = -0.023.
 * The rig's own L_/R_ prefixes therefore agree with the measured geometry — a mirrored pair, not
 * a rotated one.
 */
export const MONSTER_TREE_FRAME = {
  forward: [1, 0, 0] as [number, number, number],
  up: [0, 1, 0] as [number, number, number],
  right: [0, 0, 1] as [number, number, number],
  note: 'measured from the eye clusters and the arm axis; overrides the spec\'s "faces -z"',
};

export type { MonsterTreeRig, RigOptions, CostumePiece, SocketKind } from './rig';
