/**
 * Where the monster's attacks are — measured off the embedded rig, not eyeballed off a scrub bar.
 *
 * Every number below came out of `node scripts/measure-monster-events.mjs`, which sweeps all 27
 * embedded clips at 400 samples each and tracks the WORLD position of both hands, both toes, both
 * feet, the head, the chest and the hip through the same skeleton the browser renders (the RIG
 * literal parsed out of `rigData.ts`, driven by a real AnimationMixer in Node). Distances are in
 * figure heights — H = 1.594 world units, the highest head position across the clip set plus a 4%
 * crown margin — so nothing here depends on the normalisation scale staying what it is today.
 *
 * A STRIKE is three things at once, which is what separates a claw sweep from an arm merely
 * reversing direction:
 *
 *   1. a local maximum in limb speed at or above 45% of that limb's 95th-percentile speed for the
 *      clip, and at least 0.8 H/s;
 *   2. that speed collapsing by at least 50% within 0.14 s — the claw has been STOPPED, which is
 *      where the air tears, not where it is still travelling;
 *   3. the stop happening at EXTENSION: hip-to-hand distance in the top 30% of that limb's range
 *      for the clip. A gesture reverses near the chest; a swipe ends reaching out.
 *
 * Percentiles rather than maxima, because one bad sample at t = duration — where the mixer snaps
 * the pose — would otherwise set the threshold for the whole clip and reject every real event.
 *
 * Test 3 is a percentile WITHIN a clip, which is what lets one detector serve clips of wildly
 * different amplitude, and also what lets a clip whose arms never extend nominate its least-bent
 * arm as an attack. So a candidate clears two ABSOLUTE floors as well: reach >= 0.30 H and speed
 * >= 2.2 H/s for a claw, 2.0 H/s for a toe. What that admits, and what it throws out:
 *
 *   slash          hand.l @ 2.070 s  v 6.57  reach 0.615  <- the fastest limb in the whole set, and
 *                  hand.r @ 2.103 s  v 5.72  reach 0.464     0.033 s behind it: both claws through
 *                                                            the same volume. This is the demo.
 *   box_02         hand.r @ 1.728 s  v 5.89  reach 0.578  <- second fastest, 0.204 s after the left
 *   front_kick_02  four events in 1.42 s                  <- a spin: two claws, a downward slam and
 *                                                            the leg, in that order
 *   run            hand.l @ 0.437 s  v 3.99  reach 0.474  <- clears both floors and is still not an
 *                                                            attack. A runner's arm stops at the top
 *                                                            of every swing; tearing the air four
 *                                                            times a second while running reads as a
 *                                                            bug. Locomotion is carried by the claw
 *                                                            trail, which is speed-driven anyway.
 *   jump_down      hand.l @ 0.847 s  v 3.61  reach 0.363  <- the arm swing of a hop, rejected for the
 *                                                            same reason. What that clip actually
 *                                                            lands is a two-foot stomp at 1.62 s,
 *                                                            drop 2.3-2.5 H/s — four times heavier
 *                                                            than any other contact in the set.
 *   defeat_03      hand.l @ 2.524 s  v 3.33                <- a collapse, not a swing: the arm is
 *                                                            falling with the body. Carried by the
 *                                                            chest stagger at 2.513 s instead.
 *   dance_05       four claw peaks over 2.33 s             <- fast, extended, and not an attack.
 *                                                            Not in the demo's action list at all.
 *   idle, fire, look_around, sit                           <- p95 claw speed 0.08-0.46: correctly
 *                                                            silent. `fire` is the channel pose and
 *                                                            is carried entirely by the aura.
 *
 * The 0.033 s gap between the two claws in `slash` is why that clip gets the crossed double crescent
 * rather than two independent tears: at 33 ms apart they are one attack, and drawing them as two
 * reads as a stutter.
 */

/** H, measured: the highest head position across the clip set plus a 4% crown margin. */
export const FIGURE_HEIGHT = 1.594;

