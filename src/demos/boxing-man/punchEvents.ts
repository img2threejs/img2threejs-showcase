/**
 * Where the punches are — measured off the embedded rig, not eyeballed off a scrub bar.
 *
 * An impact flare that fires 80 ms after the glove has already stopped reads as a bug, and
 * "watch the clip and write down a timestamp" does not survive a clip being renamed, retimed or
 * reordered. So every number below came out of a sweep of all nineteen embedded clips at 400
 * samples each, tracking the WORLD position of both hands, both toes, the head, the chest and the
 * hip through the same skeleton the demo renders (`buildSkeleton` + `buildClips` from meshCodec,
 * driven by an AnimationMixer in Node). Distances are in figure heights (H = 2.152 world units,
 * the highest head position across the set plus a crown margin) so nothing here depends on the
 * normalisation scale staying what it is today.
 *
 * A PUNCH is three things happening at once, which is what separates a landed blow from an arm
 * merely reversing direction:
 *
 *   1. a local maximum in hand speed at or above 45% of that hand's 95th-percentile speed for the
 *      clip, and at least 0.8 H/s;
 *   2. that speed collapsing by at least 50% within 0.14 s — the glove is STOPPED, not curving;
 *   3. the stop happening at EXTENSION: hip-to-hand distance in the top 30% of that hand's range
 *      for the clip. A gesture reverses close to the chest; a punch ends reaching out.
 *
 * Percentiles rather than maxima, because one bad sample at `t = duration` — where the mixer snaps
 * the pose — would otherwise set the threshold for the whole clip and reject every real event in it.
 *
 * Test 3 is a percentile WITHIN a clip, which is what lets one detector serve clips of very
 * different amplitude — and also what lets a clip whose hands never extend report its least bent arm
 * as a strike. So a candidate must clear two ABSOLUTE floors as well: reach >= 0.30 H and speed
 * >= 2.4 H/s. What that admits, and what it throws out:
 *
 *   box_01     hand.l @ 0.405 s  v 2.64 H/s  reach 0.320  <- one lead-hand punch, nothing else
 *   box_02     hand.l @ 1.524 s  v 2.92      reach 0.304  <- and 0.204 s later:
 *              hand.r @ 1.728 s  v 3.75      reach 0.380  <- the fastest hand event in the set
 *   box_03     hand.l @ 0.506 s  v 2.62      reach 0.387  <- furthest reach, highest contact (0.713 H)
 *   box_02     hand.l @ 1.224 s  v 1.07      reach 0.348  <- rejected on speed: a feint, not a punch
 *   jump       three peaks per hand, reach 0.21-0.23      <- rejected on reach. The clip's top-30%
 *                                                            reach is 0.226 H: the hands stay by the
 *                                                            chest all hop. That is an arm swing.
 *   run        hand.l @ 0.437 s  v 3.02      reach 0.325  <- clears both floors and is still not a
 *                                                            punch. A runner's arm stops at the top
 *                                                            of every swing; flaring four times a
 *                                                            second while jogging reads as a bug.
 *                                                            Locomotion is carried by the trail.
 *   warm_up    p95 hand speed 1.16, nothing at all        <- 14.7 s of shadow work, correctly quiet
 *   hit_to_body_01, wave_goodbye_01, dance_06             <- nothing; none of them throw anything
 *
 * `box_02` measuring a 0.204 s gap between the two hands is independent support for reading it as a
 * one-two: the published elite-boxer literature puts fist speed at 8-12 m/s and the second punch of
 * a combination about 0.2 s behind the first, which is what this rig actually does.
 *
 * Regenerate all of it with `node scripts/measure-boxing-events.mjs`, which prints the accepted
 * events and, separately, the candidates the floors rejected.
 */

/** Rig joints the effects hang off. These are the rig's own bone names, not hypotheses. */
export const VFX_JOINTS = {
  handL: 'L_Hand',
  handR: 'R_Hand',
  toeL: 'L_ToeBase',
  toeR: 'R_ToeBase',
  footL: 'L_Foot',
  footR: 'R_Foot',
  head: 'Head',
  chest: 'Spine02',
  hip: 'Hip',
} as const;

/** Figure height used for every normalised number in this file, in world units. */
export const FIGURE_HEIGHT = 2.152;

