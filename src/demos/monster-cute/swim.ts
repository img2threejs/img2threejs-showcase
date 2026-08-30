/**
 * Run, leap, hit the water, swim — as one continuous move with no seam.
 *
 * HAND-WRITTEN choreography over the rig's own clips. Nothing here authors a pose; it decides WHEN
 * to hand over between clips that already exist, and the times are measured rather than chosen.
 *
 * THE PROBLEM, and why the obvious fix is the wrong one. Every clip on this rig is a one-shot that
 * ends far from where it began, so cutting between them at arbitrary times means cross-fading
 * across a large gap in joint space, and the figure lurches. The instinct is to lengthen the fade,
 * but a long fade over a big gap is just a slow lurch. The fix is to cut where the two clips
 * already agree, so `tools/stitch.ts` compares every pose in one clip against every pose in the
 * other and reports the closest pair. The numbers it found, as mean degrees per joint:
 *
 *   run  ->  run    leave 1.073 s, arrive 0.438 s    0.90 deg   (naive end->start: 3.35)
 *   run  ->  dive   leave 0.788 s, arrive 0.373 s    4.26 deg   (naive end->start: 7.11)
 *
 * A 0.9-degree handover is invisible. That is what makes the run cycle, and it is why the leap
 * leaves from inside the run's loop window rather than at the unconstrained best match at 0.285 s —
 * a run phase that is cycling [0.438, 1.073] never reaches 0.285.
 *
 * THE SWIM. There is no swim clip, and the submerged stretch of the dive has no usable loop in it
 * either: the best pair inside that window is 7.31 degrees apart, which reads as a hitch every
 * cycle. So the swim is not a clip. The dive is held at its most streamlined pose — which IS a
 * swimming shape — and a slow procedural stroke is layered on top of the arms and legs, plus a bob
 * and roll on the body. Being a continuous sine, it cannot break by construction, and it is gentle
 * because a heavy stroke on a floating character reads as thrashing.
 *
 * The root travel is left alone. The viewer's hold-in-place already pins the hip, which is what
 * keeps 2.5 figure-heights of dive inside the frame.
 */
import * as THREE from 'three';
import type { Animator } from './animation';
import { FIGURE_HEIGHT } from './characterProfile';
import { WATER_ENTRY_TIME } from './water';

const H = FIGURE_HEIGHT;

/** Every number here comes from `tools/stitch.ts`; see `evidence/stitches.json`. */
const RUN = 'preset:biped:run';
const DIVE = 'preset:dive';
const RUN_LOOP_IN = 0.438;
const RUN_LOOP_OUT = 1.073;
const RUN_LEAVE = 0.788;
const DIVE_ARRIVE = 0.373;
/** How long the swim pose settles at. Just past the entry, where the body is most streamlined. */
const SWIM_HOLD_TIME = 1.98;

export type SwimPhase = 'idle' | 'run' | 'leap' | 'swim';

export interface Swim {
  start(): void;
  stop(): void;
  update(dt: number): void;
  readonly phase: SwimPhase;
  readonly active: boolean;
}

export interface SwimHooks {
  /** Fired once, at the measured frame the body meets the surface. */
  onEnterWater(at: THREE.Vector3, force: number): void;
  onPhase(phase: SwimPhase): void;
}

