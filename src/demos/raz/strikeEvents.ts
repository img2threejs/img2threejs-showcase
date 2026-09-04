/**
 * Where the blows land — measured off the embedded rig, not read off a scrub bar.
 *
 * An impact flare that fires 80 ms after the fist has already stopped reads as a bug, and "watch
 * the clip and write down a timestamp" does not survive a clip being renamed, retimed or reordered.
 * So every number below came out of `node scripts/measure-raz-strikes.mjs`: a sweep of all
 * twenty-four embedded clips at 400 samples each, tracking the WORLD position of both hands, both
 * toes, both ankles, the head, the chest and the hip through the same skeleton the demo renders
 * (`buildSkeleton` + `buildClips` from meshCodec, driven by an AnimationMixer in Node).
 *
 * Distances are in figure heights — H = 2.115 world units, the highest head across the whole set
 * plus a 6% crown margin — so nothing here depends on the normalisation scale staying what it is.
 *
 * A STRIKE is an EXTENSION APEX arrived at speed: a local maximum of hip-to-limb distance (which is
 * where the limb reverses, and therefore where contact is) that the limb reached fast, from far
 * out, while getting longer rather than shorter.
 *
 * Two earlier detectors are worth recording because they are the obvious first guesses and both are
 * wrong:
 *
 *   1. "hand speed collapses by half within 0.14 s". Correct for a punch — a straight lead stops
 *      dead — and it rejected EVERY kick in the set. `front_kick_02` crosses its furthest point
 *      still travelling 5.22 H/s and is retracting at 3.7 H/s one frame later.
 *   2. "speed at the apex is under three quarters of the approach". The same failure, softer: it
 *      admitted the combination and still threw out both kicks.
 *
 * No purely kinematic gate separated locomotion from strikes across this set without also throwing
 * out a real kick — a runner's arm stops at the top of every swing, and flaring four times a second
 * while jogging reads as a bug. So the detector is tuned for RECALL and locomotion is excluded HERE,
 * by name, where the reason can be written down: `run`, `walk`, `jump` and `jump_rope_01` all report
 * apexes and none of them is a blow. Their motion is carried by the plumes and the footfalls.
 */

/** Rig joints the effects hang off. These are the rig's own bone names, not bounds hypotheses. */
export const VFX_JOINTS = {
  handL: 'L_Hand',
  handR: 'R_Hand',
  toeL: 'L_ToeBase',
  toeR: 'R_ToeBase',
  footL: 'L_Foot',
  footR: 'R_Foot',
  forearmL: 'L_Forearm',
  forearmR: 'R_Forearm',
  shoulderL: 'L_Upperarm',
  shoulderR: 'R_Upperarm',
  head: 'Head',
  chest: 'Spine02',
  hip: 'Hip',
} as const;

/** Figure height used for every normalised number in this file, in world units. */
export const FIGURE_HEIGHT = 2.115;

/**
 * The four jade blocks the reference photograph shows: crystal knuckles on both fists and glowing
 * crystal soles under both boots. Every plume, every charge and every burst is anchored to one of
 * these, which is why they are named rather than derived — the effect belongs to the CRYSTAL, not
 * to the limb, and a future rig with a wrist bone would move the anchor without changing the idea.
 */
export type JadeBlock = 'handL' | 'handR' | 'footL' | 'footR';

export const JADE_BLOCKS: readonly JadeBlock[] = ['handL', 'handR', 'footL', 'footR'];

/**
 * How a blow should READ, and not only what colour it is. Recolouring one impact four times gives
 * four impacts that all feel like the same punch, so the four kinds differ in geometry:
 *
 * `straight`  a lead going out in a line: one tight ring on the travel axis, a narrow shard cone.
 * `cross`     the power hand behind the hips: twin rings, a wider cone, a floor ripple, hitstop.
 * `hook`      an arc through the head line: the ring is rolled onto the swing plane and the shards
 *             fan sideways rather than forward.
 * `kick`      a boot: the heaviest ring, shards thrown down as well as out, and the ground couples.
 * `knockout`  the finish: three rings instead of two, the widest shard cone, the deepest floor
 *             coupling, and two thirds again the hitstop of a kick. It is not the kick recoloured —
 *             every one of those is a different NUMBER of things or a different direction, which is
 *             the whole rule this table exists to enforce.
 */
