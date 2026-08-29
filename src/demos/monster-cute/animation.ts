/**
 * The Stage R5 runtime controller.
 *
 * The factory's own `rigged.play` cross-fades correctly, which is the part that matters most — a
 * hard cut between two looping clips pops on the first frame because the new clip's pose is
 * nowhere near the pose the old one ended on. Two things it does not do, both of which this adds:
 *
 * 1. **Loop mode from the measurement.** It sets `LoopRepeat, Infinity` on everything. Only four
 *    of this rig's 33 clips actually return to their own first pose (`preset:biped:agree`, `cry`,
 *    `frustrated_01`, `frustrated_02`); the other 29 end somewhere else, and repeating them snaps
 *    the figure back to the start every cycle. The loop flag comes from the pose-return rule —
 *    `poseReturn <= 0.5 deg` and `hipReturn <= 0.01H` — measured per clip in `gate_r1.ts`, not
 *    from the clip's name and not from whether its root happened to stay put.
 *
 * 2. **Bind-pose restore before each play.** A clip that ends mid-pose leaves joints displaced,
 *    and the next clip's tracks only overwrite the joints they address — so whatever the last clip
 *    left behind on the others bleeds through. Restoring first is what keeps clips independent.
 *
 * `update` takes a DELTA. This is the single easiest thing to get wrong here: `AnimationMixer`
 * advances by the amount you hand it, so passing `clock.getElapsedTime()` makes the first frame
 * jump to wherever the clip is at that moment and every frame after it race away at elapsed-time
 * speed. The signature is named `deltaSeconds` for that reason.
 */
import * as THREE from 'three';
import type { RiggedModel } from './meshCodec';
import { CLIP_PROFILES } from './characterProfile';

export interface Animator {
  /** Cross-fade to a clip by name or index. Returns the clip's name, or null if there is no such clip. */
  play(clip: string | number, fadeSeconds?: number): string | null;
  /** Park a clip at one time without running it — what the gates use. */
  seek(clip: string | number, time: number): boolean;
  stop(): void;
  /** Advance the mixer. DELTA seconds, not elapsed. */
  update(deltaSeconds: number): void;
  readonly current: string | null;
  readonly names: string[];
  /** Measured, not guessed: does this clip's last pose return to its first? */
  loops(clip: string): boolean;
  durationOf(clip: string): number;
  /** Keep a non-looping clip going by cross-fading it back to its own start. On by default. */
  setAutoRepeat(on: boolean): void;
}

