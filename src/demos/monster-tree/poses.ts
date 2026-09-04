import * as THREE from 'three';
import type { MonsterTreeRig } from './rig';

/**
 * Authored gestures for Y'bneth's kit.
 *
 * WHY THESE EXIST. The rig ships sixteen clips from Tripo's generic biped library — boxing rounds,
 * front kicks, six dances. They are real motion and they are measured honestly elsewhere in this
 * demo, but none of them is the motion of a treant throwing a vine, calling wood down, or rooting
 * itself into the ground. Borrowing `box_01` for Heartwood Lash gives a boxer's jab with a vine drawn on
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

export interface Key {
  /** Seconds into the move. */
  at: number;
  pose: Pose;
  /**
   * Twist, in degrees about the figure's own up axis, per bone.
   *
   * This is where a body's power comes from and it was the largest thing missing. Hips drive,
   * shoulders counter, and the arm is the last link in the chain rather than the whole of it.
   */
  turn?: Record<string, number>;
  /**
   * Where the hips are, in figure units: +x forward, +y up, +z to the character's right.
   *
   * Weight shift and crouch. A figure whose pelvis never moves is a mannequin with articulated
   * arms, which is exactly what these gestures looked like before this existed.
   */
  hips?: [number, number, number];
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
  // NOT the feet. `L_Foot` reaches its toe in 0.039 units, so aiming it swings the whole ankle
  // through a rotation the skin cannot follow and the foot tears into a flat sheet. A heel lifting
  // would be worth having and this rig cannot express it.
  'L_Thigh', 'L_Calf', 'R_Thigh', 'R_Calf',
];

/** Clear every aim this file can set, so a move handing over cannot leave a limb behind. */
export function clearPose(rig: MonsterTreeRig): void {
  for (const bone of BONES) rig.aim(bone, null);
  for (const bone of TURNED) rig.turn(bone, 0);
  rig.shift(0, 0, 0);
}

const BLEND_FROM = new THREE.Vector3();
const BLEND_TO = new THREE.Vector3();

/** Every bone any timeline twists. Iterated per frame, so it is a list and not a scan. */
const TURNED = ['Hip', 'Waist', 'Spine01', 'Spine02'];
const DEG = Math.PI / 180;

/** One channel's value at a time, interpolated across the keys that actually set it. */
function scalarAt(keys: Key[], pick: (k: Key) => number | undefined, time: number): number {
  let from: Key | null = null;
  let to: Key | null = null;
  for (const key of keys) {
    if (pick(key) === undefined) continue;
    if (key.at <= time && (!from || key.at > from.at)) from = key;
    if (key.at >= time && (!to || key.at < to.at)) to = key;
  }
  if (!from && !to) return 0;
  const a = from ?? to!;
  const b = to ?? from!;
  const span = b.at - a.at;
  const k = span > 1e-6 ? ease((time - a.at) / span) : 1;
  const va = pick(a) ?? 0;
  const vb = pick(b) ?? 0;
  return va + (vb - va) * k;
}

/** The hip offset at a time, or null when no key sets one. */
function hipsAt(keys: Key[], time: number, out: THREE.Vector3): boolean {
  if (!keys.some((k) => k.hips)) return false;
  out.set(
    scalarAt(keys, (k) => k.hips?.[0], time),
    scalarAt(keys, (k) => k.hips?.[1], time),
    scalarAt(keys, (k) => k.hips?.[2], time),
  );
  return true;
}