export type StrikeKind = 'straight' | 'cross' | 'hook' | 'kick' | 'knockout';

export interface StrikeEvent {
  readonly clip: string;
  readonly block: JadeBlock;
  /** Seconds into the clip, at the extension apex. Never equal to the clip duration. */
  readonly time: number;
  /** Approach speed into the apex, in figure heights per second. */
  readonly speed: number;
  /** Hip-to-limb distance at the apex, in figure heights. */
  readonly reach: number;
  /** Contact height, in figure heights — 0.71 is the head line on this figure, 0.62 the chest. */
  readonly height: number;
  readonly kind: StrikeKind;
  /**
   * Fire this contact only while the named action is playing.
   *
   * The imported uppercut belongs specifically to the Knockout choreography. Scoping keeps the
   * measured row from becoming a generic hit if a host previews the source clip directly.
   *
   * Absent means the contact belongs to the clip and fires for anything that plays it.
   */
  readonly action?: string;
}

/**
 * Every accepted event, per curated clip.
 *
 * `box_02` is three punches and not two: the right leads at 1.835 s (1.91 H/s), the left answers
 * 0.127 s later at 2.25, and the right returns at 2.252 s at 2.59 H/s and the longest hand reach of
 * the three. That last one is typed `cross` — it is the power hand arriving behind the other two,
 * which is why it is the one that couples through the floor and buys hitstop.
 *
 * `front_kick_01` lands TWICE: a low boot at 0.363 H and then, 0.293 s later, the same foot at
 * 0.881 H — head height — at the longest reach any limb makes in the set alongside `front_kick_02`.
 *
 * `front_kick_02` carries the fastest limb event measured anywhere here: 5.22 H/s, more than double
 * the hardest punch. Its left hand also reports an apex at 0.832 s, and it is NOT a strike — at
 * 0.220 H that hand is down by the knee, counterweighting the kick. It is excluded on height.
 */
