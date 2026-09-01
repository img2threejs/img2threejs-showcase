import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';

/**
 * Authored gestures for Y'bneth's kit.
 *
 * WHY THESE EXIST. The rig ships sixteen clips from Tripo's generic biped library — boxing rounds,
 * front kicks, six dances. They are real motion and they are measured honestly elsewhere in this
 * demo, but none of them is the motion of a treant throwing a vine, calling wood down, or rooting
 * itself into the ground. Borrowing `box_01` for Dây Leo gives a boxer's jab with a vine drawn on
 * it, and no amount of effect work fixes a body doing the wrong thing.
 *
 * So the kit's four moves are POSED here rather than borrowed. Each is a timeline of aim
 * directions, one per bone, blended with smoothstep and solved onto the skeleton by
 * `rig.aim` / `rig.applyPose`. Underneath, the body still plays a trimmed copy of
 * `standing_relax` — the quietest clip in the library — so the torso keeps breathing and the
 * weight keeps shifting without any of that having to be hand-authored.
 *
 * THE FRAME, measured not assumed (see `model.ts`): the figure faces **+X**, up is **+Y**, and its
 * own left is **-Z**. At rest its arms run straight out along ±Z, so pointing one forward is a
 * ninety-degree swing at the shoulder.
 *
 * THE BEATS ARE AUTHORED. Everything else in this showcase schedules against `events.ts`, a sweep
 * of the shipped clips at 240 Hz. That table describes clips nobody here wrote. For these four the
 * relationship is inverted: the gesture is designed around when the hand should stop, and the
 * skill's cues use the same numbers. `BEATS` below is that contract, in one place, so the pose and
 * the effect cannot drift apart.
 */

/** A pose: bone name to the direction its segment should point, in the figure's own frame. */
export type Pose = Record<string, [number, number, number]>;

interface Key {
  /** Seconds into the move. */
  at: number;
  pose: Pose;
}