/**
 * A leg, bent by `deg` MORE than it rests — never less, and with the foot kept under the hip.
 *
 * Two things this exists to prevent, both measured rather than guessed.
 *
 * The rest leg is already off vertical: the thigh sits about 9 degrees forward and the calf about
 * 12. Typing leg directions by hand quietly STRAIGHTENED it, and a straighter leg reaches further
 * down — the foot went 8 cm through the floor at the deepest frame of the former lash. Deriving both
 * segments from the measured rest with a bend that only ever adds makes that impossible.
 *
 * And the calf angle is SOLVED, not chosen. Given a thigh of 0.395 tilted forward by `a`, the knee
 * moves forward by 0.395·sin(a), and the calf of 0.473 has to come back by asin(0.395·sin(a)/0.473)
 * to put the foot underneath again. Picking the calf angle by eye instead left the foot out in
 * front and the leg barely shortened, so a crouch that asked for 7 cm of drop got 2 cm of leg and
 * pushed the difference through the floor.
 */
const THIGH_LEN = 0.395;
const CALF_LEN = 0.473;

function leg(side: -1 | 1, deg: number, lean = 0): Pose {
  const a = (9 + Math.max(0, deg)) * DEG;
  const b = Math.asin(Math.min(0.98, (THIGH_LEN * Math.sin(a)) / CALF_LEN));
  const z = side < 0 ? -0.115 : 0.105;
  return {
    [side < 0 ? 'L_Thigh' : 'R_Thigh']: [Math.sin(a), -Math.cos(a), z + lean],
    [side < 0 ? 'L_Calf' : 'R_Calf']: [-Math.sin(b), -Math.cos(b), z * 0.5],
  };
}

/** How far a leg bent by `deg` shortens, so a crouch can never ask for more drop than it has. */
export function legDrop(deg: number): number {
  const a = (9 + Math.max(0, deg)) * DEG;
  const b = Math.asin(Math.min(0.98, (THIGH_LEN * Math.sin(a)) / CALF_LEN));
  const rest = THIGH_LEN * Math.cos(9 * DEG) + CALF_LEN * Math.cos(12 * DEG);
  return rest - (THIGH_LEN * Math.cos(a) + CALF_LEN * Math.cos(b));
}

const HIPS_A = new THREE.Vector3();
const HIPS_B = new THREE.Vector3();

/**
 * Cross-fade one authored pose into another over `k` (0 = fully the outgoing pose, 1 = the new one).
 *
 * WHY A MOVE CANNOT SIMPLY DROP ITS POSE. The clip cross-fades; the pose does not, and dropping it
 * puts the whole gesture back to the resting animation between two frames. Measured on the review
 * harness, ending the ultimate moved a hand **1.10 units in one frame** — by far the largest
 * discontinuity anywhere in the demo, and one that no still frame shows.
 *
 * Three cases, and they are all needed. A bone that both poses aim gets its DIRECTION slerped, so
 * it sweeps from one gesture to the other. A bone only the outgoing pose aims fades out by weight,
 * back toward whatever the clip underneath is doing. A bone only the incoming pose aims fades in
 * the same way. Handing over to a move with no pose at all — idle, or any of the older borrowed
 * clips — is just the middle case for every bone.
 */
export function blendPose(
  rig: MonsterTreeRig,
  from: { keys: Key[]; time: number } | null,
  to: { keys: Key[]; time: number } | null,
  k: number,
): void {
  for (const bone of BONES) {
    const a = from ? sample(from.keys, bone, from.time, BLEND_FROM) : null;
    const b = to ? sample(to.keys, bone, to.time, BLEND_TO) : null;
    if (a && b) {
      slerpDir([a.x, a.y, a.z], [b.x, b.y, b.z], k, SCRATCH);
      rig.aim(bone, SCRATCH, 1);
    } else if (a) {
      rig.aim(bone, a, 1 - k);
    } else if (b) {
      rig.aim(bone, b, k);
    } else {
      rig.aim(bone, null);
    }
  }

  for (const bone of TURNED) {
    const a = from ? scalarAt(from.keys, (key) => key.turn?.[bone], from.time) : 0;
    const b = to ? scalarAt(to.keys, (key) => key.turn?.[bone], to.time) : 0;
    rig.turn(bone, (a + (b - a) * k) * DEG);
  }

  const hasA = from ? hipsAt(from.keys, from.time, HIPS_A) : false;
  const hasB = to ? hipsAt(to.keys, to.time, HIPS_B) : false;
  if (!hasA) HIPS_A.set(0, 0, 0);
  if (!hasB) HIPS_B.set(0, 0, 0);
  rig.shift(
    HIPS_A.x + (HIPS_B.x - HIPS_A.x) * k,
    HIPS_A.y + (HIPS_B.y - HIPS_A.y) * k,
    HIPS_A.z + (HIPS_B.z - HIPS_A.z) * k,
  );
}