export const STRIKE_EVENTS: readonly StrikeEvent[] = [
  { clip: 'preset:biped:box_01', block: 'handL', time: 0.619, speed: 2.48, reach: 0.373, height: 0.611, kind: 'straight' },

  { clip: 'preset:biped:box_02', block: 'handR', time: 1.835, speed: 1.91, reach: 0.334, height: 0.666, kind: 'straight' },
  { clip: 'preset:biped:box_02', block: 'handL', time: 1.962, speed: 2.25, reach: 0.342, height: 0.703, kind: 'straight' },
  { clip: 'preset:biped:box_02', block: 'handR', time: 2.252, speed: 2.59, reach: 0.366, height: 0.691, kind: 'cross' },

  { clip: 'preset:biped:box_03', block: 'handL', time: 0.665, speed: 1.99, reach: 0.391, height: 0.741, kind: 'hook' },

  { clip: 'preset:biped:front_kick_01', block: 'footR', time: 0.832, speed: 3.70, reach: 0.488, height: 0.363, kind: 'kick' },
  { clip: 'preset:biped:front_kick_01', block: 'footR', time: 1.125, speed: 3.17, reach: 0.532, height: 0.881, kind: 'kick' },

  { clip: 'preset:biped:front_kick_02', block: 'footR', time: 0.751, speed: 5.22, reach: 0.532, height: 0.714, kind: 'kick' },

  /**
   * THE UPPERCUT, and the one row in this table the strike sweep did not find.
   *
   * `measure-raz-strikes.mjs` rejected it, correctly by its own rules and wrongly for this purpose,
   * and the reason is the technique rather than a bug. That detector gates a hand on 1.9 H/s; this
   * fist lands at 1.00. An uppercut is a SHORT punch driven up through the legs and hips — the hand
   * never has to reach the speed of a lead thrown from the shoulder, so a hand-speed gate cannot see
   * one, and every clip that DOES pass that gate throws its punches horizontally.
   *
   * So it is measured by a second instrument, `scripts/probe-raz-rising-hands.mjs`, which reads the
   * geometry the technique actually specifies: the ELEVATION of hand travel, the ELBOW angle, and
   * whether the HIP is still rising underneath. Against those three, `angry_03`'s left hand is the
   * only uppercut in the twenty-four clips:
   *
   *   load      2.556 s   fist at 0.397 H, reach 0.120 H, elbow 87° — tucked in, arm already folded
   *   CONTACT   2.918 s   0.670 H at 72° of elevation, elbow 88°, hip climbing at 0.35 H/s,
   *                       0.045 H under the chin line
   *   apex      3.045 s   0.721 H, elbow CLOSING to 62° — the arm never extends
   *
   * and the hip carries 0.369 -> 0.491 H through it. That last number is the punch: 0.122 H of body
   * rising under a hand that only travels 0.324 H, which is what "the power comes from the hips and
   * the legs, not the arm" looks like when it is measured.
   *
   * TWO EARLIER ROWS SAT HERE AND BOTH WERE WRONG, in ways only the elbow could show:
   *
   *   - `box_03` handL, chosen for finishing highest. It travels 20° above horizontal at its own
   *     contact. It is an arc, which is why the table types it `hook`.
   *   - `angry_03` handR, chosen for rising steeply — 81°, and it does reach 0.908 H, the highest
   *     hand anywhere here. But its elbow sits at 120° at the load, 120° at the contact and 121° at
   *     the apex: it never bends and never closes. That is a fist CARRIED up by the torso, not
   *     punched up, and the same clip's left hand does the real thing 1.3 s later.
   *
   * The contact is the frame nearest a right angle at the elbow among those rising at 60°+ within
   * 0.08 H of the chin — the rule is in the probe, so this row can be regenerated rather than
   * defended. It lands at chin height and not overhead, because that is where a chin is.
   */
  /**
   * Retargeted from the supplied Uppercut FBX using WORLD ROTATION DELTAS from each source bone's
   * rest orientation, applied on top of the corresponding Raz rest orientation. Target bone
   * positions and scales remain Raz's bind values; unmapped twist bones keep local rest and follow
   * their animated parents.
   *
   * The corrected contact rises at 4.82 H/s to 0.812 H, at 61-64 degrees with a 94-degree elbow.
   * At the rendered contact its skinned edge p01-p99 is 0.659-1.599 versus 0.368-3.387 for the old
   * direct-world-copy retarget, which is why the former pose keeps Raz's volume and the latter did not.
   */
  { clip: 'preset:biped:uppercut', block: 'handL', time: 0.536, speed: 4.82, reach: 0.380, height: 0.812, kind: 'knockout', action: 'knockout' },

  /** Native planted fallback retained for measurement, but not used by the Knockout action. */
  { clip: 'preset:biped:angry_03', block: 'handL', time: 2.918, speed: 1.00, reach: 0.233, height: 0.670, kind: 'knockout', action: 'uppercut-planted' },
];

export interface FootfallEvent {
  readonly clip: string;
  readonly block: Extract<JadeBlock, 'footL' | 'footR'>;
  readonly time: number;
  /**
   * Descent speed over the 4 samples before contact, in figure heights per second. Measured on the
   * APPROACH and not at the contact: a local minimum has zero derivative by definition, so a first
   * pass at this reported ~0 for every landing in the set, including a running stride.
   */
  readonly drop: number;
}

/**
 * Ground contacts, detected as threshold CROSSINGS rather than as height minima, with the gate set
 * per clip and per foot from that foot's own lift range (contact at 30% of the range, armed only
 * once the foot has passed 65%). A fixed gate cannot serve both a running stride, which lifts the
 * toe far, and the 0.01 H shuffle of a fighter holding his stance: one reports every frame as a
 * footfall, the other reports none.
 *
 * Contacts descending under 0.18 H/s are dropped — a foot rolling over a planted toe scatters no
 * embers, and firing a puff for one made the stance look like it was standing in a smoke machine.
 */