/** Smoothstep: no corner entering or leaving a key, which is most of what reads as "animated". */
function ease(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

const SCRATCH = new THREE.Vector3();
const SLERP_A = new THREE.Vector3();
const SLERP_B = new THREE.Vector3();
const SLERP_AXIS = new THREE.Vector3();
const SLERP_Q = new THREE.Quaternion();

/**
 * Interpolate two aim directions along the sphere, at a constant angular rate.
 *
 * A plain lerp of two unit vectors does NOT turn at a constant rate — it crawls near the ends and
 * whips through the middle, and the closer the two directions are to opposite, the worse it gets.
 * That is not a cosmetic difference here. The ultimate folds a forearm from pointing left to
 * pointing right in a fifth of a second, a reversal of nearly 180 degrees, and a lerp through it
 * measured a hand speed of **60.7 figure heights per second** — twelve times the fastest hand in
 * any shipped clip — in a two-frame spike that read as the arm teleporting. Slerped, the same
 * gesture turns evenly and peaks under 2.
 *
 * At exactly opposite there is no shortest arc, so any perpendicular axis will do; picking one
 * deterministically is better than the NaN that dividing by sin(pi) produces.
 */
function slerpDir(a: readonly [number, number, number], b: readonly [number, number, number], t: number, out: THREE.Vector3): void {
  SLERP_A.set(a[0], a[1], a[2]);
  SLERP_B.set(b[0], b[1], b[2]);
  if (SLERP_A.lengthSq() < 1e-10 || SLERP_B.lengthSq() < 1e-10) { out.copy(SLERP_B); return; }
  SLERP_A.normalize();
  SLERP_B.normalize();
  const dot = Math.max(-1, Math.min(1, SLERP_A.dot(SLERP_B)));
  if (dot > 0.9995) { out.lerpVectors(SLERP_A, SLERP_B, t).normalize(); return; }
  if (dot < -0.9995) {
    SLERP_AXIS.set(0, 1, 0).cross(SLERP_A);
    if (SLERP_AXIS.lengthSq() < 1e-8) SLERP_AXIS.set(1, 0, 0).cross(SLERP_A);
    SLERP_Q.setFromAxisAngle(SLERP_AXIS.normalize(), Math.PI * t);
    out.copy(SLERP_A).applyQuaternion(SLERP_Q);
    return;
  }
  const theta = Math.acos(dot);
  const sin = Math.sin(theta);
  out.copy(SLERP_A).multiplyScalar(Math.sin((1 - t) * theta) / sin)
    .addScaledVector(SLERP_B, Math.sin(t * theta) / sin)
    .normalize();
}

/**
 * Drive a timeline onto the skeleton for one frame.
 *
 * Directions are interpolated and re-normalised rather than slerped as quaternions. For an aim
 * that is the same thing and it is far simpler: two unit vectors lerped and normalised sweep the
 * short way round the arc between them, which is exactly the path a limb takes.
 *
 * A bone named in ANY key is aimed for the whole move, holding its nearest keyed value outside the
 * span it is keyed over. Otherwise a bone would snap back to the underlying clip the moment it
 * dropped out of a key, and an arm that has finished its throw would twitch back to a resting
 * animation while the vine is still attached to it.
 */
export function drivePose(rig: MonsterTreeRig, keys: Key[], time: number, weight = 1): void {
  if (!keys.length) return;
  for (const bone of BONES) {
    const from = nearest(keys, bone, time, -1);
    const to = nearest(keys, bone, time, 1);
    if (!from && !to) continue;
    const start = from ?? to!;
    const end = to ?? from!;
    // Blend across whichever pair of keys actually names this bone, not across the global pair —
    // an arm keyed at 0.3 and 0.5 must not be dragged by a spine keyed at 0.1 and 0.9.
    const localSpan = end.at - start.at;
    const k = localSpan > 1e-6 ? ease((time - start.at) / localSpan) : 1;
    slerpDir(start.pose[bone], end.pose[bone], k, SCRATCH);
    if (SCRATCH.lengthSq() < 1e-8) continue;
    rig.aim(bone, SCRATCH, weight);
  }
}

/** The last key at or before `time` that names this bone (dir -1), or the first after it (dir 1). */
function nearest(keys: Key[], bone: string, time: number, dir: -1 | 1): Key | null {
  let best: Key | null = null;
  for (const key of keys) {
    if (!key.pose[bone]) continue;
    if (dir < 0 ? key.at <= time : key.at >= time) {
      if (!best || (dir < 0 ? key.at > best.at : key.at < best.at)) best = key;
    }
  }
  if (best) return best;
  // Outside the keyed span: hold the closest end rather than dropping the bone back to the clip.
  for (const key of keys) {
    if (!key.pose[bone]) continue;
    if (!best || (dir < 0 ? key.at < best.at : key.at > best.at)) best = key;
  }
  return best;
}

/** Every bone any pose in this file aims. Iterated per frame, so it is a list and not a scan. */
const BONES = [
  'Waist', 'Spine01', 'Spine02',
  'L_Clavicle', 'L_Upperarm', 'L_Forearm',
  'R_Clavicle', 'R_Upperarm', 'R_Forearm',
  'L_Thigh', 'L_Calf', 'R_Thigh', 'R_Calf',
];

/** Clear every aim this file can set, so a move handing over cannot leave a limb behind. */
export function clearPose(rig: MonsterTreeRig): void {
  for (const bone of BONES) rig.aim(bone, null);
}

const UP_SPINE: [number, number, number] = [-0.02, 1, -0.05];

/**
 * When each move's hand stops.
 *
 * This is the contract between the gesture and the effect. Everywhere else in this demo the beats
 * come out of a measurement of a clip nobody wrote; here the clip IS written, so the beat is a
 * decision — and it has to be made once, in one place, or the pose and the cue drift apart and the
 * vine leaves a hand that is still winding up.
 */
export const BEATS = {
  vine: { release: 0.34, recover: 0.95, duration: 1.55 },
  // Nature's Call no longer beats time with its arms. They go up, they STAY up, and the wood comes
  // down while they are held there — so these are the moments the summons land, not the moments an
  // arm moves. `raised` is when the hold is reached and the coils are at full strength.
  logs: { raised: 0.42, calls: [0.62, 0.95, 1.28], finish: 1.70, duration: 2.60 },
  ultimate: { rooted: 0.55, open: 0.80, rainEnds: 2.55, duration: 3.20 },
} as const;

/**
 * Nội tại — Thân Thể Đại Thụ.
 *
 * Not an attack and not a stance from the clip library: arms low and open, palms turned down over
 * the undergrowth he is drawing out of. The whole pose is one slow cycle, because the passive is a
 * state rather than an event and anything with an attack in it would read as a move about to
 * happen.
 */
export function passivePose(time: number): Key[] {
  // The pose carries ALL of the stance's life, so the breath has to be authored rather than left
  // to leak through from the clip underneath. Blending at less than full weight looked like the
  // way to get that leak and it is not: the mixer skips writing a track whose value never changes,
  // so a partial slerp reads its own previous output, converges to the aim within two frames, and
  // then jumps whenever the clip does change — which measured as a 1.08 H/s twitch on a stance
  // that should be the stillest thing in the demo.
  // THREE rates, none a multiple of another, and the two sides out of phase.
  //
  // One sine on both arms is a metronome: the pair rise and fall together, return to exactly the
  // same place every cycle, and the eye reads a loop. Incommensurable rates never repeat, and
  // offsetting the sides means the figure is never symmetrical, which is most of what separates
  // something breathing from something oscillating.
  //
  // The amplitudes are set against a measurement. Aiming the arms at full weight replaces the
  // clip's own hand motion, and the first version of this stance swept 0.01 H/s where
  // standing_relax itself manages 0.103 — ten times stiller than the quietest thing in the
  // library, which is a statue. The life has to be authored here because nothing else supplies it.
  const slow = Math.sin(time * 0.62);
  const mid = Math.sin(time * 1.13 + 0.7);
  const fast = Math.sin(time * 1.91 + 2.1);
  const openL = 0.16 + slow * 0.20 + fast * 0.07;
  const openR = 0.16 + Math.sin(time * 0.62 + 1.9) * 0.20 + mid * 0.07;
  const lift = slow * 0.05;
  return [{
    at: 0,
    pose: {
      // A slow sway through the trunk, so the whole figure shifts its weight rather than only
      // waving its arms about on a body that is nailed down.
      Waist: [0.02 + mid * 0.035, 1, -0.05 + slow * 0.045],
      Spine01: [0.01 + mid * 0.045, 1, -0.05 + slow * 0.055],
      Spine02: [-0.03 + fast * 0.035, 1, -0.05 + slow * 0.06],
      // Shoulders settle and lift with the breath.
      L_Clavicle: [-0.05, 0.05 + slow * 0.13, -0.99],
      R_Clavicle: [0.02, 0.05 + Math.sin(time * 0.62 + 1.9) * 0.13, 0.99],
      // Arms down and slightly forward, elbows soft, opening a little on each intake.
      L_Upperarm: [0.30 + lift, -0.72 - openL * 0.45, -0.62 + openL],
      L_Forearm: [0.42 + fast * 0.09, -0.87 + openL * 0.34, -0.26 - openL * 0.20],
      R_Upperarm: [0.30 - lift, -0.72 - openR * 0.45, 0.62 - openR],
      R_Forearm: [0.42 + mid * 0.09, -0.87 + openR * 0.34, 0.26 + openR * 0.20],
    },
  }];
}

/**
 * Chiêu 1 — Dây Leo. Wind the arm back across the body, then throw it straight forward.
 *
 * The vine leaves at `BEATS.vine.release`, which is the frame the hand STOPS — the same principle
 * the measured moves use, with the difference that here the stop was placed rather than found. The
 * hold after it is what makes the vine read as attached: the arm stays out, trembling slightly,
 * for as long as there is something on the end of it.
 */
export function vinePose(): Key[] {
  return [
    {
      at: 0,
      pose: {
        Waist: UP_SPINE, Spine01: UP_SPINE, Spine02: [-0.05, 1, -0.08],
        L_Clavicle: [-0.05, 0.04, -0.99], R_Clavicle: [0.02, 0.04, 0.99],
        L_Upperarm: [0.24, -0.62, -0.75], L_Forearm: [0.40, -0.80, -0.44],
        R_Upperarm: [0.28, -0.70, 0.66], R_Forearm: [0.40, -0.86, 0.30],
      },
    },
    {
      // Windup: the throwing arm is pulled back and across, the torso winds with it. A throw with
      // no coil in front of it is a hand appearing in a new place.
      at: 0.20,
      pose: {
        Waist: [-0.10, 0.99, -0.06], Spine01: [-0.14, 0.98, -0.08], Spine02: [-0.20, 0.96, -0.14],
        L_Clavicle: [-0.30, 0.10, -0.95],
        L_Upperarm: [-0.42, -0.20, -0.88],
        L_Forearm: [-0.80, 0.34, -0.49],
        R_Upperarm: [0.34, -0.66, 0.67], R_Forearm: [0.46, -0.84, 0.28],
      },
    },
    {
      // Release. Arm straight out along +X, which is the direction the figure was measured to
      // face, so the vine and the body agree about where the enemy is.
      at: BEATS.vine.release,
      pose: {
        Waist: [0.10, 0.99, -0.04], Spine01: [0.14, 0.98, -0.05], Spine02: [0.20, 0.96, -0.06],
        L_Clavicle: [0.22, 0.02, -0.97],
        L_Upperarm: [0.88, -0.06, -0.47],
        L_Forearm: [0.99, 0.06, -0.12],
        R_Upperarm: [0.10, -0.72, 0.68], R_Forearm: [0.22, -0.90, 0.37],
      },
    },
    {
      // FOLLOW THROUGH. The arm does not stop where the vine left it — it carries past, opens out
      // and drops, which is what a thrown limb does. Holding the release pose until the recovery
      // is what made the arm read as a rigid pointer: a throw that ends the instant the projectile
      // leaves has no weight in it at all.
      at: BEATS.vine.release + 0.16,
      pose: {
        Waist: [0.16, 0.98, -0.03], Spine01: [0.22, 0.97, -0.03], Spine02: [0.30, 0.94, -0.03],
        L_Clavicle: [0.34, -0.06, -0.94],
        L_Upperarm: [0.93, -0.22, -0.29],
        L_Forearm: [0.90, -0.34, 0.27],
        R_Upperarm: [0.06, -0.76, 0.65], R_Forearm: [0.18, -0.92, 0.35],
      },
    },
    {
      // Held on the line, the shoulder pulled by the load at the far end.
      at: BEATS.vine.recover,
      pose: {
        Waist: [0.10, 0.99, -0.04], Spine01: [0.15, 0.98, -0.05], Spine02: [0.21, 0.97, -0.06],
        L_Clavicle: [0.28, -0.02, -0.96],
        L_Upperarm: [0.88, -0.18, -0.44],
        L_Forearm: [0.96, -0.14, -0.24],
        R_Upperarm: [0.12, -0.74, 0.66], R_Forearm: [0.24, -0.90, 0.35],
      },
    },
    { at: BEATS.vine.duration, pose: passivePose(0)[0].pose },
  ];
}

/**
 * Chiêu 2 — Thiên Nhiên Vẫy Gọi. Both arms called up, then driven down and forward, three times,
 * then once more with everything behind it.
 *
 * "Đập liên tục" is a RHYTHM, and a rhythm needs a recovery between the beats or it is one long
 * push. Each slam is followed by a partial lift — not all the way back up, so the barrage keeps
 * moving forward — and the last lift goes higher than any of them because the fourth slam is the
 * one that lands with the stun.
 */
export function logsPose(): Key[] {
  // Both arms up and open, palms turned outward, and then nothing: the summons happen while he
  // holds, not because he moves. This replaced a three-beat slam, and the reason is worth keeping —
  // an arm that pumps up and down every third of a second reads as a character *hitting* something
  // repeatedly, when what the skill actually does is call wood down from somewhere else. Holding
  // makes him the source rather than the hammer, and it leaves the arms still enough for the light
  // coiling around them to be seen at all.
  const held: Pose = {
    L_Clavicle: [0.02, 0.62, -0.78],
    R_Clavicle: [0.06, 0.62, 0.78],
    L_Upperarm: [0.16, 0.90, -0.41],
    L_Forearm: [0.20, 0.95, -0.24],
    R_Upperarm: [0.16, 0.90, 0.41],
    R_Forearm: [0.20, 0.95, 0.24],
    Waist: [-0.05, 0.998, -0.03],
    Spine01: [-0.08, 0.996, -0.03],
    Spine02: [-0.12, 0.99, -0.03],
  };
  // A slow, shallow drift on the hold. Perfectly still is a mannequin; this is small enough that
  // nobody reads it as a gesture and large enough that the figure is plainly alive.
  const drift = (k: number): Pose => ({
    ...held,
    L_Upperarm: [0.16, 0.90, -0.41 - k * 0.05],
    L_Forearm: [0.20 + k * 0.04, 0.95, -0.24 - k * 0.05],
    R_Upperarm: [0.16, 0.90, 0.41 + k * 0.05],
    R_Forearm: [0.20 + k * 0.04, 0.95, 0.24 + k * 0.05],
    Spine02: [-0.12 - k * 0.03, 0.99, -0.03],
  });

  return [
    { at: 0, pose: passivePose(0)[0].pose },
    { at: BEATS.logs.raised, pose: held },
    { at: BEATS.logs.raised + 0.55, pose: drift(1) },
    { at: BEATS.logs.finish - 0.10, pose: drift(-1) },
    // One commitment at the end: the arms press further up and out as the last of it comes down.
    {
      at: BEATS.logs.finish,
      pose: {
        ...held,
        L_Clavicle: [0.02, 0.74, -0.67], R_Clavicle: [0.06, 0.74, 0.67],
        L_Upperarm: [0.20, 0.96, -0.20], L_Forearm: [0.22, 0.97, -0.10],
        R_Upperarm: [0.20, 0.96, 0.20], R_Forearm: [0.22, 0.97, 0.10],
        Spine02: [-0.18, 0.98, -0.03],
      },
    },
    { at: BEATS.logs.finish + 0.45, pose: drift(0) },
    { at: BEATS.logs.duration, pose: passivePose(0)[0].pose },
  ];
}

/**
 * Ultimate — Seeds of Destiny. Root, open the canopy, and hold it open while the sky comes down.
 *
 * The move changed from throwing to RAINING, and the gesture had to change with it. Three
 * alternating throws said "he is putting each of these somewhere"; a barrage that covers the whole
 * field is not aimed at anything, so he opens and stays open. The legs straighten and widen and
 * never move again, the trunk goes up, and the arms sweep out and up into a canopy that holds for
 * the whole downpour — the shape of a tree letting go of its seeds all at once.
 */
export function ultimatePose(): Key[] {
  const rooted: Pose = {
    // Straight, wide and planted: the stance of something that is not going to be moved.
    L_Thigh: [-0.06, -0.97, -0.24], L_Calf: [-0.02, -0.999, -0.04],
    R_Thigh: [-0.06, -0.97, 0.24], R_Calf: [-0.02, -0.999, 0.04],
    Waist: [0, 1, 0], Spine01: [0, 1, 0], Spine02: [0, 1, 0],
  };
  // The canopy: arms high and thrown wide, forearms turned further out than the upper arms so the
  // silhouette forks the way a crown does instead of making a V.
  const canopy = (spread: number): Pose => ({
    ...rooted,
    L_Clavicle: [0.02, 0.55 + spread * 0.12, -0.83],
    R_Clavicle: [0.02, 0.55 + spread * 0.12, 0.83],
    L_Upperarm: [0.02, 0.72 + spread * 0.10, -0.69 + spread * 0.06],
    L_Forearm: [0.06, 0.62 + spread * 0.06, -0.78 - spread * 0.04],
    R_Upperarm: [0.02, 0.72 + spread * 0.10, 0.69 - spread * 0.06],
    R_Forearm: [0.06, 0.62 + spread * 0.06, 0.78 + spread * 0.04],
  });

  return [
    { at: 0, pose: passivePose(0)[0].pose },
    {
      // Sinking to root: knees bend, arms drop and gather in. Everything goes DOWN before it goes
      // up, or the canopy opens out of nothing.
      at: 0.24,
      pose: {
        L_Thigh: [-0.14, -0.96, -0.24], L_Calf: [0.18, -0.98, -0.05],
        R_Thigh: [-0.14, -0.96, 0.24], R_Calf: [0.18, -0.98, 0.05],
        Waist: [-0.10, 0.99, 0], Spine01: [-0.14, 0.99, 0], Spine02: [-0.18, 0.98, 0],
        L_Clavicle: [-0.05, -0.14, -0.99], R_Clavicle: [0.02, -0.14, 0.99],
        L_Upperarm: [0.22, -0.86, -0.46], L_Forearm: [-0.20, -0.66, 0.72],
        R_Upperarm: [0.22, -0.86, 0.46], R_Forearm: [-0.20, -0.66, -0.72],
      },
    },
    { at: BEATS.ultimate.rooted, pose: canopy(0) },
    // Thrown fully open on the frame the rain starts.
    { at: BEATS.ultimate.open, pose: canopy(1) },
    // A long, almost imperceptible widening through the downpour: the canopy is under load.
    { at: (BEATS.ultimate.open + BEATS.ultimate.rainEnds) / 2, pose: canopy(1.35) },
    { at: BEATS.ultimate.rainEnds, pose: canopy(1.1) },
    { at: BEATS.ultimate.duration, pose: { ...rooted, ...passivePose(0)[0].pose } },
  ];
}