/** Rig joints the effects hang off. These are the rig's own bone names, not bounds hypotheses. */
export const VFX_JOINTS = {
  clawL: 'L_Hand',
  clawR: 'R_Hand',
  toeL: 'L_ToeBase',
  toeR: 'R_ToeBase',
  footL: 'L_Foot',
  footR: 'R_Foot',
  head: 'Head',
  chest: 'Spine02',
  waist: 'Waist',
  hip: 'Hip',
  shoulderL: 'L_Upperarm',
  shoulderR: 'R_Upperarm',
} as const;

export type Limb = 'clawL' | 'clawR' | 'toeL' | 'toeR';

/**
 * What the air does, per attack. The kinds differ in MOTION first and colour second — a rend that
 * only differs from a swipe by being brighter is still a swipe.
 *
 *   swipe  one crescent along the travel, a short shear cone behind it
 *   rip    a faster swipe: longer cone, more shards, the crescent thrown wider
 *   rend   the double-claw signature — two crossed crescents and a void ring down the axis
 *   slam   downward: the crescent lies flat, the ring becomes a ground pulse
 *   kick   a heavy, low, blunt tear with few shards; a leg displaces air, it does not cut it
 */
export type StrikeKind = 'swipe' | 'rip' | 'rend' | 'slam' | 'kick';

export interface StrikeEvent {
  clip: string;
  limb: Limb;
  kind: StrikeKind;
  /** Seconds into the clip, at the frame the limb stops. */
  time: number;
  /** Measured speed at the stop, in figure heights per second. */
  speed: number;
  /** Hip-to-limb distance at the stop, in figure heights. */
  reach: number;
}

export const STRIKE_EVENTS: StrikeEvent[] = [
  // slash — the signature. Left claw is the fastest limb measured anywhere in the set.
  { clip: 'preset:biped:slash', limb: 'clawL', kind: 'rend', time: 2.070, speed: 6.57, reach: 0.615 },
  { clip: 'preset:biped:slash', limb: 'clawR', kind: 'rend', time: 2.103, speed: 5.72, reach: 0.464 },
  // box_01 — a single lead-claw swipe, high (y 0.751 H).
  { clip: 'preset:biped:box_01', limb: 'clawL', kind: 'swipe', time: 0.405, speed: 3.98, reach: 0.450 },
  // box_02 — a one-two: left then right 0.204 s later, the right the harder of the pair.
  { clip: 'preset:biped:box_02', limb: 'clawL', kind: 'swipe', time: 1.524, speed: 4.51, reach: 0.426 },
  { clip: 'preset:biped:box_02', limb: 'clawR', kind: 'rip', time: 1.728, speed: 5.89, reach: 0.578 },
  // box_03 — the furthest reach of the box set, thrown from overhead.
  { clip: 'preset:biped:box_03', limb: 'clawL', kind: 'swipe', time: 0.506, speed: 3.86, reach: 0.577 },
  // front_kick_01 — one leg, nothing from the arms (both under the speed floor).
  { clip: 'preset:biped:front_kick_01', limb: 'toeR', kind: 'kick', time: 0.966, speed: 3.88, reach: 0.539 },
  // front_kick_02 — a spin, in measured order: claws, then a downward slam, then the leg.
  { clip: 'preset:biped:front_kick_02', limb: 'clawL', kind: 'rip', time: 0.503, speed: 5.73, reach: 0.469 },
  { clip: 'preset:biped:front_kick_02', limb: 'clawR', kind: 'swipe', time: 0.535, speed: 4.75, reach: 0.356 },
  // Travel at this one is [0.18, -0.96, -0.21]: straight down, so it is a slam and not a swipe.
  { clip: 'preset:biped:front_kick_02', limb: 'clawL', kind: 'slam', time: 0.754, speed: 3.66, reach: 0.507 },
  { clip: 'preset:biped:front_kick_02', limb: 'toeR', kind: 'kick', time: 0.910, speed: 5.33, reach: 0.503 },
];

export interface FootfallEvent {
  clip: string;
  foot: 'left' | 'right';
  time: number;
  /** Descent speed over the 4 samples into contact, in figure heights per second. */
  drop: number;
}