export const FOOTFALL_EVENTS: readonly FootfallEvent[] = [
  // Footwork hops: five landings, the heaviest contacts in the set.
  { clip: 'preset:jump', block: 'footR', time: 0.301, drop: 1.93 },
  { clip: 'preset:jump', block: 'footL', time: 0.711, drop: 1.89 },
  { clip: 'preset:jump', block: 'footR', time: 0.729, drop: 1.91 },
  { clip: 'preset:jump', block: 'footL', time: 1.053, drop: 1.90 },
  { clip: 'preset:jump', block: 'footR', time: 1.066, drop: 2.06 },
  // Roadwork stride.
  { clip: 'preset:biped:run', block: 'footL', time: 0.186, drop: 0.60 },
  { clip: 'preset:biped:run', block: 'footR', time: 0.460, drop: 1.07 },
  { clip: 'preset:biped:run', block: 'footL', time: 0.695, drop: 0.37 },
  { clip: 'preset:biped:run', block: 'footR', time: 0.961, drop: 1.02 },
  // Stance work inside the punching clips: the step that carries the weight into the punch.
  { clip: 'preset:biped:box_01', block: 'footL', time: 0.534, drop: 0.37 },
  { clip: 'preset:biped:box_01', block: 'footR', time: 0.681, drop: 0.20 },
  { clip: 'preset:biped:box_01', block: 'footR', time: 1.569, drop: 0.20 },
  /** The rear-foot pivot 0.920 s before the cross lands — where the power in a cross comes from. */
  { clip: 'preset:biped:box_02', block: 'footR', time: 1.332, drop: 0.29 },
  { clip: 'preset:biped:box_03', block: 'footL', time: 0.730, drop: 0.43 },
  // The recovery step each kick comes down on, both a good deal heavier than any boxing footfall.
  { clip: 'preset:biped:front_kick_01', block: 'footR', time: 1.608, drop: 1.54 },
  { clip: 'preset:biped:front_kick_02', block: 'footR', time: 1.094, drop: 1.36 },
  // The stamp in the middle of the rage clip, as heavy as a hop landing.
  { clip: 'preset:biped:angry_01', block: 'footR', time: 2.311, drop: 1.89 },
  /**
   * The uppercut's landing. The left settles first as the drive finishes, then the right comes down
   * hard — and 1.767 s is what the knockout's hop is timed to land ON, so the figure meets the floor
   * on a contact the clip itself puts weight through rather than on a moment chosen to look right.
   */
  { clip: 'preset:biped:angry_03', block: 'footL', time: 1.767, drop: 0.25 },
  { clip: 'preset:biped:angry_03', block: 'footR', time: 1.894, drop: 1.59 },
  // Three weight shifts across the guard-down clip, the only thing that happens in 5.58 s.
  { clip: 'preset:biped:defeat_03', block: 'footL', time: 1.075, drop: 0.41 },
  { clip: 'preset:biped:defeat_03', block: 'footR', time: 1.773, drop: 0.44 },
  { clip: 'preset:biped:defeat_03', block: 'footR', time: 3.671, drop: 0.53 },
];

/**
 * Limb speed at which a plume reaches full roar, per clip, in figure heights per second.
 *
 * Each is that clip's own measured 95th-percentile limb speed, so the plumes are calibrated to the
 * clip they play in. One number for everything cannot work: a value tuned on `run` (p95 6.08) leaves
 * `box_01` (1.55) with no plume at all, and one tuned on `box_01` turns the roadwork into a solid
 * wall of green.
 */
export const CLIP_PLUME_REFERENCE: Readonly<Record<string, number>> = {
  'preset:jump': 3.10,
  'preset:biped:run': 6.08,
  'preset:biped:box_01': 1.55,
  'preset:biped:box_02': 2.46,
  'preset:biped:box_03': 1.71,
  'preset:biped:front_kick_01': 3.19,
  'preset:biped:front_kick_02': 5.92,
  'preset:biped:angry_01': 3.64,
  'preset:biped:angry_03': 2.67,
  'preset:biped:defeat_03': 1.29,
  'preset:biped:uppercut': 5.07,
};

