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
  vine: { release: 0.34, recover: 0.78, duration: 1.30 },
  logs: { slams: [0.42, 0.70, 0.98], finish: 1.52, duration: 2.30 },
  ultimate: { rooted: 0.62, throws: [0.86, 1.20, 1.54], gather: 1.90, stun: 2.34, duration: 3.00 },
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
      // Held taut. Almost the same pose, a hair further out: a vine under load pulls the shoulder.
      at: BEATS.vine.recover,
      pose: {
        Waist: [0.08, 0.99, -0.04], Spine01: [0.12, 0.99, -0.05], Spine02: [0.17, 0.98, -0.06],
        L_Clavicle: [0.26, 0.00, -0.96],
        L_Upperarm: [0.91, -0.10, -0.40],
        L_Forearm: [0.99, 0.02, -0.10],
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
  const raise = (h: number): Pose => ({
    L_Clavicle: [-0.02, 0.30 + h * 0.35, -0.95],
    R_Clavicle: [0.02, 0.30 + h * 0.35, 0.94],
    L_Upperarm: [-0.10 + h * 0.18, 0.55 + h * 0.40, -0.82 + h * 0.20],
    L_Forearm: [0.16 + h * 0.20, 0.72 + h * 0.30, -0.66 + h * 0.24],
    R_Upperarm: [-0.10 + h * 0.18, 0.55 + h * 0.40, 0.82 - h * 0.20],
    R_Forearm: [0.16 + h * 0.20, 0.72 + h * 0.30, 0.66 - h * 0.24],
    Waist: [-0.06 - h * 0.05, 0.99, -0.05],
    Spine01: [-0.10 - h * 0.06, 0.99, -0.05],
    Spine02: [-0.16 - h * 0.08, 0.98, -0.05],
  });
  const slam = (power: number): Pose => ({
    L_Clavicle: [0.12, -0.10, -0.98],
    R_Clavicle: [0.12, -0.10, 0.98],
    L_Upperarm: [0.72 + power * 0.12, -0.55 - power * 0.10, -0.42],
    L_Forearm: [0.86 + power * 0.08, -0.48 - power * 0.08, -0.18],
    R_Upperarm: [0.72 + power * 0.12, -0.55 - power * 0.10, 0.42],
    R_Forearm: [0.86 + power * 0.08, -0.48 - power * 0.08, 0.18],
    Waist: [0.12 + power * 0.06, 0.98, -0.04],
    Spine01: [0.18 + power * 0.08, 0.97, -0.04],
    Spine02: [0.26 + power * 0.10, 0.95, -0.04],
  });

  const keys: Key[] = [{ at: 0, pose: passivePose(0)[0].pose }];
  keys.push({ at: 0.22, pose: raise(0.35) });
  BEATS.logs.slams.forEach((at, i) => {
    keys.push({ at, pose: slam(i * 0.18) });
    keys.push({ at: at + 0.16, pose: raise(0.15 + i * 0.08) });
  });
  // The big lift, then a HOLD at the top, then a drop that is the fastest motion in the move.
  //
  // The first version simply spread the last slam over a longer span, and the sweep caught what
  // that actually produced: the payoff was the *gentlest* stop in the whole gesture, slower than
  // the three jabs leading into it, and the two hardest arrests the measurement found were
  // elsewhere. A climax has to arrive faster than what came before it, so the arm goes up early,
  // waits at the top — which is also the windup the effects are already charging into — and then
  // covers the greatest distance of any beat in the shortest time of any beat.
  keys.push({ at: BEATS.logs.finish - 0.46, pose: raise(1) });
  keys.push({ at: BEATS.logs.finish - 0.12, pose: raise(1) });
  keys.push({ at: BEATS.logs.finish, pose: slam(1) });
  keys.push({ at: BEATS.logs.finish + 0.30, pose: slam(0.2) });
  keys.push({ at: BEATS.logs.duration, pose: passivePose(0)[0].pose });
  return keys;
}

/**
 * Chiêu cuối — Hạt Giống Thần Mệnh. Root, become the tree, throw, then draw everything in.
 *
 * Four movements, and the shape of the whole thing is the point: he COMMITS. The legs straighten
 * and widen and never move again, the spine goes up, and the arms spend the rest of the move
 * working — three alternating throws out and up, then a wide sweep that closes on his own chest.
 * The last gesture reverses the direction of every one before it, which is what "gom về trung tâm"
 * has to look like from the outside.
 */