export function createAnimator(rigged: RiggedModel): Animator {
  const { mixer, mesh, group, clips } = rigged;

  /**
   * The bind pose, read back out of the skeleton rather than out of the encoded payload.
   *
   * `boneInverses[i]` is the inverse of bone i's world matrix at bind time, so inverting it gives
   * the bind world matrix, and composing that with the parent's inverse gives the local TRS the
   * payload would have listed. Deriving it here keeps this module off `rigData` entirely — that
   * import is 15 MB, and a static reference to it drags the whole payload into whatever bundle
   * touches the animator.
   */
  const restPose = (() => {
    const bones = mesh.skeleton.bones;
    const indexOf = new Map<THREE.Object3D, number>(bones.map((bone, i) => [bone as THREE.Object3D, i]));
    const bindWorld = mesh.skeleton.boneInverses.map((m) => m.clone().invert());
    return bones.map((bone, i) => {
      const parentIndex = bone.parent ? indexOf.get(bone.parent) : undefined;
      const local = parentIndex === undefined
        ? bindWorld[i].clone()
        : new THREE.Matrix4().copy(bindWorld[parentIndex]).invert().multiply(bindWorld[i]);
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      local.decompose(position, quaternion, scale);
      return { position, quaternion, scale };
    });
  })();

  function restoreBindPose(): void {
    mesh.skeleton.bones.forEach((bone, i) => {
      const rest = restPose[i];
      if (!rest) return;
      bone.position.copy(rest.position);
      bone.quaternion.copy(rest.quaternion);
      bone.scale.copy(rest.scale);
    });
    group.updateMatrixWorld(true);
  }

  const resolve = (which: string | number): THREE.AnimationClip | null =>
    (typeof which === 'number' ? clips[which] : clips.find((c) => c.name === which)) ?? null;

  const loops = (name: string): boolean => CLIP_PROFILES[name]?.loop ?? false;

  let current: THREE.AnimationAction | null = null;
  let currentName: string | null = null;
  let autoRepeat = true;

  /**
   * Two actions per clip, so a clip can cross-fade into itself.
   *
   * 29 of this rig's 33 clips do not return to their first pose, so by the measured loop rule they
   * are one-shots — and a viewer that honours that strictly shows a monster that moves for two
   * seconds and then stands frozen, which is most of the clip library dead on arrival. Repeating
   * them with `LoopRepeat` instead is worse: the snap from the last pose back to the first is
   * exactly the discontinuity the measurement found, and it fires every cycle.
   *
   * So the clip is restarted through a cross-fade. `mixer.clipAction` is keyed by the clip object,
   * so an action cannot blend with itself; a cloned clip gives a second action over the same
   * tracks and the two hand off to each other. This does not make the clip loop. It hides a real
   * seam, which is why `loops()` keeps reporting what was measured rather than what the viewer
   * does with it.
   */
  const variants = new Map<string, THREE.AnimationClip[]>();
  function variantsOf(clip: THREE.AnimationClip): THREE.AnimationClip[] {
    let pair = variants.get(clip.name);
    if (!pair) { pair = [clip, clip.clone()]; variants.set(clip.name, pair); }
    return pair;
  }

  mixer.addEventListener('finished', (event) => {
    const finished = (event as unknown as { action: THREE.AnimationAction }).action;
    if (!autoRepeat || finished !== current || !currentName) return;
    const pair = variants.get(currentName);
    if (!pair) return;
    const next = configure(pair[0] === finished.getClip() ? pair[1] : pair[0]);
    next.reset();
    next.play();
    next.crossFadeFrom(finished, 0.3, false);
    current = next;
  });

  function configure(clip: THREE.AnimationClip): THREE.AnimationAction {
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    if (loops(clip.name)) {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    } else {
      // Holds its last frame instead of snapping home. A one-shot that resets is worse than one
      // that stops, because the reset is a second, unintended motion.
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    return action;
  }

  function play(which: string | number, fadeSeconds = 0.28): string | null {
    const clip = resolve(which);
    if (!clip) return null;

    const next = configure(variantsOf(clip)[0]);
    if (current && current !== next && fadeSeconds > 0) {
      next.reset();
      next.play();
      // `warp: false` — the two clips keep their own timing through the blend. Warping them to a
      // common rate makes a 0.7 s clip and a 23 s clip visibly stretch into each other.
      next.crossFadeFrom(current, fadeSeconds, false);
    } else {
      current?.stop();
      restoreBindPose();
      next.reset();
      next.play();
    }
    current = next;
    currentName = clip.name;
    return clip.name;
  }

  function seek(which: string | number, time: number): boolean {
    const clip = resolve(which);
    if (!clip) return false;
    mixer.stopAllAction();
    restoreBindPose();
    const action = configure(clip);
    action.reset();
    action.play();
    action.paused = true;
    action.time = THREE.MathUtils.clamp(time, 0, clip.duration);
    mixer.update(0);
    group.updateMatrixWorld(true);
    current = action;
    currentName = clip.name;
    return true;
  }

  function stop(): void {
    mixer.stopAllAction();
    restoreBindPose();
    current = null;
    currentName = null;
  }

  // The factory auto-plays clip 0 on build. Clear that so the first `play` is a clean start
  // rather than a cross-fade from something the caller never asked for.
  stop();

  return {
    play,
    seek,
    stop,
    update: (deltaSeconds: number) => {
      mixer.update(deltaSeconds);
      group.updateMatrixWorld(true);
    },
    get current() { return currentName; },
    get names() { return clips.map((c) => c.name); },
    loops,
    durationOf: (name: string) => resolve(name)?.duration ?? 0,
    setAutoRepeat: (on: boolean) => { autoRepeat = on; },
  };
}