/**
 * Below this share of the clip reference a jade block only simmers.
 *
 * It is not zero, and that is the whole point of the brief: these crystals BURN. A block at rest
 * still breathes smoke — see `PLUME_FLOOR` — and the gate only decides where the trail on top of it
 * starts.
 */
export const PLUME_GATE = 0.28;

/**
 * What a motionless jade block still emits, as a share of full roar.
 *
 * Tuned in the browser rather than argued from a number: at 0.16 a planted boot barely smoked, and
 * a fighter standing in his guard is where a visitor spends most of their time looking.
 */
export const PLUME_FLOOR = 0.24;

/**
 * Clips whose root travels, with the distance it covers over one loop in figure heights.
 *
 * `run` carries the figure 2.720 H forward in 1.03 s — three seconds of it and the fighter has left
 * the frame — so it is held in place at runtime by subtracting the hip's horizontal position from
 * the model group, which is a treadmill and not a retime: the stride, the contact timings and the
 * embers all stay exactly where they were measured.
 *
 * `walk` travels 1.394 H per loop and needed the same treatment while it had a button. It no longer
 * does, and its row is gone with it rather than left behind as a lookup nothing can reach —
 * `node scripts/measure-raz-strikes.mjs` prints the number again if the clip is ever brought back.
 *
 * Every other curated clip drifts under 0.17 H over its loop and is left alone.
 */
export const ROOT_LOCKED_CLIPS: Readonly<Record<string, number>> = {
  'preset:biped:run': 2.720,
};

export interface RazAction {
  /** Button id in the demo panel. */
  readonly id: string;
  readonly label: string;
  /** Clip name inside the embedded rig. */
  readonly clip: string;
  /** One-line note for the button tooltip — what the sweep measured in this clip. */
  readonly note: string;
  /**
   * Throw a fireball on this clip's LAST measured contact instead of detonating there. Earlier
   * contacts in the same clip still detonate normally — on `front_kick_01` the low boot at 0.363 H
   * lands as a boot and the high one at 0.881 H is the one that lets go of the ball.
   */
  readonly projectile?: boolean;
  /** Drive the figure forward on an authored dash, trailing frozen copies of itself. */
  readonly dash?: boolean;
  /**
   * The finish. Detonates this clip's measured contacts as `knockout` rather than as their own kind,
   * and ends with the victory burst.
   *
   * The TIMING is still the clip's own measurement and not one number of it is authored here — this
   * is the same override the fireball already performs, which keeps the clip's measured contact time
   * and changes only what happens on that frame.
   */
  readonly knockout?: boolean;
  /**
   * Play several clips back to back as one looping action, instead of the single `clip`.
   *
   * The rig ships individual movements, while the knockout needs three readable beats: settle into
   * a boxing guard, close distance, then jump through an uppercut. The action therefore gets a
   * timeline whose phases can run at different rates.
   *
   * The measured schedule is NOT rewritten for this. Strikes and footfalls stay keyed to the clip
   * they were measured in and keep their own clip-local times; the sequence only decides which clip
   * is playing, where it starts, and how quickly its local clock advances.
   *
   * `clip` is still required and must be the phase the action is identified by, because the viewer's
   * panel and the plume calibration both read it before the first frame is drawn.
   */
  readonly sequence?: {
    /** Length of the whole composite loop, in seconds. */
    readonly duration: number;
    readonly phases: readonly {
      readonly clip: string;
      /** Composite time this phase takes over. The first must be 0. */
      readonly at: number;
      /** Time inside its own clip that the phase starts from. */
      readonly offset: number;
      /** Cross-fade into this phase, in seconds. */
      readonly fade: number;
      /** Multiplier for this phase's clip clock. The composite clock always advances at 1x. */
      readonly speed: number;
    }[];
  };
}