export function createSwim(
  animator: Animator,
  mesh: THREE.SkinnedMesh,
  group: THREE.Group,
  hooks: SwimHooks,
): Swim {
  const bones = new Map(mesh.skeleton.bones.map((b) => [b.name, b]));
  const hip = bones.get('Hip');

  let phase: SwimPhase = 'idle';
  let clock = 0;
  let runCycles = 0;
  let splashed = false;
  let swimTime = 0;

  const baseGroupY = group.position.y;

  /** Bones the procedural stroke touches, and the rest pose it adds onto. */
  const strokeBones = ['L_Upperarm', 'R_Upperarm', 'L_Forearm', 'R_Forearm', 'L_Thigh', 'R_Thigh', 'L_Calf', 'R_Calf', 'Spine01', 'Spine02']
    .map((name) => bones.get(name))
    .filter((b): b is THREE.Bone => !!b);
  const held = new Map<THREE.Bone, THREE.Quaternion>();

  const axis = new THREE.Vector3();
  const spin = new THREE.Quaternion();

  function setPhase(next: SwimPhase): void {
    if (phase === next) return;
    phase = next;
    hooks.onPhase(next);
  }

  function start(): void {
    clock = 0;
    runCycles = 0;
    splashed = false;
    swimTime = 0;
    held.clear();
    group.position.y = baseGroupY;
    animator.setAutoRepeat(false);   // the sequence owns every handover from here
    animator.play(RUN, 0.25);
    animator.setTime(RUN, RUN_LOOP_IN);
    setPhase('run');
  }

  function stop(): void {
    held.clear();
    group.position.y = baseGroupY;
    animator.setAutoRepeat(true);
    setPhase('idle');
  }

  function update(dt: number): void {
    if (phase === 'idle') return;
    clock += dt;

    if (phase === 'run') {
      const t = animator.timeOf(RUN);
      // Two cycles of running before the leap: one is over before it reads as running.
      if (runCycles >= 2 && t >= RUN_LEAVE) {
        animator.play(DIVE, 0.16);
        animator.setTime(DIVE, DIVE_ARRIVE);
        setPhase('leap');
      } else if (t >= RUN_LOOP_OUT) {
        // The 0.9-degree loop. Short enough that a fade would be more visible than the seam.
        animator.setTime(RUN, RUN_LOOP_IN + (t - RUN_LOOP_OUT));
        runCycles += 1;
      }
      return;
    }

    if (phase === 'leap') {
      const t = animator.timeOf(DIVE);
      if (!splashed && t >= WATER_ENTRY_TIME) {
        splashed = true;
        const at = hip ? hip.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
        hooks.onEnterWater(at, 1);
      }
      if (t >= SWIM_HOLD_TIME) {
        // Freeze the clip here rather than cross-fading anywhere. There is nothing to fade TO — the
        // swim is this pose plus a procedural stroke — so holding it is the seamless option.
        animator.pauseAt(DIVE, SWIM_HOLD_TIME);
        for (const bone of strokeBones) held.set(bone, bone.quaternion.clone());
        setPhase('swim');
      }
      return;
    }

    // ---- swim ----
    swimTime += dt;
    // Slow. A fast stroke on a floating body reads as thrashing, and the brief was to swim lightly.
    const phaseAngle = swimTime * 1.5;

    for (const bone of strokeBones) {
      const base = held.get(bone);
      if (!base) continue;
      const name = bone.name;
      const side = name.startsWith('R_') ? 1 : -1;
      // Arms and legs alternate; the spine carries a slower, smaller counter-roll.
      let amplitude = 0;
      let offset = 0;
      if (name.includes('Upperarm')) { amplitude = 0.30; offset = 0; }
      else if (name.includes('Forearm')) { amplitude = 0.20; offset = 0.6; }
      else if (name.includes('Thigh')) { amplitude = 0.16; offset = Math.PI; }
      else if (name.includes('Calf')) { amplitude = 0.12; offset = Math.PI + 0.5; }
      else { amplitude = 0.05; offset = 0.9; }   // spine

      const swing = Math.sin(phaseAngle + offset + (side > 0 ? Math.PI : 0)) * amplitude;
      // Rotated about the bone's own local X, which is the axis these limbs already bend on.
      axis.set(1, 0, 0);
      spin.setFromAxisAngle(axis, swing);
      bone.quaternion.copy(base).multiply(spin);
    }

    // Body bob and roll. Presentation only — the group, never the bones.
    group.position.y = baseGroupY + Math.sin(phaseAngle * 0.75) * 0.018 * H;
    group.rotation.z = Math.sin(phaseAngle * 0.5) * 0.035;
  }

  return {
    start,
    stop,
    update,
    get phase() { return phase; },
    get active() { return phase !== 'idle'; },
  };
}