/** One bone's aim direction from a timeline at a time, or null if the timeline never aims it. */
function sample(keys: Key[], bone: string, time: number, out: THREE.Vector3): THREE.Vector3 | null {
  const from = nearest(keys, bone, time, -1);
  const to = nearest(keys, bone, time, 1);
  if (!from && !to) return null;
  const start = from ?? to!;
  const end = to ?? from!;
  const span = end.at - start.at;
  const k = span > 1e-6 ? ease((time - start.at) / span) : 1;
  slerpDir(start.pose[bone], end.pose[bone], k, out);
  return out;
}


/**
 * When each move's hand stops.
 *
 * This is the contract between the gesture and the effect. Everywhere else in this demo the beats
 * come out of a measurement of a clip nobody wrote; here the clip IS written, so the beat is a
 * decision — and it has to be made once, in one place, or the pose and the cue drift apart and the
 * vine leaves a hand that is still winding up.
 */
export const BEATS = {
  // The branch begins travelling at `release`; the throwing hand stops at `arrest`. Keeping both
  // beats explicit is the difference between an effect that merely follows a hand and one that
  // builds around the instant the hand and branch run out of travel together.
  vine: { raised: 0.58, release: 0.72, arrest: 0.86, recover: 1.38, duration: 2.05 },
  // A real two-hand ground contact: gather, overhead hold, hard arrest at the floor, then two
  // scheduled root aftershocks. `finish` remains the contact beat for the browser scorer's hold
  // window; `recover` is when the torso has carried the recoil back upward.
  logs: { raised: 0.52, contact: 0.90, calls: [1.08, 1.28], finish: 0.90, recover: 1.58, duration: 2.45 },
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
  const openL = 0.20 + slow * 0.36 + fast * 0.13;
  const openR = 0.20 + Math.sin(time * 0.62 + 1.9) * 0.36 + mid * 0.13;
  const lift = slow * 0.05;
  return [{
    at: 0,
    // The weight drifts from one foot to the other and back, on a slower cycle than the breath and
    // never in step with it. A stance whose pelvis is nailed down cannot look like it is standing;
    // it looks like it is mounted.
    hips: [Math.sin(time * 0.41) * 0.012, -0.006 + Math.sin(time * 0.62) * 0.008, Math.sin(time * 0.29 + 1.1) * 0.026],
    turn: { Hip: Math.sin(time * 0.29 + 1.1) * 3.5, Spine02: Math.sin(time * 0.47) * 4.5 },
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
      // One knee softer than the other, and the softer one changes over. Perfect bilateral symmetry
      // is the single loudest tell that a pose was typed rather than observed.
      ...leg(-1, 2 + slow * 1.8), ...leg(1, 2 - slow * 1.8),
      L_Upperarm: [0.30 + lift, -0.72 - openL * 0.45, -0.62 + openL],
      L_Forearm: [0.42 + fast * 0.09, -0.87 + openL * 0.34, -0.26 - openL * 0.20],
      R_Upperarm: [0.30 - lift, -0.72 - openR * 0.45, 0.62 - openR],
      R_Forearm: [0.42 + mid * 0.09, -0.87 + openR * 0.34, 0.26 + openR * 0.20],
    },
  }];
}