export interface RazLungeProfile {
  readonly start: number;
  readonly arrive: number;
  readonly hold: number;
  readonly home: number;
  readonly distance: number;
  readonly entry: number;
  readonly ghostInterval: number;
  readonly ghostGain: number;
  /** Optional capture window when the visible fast phase is shorter than the full travel. */
  readonly ghostFrom?: number;
  readonly ghostTo?: number;
  /** Body-weight dip before takeoff, on the same composite clock as the sequence. */
  readonly crouchFrom: number;
  readonly crouchPeak: number;
  readonly crouchTo: number;
  readonly crouchDepth: number;
  readonly liftFrom: number;
  readonly liftPeak: number;
  /** End of the high hold. Equal to liftPeak for actions without hang time. */
  readonly liftHold: number;
  readonly liftTo: number;
  readonly liftHeight: number;
  /** Airborne turn window and revolution count. Zeroed for non-spinning actions. */
  readonly spinFrom: number;
  readonly spinTo: number;
  readonly spinTurns: number;
  /** Clip-local recovery pose reached on the exact touchdown frame. */
  readonly landingPoseTime: number;
  readonly chargeLead: number;
}

/**
 * The dash, in seconds into `box_01` and in world units.
 *
 * AUTHORED, and flagged as such — this is the one piece of motion in the demo the sweep did not
 * measure, because there is no dash anywhere in the 24 clips. What stays measured is the punch
 * inside it: the contact is still `box_01`'s own 0.619 s, and the travel is timed to ARRIVE on that
 * frame rather than to look good on its own.
 *
 * The figure returns to the origin before the 2.25 s loop repeats. It has to: without the return
 * leg each loop would start a dash further downrange and the third pass would be off-camera.
 */
export const DASH = {
  /** Push-off, contact, and the two ends of the slide back. */
  start: 0.32,
  arrive: 0.62,
  hold: 1.30,
  home: 2.10,
  /**
   * How far the figure travels, in world units — a whole figure height, and then some.
   *
   * The first two attempts fought the camera and lost. `box_01` faces yaw 49 degrees at contact and
   * the lens sits at 29, so the dash runs almost straight down the camera axis: every unit forward
   * is a unit CLOSER. Dashing OUT of the authored mark, 0.85 already ended cropped against the right
   * edge, and 0.55 fit only by being too short to read as a dash at all.
   *
   * The fix is to dash INTO the mark instead of out of it. The figure now stands this far BACK and
   * arrives at the authored framing exactly as the punch lands (see the offset in `razShowcase.ts`),
   * which inverts the whole problem: distance now buys a figure that starts small and far and grows
   * as it closes, and the frame gets tighter around it rather than losing it. 2.10 puts the start
   * mark about two metres further from the lens — roughly three quarters scale — and the run home
   * covers it in 0.30 s, which is 7 m/s.
   */
  distance: 2.10,
  /**
   * Seconds spent taking the step BACK to the start mark when the button is first pressed.
   *
   * Without it, pressing Dash Punch teleports the figure two metres backwards on the first frame.
   * Eased in over a quarter second it reads as a fighter setting his feet before the lunge, and on
   * every loop after the first the return leg has already put him there, so this never runs again.
   */
  entry: 0.25,
  /** Seconds between afterimage captures while the figure is accelerating. */
  ghostInterval: 0.045,
  /** Opacity scale per capture. Full: at this spacing the copies barely overlap. */
  ghostGain: 1,
  crouchFrom: 0,
  crouchPeak: 0,
  crouchTo: 0,
  crouchDepth: 0,
  /**
   * No hop. A dash punch is a level shove off the back foot — `box_01`'s lead travels forward, not
   * up — so the lift is zeroed rather than omitted, which keeps both profiles one shape and makes
   * "this lunge does not leave the floor" a stated fact instead of a missing field.
   */
  liftFrom: 0,
  liftPeak: 0,
  liftHold: 0,
  liftTo: 0,
  liftHeight: 0,
  spinFrom: 0,
  spinTo: 0,
  spinTurns: 0,
  landingPoseTime: 0,
  /** The default windup; only the knockout needs a longer one. */
  chargeLead: 0.22,
} as const satisfies RazLungeProfile;