export type Glove = 'left' | 'right';

/**
 * How a punch should read. The three differ in MOTION and not only in colour — recolouring one
 * impact three times gives three impacts that all feel like the same punch.
 *
 * `jab`      a fast straight lead: narrow air-tear, tight ring, small spray, no floor coupling.
 * `cross`    the power hand behind full hip rotation: wide flare, twin rings, floor ripple, hitstop.
 * `hook`     an arc through the head line: the crescent is swept sideways and the spray fans wide.
 */
export type PunchKind = 'jab' | 'cross' | 'hook';

export interface PunchEvent {
  readonly clip: string;
  readonly glove: Glove;
  /** Seconds into the clip. Never equal to the clip duration. */
  readonly time: number;
  /** Hand speed at the peak, in figure heights per second. */
  readonly speed: number;
  /** Fraction of that speed lost within the following 0.14 s. */
  readonly decel: number;
  /** Hip-to-hand distance at the stop, in figure heights. */
  readonly reach: number;
  /** Contact height, in figure heights — 0.71 is the head line, 0.62 the chest. */
  readonly height: number;
  readonly kind: PunchKind;
}

export const PUNCH_EVENTS: readonly PunchEvent[] = [
  { clip: 'preset:biped:box_01', glove: 'left', time: 0.405, speed: 2.64, decel: 0.82, reach: 0.320, height: 0.664, kind: 'jab' },
  /**
   * The one-two. The left lands first and shorter (reach 0.304), the right 0.204 s later at the
   * longest reach and highest speed measured anywhere in the set — the shape of a jab setting up a
   * cross, which is why the two are typed differently and the right gets the floor ripple.
   */
  { clip: 'preset:biped:box_02', glove: 'left', time: 1.524, speed: 2.92, decel: 0.76, reach: 0.304, height: 0.618, kind: 'jab' },
  { clip: 'preset:biped:box_02', glove: 'right', time: 1.728, speed: 3.75, decel: 0.93, reach: 0.380, height: 0.654, kind: 'cross' },
  /**
   * Contact at 0.713 H — the head line — at the clip's maximum hand reach. A straight punch from
   * this rig lands at 0.62-0.67 H; this one arrives higher and further, which is a hook.
   */
  { clip: 'preset:biped:box_03', glove: 'left', time: 0.506, speed: 2.62, decel: 0.64, reach: 0.387, height: 0.713, kind: 'hook' },
];

export type Foot = 'left' | 'right';

export interface FootfallEvent {
  readonly clip: string;
  readonly foot: Foot;
  readonly time: number;
  /**
   * Descent speed over the 4 samples before contact, in figure heights per second. Measured on the
   * APPROACH and not at the contact itself: a local minimum has zero derivative by definition, so
   * the first pass at this reported ~0 for every landing in the set, including a running stride.
   */
  readonly drop: number;
}

/**
 * Ground contacts, detected as threshold CROSSINGS rather than as height minima, with the gate set
 * per clip and per foot from that foot's own lift range (contact at 30% of the range, armed only
 * once the foot has passed 65%). A fixed gate cannot serve both a running stride, which lifts the
 * toe 0.15 H, and the 0.013 H shuffle of a boxer holding his stance — one reports every frame as a
 * footfall, the other reports none.
 *
 * Contacts below 0.18 H/s of descent are dropped: a foot rolling over a planted toe displaces no
 * dust, and firing a puff for it made the stance look like it was standing in a smoke machine.
 * That is why `warm_up` and `dance_05` have no entries at all — their heaviest contact descends at
 * 0.10 and 0.12 H/s. The idle stays clean on purpose.
 */