/**
 * Weight arriving on the ground. Threshold crossings of the toe height, gated per clip and per foot
 * off that foot's own lift range — one fixed gate cannot serve a 0.79 H leap and a 0.01 H shuffle.
 * Anything under drop 0.18 is left out: below that the foot is being placed, not landed, and a puff
 * of ash under a placed foot reads as a leak.
 */
export const FOOTFALL_EVENTS: FootfallEvent[] = [
  // The leap. Both feet inside 7 ms, at four times the descent of anything else measured.
  { clip: 'preset:biped:jump_down', foot: 'right', time: 1.620, drop: 2.30 },
  { clip: 'preset:biped:jump_down', foot: 'left', time: 1.627, drop: 2.49 },
  { clip: 'preset:biped:run', foot: 'left', time: 0.212, drop: 0.67 },
  { clip: 'preset:biped:run', foot: 'right', time: 0.457, drop: 0.94 },
  { clip: 'preset:biped:run', foot: 'left', time: 0.721, drop: 0.60 },
  { clip: 'preset:biped:run', foot: 'right', time: 0.958, drop: 0.91 },
  { clip: 'preset:biped:walk', foot: 'left', time: 0.793, drop: 0.25 },
  { clip: 'preset:biped:walk', foot: 'right', time: 1.206, drop: 0.47 },
  { clip: 'preset:biped:walk', foot: 'left', time: 1.491, drop: 0.30 },
  { clip: 'preset:biped:box_01', foot: 'left', time: 0.432, drop: 0.44 },
  { clip: 'preset:biped:box_01', foot: 'right', time: 0.531, drop: 0.40 },
  { clip: 'preset:biped:box_02', foot: 'right', time: 0.618, drop: 0.28 },
  { clip: 'preset:biped:box_02', foot: 'right', time: 1.088, drop: 0.18 },
  { clip: 'preset:biped:box_03', foot: 'left', time: 0.584, drop: 0.57 },
  { clip: 'preset:biped:box_03', foot: 'right', time: 1.054, drop: 0.26 },
  // The landing of the kick, which is heavier than the kick itself.
  { clip: 'preset:biped:front_kick_01', foot: 'right', time: 1.595, drop: 1.74 },
  { clip: 'preset:biped:front_kick_02', foot: 'right', time: 1.084, drop: 1.49 },
  { clip: 'preset:biped:defeat_03', foot: 'left', time: 0.860, drop: 0.50 },
  { clip: 'preset:biped:defeat_03', foot: 'right', time: 2.903, drop: 0.60 },
];

export interface StaggerEvent {
  clip: string;
  joint: 'head' | 'chest';
  time: number;
  /** Speed of the driven joint at the peak, in figure heights per second. */
  speed: number;
}

/**
 * Blows the monster TAKES. The strike detector cannot see these: the force arrives from outside the
 * clip, so nothing accelerates to extension — what is measurable is the head or chest being driven
 * and then stopped. `jump_down` reports a head peak at 1.792 s that is the recoil of its own
 * landing, 0.17 s after the stomp already fired; it is left out rather than double-counted.
 */
export const STAGGER_EVENTS: StaggerEvent[] = [
  { clip: 'preset:biped:hit_to_body_01', joint: 'head', time: 0.253, speed: 0.59 },
  { clip: 'preset:biped:hit_to_body_02', joint: 'head', time: 0.538, speed: 0.76 },
  { clip: 'preset:biped:hit_to_body_02', joint: 'head', time: 1.120, speed: 0.42 },
  // The collapse itself: the body meeting the ground, measured at the chest.
  { clip: 'preset:biped:defeat_03', joint: 'chest', time: 2.513, speed: 1.64 },
];

/**
 * Clips that carry the figure out of frame, with the measured drift of one loop in figure heights.
 * Held in place by subtracting the hip's own horizontal displacement; the stride itself is
 * untouched, so contacts, ash and trails still happen exactly where the sweep measured them.
 */
export const ROOT_LOCKED_CLIPS: Record<string, number> = {
  'preset:biped:run': 3.042,
  'preset:biped:walk': 1.558,
  'preset:biped:jump_down': 1.133,
};