export function ultimatePose(): Key[] {
  const branchL: [number, number, number] = [-0.10, 0.86, -0.50];
  const branchR: [number, number, number] = [-0.10, 0.86, 0.50];
  const rooted: Pose = {
    // Straight, wide and planted: the stance of something that is not going to be moved.
    L_Thigh: [-0.06, -0.97, -0.24], L_Calf: [-0.02, -0.999, -0.04],
    R_Thigh: [-0.06, -0.97, 0.24], R_Calf: [-0.02, -0.999, 0.04],
    Waist: [0, 1, 0], Spine01: [0, 1, 0], Spine02: [0, 1, 0],
  };
  const throwOut = (side: -1 | 1): Pose => ({
    [side < 0 ? 'L_Clavicle' : 'R_Clavicle']: [0.10, 0.34, 0.94 * side],
    [side < 0 ? 'L_Upperarm' : 'R_Upperarm']: [0.62, 0.44, 0.65 * side],
    [side < 0 ? 'L_Forearm' : 'R_Forearm']: [0.78, 0.56, 0.28 * side],
  });
  const gatherIn = (side: -1 | 1): Pose => ({
    [side < 0 ? 'L_Clavicle' : 'R_Clavicle']: [0.06, 0.16, 0.98 * side],
    [side < 0 ? 'L_Upperarm' : 'R_Upperarm']: [0.40, -0.20, 0.89 * side],
    [side < 0 ? 'L_Forearm' : 'R_Forearm']: [0.30, 0.10, -0.95 * side],
  });

  const keys: Key[] = [
    { at: 0, pose: passivePose(0)[0].pose },
    {
      // Sinking to root: knees bend, arms drop, everything gathers before it goes up.
      at: 0.26,
      pose: {
        L_Thigh: [-0.14, -0.96, -0.24], L_Calf: [0.18, -0.98, -0.05],
        R_Thigh: [-0.14, -0.96, 0.24], R_Calf: [0.18, -0.98, 0.05],
        Waist: [-0.10, 0.99, 0], Spine01: [-0.14, 0.99, 0], Spine02: [-0.18, 0.98, 0],
        L_Clavicle: [-0.05, -0.10, -0.99], R_Clavicle: [0.02, -0.10, 0.99],
        L_Upperarm: [0.16, -0.86, -0.48], L_Forearm: [0.34, -0.92, -0.20],
        R_Upperarm: [0.16, -0.86, 0.48], R_Forearm: [0.34, -0.92, 0.20],
      },
    },
    {
      // The tree: planted, tall, arms open as branches.
      at: BEATS.ultimate.rooted,
      pose: {
        ...rooted,
        L_Clavicle: [-0.02, 0.42, -0.91], R_Clavicle: [0.02, 0.42, 0.91],
        L_Upperarm: branchL, L_Forearm: [0.10, 0.94, -0.32],
        R_Upperarm: branchR, R_Forearm: [0.10, 0.94, 0.32],
      },
    },
  ];

  // Three throws, alternating. Each is a scoop across the chest and a fling out and up, and the
  // arm that is not throwing stays up as a branch — a treant does not drop its guard to throw.
  BEATS.ultimate.throws.forEach((at, i) => {
    const side: -1 | 1 = i % 2 === 0 ? -1 : 1;
    keys.push({
      at: at - 0.16,
      pose: {
        ...rooted,
        [side < 0 ? 'L_Upperarm' : 'R_Upperarm']: [0.20, 0.10, 0.97 * side],
        [side < 0 ? 'L_Forearm' : 'R_Forearm']: [-0.30, 0.36, -0.88 * side],
      },
    });
    keys.push({ at, pose: { ...rooted, ...throwOut(side) } });
  });

  keys.push({
    // Wide: everything opened out before it closes, so the pull has somewhere to come from.
    at: BEATS.ultimate.gather - 0.22,
    pose: {
      ...rooted,
      L_Clavicle: [0, 0.30, -0.95], R_Clavicle: [0, 0.30, 0.95],
      L_Upperarm: [0.10, 0.30, -0.95], L_Forearm: [0.16, 0.44, -0.88],
      R_Upperarm: [0.10, 0.30, 0.95], R_Forearm: [0.16, 0.44, 0.88],
    },
  });
  keys.push({ at: BEATS.ultimate.gather, pose: { ...rooted, ...gatherIn(-1), ...gatherIn(1) } });
  keys.push({
    // The close. Both forearms crossed in over the chest — the stun lands on this frame.
    at: BEATS.ultimate.stun,
    pose: {
      ...rooted,
      L_Clavicle: [0.10, 0.08, -0.99], R_Clavicle: [0.10, 0.08, 0.99],
      L_Upperarm: [0.50, -0.30, -0.81], L_Forearm: [0.60, 0.30, 0.74],
      R_Upperarm: [0.50, -0.30, 0.81], R_Forearm: [0.60, 0.30, -0.74],
    },
  });
  keys.push({ at: BEATS.ultimate.duration, pose: { ...rooted, ...passivePose(0)[0].pose } });
  return keys;
}