export const FOOTFALL_EVENTS: readonly FootfallEvent[] = [
  // Hops: six landings, the heaviest contacts in the whole set.
  { clip: 'preset:jump', foot: 'left', time: 0.283, drop: 1.97 },
  { clip: 'preset:jump', foot: 'right', time: 0.301, drop: 1.93 },
  { clip: 'preset:jump', foot: 'left', time: 0.711, drop: 1.93 },
  { clip: 'preset:jump', foot: 'right', time: 0.729, drop: 1.89 },
  { clip: 'preset:jump', foot: 'left', time: 1.053, drop: 1.85 },
  { clip: 'preset:jump', foot: 'right', time: 1.066, drop: 1.98 },
  // Roadwork stride.
  { clip: 'preset:run', foot: 'left', time: 0.176, drop: 0.56 },
  { clip: 'preset:run', foot: 'right', time: 0.457, drop: 0.97 },
  { clip: 'preset:run', foot: 'left', time: 0.682, drop: 0.55 },
  { clip: 'preset:run', foot: 'right', time: 0.958, drop: 0.93 },
  // Ring walk.
  { clip: 'preset:walk', foot: 'left', time: 0.570, drop: 0.37 },
  { clip: 'preset:walk', foot: 'right', time: 1.192, drop: 0.42 },
  { clip: 'preset:walk', foot: 'left', time: 1.491, drop: 0.45 },
  // Stance work inside the punching clips: the step that carries the weight into the punch.
  { clip: 'preset:biped:box_01', foot: 'left', time: 0.423, drop: 0.46 },
  { clip: 'preset:biped:box_01', foot: 'right', time: 0.535, drop: 0.30 },
  { clip: 'preset:biped:box_01', foot: 'right', time: 1.273, drop: 0.20 },
  /**
   * The rear-foot pivot at 1.071 s, 0.657 s before the cross lands. Rotating onto that foot is
   * where the power in a cross comes from, and it is the one footfall in the set worth reading as
   * part of a punch rather than as locomotion.
   */
  { clip: 'preset:biped:box_02', foot: 'right', time: 0.640, drop: 0.21 },
  { clip: 'preset:biped:box_02', foot: 'right', time: 1.071, drop: 0.30 },
  { clip: 'preset:biped:box_03', foot: 'left', time: 0.584, drop: 0.54 },
];

export interface AbsorbEvent {
  readonly clip: string;
  readonly time: number;
  /** Which joint the blow is absorbed on — the anchor the effect is placed at. */
  readonly joint: 'chest' | 'head';
  /** Peak head speed the blow drives, in figure heights per second. */
  readonly speed: number;
}

/**
 * Blows this figure TAKES rather than throws. The punch detector cannot find these — nothing here
 * accelerates and stops at extension, because the force arrives from outside the clip — so they are
 * measured the other way round: the head is DRIVEN, peaking and then collapsing by more than 55%.
 *
 * `hit_to_body_01` peaks the head at 0.91 H/s at 0.237 s, collapsing 89%, while the hip RISES from
 * 0.454 to 0.483 H over the same window. The body is being lifted and folded, which puts the glove
 * on the torso a little before the head snaps — hence 0.20 s and the chest anchor.
 */
export const ABSORB_EVENTS: readonly AbsorbEvent[] = [
  { clip: 'preset:biped:hit_to_body_01', time: 0.200, joint: 'chest', speed: 0.91 },
];

/**
 * Hand speed at which a glove trail reaches full strength, per clip, in figure heights per second.
 *
 * Each is that clip's own measured 95th-percentile hand speed, so the trail is calibrated to the
 * clip it plays in. One number for everything cannot work: a value tuned on `run` (p95 5.33) leaves
 * `box_03` (2.03) with no trail at all, and one tuned on `warm_up` (1.16) smears the roadwork into
 * a solid ribbon.
 */
export const CLIP_TRAIL_REFERENCE: Readonly<Record<string, number>> = {
  'preset:jump': 2.85,
  'preset:run': 5.33,
  'preset:walk': 1.27,
  'preset:biped:box_01': 2.14,
  'preset:biped:box_02': 3.56,
  'preset:biped:box_03': 2.03,
  'preset:biped:defeat_02': 0.64,
  'preset:biped:hit_to_body_01': 0.59,
  'preset:biped:warm_up': 1.16,
  'preset:biped:dance_05': 2.92,
};

/** Below this share of the clip reference a glove leaves no trail, so the stance stays clean. */
export const TRAIL_GATE = 0.30;

/**
 * Clips whose root travels, with the distance it travels over one loop in figure heights.
 *
 * `run` carries the figure 2.725 H forward in 1.03 s and `walk` 1.396 H in 1.9 s — three seconds of
 * either and the boxer has left the frame. Both are held in place at runtime by subtracting the
 * hip's horizontal displacement from the model group, which is a treadmill and not a retime: the
 * stride, the contact timings and the dust all stay exactly where they were measured.
 *
 * Every other clip in the demo drifts under 0.07 H and is left alone.
 */