/**
 * Heartwood Lash. Wind the whole tree away, hold it loaded, then cross into a hard stop.
 *
 * The vine leaves at `BEATS.vine.release` and reaches full extension at `BEATS.vine.arrest`. Keeping
 * those as separate table beats gives the effect a real travel interval and lets hitstop belong to
 * the stop. The hand remains extended through the brief hold so the living branch stays connected.
 */
export function vinePose(): Key[] {
  return [
    { at: 0, pose: passivePose(0)[0].pose, turn: { Hip: 0, Spine02: 0 }, hips: [0, 0, 0] },
    {
      // The whole body withdraws from the target before the arm does. This is a branch bending in
      // a storm, not a boxer chambering a jab: the pelvis moves back, the crown follows, and the
      // free hand opens the silhouette in the opposite direction.
      at: 0.26,
      turn: { Hip: -8, Waist: -13, Spine01: -17, Spine02: -22 },
      hips: [-0.035, -0.026, -0.018],
      pose: {
        ...leg(-1, 11, -0.025), ...leg(1, 17, 0.025),
        Waist: [-0.12, 0.99, -0.05], Spine01: [-0.17, 0.98, -0.06], Spine02: [-0.23, 0.96, -0.07],
        L_Clavicle: [-0.22, 0.18, -0.96],
        L_Upperarm: [-0.46, -0.40, -0.79],
        L_Forearm: [0.05, 0.50, -0.86],
        R_Clavicle: [0.20, 0.08, 0.97],
        R_Upperarm: [0.48, -0.52, 0.70], R_Forearm: [0.67, -0.64, 0.37],
      },
    },
    {
      // Maximum bend. The throwing hand is behind the crown and the body makes one long reverse C.
      at: BEATS.vine.raised,
      turn: { Hip: -16, Waist: -25, Spine01: -33, Spine02: -43 },
      hips: [-0.068, -0.047, -0.034],
      pose: {
        ...leg(-1, 18, -0.04), ...leg(1, 26, 0.035),
        Waist: [-0.19, 0.97, -0.06], Spine01: [-0.26, 0.95, -0.08], Spine02: [-0.35, 0.91, -0.10],
        L_Clavicle: [-0.44, 0.29, -0.85],
        L_Upperarm: [-0.66, 0.02, -0.75],
        L_Forearm: [-0.10, 0.84, 0.53],
        R_Clavicle: [0.25, 0.15, 0.96],
        R_Upperarm: [0.58, -0.36, 0.73], R_Forearm: [0.70, -0.57, 0.43],
      },
    },
    {
      // Fourteen hundredths of held tension. This is where sap reaches the hand and the audience
      // is given time to see that the branch is about to leave.
      at: BEATS.vine.release,
      turn: { Hip: -17, Waist: -27, Spine01: -35, Spine02: -46 },
      hips: [-0.070, -0.049, -0.036],
      pose: {
        ...leg(-1, 18, -0.04), ...leg(1, 27, 0.035),
        Waist: [-0.20, 0.97, -0.06], Spine01: [-0.27, 0.95, -0.08], Spine02: [-0.37, 0.90, -0.10],
        L_Clavicle: [-0.46, 0.30, -0.84],
        L_Upperarm: [-0.68, 0.04, -0.73],
        L_Forearm: [-0.12, 0.86, 0.49],
        R_Upperarm: [0.60, -0.34, 0.72], R_Forearm: [0.72, -0.55, 0.42],
      },
    },
    {
      // ARREST. The hips have crossed the neutral line, the free arm is behind, and the throwing
      // chain has become a single forward diagonal. The signature branch reaches its fixed target
      // on this same frame.
      at: BEATS.vine.arrest,
      turn: { Hip: 20, Waist: 37, Spine01: 50, Spine02: 64 },
      hips: [0.105, -0.018, 0.044],
      pose: {
        ...leg(-1, 12, 0.035), ...leg(1, 29, 0.05),
        Waist: [0.32, 0.94, -0.04], Spine01: [0.44, 0.89, -0.05], Spine02: [0.58, 0.81, -0.06],
        L_Clavicle: [0.38, 0.07, -0.92],
        L_Upperarm: [0.94, -0.08, -0.33],
        L_Forearm: [0.997, 0.04, -0.06],
        R_Clavicle: [-0.34, 0.12, 0.93],
        R_Upperarm: [-0.58, -0.35, 0.74], R_Forearm: [-0.46, -0.67, 0.58],
      },
    },
    {
      // Wood keeps flexing after the sap stops. The hand dips while the shoulder and crown travel
      // past it, giving the hitstop a visible recoil to release into.
      at: BEATS.vine.arrest + 0.24,
      turn: { Hip: 23, Waist: 42, Spine01: 56, Spine02: 70 },
      hips: [0.118, -0.042, 0.052],
      pose: {
        ...leg(-1, 16, 0.04), ...leg(1, 31, 0.055),
        Waist: [0.38, 0.92, -0.02], Spine01: [0.50, 0.86, -0.03], Spine02: [0.63, 0.77, -0.03],
        L_Clavicle: [0.42, -0.18, -0.89],
        L_Upperarm: [0.88, -0.34, -0.33],
        L_Forearm: [0.76, -0.52, 0.39],
        R_Clavicle: [-0.38, 0.20, 0.90],
        R_Upperarm: [-0.68, -0.08, 0.73], R_Forearm: [-0.52, -0.22, 0.82],
      },
    },
    {
      // Slow elastic recovery, deliberately much longer than the release.
      at: BEATS.vine.recover,
      turn: { Hip: 8, Waist: 16, Spine01: 22, Spine02: 28 },
      hips: [0.034, -0.022, 0.016],
      pose: {
        ...leg(-1, 12, 0.015), ...leg(1, 17, 0.02),
        Waist: [0.16, 0.98, -0.05], Spine01: [0.22, 0.97, -0.05], Spine02: [0.29, 0.95, -0.06],
        L_Clavicle: [0.25, -0.14, -0.96],
        L_Upperarm: [0.70, -0.48, -0.52],
        L_Forearm: [0.78, -0.52, -0.35],
        R_Upperarm: [-0.12, -0.70, 0.70], R_Forearm: [0.08, -0.91, 0.40],
      },
    },
    { at: BEATS.vine.duration, pose: passivePose(0)[0].pose, turn: { Hip: 0, Waist: 0, Spine01: 0, Spine02: 0 }, hips: [0, 0, 0] },
  ];
}