/**
 * Per-clip claw speed the trail is normalised against: the measured p95 of the faster hand, floored
 * at 1.8 H/s. Without the floor a clip whose hands barely move — `fire` measures p95 0.15 — would
 * give its slowest drift a full-strength trail, and the channel pose would rake the air while
 * standing still.
 */
export const CLIP_TRAIL_REFERENCE: Record<string, number> = {
  'preset:biped:idle': 1.8,
  'preset:biped:fire': 1.8,
  'preset:biped:sit': 1.8,
  'preset:biped:look_around': 1.8,
  'preset:biped:hit_to_body_01': 1.8,
  'preset:biped:hit_to_body_02': 1.8,
  'preset:biped:walk': 1.8,
  'preset:biped:slash': 1.8,
  'preset:biped:defeat_03': 2.25,
  'preset:biped:front_kick_01': 2.23,
  'preset:biped:jump_down': 2.72,
  'preset:biped:box_03': 2.83,
  'preset:biped:box_01': 2.93,
  'preset:biped:front_kick_02': 5.20,
  'preset:biped:box_02': 5.64,
  'preset:biped:run': 7.47,
};

/** Below this fraction of the clip's reference speed a claw leaves no trail at all. */
export const TRAIL_GATE = 0.42;

export const MONSTER_IDLE_CLIP = 'preset:biped:idle';

export interface MonsterAction {
  id: string;
  label: string;
  clip: string;
  note: string;
}

/** The curated set. Twenty-seven clips ship with the rig; these are the ones a monster does. */
export const MONSTER_ACTIONS: MonsterAction[] = [
  { id: 'rend', label: 'Rend the Air', clip: 'preset:biped:slash', note: 'Both claws through the same volume 33 ms apart — the fastest limbs measured in the set (6.57 and 5.72 H/s).' },
  { id: 'claw-jab', label: 'Claw Jab', clip: 'preset:biped:box_01', note: 'One lead-claw swipe at 3.98 H/s, thrown high.' },
  { id: 'claw-combo', label: 'Claw Combo', clip: 'preset:biped:box_02', note: 'A one-two: left at 1.524 s, right 0.204 s later and harder.' },
  { id: 'overhead-rake', label: 'Overhead Rake', clip: 'preset:biped:box_03', note: 'The furthest reach of the box set (0.577 H), thrown from above the head.' },
  { id: 'rising-kick', label: 'Rising Kick', clip: 'preset:biped:front_kick_01', note: 'One leg at 3.88 H/s; the landing at 1.595 s is heavier than the kick.' },
  { id: 'spin-flurry', label: 'Spin Flurry', clip: 'preset:biped:front_kick_02', note: 'Four measured strikes in 1.42 s: two claws, a downward slam, then the leg.' },
  { id: 'leap', label: 'Leap & Stomp', clip: 'preset:biped:jump_down', note: 'A two-foot landing at drop 2.3-2.5 H/s, four times any other contact. Root-locked.' },
  { id: 'charge', label: 'Charge', clip: 'preset:biped:run', note: 'Carries 3.042 H per loop, held in place. Four contacts a loop; the claws only trail.' },
  { id: 'stalk', label: 'Stalk', clip: 'preset:biped:walk', note: 'Carries 1.558 H per loop, held in place.' },
  { id: 'prowl', label: 'Prowl', clip: 'preset:biped:look_around', note: 'Silent by measurement: p95 claw speed 0.46 H/s. The aura carries it.' },
  { id: 'channel', label: 'Channel the Abyss', clip: 'preset:biped:fire', note: 'The stillest clip in the set (p95 0.15 H/s). Everything you see here is the aura winding up.' },
  { id: 'take-hit', label: 'Take a Hit', clip: 'preset:biped:hit_to_body_02', note: 'Two blows arriving from outside the clip, at 0.538 s and 1.120 s.' },
  { id: 'collapse', label: 'Collapse', clip: 'preset:biped:defeat_03', note: 'The body meeting the ground at 2.513 s; the aura goes out with it.' },
];
