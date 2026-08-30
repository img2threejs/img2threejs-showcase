import * as THREE from 'three';
import type { RiggedModel } from './meshCodec';
import { RIG } from './rigData';

/**
 * Clip playback for Roblin.
 *
 * The 16 clips are REAL — they ship embedded in rigData.ts with 41 tracks each — so this is a
 * mixer, not a procedural fallback. Three things the codec's own `play` does not do and a
 * showcase needs:
 *
 *   - a ONE-SHOT that returns to the clip it interrupted, so an attack does not become the new
 *     idle;
 *   - CUES fired off the mixer's own clock at a fraction of the clip, so a projectile leaves the
 *     hand on the frame the arm extends rather than on a wall-clock timer that drifts;
 *   - a cross-fade on every transition. Cutting straight between two looping clips pops on the
 *     first frame, because the two poses have no reason to agree there.
 *
 * `update` takes a DELTA, never elapsed time. An AnimationMixer integrates what it is given; hand
 * it elapsed seconds and it fast-forwards by the whole session on every frame.
 */

export interface ClipCue {
  /** 0..1 through the clip. */
  at: number;
  fire(): void;
}

export interface OnceOptions {
  fade?: number;
  /** Clip to cross-fade back to when this one finishes. Defaults to the clip that was playing. */
  returnTo?: string;
  timeScale?: number;
  cues?: ClipCue[];
}

export interface Animator {
  readonly clips: readonly THREE.AnimationClip[];
  readonly names: readonly string[];
  /** The looping clip the animator returns to. */
  readonly base: string;
  /** What is on screen right now, one-shot included. */
  readonly current: string;
  /** Cross-fade to a clip and loop it. `false` if there is no such clip. */
  play(clip: string | number, fade?: number): boolean;
  /** Play once, fire its cues, then cross-fade back. `false` if there is no such clip. */
  once(clip: string | number, options?: OnceOptions): boolean;
  /** True while a one-shot is running. */
  readonly busy: boolean;
  /** Advance the mixer. DELTA seconds. */
  update(delta: number): void;
}

function resolve(clips: readonly THREE.AnimationClip[], which: string | number): THREE.AnimationClip | null {
  if (typeof which === 'number') return clips[which] ?? null;
  return clips.find((c) => c.name === which) ?? null;
}

/**
 * Guard against the one edit that silently destroys a skinned model: decimation.
 *
 * `skinIndex` and `skinWeight` are per-vertex arrays indexed in lockstep with `position`. Collapse
 * the mesh and every weight past the new vertex count addresses a vertex that no longer exists, so
 * the figure tears itself open the moment a clip runs — and it looks fine in a static screenshot,
 * which is why this is a thrown error and not a warning. It is also why this model ships at ONE
 * level of detail: there is no cheap tier to fall back to without rebuilding the binding.
 */
export function assertBindingIntact(mesh: THREE.SkinnedMesh): void {
  const vertices = mesh.geometry.getAttribute('position').count;
  if (vertices !== RIG.vertexCount) {
    throw new Error(
      `skin binding broken: geometry has ${vertices} vertices but the rig was bound against `
      + `${RIG.vertexCount}. Something decimated or rebuilt the mesh after binding — skinIndex now `
      + 'points at vertices that do not exist. Rebuild the binding or drop the decimation.',
    );
  }
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) throw new Error('skin binding broken: the geometry has no skinIndex/skinWeight');
  if (skinIndex.count !== vertices || skinWeight.count !== vertices) {
    throw new Error(
      `skin binding broken: skinIndex ${skinIndex.count}, skinWeight ${skinWeight.count}, positions ${vertices}`,
    );
  }
  const bones = mesh.skeleton.bones.length;
  const idx = skinIndex.array as ArrayLike<number>;
  for (let i = 0; i < idx.length; i += 1) {
    if (idx[i] >= bones) {
      throw new Error(`skin binding broken: skinIndex[${i}] = ${idx[i]} but the skeleton has ${bones} bones`);
    }
  }
}

export function createAnimator(rigged: RiggedModel, baseClip: string): Animator {
  assertBindingIntact(rigged.mesh);

  const { mixer, clips } = rigged;
  const names = clips.map((c) => c.name);
  if (!names.includes(baseClip)) {
    throw new Error(`base clip "${baseClip}" is not in this rig. Clips: ${names.join(', ')}`);
  }

  // The codec's builder already started clip 0 so the figure is never in bind pose on screen.
  // Stop everything and take the reins explicitly rather than inheriting whatever it left running.
  mixer.stopAllAction();

  let baseName = baseClip;
  let currentName = baseClip;
  let loopAction: THREE.AnimationAction | null = null;
  let shotAction: THREE.AnimationAction | null = null;
  let shotCues: { at: number; fire(): void; fired: boolean }[] = [];
  let shotReturn = baseClip;

  const startLoop = (clip: THREE.AnimationClip, fade: number): THREE.AnimationAction => {
    const next = mixer.clipAction(clip);
    next.enabled = true;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.reset();
    const from = shotAction ?? loopAction;
    if (from && from !== next && fade > 0) next.crossFadeFrom(from, fade, true).play();
    else {
      from?.stop();
      next.play();
    }
    return next;
  };

  const finishShot = (): void => {
    if (!shotAction) return;
    const back = resolve(clips, shotReturn);
    if (back) {
      loopAction = startLoop(back, 0.28);
      currentName = back.name;
      baseName = back.name;
    }
    shotAction = null;
    shotCues = [];
  };

  mixer.addEventListener('finished', (event) => {
    if ((event as { action?: THREE.AnimationAction }).action === shotAction) finishShot();
  });

  const animator: Animator = {
    clips,
    names,
    get base() { return baseName; },
    get current() { return currentName; },
    get busy() { return shotAction !== null; },

    play(which, fade = 0.35) {
      const clip = resolve(clips, which);
      if (!clip) return false;
      if (shotAction) {
        // A deliberate clip change outranks a one-shot; drop it rather than let it snap back later.
        shotAction.stop();
        shotAction = null;
        shotCues = [];
      }
      loopAction = startLoop(clip, fade);
      currentName = clip.name;
      baseName = clip.name;
      return true;
    },

    once(which, options = {}) {
      const clip = resolve(clips, which);
      if (!clip) return false;
      const fade = options.fade ?? 0.18;
      const previous = shotAction ?? loopAction;

      const next = mixer.clipAction(clip);
      next.enabled = true;
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      next.setEffectiveTimeScale(options.timeScale ?? 1);
      next.setEffectiveWeight(1);
      next.reset();
      if (previous && previous !== next && fade > 0) next.crossFadeFrom(previous, fade, true).play();
      else next.play();

      shotAction = next;
      shotReturn = options.returnTo ?? baseName;
      shotCues = (options.cues ?? []).map((c) => ({ ...c, fired: false }));
      currentName = clip.name;
      return true;
    },

    update(delta) {
      mixer.update(delta);
      if (!shotAction) return;
      // Cues run off the action's own clock, so they stay in step if the clip is time-scaled or
      // the frame rate drops. A setTimeout would not.
      const t = shotAction.time / (shotAction.getClip().duration || 1);
      for (const cue of shotCues) {
        if (!cue.fired && t >= cue.at) {
          cue.fired = true;
          cue.fire();
        }
      }
      // clampWhenFinished holds the last frame; `finished` normally fires, but a cross-fade that
      // zeroes the weight can swallow it, so close the loop on the clock too.
      if (shotAction.time >= shotAction.getClip().duration - 1e-4) finishShot();
    },
  };

  animator.play(baseClip, 0);
  return animator;
}
