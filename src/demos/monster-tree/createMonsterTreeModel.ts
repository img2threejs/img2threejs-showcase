import * as THREE from 'three';
import { createBackdrop, createMonsterTreeLights } from './lighting';
import { COSTUME_PIECES, SOCKETS } from './measured';
import type { EncodedModel, EncodedRig } from './meshCodec';
import { buildMonsterTreeRig, type MonsterTreeRig, type RigOptions } from './rig';
import { SKILLS, SkillRunner } from './skills';
import { MonsterTreeVfx } from './vfx';

/**
 * Monster Tree — a rigged treant rebuilt from one photograph.
 *
 * Gallery entry point. Everything substantive lives in the modules beside this file; this one
 * adapts them to the showcase's contracts — `userData.tick(dt, elapsed)` for the frame loop and
 * `userData.sculptRuntime.animationController` for the Animations panel.
 *
 * The full write-up, including the three defects this build fixes in the playground export's own
 * rig path and the measurements behind every claim, is in `README.md` next to this file. The
 * numbers are reproducible: `node scripts/measure-monster-tree-rig.mjs`.
 *
 * One level of detail, deliberately. `skinIndex`/`skinWeight` address vertices by position in the
 * buffer, so decimating a skinned shell leaves the binding pointing at vertices that no longer
 * exist and the figure tears open the moment a clip runs.
 */

let loaded: { model: EncodedModel; stream: string; rig: EncodedRig } | null = null;
let loading: Promise<void> | null = null;

/**
 * Fetch and hold the surface and the rig.
 *
 * Both are dynamically imported so the bundler splits them into their own chunks: the surface is
 * 1.8 MB and the rig — skin binding for all 64,307 vertices plus 16 clips of unquantised
 * keyframes — is 9.4 MB. Static imports weld both into the entry chunk and nothing on the page
 * renders until all 11 MB has landed.
 */
export function prewarmMonsterTree(): Promise<void> {
  if (loaded) return Promise.resolve();
  // The in-flight promise is cached, not just the result. The showcase calls `prewarm` twice — once
  // to drive the loader and once to rebuild the panels — and `createMonsterTreeModel` awaits it a
  // third time to fill its group. Handing all three the same promise means the payload is fetched
  // once, and it also fixes the ORDER: this module's own continuation is registered first, during
  // `build()`, so the group is populated before the page's callbacks look for a runtime on it.
  loading ??= (async () => {
    const [surface, rig] = await Promise.all([import('./surfaceData.high'), import('./rigData')]);
    loaded = { model: surface.SURFACE_MODEL, stream: surface.SURFACE_STREAM, rig: rig.RIG };
  })();
  return loading;
}

export interface MonsterTreeAction {
  id: string;
  label: string;
  loop: boolean;
}

export interface MonsterTreeAnimationController {
  actions: ReadonlyArray<MonsterTreeAction>;
  readonly active: string;
  play(name: string): void;
  stop(): void;
  subscribe(listener: (active: string) => void): () => void;
}

/**
 * Build the figure.
 *
 * The returned group holds the bark shell, the four rigid costume pieces, the skeleton and the
 * effects, and drives all of them from a single `userData.tick`.
 */
export function createMonsterTreeModel(options: RigOptions = {}): THREE.Group {
  // Returns IMMEDIATELY, empty if the payload has not landed yet.
  //
  // The showcase calls `build()` synchronously, before it awaits `prewarm`, and keeps a reference to
  // whatever group comes back — that same object is what it later reads `userData.sculptRuntime` off
  // to mount the Animations panel. So the group has to exist now and fill itself in later; throwing
  // because the 11 MB of surface and rig has not arrived yet would take the page down at line one.
  const group = new THREE.Group();
  group.name = 'monster-tree';

  if (loaded) populate(group, options);
  else void prewarmMonsterTree().then(() => populate(group, options));

  return group;
}

function populate(group: THREE.Group, options: RigOptions): void {
  if (!loaded || group.userData.sculptRuntime) return;

  const rig: MonsterTreeRig = buildMonsterTreeRig(loaded.model, loaded.stream, loaded.rig, {
    castShadow: true,
    receiveShadow: true,
    ...options,
  });
  group.add(rig.group);

  // The effects read socket world positions, so the skeleton has to have been posed once before the
  // bounding box that sizes them is measured.
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(rig.group);

  const vfx = new MonsterTreeVfx(rig, bounds);
  rig.group.add(vfx.group);

  const runner = new SkillRunner(rig, vfx, 'idle');

  const listeners = new Set<(active: string) => void>();
  const announce = (): void => {
    for (const listener of listeners) listener(runner.current.id);
  };

  const animationController: MonsterTreeAnimationController = {
    actions: SKILLS.map((s) => ({ id: s.id, label: s.label, loop: s.loop })),
    get active() {
      return runner.current.id;
    },
    play: (name: string) => {
      if (runner.play(name)) announce();
    },
    stop: () => {
      if (runner.play('idle')) announce();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(runner.current.id);
      return () => listeners.delete(listener);
    },
  };

  let announced = runner.current.id;
  // The showcase passes (dt, elapsed) and a mixer integrates a delta, so dt is what gets used. Long
  // frames are clamped: a backgrounded tab otherwise resumes by jumping the mixer several seconds
  // forward, which skips every impact cue in between.
  group.userData.tick = (dt: number): void => {
    const step = Math.min(dt, 0.1);
    rig.update(step);
    runner.update(step);
    vfx.update(step);
    // A one-shot skill hands itself back to idle when its clip ends; the panel has to hear that.
    if (runner.current.id !== announced) {
      announced = runner.current.id;
      announce();
    }
  };

  group.userData.sculptRuntime = {
    animationController,
    /** Named, selectable pieces — the shell plus the four rigid costume meshes. */
    parts: [
      { id: 'bark-shell', label: 'bark shell', kind: 'skinned', triangles: (rig.shell.geometry.index?.count ?? 0) / 3 },
      ...COSTUME_PIECES.map((p) => ({ id: p.id, label: p.label, kind: 'rigid', triangles: p.triangles })),
    ],
    sockets: SOCKETS.map((s) => ({ id: s.id, bone: s.bone, kind: s.kind })),
    provenance: {
      route: 'glb-fast-lane + animated-character stage R',
      exactnessTier: 'measured-surface',
      levelsOfDetail: 1,
      inferred: [
        'hidden sides are generated, not observed — one photograph cannot confirm the back',
        'the costume split is a warmth-profile hypothesis; the export carries no material IDs',
        'skill names come from measured clip kinematics, not from a visual review of the pose',
      ],
    },
  };
}

/** The look-dev rig, built from colours measured off the reference photograph. */
export function createMonsterTreeLookDevLights(): THREE.Group {
  return createMonsterTreeLights(1.9);
}

/** A dark grove backdrop in the bark's own measured tone. Painted into a canvas, nothing fetched. */
export function makeMonsterTreeBackground(): THREE.Texture {
  return createBackdrop();
}

export { SKILLS as MONSTER_TREE_SKILLS } from './skills';