/**
 * Knockout choreography on the composite clock.
 *
 * The first 0.34 s establishes a compact boxing guard. The run then plays at 1.35x while the carrier
 * covers most of 2.60 units; only this visibly fast window captures afterimages. At 0.94 s the
 * corrected Mixamo uppercut takes over at 1.15x from its 0.18 s load. Its measured 0.536 s contact
 * therefore lands at 0.94 + (0.536 - 0.18) / 1.15 = 1.250 s, exactly where the carrier reaches its
 * apex. The first 0.135 s of that phase is the load: Raz drops 0.12 units while the FBX folds the
 * knees, then the carrier releases the crouch and launches from the measured 0.335 s load frame.
 * At full extension the carrier descends through one complete reverse revolution. The turn and fall
 * share the same 0.965 s window, while the uppercut mixer keeps moving at a retimed 0.58x effective
 * rate instead of freezing: the raised fist follows through, the torso unwinds and the legs prepare
 * to receive the floor. All three curves reach their authored endpoints at 2.250 s — forward-facing,
 * `landingPoseTime`, and zero lift — then guard cross-fades in and the carrier travels home. The
 * skeleton never receives carrier rotation, so bone lengths and skin proportions remain invariant.
 */
export const KNOCKOUT = {
  start: 0.34,
  arrive: 1.250,
  hold: 2.25,
  home: 2.78,
  distance: 2.60,
  entry: 0.25,
  ghostInterval: 0.036,
  ghostGain: 0.45,
  ghostFrom: 0.44,
  ghostTo: 0.94,
  crouchFrom: 0.94,
  crouchPeak: 1.075,
  crouchTo: 1.18,
  crouchDepth: 0.12,
  liftFrom: 1.075,
  liftPeak: 1.250,
  liftHold: 1.285,
  liftTo: 2.25,
  liftHeight: 0.42,
  spinFrom: 1.285,
  spinTo: 2.25,
  spinTurns: -1,
  landingPoseTime: 1.137,
  chargeLead: 0.35,
} as const satisfies RazLungeProfile;


/**
 * THE DEFAULT IS THE CHARGE.
 *
 * `run` is the fastest thing this figure does — p95 limb speed 6.08 H/s, nearly two and a half times
 * the hardest punch — and it is the only clip that drives all FOUR crystals hard at once. Every
 * other candidate lights two at most. So the first thing a visitor sees, with nothing pressed, is
 * both fists and both boots laying full trails of green fire, which is what this demo is about.
 *
 * The cost is stated plainly: `run` schedules no strikes, because a runner's arm stopping at the top
 * of every swing is not a blow (see the exclusion note at the top of this file). Nothing detonates
 * until a button is pressed. `Combination` is the first button for exactly that reason — it is the
 * three-punch clip that used to hold this slot.
 *
 * `run` carries the root 2.720 H per loop, so unlike the previous default it needs the root lock;
 * see `ROOT_LOCKED_CLIPS`.
 *
 * `sit`, `dig` and `fold_arms` are the conventional idles and all three are the wrong answer here:
 * measured, their p95 limb speed is 0.42, 0.32 and 0.38 H/s. Nothing in them ever ignites.
 */
export const RAZ_IDLE_CLIP = 'preset:biped:run';

/**
 * What the default action calls itself.
 *
 * Unlike the previous default this one IS a button in `RAZ_ACTIONS`, which is deliberate: the panel
 * highlights whichever action id is active, so on arrival "Charge" reads as pressed and Stop/Reset
 * visibly returns to it. Not the conventional `idle` either — the viewer labels the status "Idle"
 * for an action of that name, and "Idle" is a false caption for a figure at a dead run.
 */
export const RAZ_IDLE_ID = 'charge';

