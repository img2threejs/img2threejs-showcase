import type { Action } from './types.js';

/**
 * Semantic hero pose authored for facing right; character.ts converts it to rig rotations and
 * the root mirror handles facing left. Angles in radians.
 */
export interface HeroPose {
  /** Upper-body lean around the hip, + forward. */
  lean: number;
  /** Forward arm raise from hanging: 0 down, π/2 straight forward, π overhead, < 0 swung back. */
  front: number;
  /** Back arm raise from hanging, + backward/up. */
  back: number;
  /** Forward leg swing, + forward. */
  stepF: number;
  /** Back leg swing, + backward. */
  stepB: number;
  /** Drawn sword angle in body space: 0 forward, -π/2 up, π/2 down. Omitted = sheathed. */
  blade?: number;
  /** Hand holding the drawn sword; default forward hand. */
  grip?: 'front' | 'back';
  /** Draw the sword over the torso (blade passing in front of the body). */
  bladeFront?: boolean;
  /** Whole-hero forward shift in px (lunges). */
  rx?: number;
  /** Whole-hero vertical shift in px, negative = airborne. */
  ry?: number;
}

export interface HeroKey { t: number; pose: HeroPose }

// Keys are stepped like sprite-sheet frames: a pose holds until the next key's time.
const SLASH: HeroKey[] = [
  { t: 0, pose: { lean: -0.08, front: 2.7, back: 0.3, stepF: 0.15, stepB: 0.2, blade: -2.0 } },
  { t: 0.06, pose: { lean: 0.04, front: 2.1, back: 0.25, stepF: 0.2, stepB: 0.25, blade: -1.0 } },
  { t: 0.1, pose: { lean: 0.12, front: 1.6, back: 0.4, stepF: 0.3, stepB: 0.3, blade: -0.1, rx: 2 } },
  { t: 0.15, pose: { lean: 0.18, front: 1.0, back: 0.5, stepF: 0.4, stepB: 0.35, blade: 0.7, rx: 4 } },
  { t: 0.26, pose: { lean: 0.14, front: 0.8, back: 0.4, stepF: 0.35, stepB: 0.3, blade: 0.9, rx: 4 } },
  { t: 0.33, pose: { lean: 0.06, front: 0.4, back: 0.15, stepF: 0.15, stepB: 0.15, blade: 1.2, rx: 2 } },
];

// Three different cuts on the 0.4 s VFX stride, each with wind-up / strike / follow-through:
// 1) horizontal sweep — sword cocked back level, swung through to the arm straight forward at chest height;
// 2) vertical chop — sword raised overhead, brought straight down into a deep stance;
// 3) diagonal finisher — hop with the sword cocked high behind, cut down-forward at 45° and land in a held pose.
const COMBO: HeroKey[] = [
  { t: 0, pose: { lean: -0.1, front: -0.5, back: 0.7, stepF: 0.2, stepB: 0.3, blade: -2.95 } },
  { t: 0.05, pose: { lean: 0.04, front: 0.9, back: 0.5, stepF: 0.3, stepB: 0.3, blade: -0.35, bladeFront: true, rx: 1 } },
  { t: 0.09, pose: { lean: 0.12, front: 1.57, back: 0.6, stepF: 0.42, stepB: 0.38, blade: 0, bladeFront: true, rx: 3 } },
  { t: 0.15, pose: { lean: 0.1, front: 1.85, back: 0.55, stepF: 0.4, stepB: 0.36, blade: -0.3, bladeFront: true, rx: 3 } },
  { t: 0.28, pose: { lean: 0.04, front: 1.2, back: 0.3, stepF: 0.25, stepB: 0.25, blade: 0.35, rx: 3 } },
  { t: 0.4, pose: { lean: -0.08, front: 2.6, back: 0.3, stepF: 0.18, stepB: 0.22, blade: -1.3, rx: 3 } },
  { t: 0.45, pose: { lean: 0.06, front: 2.0, back: 0.4, stepF: 0.3, stepB: 0.3, blade: -0.4, rx: 4 } },
  { t: 0.49, pose: { lean: 0.2, front: 1.3, back: 0.55, stepF: 0.45, stepB: 0.4, blade: 0.75, rx: 6 } },
  { t: 0.53, pose: { lean: 0.28, front: 0.95, back: 0.6, stepF: 0.52, stepB: 0.46, blade: 1.45, rx: 6 } },
  { t: 0.68, pose: { lean: 0.12, front: 0.8, back: 0.35, stepF: 0.3, stepB: 0.3, blade: 1.15, rx: 6 } },
  { t: 0.8, pose: { lean: -0.14, front: 2.65, back: 0.85, stepF: 0.35, stepB: 0.4, blade: -2.35, rx: 7, ry: -6 } },
  { t: 0.84, pose: { lean: -0.06, front: 2.5, back: 0.9, stepF: 0.25, stepB: 0.3, blade: -2.1, rx: 9, ry: -12 } },
  { t: 0.87, pose: { lean: 0.14, front: 1.75, back: 0.8, stepF: 0.4, stepB: 0.4, blade: 0.15, bladeFront: true, rx: 11, ry: -6 } },
  { t: 0.91, pose: { lean: 0.3, front: 1.1, back: 0.9, stepF: 0.56, stepB: 0.5, blade: 0.8, rx: 12 } },
  { t: 1.02, pose: { lean: 0.26, front: 1.0, back: 0.8, stepF: 0.54, stepB: 0.48, blade: 0.85, rx: 12 } },
  { t: 1.12, pose: { lean: 0.06, front: 0.45, back: 0.3, stepF: 0.18, stepB: 0.18, blade: 1.2, rx: 4 } },
];