export function logsPose(): Key[] {
  // Rootbreaker is an actual ground contact. The prior held-cast pose asked the floor to
  // erupt while both hands remained overhead, so the force had no visible route through the body.
  // Here the hands, trunk and knees arrive together, then the roots inherit that forward vector.
  const overhead: Pose = {
    ...leg(-1, 19, -0.025), ...leg(1, 21, 0.025),
    Waist: [-0.12, 0.99, 0], Spine01: [-0.16, 0.98, 0], Spine02: [-0.20, 0.97, 0],
    L_Clavicle: [-0.12, 0.52, -0.84], R_Clavicle: [-0.08, 0.52, 0.85],
    L_Upperarm: [-0.18, 0.78, -0.60], L_Forearm: [0.06, 0.98, -0.18],
    R_Upperarm: [-0.18, 0.78, 0.60], R_Forearm: [0.06, 0.98, 0.18],
  };
  const contact: Pose = {
    ...leg(-1, 34, 0.035), ...leg(1, 35, 0.04),
    Waist: [0.52, 0.84, -0.02], Spine01: [0.64, 0.76, -0.02], Spine02: [0.74, 0.66, -0.02],
    L_Clavicle: [0.42, -0.28, -0.86], R_Clavicle: [0.42, -0.28, 0.86],
    L_Upperarm: [0.60, -0.64, -0.48], L_Forearm: [0.40, -0.90, -0.15],
    R_Upperarm: [0.60, -0.64, 0.48], R_Forearm: [0.40, -0.90, 0.15],
  };
  return [
    { at: 0, pose: passivePose(0)[0].pose, turn: { Hip: 0, Spine02: 0 }, hips: [0, 0, 0] },
    {
      // Hands sweep outward and behind as the weight drops. The negative silhouette is deliberately
      // wide so the narrow overhead hold that follows reads as a change, not a vertical arm slide.
      at: 0.24,
      turn: { Hip: -7, Waist: -9, Spine01: -12, Spine02: -15 },
      hips: [-0.035, -0.055, 0],
      pose: {
        ...leg(-1, 25, -0.025), ...leg(1, 27, 0.025),
        Waist: [-0.16, 0.98, 0], Spine01: [-0.22, 0.96, 0], Spine02: [-0.30, 0.93, 0],
        L_Clavicle: [-0.16, -0.18, -0.97], R_Clavicle: [-0.12, -0.18, 0.98],
        L_Upperarm: [-0.30, -0.60, -0.74], L_Forearm: [-0.42, -0.25, -0.87],
        R_Upperarm: [-0.30, -0.60, 0.74], R_Forearm: [-0.42, -0.25, 0.87],
      },
    },
    {
      at: BEATS.logs.raised,
      turn: { Hip: -2, Waist: -5, Spine01: -7, Spine02: -9 },
      hips: [-0.025, -0.035, 0.006],
      pose: overhead,
    },
    // The held frame lets the upward travelling sap visibly converge above the crown.
    { at: BEATS.logs.contact - 0.12, pose: overhead, turn: { Hip: -3, Waist: -7, Spine01: -9, Spine02: -12 }, hips: [-0.030, -0.040, 0.004] },
    {
      at: BEATS.logs.contact,
      turn: { Hip: 4, Waist: 6, Spine01: 4, Spine02: 1 },
      hips: [0.080, -0.105, 0],
      pose: contact,
    },
    // A short rebound after hitstop. Hands remain below the waist while the bark chain flexes back.
    {
      at: BEATS.logs.contact + 0.24,
      turn: { Hip: 7, Waist: 11, Spine01: 9, Spine02: 4 },
      hips: [0.060, -0.082, 0],
      pose: {
        ...contact,
        L_Upperarm: [0.56, -0.56, -0.61], L_Forearm: [0.58, -0.78, -0.23],
        R_Upperarm: [0.56, -0.56, 0.61], R_Forearm: [0.58, -0.78, 0.23],
      },
    },
    {
      at: BEATS.logs.recover,
      turn: { Hip: 2, Waist: 5, Spine01: 5, Spine02: 3 },
      hips: [0.020, -0.025, 0],
      pose: {
        ...leg(-1, 12), ...leg(1, 13),
        Waist: [0.12, 0.99, 0], Spine01: [0.16, 0.98, 0], Spine02: [0.20, 0.97, 0],
        L_Upperarm: [0.36, -0.76, -0.54], L_Forearm: [0.40, -0.88, -0.24],
        R_Upperarm: [0.36, -0.76, 0.54], R_Forearm: [0.40, -0.88, 0.24],
      },
    },
    { at: BEATS.logs.duration, pose: passivePose(0)[0].pose, turn: { Hip: 0, Waist: 0, Spine01: 0, Spine02: 0 }, hips: [0, 0, 0] },
  ];
}

