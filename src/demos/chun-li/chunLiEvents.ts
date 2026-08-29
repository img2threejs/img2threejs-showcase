/**
 * Where the effects fire, measured off the clips rather than authored by eye.
 *
 * Every clip in `rigData.ts` was swept at 400 samples with the skeleton built exactly as the
 * runtime builds it, and the world position of each hand and toe read on every sample. From those
 * curves:
 *
 *   STRIKES     a local maximum of limb speed above 1.55 H/s, timed not at the peak but at the
 *               frame the limb has shed 55% of it — that is where the limb has ARRIVED, and it is
 *               0.02-0.12 s later than the peak. Firing on the peak puts the flash in front of the
 *               fist, which was the first thing that looked wrong.
 *   FOOTFALLS   a local minimum of toe height inside the bottom quarter of that toe's own range,
 *               reached downward at more than 0.18 H/s. Clips whose feet never leave the floor are
 *               skipped outright rather than producing a footfall on every micro-dip.
 *   TRAIL_REF   the 92nd percentile of limb speed IN THAT CLIP, so the ribbon gate means the same
 *               thing in a 6.6 s chop as in a 1.4 s snap kick.
 *
 * Speeds are in figure heights per second (H/s), which makes them comparable across clips and
 * independent of the normalisation scale.
 *
 * WHY THE SWEEP EXCLUDES THE LAST SAMPLE. None of these clips loops seamlessly: between the final
 * keyframe and the first there is a jump of up to 850 H/s. Differencing across that seam reported a
 * strike on frame 0 of nine clips out of nine, all of them phantom. The sweep therefore samples
 * [0, duration) and forward-differences inside the clip only.
 */

/** Bones the effects hang off. These are the rig's own names, not aliases. */
export const VFX_JOINTS = {
  handL: 'L_Hand',
  handR: 'R_Hand',
  forearmL: 'L_Forearm',
  forearmR: 'R_Forearm',
  toeL: 'L_ToeBase',
  toeR: 'R_ToeBase',
  footL: 'L_Foot',
  footR: 'R_Foot',
  head: 'Head',
  chest: 'Spine02',
  hip: 'Hip',
  clavicleL: 'L_Clavicle',
  clavicleR: 'R_Clavicle',
} as const;

/** Normalised standing height, from the measured figure bounds in `glb-parts.json`. */
export const FIGURE_HEIGHT = 1.9;

export type Side = 'left' | 'right';
export type Limb = 'hand' | 'foot';

export interface StrikeEvent {
  clip: string;
  limb: Limb;
  side: Side;
  /** Seconds into the clip, at the arrival frame rather than the speed peak. */
  time: number;
  /** Peak limb speed for this strike, figure heights per second. */
  speed: number;
}

export interface FootfallEvent {
  clip: string;
  side: Side;
  time: number;
  /** Descent rate on the contact frame, figure heights per second. */
  drop: number;
}

/**
 * Hand swings during a run are not strikes, so the sweep's hand events are dropped for the two
 * travelling clips and only the foot pushes above 3.0 H/s are kept — those are the strides that
 * throw dust. The idle clip's two 1.6 H/s events are dropped for the same reason: a guard resetting
 * is not a punch, and flashing it makes the stance look twitchy.
 */