const THRUST: HeroKey[] = [
  { t: 0, pose: { lean: -0.1, front: -0.4, back: 0.2, stepF: 0.1, stepB: 0.15, blade: 0, rx: -2 } },
  { t: 0.06, pose: { lean: 0.2, front: 1.57, back: 0.6, stepF: 0.45, stepB: 0.45, blade: 0, rx: 6 } },
  { t: 0.12, pose: { lean: 0.22, front: 1.57, back: 0.7, stepF: 0.5, stepB: 0.5, blade: 0, rx: 8 } },
  { t: 0.3, pose: { lean: 0.1, front: 1.2, back: 0.4, stepF: 0.25, stepB: 0.25, blade: 0.2, rx: 4 } },
  { t: 0.37, pose: { lean: 0.03, front: 0.6, back: 0.15, stepF: 0.1, stepB: 0.1, blade: 0.8, rx: 1 } },
];

// The front-view rig has no back art, so the body never mirrors: the sword orbits the low stance
// instead, in the VFX arc's direction (right → front → left → back), passing over the torso in
// front, switching to the back hand on the left and hiding behind the body at the back.
// Two revolutions of eight stepped positions over the VFX sweep (0.04-0.64 s).
const SPIN_ORBIT: ReadonlyArray<Pick<HeroPose, 'front' | 'back' | 'blade' | 'grip' | 'bladeFront'>> = [
  { front: 1.57, back: 0.6, blade: 0 },
  { front: 1.0, back: 0.6, blade: 0.7, bladeFront: true },
  { front: 0.35, back: 0.5, blade: 2.5, bladeFront: true },
  { front: 0.4, back: 1.0, blade: 2.45, grip: 'back', bladeFront: true },
  { front: 0.4, back: 1.57, blade: Math.PI, grip: 'back' },
  { front: 0.5, back: 1.8, blade: 3.5, grip: 'back' },
  { front: -0.3, back: 0.6, blade: -1.75 },
  { front: 1.9, back: 0.6, blade: -0.35 },
];
const SPIN: HeroKey[] = [
  { t: 0, pose: { lean: -0.05, front: 1.2, back: 0.6, stepF: 0.3, stepB: 0.3, blade: 0.3 } },
  ...Array.from({ length: 16 }, (_, i): HeroKey => ({
    t: 0.04 + i * 0.0375,
    // Lean toward the side the sword is sweeping.
    pose: { lean: 0.08 * Math.cos((i * Math.PI) / 4), stepF: 0.3, stepB: 0.3, ...SPIN_ORBIT[i % 8]! },
  })),
  { t: 0.64, pose: { lean: 0.05, stepF: 0.3, stepB: 0.3, ...SPIN_ORBIT[0]! } },
  { t: 0.7, pose: { lean: 0.02, front: 0.6, back: 0.2, stepF: 0.12, stepB: 0.12, blade: 0.9 } },
];