export const ROOT_LOCKED_CLIPS: Readonly<Record<string, number>> = {
  'preset:run': 2.725,
  'preset:walk': 1.396,
};

export interface BoxingAction {
  /** Button id in the demo panel. */
  readonly id: string;
  readonly label: string;
  /** Clip name inside the embedded rig. */
  readonly clip: string;
  /** One-line note for the button tooltip — what the sweep measured in this clip. */
  readonly note: string;
}

/**
 * THE DEFAULT IS THE ONE-TWO.
 *
 * `warm_up` is the obvious idle — fourteen seconds long, literally called warm-up — and it is the
 * wrong one: measured, it spends 1.9 s to 4.9 s with the hip at 0.31 H, which is a floor stretch,
 * and its shoulder line swings through 270 degrees, so a visitor's first three seconds would be the
 * boxer's back while he touches his toes.
 *
 * `box_02` is the combination this demo exists to show. Over its 2.27 s loop it lands the jab at
 * 1.524 s and the cross 0.204 s behind it — the fastest hand event measured anywhere in the set,
 * and the only punch that couples through the floor — so the full effect stack (windup charge, air
 * tear, twin rings, spray, canvas ripple, hitstop) plays once per loop without anyone pressing
 * anything. Its root drifts 0.066 H per loop, so it needs no lock, and it faces 99-105 degrees at
 * both contacts, which is where the camera is authored.
 *
 * The single jab keeps its own button, and so does the warm-up.
 */
export const BOXING_IDLE_CLIP = 'preset:biped:box_02';

/**
 * What the default action calls itself.
 *
 * Not the conventional `idle`, because the panel prints exactly this: the viewer labels the status
 * "Idle" for an action of that name and anything else by its own id, and "Idle" is a false caption
 * for a figure throwing a one-two. Nothing else in the gallery keys off the string.
 */
export const BOXING_IDLE_ID = 'one-two';

export const BOXING_ACTIONS: readonly BoxingAction[] = [
  { id: 'jab', label: 'Jab', clip: 'preset:biped:box_01',
    note: 'lead hand, one punch at 0.405 s — 2.64 H/s, stopped 82% inside 0.14 s' },
  { id: 'hook', label: 'Hook', clip: 'preset:biped:box_03',
    note: 'arc to the head line — contact at 0.713 H, the clip’s longest reach' },
  { id: 'body-shot', label: 'Body Shot Taken', clip: 'preset:biped:hit_to_body_01',
    note: 'a blow absorbed: the head is driven to 0.91 H/s at 0.237 s and folds' },
  { id: 'footwork', label: 'Footwork', clip: 'preset:jump',
    note: 'six landings, the heaviest contacts in the set (descent 1.85-1.98 H/s)' },
  { id: 'ring-walk', label: 'Ring Walk', clip: 'preset:walk',
    note: 'held in place: the clip carries the root 1.396 H forward per loop' },
  { id: 'roadwork', label: 'Roadwork', clip: 'preset:run',
    note: 'held in place: 2.725 H per 1.03 s loop, p95 hand speed 5.33 H/s' },
  { id: 'warm-up', label: 'Warm-up', clip: 'preset:biped:warm_up',
    note: '14.67 s of shadow work and stretching; no punch clears the detector in any of it' },
  { id: 'defeat', label: 'Defeat', clip: 'preset:biped:defeat_02',
    note: 'no impact anywhere in 6.8 s — sweat and breath only' },
  { id: 'victory', label: 'Victory', clip: 'preset:biped:dance_05',
    note: 'celebration flourish at 0.957 s; no contact, so no impact fires' },
];

export function punchesForClip(clip: string): readonly PunchEvent[] {
  return PUNCH_EVENTS.filter((event) => event.clip === clip);
}

export function footfallsForClip(clip: string): readonly FootfallEvent[] {
  return FOOTFALL_EVENTS.filter((event) => event.clip === clip);
}

export function absorbsForClip(clip: string): readonly AbsorbEvent[] {
  return ABSORB_EVENTS.filter((event) => event.clip === clip);
}