export const STRIKE_EVENTS: readonly StrikeEvent[] = [
  // angry_01
  { clip: 'preset:biped:angry_01', limb: 'hand', side: 'left', time: 1.160, speed: 2.49 },
  { clip: 'preset:biped:angry_01', limb: 'hand', side: 'right', time: 1.302, speed: 2.39 },
  { clip: 'preset:biped:angry_01', limb: 'hand', side: 'left', time: 1.337, speed: 1.70 },
  { clip: 'preset:biped:angry_01', limb: 'foot', side: 'right', time: 2.329, speed: 3.03 },
  { clip: 'preset:biped:angry_01', limb: 'hand', side: 'left', time: 2.444, speed: 2.79 },
  { clip: 'preset:biped:angry_01', limb: 'hand', side: 'right', time: 2.444, speed: 1.90 },
  { clip: 'preset:biped:angry_01', limb: 'hand', side: 'right', time: 3.002, speed: 1.93 },
  { clip: 'preset:biped:angry_01', limb: 'hand', side: 'left', time: 3.010, speed: 1.63 },
  { clip: 'preset:biped:angry_01', limb: 'hand', side: 'left', time: 3.214, speed: 1.62 },
  // box_02
  { clip: 'preset:biped:box_02', limb: 'foot', side: 'right', time: 0.836, speed: 2.50 },
  { clip: 'preset:biped:box_02', limb: 'hand', side: 'left', time: 0.977, speed: 1.56 },
  { clip: 'preset:biped:box_02', limb: 'foot', side: 'right', time: 1.254, speed: 1.93 },
  { clip: 'preset:biped:box_02', limb: 'hand', side: 'left', time: 1.827, speed: 1.63 },
  { clip: 'preset:biped:box_02', limb: 'hand', side: 'right', time: 1.884, speed: 2.21 },
  { clip: 'preset:biped:box_02', limb: 'hand', side: 'left', time: 2.026, speed: 2.51 },
  { clip: 'preset:biped:box_02', limb: 'hand', side: 'right', time: 2.252, speed: 3.52 },
  // chop
  { clip: 'preset:biped:chop', limb: 'hand', side: 'left', time: 1.673, speed: 1.56 },
  { clip: 'preset:biped:chop', limb: 'hand', side: 'left', time: 2.170, speed: 4.78 },
  { clip: 'preset:biped:chop', limb: 'hand', side: 'right', time: 2.170, speed: 4.48 },
  // flee_01
  { clip: 'preset:biped:flee_01', limb: 'foot', side: 'left', time: 1.043, speed: 3.83 },
  { clip: 'preset:biped:flee_01', limb: 'foot', side: 'right', time: 1.327, speed: 4.66 },
  { clip: 'preset:biped:flee_01', limb: 'foot', side: 'left', time: 1.652, speed: 5.85 },
  { clip: 'preset:biped:flee_01', limb: 'foot', side: 'right', time: 2.065, speed: 5.36 },
  { clip: 'preset:biped:flee_01', limb: 'foot', side: 'left', time: 2.329, speed: 3.45 },
  // front_kick_01
  { clip: 'preset:biped:front_kick_01', limb: 'hand', side: 'right', time: 0.356, speed: 1.70 },
  { clip: 'preset:biped:front_kick_01', limb: 'hand', side: 'right', time: 0.731, speed: 1.57 },
  { clip: 'preset:biped:front_kick_01', limb: 'foot', side: 'right', time: 0.731, speed: 3.76 },
  { clip: 'preset:biped:front_kick_01', limb: 'foot', side: 'right', time: 1.023, speed: 2.64 },
  { clip: 'preset:biped:front_kick_01', limb: 'foot', side: 'right', time: 1.436, speed: 1.73 },
  { clip: 'preset:biped:front_kick_01', limb: 'foot', side: 'right', time: 1.646, speed: 2.81 },
  { clip: 'preset:biped:front_kick_01', limb: 'foot', side: 'right', time: 1.836, speed: 3.35 },
  // front_kick_02
  { clip: 'preset:biped:front_kick_02', limb: 'foot', side: 'right', time: 0.287, speed: 1.65 },
  { clip: 'preset:biped:front_kick_02', limb: 'hand', side: 'left', time: 0.521, speed: 2.40 },
  { clip: 'preset:biped:front_kick_02', limb: 'foot', side: 'left', time: 0.584, speed: 1.58 },
  { clip: 'preset:biped:front_kick_02', limb: 'hand', side: 'right', time: 0.627, speed: 3.49 },
  { clip: 'preset:biped:front_kick_02', limb: 'hand', side: 'left', time: 0.761, speed: 2.06 },
  { clip: 'preset:biped:front_kick_02', limb: 'foot', side: 'right', time: 0.761, speed: 6.10 },
  { clip: 'preset:biped:front_kick_02', limb: 'foot', side: 'right', time: 0.935, speed: 7.42 },
  { clip: 'preset:biped:front_kick_02', limb: 'hand', side: 'left', time: 1.165, speed: 1.72 },
  { clip: 'preset:biped:front_kick_02', limb: 'hand', side: 'right', time: 1.229, speed: 1.75 },
  { clip: 'preset:biped:front_kick_02', limb: 'hand', side: 'right', time: 1.413, speed: 1.80 },
];