// World moves the hero forward during 0.04-0.26 s; the pose leans into it and brakes.
const DASH: HeroKey[] = [
  { t: 0, pose: { lean: 0.15, front: -0.5, back: 0.6, stepF: 0.2, stepB: 0.35, blade: 2.6 } },
  { t: 0.04, pose: { lean: 0.42, front: -0.9, back: 0.9, stepF: 0.55, stepB: 0.6, blade: 2.8, ry: -2 } },
  { t: 0.26, pose: { lean: -0.06, front: 0.2, back: 0.2, stepF: 0.45, stepB: 0.2, blade: 2.0 } },
  { t: 0.38, pose: { lean: 0.04, front: 0.1, back: 0.1, stepF: 0.15, stepB: 0.15, blade: 1.6 } },
];

// Jump with the sword overhead, then plunge it into the ground at the VFX impact (0.18 s).
const GROUND: HeroKey[] = [
  { t: 0, pose: { lean: 0.05, front: 2.9, back: 0.3, stepF: 0.3, stepB: 0.3, blade: -1.5 } },
  { t: 0.07, pose: { lean: -0.06, front: 3.0, back: 0.6, stepF: 0.25, stepB: 0.35, blade: -1.65, ry: -12 } },
  { t: 0.13, pose: { lean: 0, front: 2.7, back: 0.6, stepF: 0.25, stepB: 0.35, blade: -1.2, ry: -16 } },
  { t: 0.18, pose: { lean: 0.35, front: 0.9, back: 0.8, stepF: 0.55, stepB: 0.55, blade: 1.35, rx: 4 } },
  { t: 0.55, pose: { lean: 0.2, front: 0.8, back: 0.5, stepF: 0.35, stepB: 0.35, blade: 1.25, rx: 3 } },
  { t: 0.75, pose: { lean: 0.06, front: 0.4, back: 0.2, stepF: 0.12, stepB: 0.12, blade: 1.3, rx: 1 } },
];

// Spells keep the sword sheathed: heal opens both arms to the sides (raised overhead they would
// hide behind the head and torso layers); ice/fire push the forward palm out as the projectile
// leaves its 0.08 s charge.
const HEAL: HeroKey[] = [
  { t: 0, pose: { lean: -0.02, front: 1.0, back: 1.0, stepF: 0, stepB: 0 } },
  { t: 0.06, pose: { lean: -0.06, front: 1.9, back: 1.9, stepF: 0, stepB: 0, ry: -1 } },
  { t: 0.26, pose: { lean: -0.02, front: 1.5, back: 1.5, stepF: 0, stepB: 0 } },
  { t: 0.31, pose: { lean: 0, front: 0.6, back: 0.6, stepF: 0, stepB: 0 } },
];

const PROJECT: HeroKey[] = [
  { t: 0, pose: { lean: -0.05, front: -0.4, back: 0.2, stepF: 0.05, stepB: 0.05 } },
  { t: 0.06, pose: { lean: 0.12, front: 1.6, back: 0.6, stepF: 0.25, stepB: 0.2, rx: 2 } },
  { t: 0.24, pose: { lean: 0.06, front: 1.2, back: 0.4, stepF: 0.15, stepB: 0.1, rx: 1 } },
  { t: 0.3, pose: { lean: 0.02, front: 0.5, back: 0.2, stepF: 0.05, stepB: 0.05 } },
];

export const HERO_ACTIONS: Record<Action, readonly HeroKey[]> = {
  slash: SLASH, combo: COMBO, thrust: THRUST, spin: SPIN, dash: DASH, ground: GROUND,
  heal: HEAL, ice: PROJECT, fire: PROJECT,
};

/** Stepped lookup: the last key whose time has been reached. */
export function heroPoseAt(action: Action, time: number): HeroPose {
  const keys = HERO_ACTIONS[action];
  let pose = keys[0]!.pose;
  for (const key of keys) {
    if (key.t > time) break;
    pose = key.pose;
  }
  return pose;
}