export const RAZ_ACTIONS: readonly RazAction[] = [
  { id: 'combination', label: 'Combination', clip: 'preset:biped:box_02',
    note: 'three punches in a 2.83 s loop — 1.835 s, 1.962 s and 2.252 s, the last the power hand' },
  { id: 'lead', label: 'Lead Punch', clip: 'preset:biped:box_01',
    note: 'one left hand at 0.619 s — 2.48 H/s into a 0.373 H reach, contact on the chest line' },
  { id: 'hook', label: 'Hook', clip: 'preset:biped:box_03',
    note: 'an arc to the head line: contact at 0.741 H, the longest hand reach in the set' },
  { id: 'front-kick', label: 'Front Kick', clip: 'preset:biped:front_kick_01',
    note: 'two boots from one leg — low at 0.363 H, then head height at 0.881 H, 0.293 s apart' },
  /**
   * Shares `front_kick_01` with Front Kick, and there is no way around that: the rig ships exactly
   * two kicks and both already had a button. The same motion with a different consequence is an
   * honest pairing — press them back to back and the difference is the point.
   */
  { id: 'fireball', label: 'Fireball Kick', clip: 'preset:biped:front_kick_01', projectile: true,
    note: 'the high boot at 0.881 H lets go of a ball of jade fire that arcs out and detonates' },
  { id: 'snap-kick', label: 'Snap Kick', clip: 'preset:biped:front_kick_02',
    note: '5.22 H/s at the apex — the fastest limb event measured anywhere in the 24 clips' },
  {
    id: 'knockout',
    label: 'Knockout',
    clip: 'preset:biped:uppercut',
    knockout: true,
    sequence: {
      duration: 3.00,
      phases: [
        { clip: 'preset:biped:box_01', at: 0.00, offset: 0.35, fade: 0.18, speed: 0.15 },
        { clip: 'preset:biped:run', at: 0.34, offset: 0.04, fade: 0.18, speed: 1.35 },
        { clip: 'preset:biped:uppercut', at: 0.94, offset: 0.18, fade: 0.18, speed: 1.15 },
        { clip: 'preset:biped:box_01', at: 2.25, offset: 0.35, fade: 0.22, speed: 0.30 },
      ],
    },
    note: 'boxing guard, a 1.35x afterimage run-in and knee-loading crouch, then a 1.15x Mixamo uppercut rising 0.42 units whose follow-through flows through a 0.965-second reverse 360-degree spin and lands exactly in guard',
  },
  /**
   * Shares `box_01` with Lead Punch for the same reason, and adds the one authored movement in the
   * demo — see `DASH`. The afterimages are not stylistic licence: at 0.85 units in 0.30 s this
   * figure crosses its own width in under a fifth of a second, which is exactly when a real camera
   * would smear it.
   */
  { id: 'dash', label: 'Dash Punch', clip: 'preset:biped:box_01', dash: true,
    note: 'closes 2.10 units \u2014 7 m/s \u2014 to land box_01\u2019s 0.619 s lead, trailing four frozen copies' },
  { id: 'rage', label: 'Rage', clip: 'preset:biped:angry_01',
    note: 'p95 3.64 H/s and not one apex clears the floors: all plume, no impact, plus one stamp' },
  { id: 'footwork', label: 'Footwork', clip: 'preset:jump',
    note: 'five landings, the heaviest ground contacts in the set (descent 1.89-2.06 H/s)' },
  { id: 'charge', label: 'Charge', clip: 'preset:biped:run',
    note: 'held in place: 2.720 H per 1.03 s loop, p95 limb speed 6.08 H/s — the widest trails' },
  { id: 'guard', label: 'Guard Down', clip: 'preset:biped:defeat_03',
    note: '5.58 s at p95 1.29 H/s: the crystals bank down to embers and nothing detonates' },
];

export function strikesForClip(clip: string): readonly StrikeEvent[] {
  return STRIKE_EVENTS.filter((event) => event.clip === clip);
}

export function footfallsForClip(clip: string): readonly FootfallEvent[] {
  return FOOTFALL_EVENTS.filter((event) => event.clip === clip);
}