export const FOOTFALL_EVENTS: readonly FootfallEvent[] = [
  // flee_01
  { clip: 'preset:biped:flee_01', side: 'left', time: 1.009, drop: 0.27 },
  { clip: 'preset:biped:flee_01', side: 'right', time: 1.307, drop: 0.34 },
  // front_kick_01
  { clip: 'preset:biped:front_kick_01', side: 'right', time: 0.674, drop: 0.26 },
];

/**
 * The 92nd-percentile limb speed in each clip. The ribbon trails open above a FRACTION of this,
 * not above an absolute speed, so the same gate means "this limb is moving hard for this clip" in
 * a 6.6 s chop whose fastest hand does 4.9 H/s and in a sprint whose feet do 8.4 H/s.
 */
export const TRAIL_REFERENCE: Readonly<Record<string, number>> = {
  'preset:biped:box_01': 0.87,
  'preset:biped:box_02': 1.73,
  'preset:biped:front_kick_01': 2.41,
  'preset:biped:front_kick_02': 4.01,
  'preset:biped:cast_a_spell': 1.03,
  'preset:biped:chop': 0.54,
  'preset:biped:flee_01': 3.88,
  'preset:biped:angry_01': 1.63,
};

/** Fraction of `TRAIL_REFERENCE` a limb must exceed before its ribbon opens at all. */
export const TRAIL_GATE = 0.34;

/**
 * Clips whose hips travel away from the origin, and how far, in figure heights per loop. Both are
 * held in place so the figure runs on the spot in a fixed camera — the stride itself is untouched,
 * so the dust still lands under the foot that threw it.
 */
export const ROOT_LOCKED_CLIPS: Readonly<Record<string, number>> = {
  'preset:biped:flee_01': 3.706,
};

/**
 * Kikoken, choreographed against the measured hand curves of `cast_a_spell` rather than guessed.
 *
 * Sweeping palm separation and reach out of the chest across the clip gives an unmistakable shape:
 * the hands open wide (0.53 H apart at t=0.74), close into a cup (0.18 H at t=1.34), part again,
 * close harder (0.14 H at t=2.38), and then at t=2.53 the reach hits its maximum for the whole clip
 * (0.168 H) as the palms drive apart to 0.41 H. That last one is the throw; the first is the
 * gather that fails to become one. After t=2.68 the pose holds nearly still for almost a second,
 * which is where the orb gets its flight.
 */
export const KIKOKEN = {
  clip: 'preset:biped:cast_a_spell',
  /** Motes spiral into the palms across each window; the orb only forms in the second one. */
  gather: [
    { from: 0.85, to: 1.34, forms: false },
    { from: 2.05, to: 2.50, forms: true },
    { from: 3.85, to: 4.32, forms: false },
  ],
  /** The failed gather flares off the palms instead of leaving them. */
  flare: 1.49,
  /** Release: measured right-hand arrival at 2.505 s, on the frame of maximum reach. */
  fire: 2.505,
  /**
   * Seconds of flight before the orb bursts, and how far it gets, in figure heights.
   *
   * The range is set by the FRAMING, not by taste. The throw runs almost straight down the lens —
   * the demo camera sits at x=4.55 and the arm points at yaw 98 degrees — so at 2.6 H the orb left
   * the frustum about 0.3 s before it burst, and the burst, the biggest single effect in the demo,
   * happened off-screen every time. Shorter is also FURTHER from the lens, because the throw runs
   * toward it: at 0.62 H the burst sits about 17 degrees off the camera axis, inside a 22.6-degree
   * horizontal half-angle, so the whole shock ring is in shot instead of clipping the right edge.
   */
  flight: 0.45,
  range: 0.62,
} as const;

/**
 * `chop` raises both hands to their highest point at t=1.94 and lands them together at t=2.17 with
 * the two fastest hand speeds in the whole demo (4.78 and 4.48 H/s). It is the only two-handed
 * strike here, so it gets the ground crack rather than an air burst.
 */
export const GROUND_SLAM = { clip: 'preset:biped:chop', time: 2.17 } as const;