/**
 * Crown of First Seeds. Root, open the canopy, and hold it above the antlers.
 *
 * The move changed from throwing to RAINING, and the gesture had to change with it. Three
 * alternating throws said "he is putting each of these somewhere"; a barrage that covers the whole
 * field is not aimed at anything, so he opens and stays open. The legs straighten and widen and
 * never move again, the trunk goes up, and the arms sweep out and up into a canopy that holds for
 * the whole downpour — the shape of a tree letting go of its seeds all at once.
 */
export function ultimatePose(): Key[] {
  const rooted: Pose = {
    // Wide and planted, and NOT straight. A leg typed as vertical is longer than the leg at rest,
    // which drives the foot through the floor — and this move also lengthens the thighs by a tenth
    // with `rig.stretch`, pushing them further down again. A small held bend absorbs both.
    ...leg(-1, 4, -0.10), ...leg(1, 4, 0.11),
    Waist: [0, 1, 0], Spine01: [0, 1, 0], Spine02: [0, 1, 0],
  };
  // The canopy: arms high and thrown wide, forearms turned further out than the upper arms so the
  // silhouette forks the way a crown does instead of making a V.
  const canopy = (spread: number): Pose => ({
    ...rooted,
    L_Clavicle: [-0.24, 0.42 + spread * 0.10, -0.87],
    R_Clavicle: [-0.24, 0.42 + spread * 0.10, 0.87],
    L_Upperarm: [-0.34, 0.54 + spread * 0.10, -0.77],
    L_Forearm: [-0.42, 0.34 + spread * 0.06, -0.84],
    R_Upperarm: [-0.34, 0.54 + spread * 0.10, 0.77],
    R_Forearm: [-0.42, 0.34 + spread * 0.06, 0.84],
  });

  return [
    { at: 0, pose: passivePose(0)[0].pose, turn: { Hip: 0, Spine02: 0 }, hips: [0, 0, 0] },
    {
      // Sinking to root: knees bend, arms drop and gather in. Everything goes DOWN before it goes
      // up, or the canopy opens out of nothing. The deepest crouch in the kit, because this is the
      // move that commits hardest.
      at: 0.24,
      turn: { Hip: -6, Waist: -8, Spine01: -10, Spine02: -12 },
      hips: [-0.03, -0.042, 0],
      pose: {
        ...leg(-1, 24, -0.02), ...leg(1, 23, 0.02),
        Waist: [-0.10, 0.99, 0], Spine01: [-0.14, 0.99, 0], Spine02: [-0.18, 0.98, 0],
        L_Clavicle: [-0.05, -0.14, -0.99], R_Clavicle: [0.02, -0.14, 0.99],
        L_Upperarm: [0.22, -0.86, -0.46], L_Forearm: [-0.20, -0.66, 0.72],
        R_Upperarm: [0.22, -0.86, 0.46], R_Forearm: [-0.20, -0.66, -0.72],
      },
    },
    // Driving up out of the crouch, legs straightening under it.
    { at: BEATS.ultimate.rooted, pose: canopy(0), turn: { Hip: 3, Waist: 4, Spine01: 2, Spine02: -3 }, hips: [0.01, 0.008, 0.006] },
    // Thrown fully open on the frame the rain starts, at full extension.
    { at: BEATS.ultimate.open, pose: canopy(1), turn: { Hip: 0, Waist: 2, Spine01: 0, Spine02: -6 }, hips: [0, 0.014, 0] },
    // A long, almost imperceptible widening through the downpour: the canopy is under load, and
    // the trunk sways off centre and back the way a loaded tree does.
    {
      at: (BEATS.ultimate.open + BEATS.ultimate.rainEnds) / 2,
      pose: canopy(1.35),
      turn: { Hip: -2, Waist: -3, Spine01: -2, Spine02: 5 },
      hips: [0.004, 0.012, -0.014],
    },
    { at: BEATS.ultimate.rainEnds, pose: canopy(1.1), turn: { Hip: 2, Waist: 3, Spine01: 2, Spine02: -4 }, hips: [-0.004, 0.010, 0.012] },
    {
      at: BEATS.ultimate.duration,
      pose: { ...rooted, ...passivePose(0)[0].pose },
      turn: { Hip: 0, Waist: 0, Spine01: 0, Spine02: 0 },
      hips: [0, 0, 0],
    },
  ];
}