/**
 * `angry_01` is a power-up, not a combination: reach out of the chest peaks three times (0.250 H at
 * t=0.60, 0.275 H at t=2.11, 0.246 H at t=3.16) with the hands high each time. The aura swells to
 * those, and the measured hand strikes in between only throw small ki flares.
 */
export const AURA_SURGES = [0.60, 2.11, 3.16] as const;

export type ActionKind = 'idle' | 'attack' | 'cast' | 'move' | 'aura';

export interface ChunLiAction {
  id: string;
  label: string;
  clip: string;
  kind: ActionKind;
  /** One line for the runtime manifest and the capture harness. */
  note: string;
}

/** The clip the demo rests on, and the one `Stop / Reset` returns to. */
export const CHUN_LI_IDLE_ID = 'stance';
export const CHUN_LI_IDLE_CLIP = 'preset:biped:box_01';

/**
 * Eight of the rig's twenty-seven clips. The other eighteen are either near-static (`fire` peaks at
 * 0.11 H/s — it is a held pose), duplicates of one already here, or unreadable at this framing.
 *
 * `flee_02` was here and was CUT. It is the only clip whose hip leaves the floor (0.591 H at
 * t=3.458), and the skirt is not a separate garment: the whole figure is one skinned shell, so
 * the split panels are skinned to the thighs and ride up with them. There is no cloth to
 * re-simulate and no separate mesh to weight differently — fixing it would mean re-authoring the
 * shell — so the clip is gone rather than shown. `flee_01` covers travel and keeps its feet low.
 */
export const CHUN_LI_ACTIONS: readonly ChunLiAction[] = [
  {
    id: 'stance',
    label: 'Fighting Stance',
    clip: 'preset:biped:box_01',
    kind: 'idle',
    note: 'Guard held. Ki breathes off the palms, the stage ring turns, nothing strikes.',
  },
  {
    id: 'lightning-legs',
    label: 'Lightning Legs',
    clip: 'preset:biped:front_kick_01',
    kind: 'attack',
    note: 'Five right-foot strikes in 1.1 s (3.76, 2.64, 1.73, 2.81, 3.35 H/s) — the ribbons never fully close between them.',
  },
  {
    id: 'snap-kick',
    label: 'Snap Kick',
    clip: 'preset:biped:front_kick_02',
    kind: 'attack',
    note: 'The hardest strike measured anywhere in the rig: 7.42 H/s at t=0.935, straight after a 6.10 at t=0.761.',
  },
  {
    id: 'kikoken',
    label: 'Kikoken',
    clip: 'preset:biped:cast_a_spell',
    kind: 'cast',
    note: 'Gather, feint, gather, throw at t=2.505 — the orb flies 0.95 H over 0.62 s and bursts.',
  },
  {
    id: 'ground-slam',
    label: 'Overhead Slam',
    clip: 'preset:biped:chop',
    kind: 'attack',
    note: 'Both hands arrive together at t=2.17 at 4.78 and 4.48 H/s; the shock goes into the floor.',
  },
  {
    id: 'rapid-combo',
    label: 'Rapid Combo',
    clip: 'preset:biped:box_02',
    kind: 'attack',
    note: 'Seven arrivals in 1.4 s, closing on the hardest of them (3.52 H/s at t=2.252).',
  },
  {
    id: 'battle-aura',
    label: 'Battle Aura',
    clip: 'preset:biped:angry_01',
    kind: 'aura',
    note: 'Reach out of the chest peaks at t=0.60, 2.11 and 3.16; the aura column swells to each.',
  },
  {
    id: 'sprint',
    label: 'Sprint',
    clip: 'preset:biped:flee_01',
    kind: 'move',
    note: 'Root-locked over 3.71 H of travel. Four stride pushes throw dust; the ribbons run off the ankles.',
  },
];

export function actionFor(id: string): ChunLiAction | undefined {
  return CHUN_LI_ACTIONS.find((action) => action.id === id);
}

export function strikesForClip(clip: string): readonly StrikeEvent[] {
  return STRIKE_EVENTS.filter((event) => event.clip === clip);
}

export function footfallsForClip(clip: string): readonly FootfallEvent[] {
  return FOOTFALL_EVENTS.filter((event) => event.clip === clip);
}
