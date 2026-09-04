import * as THREE from 'three';
import {
  createRazRigged,
  razReady,
  prewarmRaz,
  type RazOptions,
} from './createRazModel';
import { createRazVfx, type ProjectileTarget, type RazVfx } from './razVfx';
import type { StrikeKind } from './strikeEvents';
import type { Tint } from './razVfx';
import {
  CLIP_PLUME_REFERENCE,
  DASH,
  FIGURE_HEIGHT,
  FOOTFALL_EVENTS,
  KNOCKOUT,
  RAZ_ACTIONS,
  JADE_BLOCKS,
  RAZ_IDLE_CLIP,
  RAZ_IDLE_ID,
  PLUME_FLOOR,
  PLUME_GATE,
  ROOT_LOCKED_CLIPS,
  STRIKE_EVENTS,
  VFX_JOINTS,
  type JadeBlock,
  type RazAction,
  type RazLungeProfile,
} from './strikeEvents';

/**
 * The showcase build: the rigged figure, nine curated clips, and the jade effects driven off the
 * measured events in `strikeEvents.ts`.
 *
 * WHY A SCHEDULER AND NOT A LOOK-AT-THE-SPEED TRIGGER. A live detector — "detonate when the fist
 * decelerates" — can only know a blow landed AFTER it has landed, because the reversal takes about
 * 0.1 s to observe. That is two things wrong at once: the burst is late, and the windup gather
 * cannot exist at all, because nothing knows a blow is coming. Both are answered by scheduling
 * against the measured table: the detonation fires on the frame the crystal reaches its apex, and
 * the 0.22 s before it are spent pulling fire into the block.
 *
 * WHAT IS STILL LIVE. The plumes are. Emission, streak length and glow are read from the crystal's
 * ACTUAL world velocity every frame, not from the table — so they are right during a cross-fade
 * between two clips, right while hitstop is slowing the mixer, and right for the five clips that
 * schedule nothing at all. The table decides only where blows LAND; how hard the crystals burn on
 * the way there is measured live.
 *
 * HITSTOP. On impact the clip drops to a quarter speed for 45-100 ms depending on the blow. This is
 * the single largest contributor to how hard a strike reads and it costs one multiply — the mixer is
 * driven from here, so the schedule stays consistent with the slowed clip automatically.
 *
 * ROOT LOCK. `run` carries the figure 2.720 H forward per loop — three seconds of it and the fighter
 * has left the frame. It is held over the stage origin by subtracting the hip's own horizontal
 * position from the model group, measured in the group's LOCAL frame so the correction is a function
 * of the animation alone and cannot chase itself. The stride is untouched: contact times, embers and
 * plumes all still happen exactly where the sweep measured them.
 *
 * BUILD ORDER. `build()` is synchronous by the registry's contract while the level of detail and the
 * rig live in their own chunks, so this returns a root holding only the effects layer and binds the
 * figure when `prewarmRaz` resolves. The ticker and the animation controller are published
 * immediately — the viewer collects tickers exactly once, and the demo panel reads the controller on
 * the frame after `build()` — so both have to exist before the geometry does. A button pressed in
 * that window is remembered and applied on binding rather than dropped.
 */

const CHARGE_LEAD = 0.22;
const HITSTOP_SCALE = 0.25;

/** Seconds a knock-back takes to shove out and settle back. */
export const RECOIL_SPAN = 0.75;

/**
 * The shape of a knock-back, shared by both fighters in a duel so they are hit the same way.
 *
 * `push` is along the line from the blow through the body: two thirds of the travel is spent in the
 * first fifth of the time, because that is what being hit looks like, and the elastic return is the
 * slow half — the fighter recovering. `shake` rides ACROSS that line and dies with it, which is what
 * makes the contact point read as the origin of the movement rather than merely its direction.
 */
export function recoilCurve(age: number): { push: number; shake: number } {
  return {
    push: Math.sin(Math.pow(age, 0.45) * Math.PI),
    shake: Math.sin(age * 46) * Math.pow(1 - age, 2.2) * 0.28,
  };
}

/**
 * Measured speed ranges the burst power is normalised against, in figure heights per second, per
 * limb family. One range cannot serve both: the hardest punch in the set is 2.59 H/s and the
 * *softest* kick is 3.17, so a shared scale would make every punch a tap and every kick maximal.
 */
const POWER_RANGE = {
  hand: { from: 1.85, to: 2.65 },
  foot: { from: 3.00, to: 5.30 },
};

/**
 * Where the CRYSTAL is, relative to the joint the rig gives us.
 *
 * Neither block sits on a bone. `L_Hand` is the wrist, and the reference puts the emerald knuckle
 * plates a whole gauntlet further out — a plume hung on the wrist smokes out of the forearm. The
 * sole crystal is under the boot, below the toe joint. So the hand emitter is pushed along the
 * forearm-to-wrist axis, which is the one direction that stays right through a rotating punch, and
 * the foot emitter is dropped straight down.
 */
const KNUCKLE_REACH = 0.13;
const SOLE_DROP = 0.030;

/** Where the contact is, ahead of the crystal. A boot drives further through than a fist. */
const CONTACT_OFFSET = { hand: 0.045, foot: 0.075 };

interface Anchor {
  bone: THREE.Bone;
  world: THREE.Vector3;
}

interface BlockState {
  anchor: Anchor;
  /** The crystal itself: the anchor pushed out to where the reference puts the jade. */
  emit: THREE.Vector3;
  previous: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Six frames of travel, so a blow's direction survives the frame the crystal stops on. */
  history: THREE.Vector3[];
  cursor: number;
  filled: number;
  speed: number;
}

interface Bound {
  play: (clip: string, fade: number, speed?: number, startTime?: number) => boolean;
  update: (delta: number) => void;
  modelGroup: THREE.Group;
  skeleton: THREE.Skeleton;
  bindPose: readonly { position: THREE.Vector3; scale: THREE.Vector3 }[];
  clipByName: Map<string, THREE.AnimationClip>;
  joints: Record<keyof typeof VFX_JOINTS, Anchor>;
  blocks: Record<JadeBlock, BlockState>;
}

/** Effects a host scene may want to fire itself, handed over once the layer exists. */
export interface RazShowcaseHandle {
  /** The victory burst, from the fighter's own feet. */
  celebrate(power: number): void;
  /** Where the fighter is standing, in world units. */
  stance(out: THREE.Vector3): THREE.Vector3;
  /** His chest, for a capsule an opponent's blow is tested against. */
  chest(out: THREE.Vector3): THREE.Vector3;
  /** His head, for judging whether a blow landed on the head line or the body. */
  head(out: THREE.Vector3): THREE.Vector3;
  /**
   * Which way he is FACING, measured live from the shoulder line and signed by the toes.
   *
   * A judge has to know the front of a fighter from the back — a blow to the back of the head is a
   * foul, not a score — and a bone quaternion cannot answer that: this rig's root alone carries a
   * 120-degree rotation of its own.
   */
  forward(out: THREE.Vector3): THREE.Vector3;
  /**
   * Where one of his four crystals is, live.
   *
   * The same point the effects layer spawns from — not the bone, the CRYSTAL, a gauntlet further out
   * along the forearm. A host watching for a landed blow has to test the point the blow is drawn at,
   * or the hit and the burst disagree by the width of a fist.
   */
  crystal(block: JadeBlock, out: THREE.Vector3): THREE.Vector3;
  /** Throw a ball from an arbitrary point — for a host staging a shot his own schedule does not. */
  throwFireball(at: THREE.Vector3, dir: THREE.Vector3, power: number, tint?: Tint): void;
  /** Two forces meeting at one point: a rift in both palettes, and the crack under it. */
  clash(at: THREE.Vector3, axis: THREE.Vector3, power: number): void;
  /** Told when two balls in flight destroy each other, at the point they met. */
  onProjectilesCollide(handler: ((at: THREE.Vector3) => void) | null): void;
  /** Turn him, in radians about Y. Same carrier the `facing` option sets. */
  face(yaw: number): void;
  /**
   * Drive him back off a blow.
   *
   * `from` is the point the blow arrived at, and it is the ORIGIN of the movement, not merely a
   * direction: the body is pushed along the line running from that point through him, and the shake
   * that follows oscillates across the same line. A recoil aimed down a fighter's facing instead
   * would send a man hit in the shoulder straight backwards, which is not what being hit looks like.
   */
  recoil(from: THREE.Vector3, strength: number): void;
  /**
   * Detonate at an arbitrary world point.
   *
   * The effects layer is anchored at the world origin and reads nothing but world positions, so it is
   * really the STAGE's, not one fighter's. A host running two characters on it can spend it on either.
   */
  impact(kind: StrikeKind, at: THREE.Vector3, dir: THREE.Vector3, power: number): void;
}

export interface RazShowcaseOptions extends RazOptions {
  /**
   * Duel mode. Given a target the fireball tests against it every frame and reports the hit, which is
   * what lets a second character react to being struck. Left out, the shot simply burns out — the
   * behaviour the solo demo has always had.
   */
  projectileTarget?: ProjectileTarget | null;
  /**
   * Receives the effect handle. A callback rather than a return value because `build()` must keep
   * returning the group the registry contract asks for.
   */
  onHandle?: (handle: RazShowcaseHandle) => void;
  /**
   * Which way the fighter faces, in radians about Y.
   *
   * THIS IS WHY THE LAYER IS SHAPED THE WAY IT IS. Every effect here is spawned from a bone's WORLD
   * position and written as a LOCAL coordinate into `vfx.group` — correct only while that group sits
   * at identity. Yaw the returned root and the whole effects layer rotates a second time: plumes
   * leave the wrong side of the fist, bursts land beside the blow, ghosts trail the wrong way.
   *
   * So the yaw goes on a carrier INSIDE the root, around the skinned figure alone. The bones' world
   * positions pick it up, which is all any effect reads; `vfx.group` never moves. The dash and the
   * root lock then have to work in world units on that carrier rather than in the model's local
   * frame, which is what the `placeCarrier` below does.
   */
  facing?: number;
  /**
   * Hold the fighter's hip over his own stance on EVERY clip, not just the travelling ones.
   *
   * The root lock exists so `run` and `walk` do not carry the figure out of frame. A duel needs more
   * than that: it places an opponent at a blow's measured reach FROM THE HIP, and every clip parks the
   * hip somewhere slightly different — `box_01` sits it at (0.2, -0.249) — so the contact lands that
   * far off the lane before it has travelled at all. Worse, the yaw that aims the blow rotates about
   * the stance, not the hip, so the error swings with the facing. Measured, every one of the eight
   * blows in the roster missed by up to 0.72 against a capsule radius of 0.42.
   *
   * Holding the hip makes `reach` mean what the staging assumes it means. The cost is the clip's own
   * weight shift, which for these clips is under 0.07 figure heights.
   */
  holdStance?: boolean;
}

export function createRazShowcase(options: RazShowcaseOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'raz';

  const vfx: RazVfx = createRazVfx();
  vfx.setProjectileTarget(options.projectileTarget ?? null);
  root.add(vfx.group);

  /**
   * Carries the fighter's yaw and his world-space displacement; `vfx.group` is deliberately NOT under
   * it. Created before the geometry so the facing is set once and never re-applied on bind.
   */
  /**
   * Knock-back, in world units, added to the carrier alongside the dash and the root lock.
   *
   * Held here rather than in the host so it decays on the fighter's own clock: a host that forgets to
   * tick it would leave a fighter permanently shoved half a metre off his mark.
   */
  const recoilDir = new THREE.Vector3();
  const recoilAcross = new THREE.Vector3();
  const recoilOffset = new THREE.Vector3();
  let recoilAge = 1;
  let recoilStrength = 0;

  const carrier = new THREE.Group();
  carrier.name = 'raz-stance';
  let stanceYaw = options.facing ?? 0;
  carrier.rotation.y = stanceYaw;
  root.add(carrier);

  let bound: Bound | null = null;
  let activeId = RAZ_IDLE_ID;
  let activeClip = RAZ_IDLE_CLIP;
  let pending: string | null = null;
  let clipTime = 0;
  let hitstop = 0;
  let primed = false;
  let firedStrikes = 0;
  let firedFootfalls = 0;
  /** Where the last blow actually landed, in world units. Published for staging and for capture. */
  const lastContact = new THREE.Vector3();
  let lastContactKind = '';
  let firedFireballs = 0;
  let activeAction: RazAction | undefined;
  /** How far along the authored dash the figure is, 0..1, and the direction it committed to. */
  let dashAmount = 0;
  let ghostTimer = 0;
  let dashEntry = 0;
  /** Height off the floor, in world units. Non-zero only while a lunge with a hop is in its window. */
  let lift = 0;
  /** Downward carrier offset that lets the clip's bent knees visibly load before takeoff. */
  let crouch = 0;
  /** Root-level aerial turn. Kept outside the skeleton so the held punch pose cannot deform. */
  let spinAngle = 0;
  let poseHeld = false;
  /**
   * Position on a sequenced action's own composite timeline, and which phase that puts us in.
   *
   * Kept SEPARATE from `clipTime` rather than replacing it, which is the whole reason the sequence
   * feature is small: every scheduled strike and footfall in this file is keyed to a clip and a
   * clip-local time, and all of that keeps working untouched. The composite clock decides only which
   * clip should be playing and where the glide and the leap are; the clip clock still decides when a
   * blow lands.
   */
  let seqTime = 0;
  let seqPhase = 0;
  const dashDirection = new THREE.Vector3();
  const dashOffset = new THREE.Vector3();

  const compensation = new THREE.Vector3();
  const travel = new THREE.Vector3();
  const contact = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const facing = new THREE.Vector3(0, 0, 1);
  const shoulder = new THREE.Vector3();
  const stance = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const listeners = new Set<(active: string) => void>();
  const notify = (): void => listeners.forEach((listener) => listener(activeId));

  function switchTo(id: string, clip: string, fade: number): void {
    activeId = id;
    activeClip = clip;
    clipTime = 0;
    hitstop = 0;
    compensation.set(0, 0, 0);
    activeAction = RAZ_ACTIONS.find((entry) => entry.id === id);
    dashAmount = 0;
    dashOffset.set(0, 0, 0);
    // The guard eases back onto the run-up mark before push-off. Seed that movement from the
    // current facing so the first use cannot sit still and then teleport when the dash finally arms.
    dashDirection.copy(facing);
    ghostTimer = 0;
    dashEntry = 0;
    lift = 0;
    crouch = 0;
    spinAngle = 0;
    poseHeld = false;
    seqTime = 0;
    seqPhase = 0;
    // A sequenced action starts on its first phase, at that phase's own offset into its clip.
    const first = activeAction?.sequence?.phases[0];
    if (first) {
      activeClip = first.clip;
      clipTime = first.offset;
    }
    const startClip = first ? first.clip : clip;
    if (bound) {
      bound.play(startClip, fade, first?.speed ?? 1, first?.offset ?? 0);
      compensation.set(0, 0, 0);
      dashOffset.set(0, 0, 0);
      placeCarrier();
      // Dropped rather than carried: the history holds the PREVIOUS clip's travel, and a cross-fade
      // would otherwise read a direction across the seam between two unrelated poses.
      for (const block of Object.values(bound.blocks)) block.filled = 0;
    } else {
      pending = id;
    }
    notify();
  }

  const animationController = {
    actions: RAZ_ACTIONS.map(({ id, label }) => ({ id, label, loop: true })),
    get active(): string { return activeId; },
    play(id: string): void {
      const action = RAZ_ACTIONS.find((entry) => entry.id === id);
      if (!action) return;
      switchTo(action.id, action.clip, 0.22);
    },
    stop(): void {
      switchTo(RAZ_IDLE_ID, RAZ_IDLE_CLIP, 0.30);
    },
    subscribe(listener: (active: string) => void): () => void {
      listeners.add(listener);
      listener(activeId);
      return () => listeners.delete(listener);
    },
  };

  // -------------------------------------------------------------------------- measured schedule
  /**
   * Contacts indexed by ACTION and then by clip, resolved once here rather than per frame.
   *
   * The extra level exists because a contact may be scoped to one action — the imported uppercut is
   * a Knockout contact, not a generic event for hosts that preview its source clip. The obvious
   * implementation is a `filter` in the update loop, and it is wrong for this file: that is
   * an allocation on every frame of every action, in a layer whose whole discipline is that nothing
   * is allocated after construction. Resolved up front, the lookup is two map reads.
   */
  const strikesByAction = new Map<string, Map<string, typeof STRIKE_EVENTS>>();
  for (const action of RAZ_ACTIONS) {
    const byClip = new Map<string, typeof STRIKE_EVENTS>();
    const mine = STRIKE_EVENTS.filter((e) => e.action === undefined || e.action === action.id);
    for (const event of mine) {
      byClip.set(event.clip, mine.filter((entry) => entry.clip === event.clip));
    }
    strikesByAction.set(action.id, byClip);
  }
  /** Clips with no scoped contact at all, for the idle and for anything played outside an action. */
  const strikesByClip = new Map<string, typeof STRIKE_EVENTS>();
  const unscoped = STRIKE_EVENTS.filter((e) => e.action === undefined);
  for (const event of unscoped) {
    strikesByClip.set(event.clip, unscoped.filter((entry) => entry.clip === event.clip));
  }
  const footfallsByClip = new Map<string, typeof FOOTFALL_EVENTS>();
  for (const event of FOOTFALL_EVENTS) {
    footfallsByClip.set(event.clip, FOOTFALL_EVENTS.filter((entry) => entry.clip === event.clip));
  }
  const EMPTY_STRIKES: typeof STRIKE_EVENTS = [];

  /** True when `time` falls inside the interval the clip has just advanced through, loop included. */
  function crossed(time: number, from: number, to: number): boolean {
    return to >= from ? time > from && time <= to : time > from || time <= to;
  }

  /** Seconds from `now` forward to `time` on a loop of `duration`. */
  function ahead(time: number, now: number, duration: number): number {
    const delta = time - now;
    return delta >= 0 ? delta : delta + duration;
  }

  function readAnchors(state: Bound): void {
    for (const value of Object.values(state.joints)) value.bone.getWorldPosition(value.world);
  }

  /**
   * Which way the figure is looking, taken from measured geometry rather than off a bone
   * quaternion: the rig's bone axes are its own — the root alone carries a 120-degree quaternion —
   * so reading a "forward" out of one would be a guess.
   *
   * The shoulder line gives the AXIS precisely, because the torso leads a punch. It cannot give the
   * SIDE: its normal is equally the chest and the back. The ankle-to-toe vector settles that — toes
   * point forward on every human and on this rig — so the sign comes from the feet and the precision
   * from the shoulders. A fighting stance is bladed and these clips turn through 90 degrees
   * mid-combination, so a sign decided once at rest would invert halfway through the blow.
   */
  function updateFacing(state: Bound): void {
    shoulder.copy(state.joints.shoulderL.world).sub(state.joints.shoulderR.world);
    shoulder.y = 0;
    if (shoulder.lengthSq() < 1e-8) return;
    facing.copy(up).cross(shoulder.normalize()).normalize();
    stance.copy(state.joints.toeL.world).sub(state.joints.footL.world);
    scratch.copy(state.joints.toeR.world).sub(state.joints.footR.world);
    stance.add(scratch);
    stance.y = 0;
    if (stance.lengthSq() > 1e-8 && facing.dot(stance.normalize()) < 0) facing.negate();
  }

  /**
   * Which lunge the active action travels on, or `null` for the nine that stand still.
   *
   * Both profiles carry the same fields for the same reasons; they differ only in the numbers, and
   * every number in each is pinned to its OWN clip's measured contact. Reading the profile off the
   * action rather than branching on it keeps the travel, the afterimages and the framing correction
   * driven by one source, so a retimed clip cannot leave the ghosts firing on the old window.
   */
  function lungeOf(action: RazAction | undefined): RazLungeProfile | null {
    if (action?.knockout) return KNOCKOUT;
    if (action?.dash) return DASH;
    return null;
  }

  /**
   * How far into the lunge the clip is, 0..1.
   *
   * Push-off is eased OUT — a lunge is a shove, all of its speed in the first third — and the slide
   * home is a smoothstep, because the recovery is a weight transfer and not a second shove.
   */
  function dashCurve(t: number, profile: RazLungeProfile): number {
    if (t < profile.start || t > profile.home) return 0;
    if (t < profile.arrive) {
      const k = (t - profile.start) / (profile.arrive - profile.start);
      // Smooth the push-off before applying the fast ease-out. The old cubic began at full velocity,
      // so the carrier covered visible distance on its first frame even when the pose blend was
      // continuous. This keeps zero velocity at both ends without losing the fast middle.
      const smooth = k * k * (3 - 2 * k);
      return 1 - Math.pow(1 - smooth, 3);
    }
    if (t < profile.hold) return 1;
    const k = (t - profile.hold) / (profile.home - profile.hold);
    return 1 - k * k * (3 - 2 * k);
  }

  /**
   * Put the carrier where the root lock and the dash want the fighter, in WORLD units.
   *
   * The displacement moved off the model group and onto the carrier when the fighter learned to turn.
   * Both inputs are world vectors — `dashOffset` is built from the measured world facing, and the
   * root lock cancels a world hip drift — and applying a world vector to a rotated group's local
   * position rotates it, which sent the dash off at whatever angle the fighter happened to face.
   */
  function placeCarrier(): void {
    carrier.position.set(
      compensation.x + dashOffset.x + recoilOffset.x,
      lift - crouch,
      compensation.z + dashOffset.z + recoilOffset.z,
    );
    carrier.rotation.y = stanceYaw + spinAngle;
  }

  /**
   * The recoil curve: a hard shove out, an elastic return, and a shake across the blow line that dies
   * with it. Two thirds of the travel is spent in the first fifth of the time, because that is what
   * being hit looks like — the return is the fighter recovering, and it is the slow half.
   */
  function updateRecoil(dt: number): void {
    if (recoilAge >= 1) {
      if (recoilOffset.lengthSq() > 0) recoilOffset.set(0, 0, 0);
      return;
    }
    recoilAge = Math.min(1, recoilAge + dt / RECOIL_SPAN);
    const { push, shake } = recoilCurve(recoilAge);
    recoilOffset.copy(recoilDir).multiplyScalar(push * recoilStrength)
      .addScaledVector(recoilAcross, shake * recoilStrength);
  }

  /**
   * The hop, 0..1, on its own three-point window rather than on `dashCurve`.
   *
   * It cannot share the travel curve: that curve holds at 1 from the contact until `hold`, which for
   * this action is sustained hang time, and a fighter who stays in the air after an uppercut is
   * floating rather than landing. The sine rise has immediate upward velocity but eases to zero at
   * the contact apex, so the body launches on the same frame as the fist without creating a corner.
   * The high hold gives the 360-degree turn a readable silhouette. The smoothstepped fall starts at
   * zero velocity after that hold and is the longer half — a body is pushed up and then dropped.
   */
  function liftCurve(t: number, profile: RazLungeProfile): number {
    if (profile.liftHeight <= 0 || t < profile.liftFrom || t > profile.liftTo) return 0;
    if (t < profile.liftPeak) {
      const k = (t - profile.liftFrom) / (profile.liftPeak - profile.liftFrom);
      return Math.sin(k * Math.PI * 0.5);
    }
    if (t <= profile.liftHold) return 1;
    const k = (t - profile.liftHold) / (profile.liftTo - profile.liftHold);
    return 1 - k * k * (3 - 2 * k);
  }

  /** Smooth one-turn carrier spin; zero outside its window and exactly 2 PI at the end. */
  function spinCurve(t: number, profile: RazLungeProfile): number {
    if (profile.spinTurns === 0 || t < profile.spinFrom || t > profile.spinTo) return 0;
    const k = (t - profile.spinFrom) / (profile.spinTo - profile.spinFrom);
    const eased = k * k * (3 - 2 * k);
    return eased * Math.PI * 2 * profile.spinTurns;
  }

  /** Smooth dip and release around the uppercut clip's measured lowest-hip load frame. */
  function crouchCurve(t: number, profile: RazLungeProfile): number {
    if (profile.crouchDepth <= 0 || t < profile.crouchFrom || t > profile.crouchTo) return 0;
    if (t < profile.crouchPeak) {
      const k = (t - profile.crouchFrom) / (profile.crouchPeak - profile.crouchFrom);
      return k * k * (3 - 2 * k);
    }
    const k = (t - profile.crouchPeak) / (profile.crouchTo - profile.crouchPeak);
    return 1 - k * k * (3 - 2 * k);
  }

  /**
   * Push each anchor out to the crystal it stands for. Done every frame rather than once: the hand
   * offset is along the LIVE forearm axis, so a fist rotating through a hook keeps its plume on the
   * knuckles instead of letting it swing off into the air.
   */
  function resolveCrystals(state: Bound): void {
    for (const side of ['L', 'R'] as const) {
      const hand = side === 'L' ? state.blocks.handL : state.blocks.handR;
      const wrist = side === 'L' ? state.joints.handL : state.joints.handR;
      const forearm = side === 'L' ? state.joints.forearmL : state.joints.forearmR;
      scratch.copy(wrist.world).sub(forearm.world);
      if (scratch.lengthSq() < 1e-8) scratch.copy(facing);
      hand.emit.copy(wrist.world).addScaledVector(scratch.normalize(), KNUCKLE_REACH);

      const foot = side === 'L' ? state.blocks.footL : state.blocks.footR;
      const toe = side === 'L' ? state.joints.toeL : state.joints.toeR;
      foot.emit.set(toe.world.x, Math.max(0.005, toe.world.y - SOLE_DROP), toe.world.z);
    }
  }

  function strikeDirection(block: BlockState, state: Bound, out: THREE.Vector3): void {
    // Direction of TRAVEL over the last few frames, not the instantaneous velocity: on the frame a
    // blow lands the crystal has already reversed, and its velocity there points back at the owner.
    const size = block.history.length;
    if (block.filled >= 2) {
      const newest = block.history[(block.cursor - 1 + size) % size];
      const oldest = block.history[(block.cursor - Math.min(block.filled, size) + size * 2) % size];
      out.copy(newest).sub(oldest);
    } else {
      out.set(0, 0, 0);
    }
    if (out.lengthSq() < 1e-6) {
      // Reaching away from the chest, which is where a blow goes by definition.
      out.copy(block.anchor.world).sub(state.joints.chest.world);
      out.y *= 0.35;
    }
    if (out.lengthSq() < 1e-9) out.copy(facing);
    out.normalize();
  }

  // --------------------------------------------------------------------------------- per frame
  root.userData.tick = (delta: number): void => {
    const dt = Math.min(0.05, Math.max(0, delta));
    const state = bound;
    if (!state) {
      vfx.update(dt);
      return;
    }
    // Hitstop: the clip crawls for a few frames after a blow lands. Charged down in REAL time, so a
    // slowed clip cannot stretch its own hitstop.
    let scale = 1;
    if (hitstop > 0) {
      hitstop = Math.max(0, hitstop - dt);
      scale = HITSTOP_SCALE;
    }
    /**
     * The dash is resolved BEFORE the anchors are read, so every ember, plume and contact spawns at
     * the position the figure actually occupies this frame. Read afterwards and the whole effects
     * layer trails a whole dash behind the body it belongs to.
     *
     * Driven off `clipTime`, not off real time, so hitstop slows the dash with the punch instead of
     * letting the figure keep sliding through a frozen frame.
     */
    /**
     * The composite clock, advanced on the SAME scaled step as the mixer.
     *
     * Sharing the step is what keeps hitstop honest across a sequence: when a blow lands and the clip
     * drops to a quarter speed, the glide and the leap slow with it instead of sliding on through a
     * frozen pose. Advanced before the phase test so a phase boundary is crossed on the frame it is
     * actually reached.
     */
    const sequence = activeAction?.sequence;
    const compositeStep = dt * scale;
    if (sequence) {
      seqTime = (seqTime + compositeStep) % sequence.duration;
      let phase = 0;
      for (let i = 0; i < sequence.phases.length; i += 1) {
        if (seqTime >= sequence.phases[i].at) phase = i;
      }
      if (phase !== seqPhase) {
        seqPhase = phase;
        const entered = sequence.phases[phase];
        activeClip = entered.clip;
        /**
         * `clipTime` is REWOUND to the phase's own offset, not carried across.
         *
         * The strike schedule reads clip-local times, so a phase that inherited the previous clip's
         * clock would test the uppercut's 0.549 s contact against a time that came out of `run`.
         * Rewinding also means a contact sitting exactly at an offset cannot double-fire: `crossed`
         * needs an interval to have passed through it, and the rewind starts a fresh one.
         */
        clipTime = entered.offset;
        /**
         * The root-lock correction is deliberately NOT reset here.
         *
         * Zeroing it was the first attempt and it is exactly backwards: the correction is what is
         * hiding the outgoing clip's root drift, and that drift is still in the pose all through the
         * cross-fade. Dropping it snapped the figure across the stage by everything `run` had
         * accumulated. A sequenced action is locked on every phase instead — see the lock below —
         * so this value is recomputed from the live hip each frame and the seam has nothing to jump.
         */
        state.play(entered.clip, entered.fade, entered.speed, entered.offset);
        // The travel history belongs to the pose that made it; a cross-fade seam is not a direction.
        for (const block of Object.values(state.blocks)) block.filled = 0;
      }
    }

    const activePhase = sequence?.phases[seqPhase];
    const phaseSpeed = activePhase?.speed ?? 1;
    const lunge = lungeOf(activeAction);
    const lungeClock = sequence ? seqTime : clipTime;
    // Keep the uppercut alive through the reverse turn instead of freezing it. The remaining source
    // recovery is retimed over the shared spin/descent window, reaching `landingPoseTime` on the
    // exact frame rotation reaches one turn and lift reaches zero. Splitting a boundary-crossing
    // frame keeps the result deterministic across requestAnimationFrame gaps.
    let poseCompositeStep = compositeStep;
    poseHeld = false;
    if (lunge && lunge.spinTurns !== 0 && sequence
      && activePhase?.clip === 'preset:biped:uppercut') {
      const previousClock = seqTime >= compositeStep
        ? seqTime - compositeStep
        : sequence.duration + seqTime - compositeStep;
      if (lungeClock >= lunge.spinFrom && lungeClock < lunge.liftTo) {
        const spinPoseTime = activePhase.offset
          + (lunge.spinFrom - activePhase.at) * phaseSpeed;
        const aerialSpan = lunge.liftTo - lunge.spinFrom;
        const sourceRecovery = Math.max(0, lunge.landingPoseTime - spinPoseTime);
        const recoveryScale = aerialSpan > 0 && phaseSpeed > 0
          ? sourceRecovery / (aerialSpan * phaseSpeed)
          : 1;
        const beforeAerial = previousClock < lunge.spinFrom
          ? lunge.spinFrom - previousClock
          : 0;
        const duringAerial = lungeClock - Math.max(previousClock, lunge.spinFrom);
        poseCompositeStep = beforeAerial + Math.max(0, duringAerial) * recoveryScale;
      }
    }
    const step = poseCompositeStep * phaseSpeed;
    const clip = state.clipByName.get(activeClip);
    if (!clip) return;
    /**
     * The mixer owns transition time; each action owns pose speed.
     *
     * Advancing the whole mixer by `step` made a 0.18 s fade take 1.20 real seconds in the 0.15x
     * guard, so it was still blending three unrelated actions when the run began. The action's
     * effective time scale now retimes only its keyframes, while fades consistently consume the
     * composite step authored in the sequence.
     */
    state.update(poseCompositeStep);
    if (sequence) {
      /**
       * A combat sequence is in-place: rotations animate, bone lengths and body scale do not.
       *
       * The source run carries almost 3 units of travel in `Hip.position`, while the uppercut starts
       * near its 0.52-unit bind position. Blending those translations moves Root-to-Hip through 2.06
       * units at the seam, producing the visible gap between phases. The carrier already owns
       * intentional travel and lift, so restoring bind position and scale here removes duplicate
       * root motion and makes body proportions an invariant on every rendered frame. The source
       * clips remain untouched for offline measurement.
       */
      state.skeleton.bones.forEach((bone, index) => {
        bone.position.copy(state.bindPose[index].position);
        bone.scale.copy(state.bindPose[index].scale);
      });
    }
    // Before the anchors are read, so every effect spawns off the shoved position, not the mark.
    updateRecoil(dt);

    /** Sequenced actions time their travel on the composite clock; everything else on the clip. */
    if (lunge) {
      dashAmount = dashCurve(lungeClock, lunge);
      // `switchTo` latches the direction for the WHOLE action, including its eased walk back onto the
      // run-up mark. Re-latching here at push-off used two different pose-derived directions on the
      // two sides of `start`: the guard's direction for the entry and the run's direction one frame
      // later. Their 90-degree difference moved the carrier 3.01 units in a single frame. Holding the
      // action-entry direction makes entry, approach, strike and recovery one continuous path even
      // while the torso turns through the blended clips.
      dashEntry = Math.min(1, dashEntry + dt / lunge.entry);
      const entryEase = dashEntry * dashEntry * (3 - 2 * dashEntry);
      /**
       * `amount - entry`, not `amount`. The figure ARRIVES at the authored mark on the punch rather
       * than leaving it: at full travel the offset is zero and the framing is the one the camera was
       * authored for, and before push-off it is a full dash BEHIND that. `entry` only softens the
       * first frames after the button is pressed, so the step back is taken rather than teleported.
       */
      dashOffset.copy(dashDirection).multiplyScalar((dashAmount - entryEase) * lunge.distance);
      // Scaled by `dashEntry` too, so the first loop's step back onto the start mark stays on the
      // floor instead of the fighter rising while he is still walking backwards.
      lift = liftCurve(lungeClock, lunge) * lunge.liftHeight * dashEntry;
      crouch = crouchCurve(lungeClock, lunge) * lunge.crouchDepth * dashEntry;
      spinAngle = spinCurve(lungeClock, lunge) * dashEntry;
    } else if (dashAmount !== 0 || dashEntry !== 0 || lift !== 0 || crouch !== 0 || spinAngle !== 0) {
      dashAmount = 0;
      dashEntry = 0;
      lift = 0;
      crouch = 0;
      spinAngle = 0;
      poseHeld = false;
      dashOffset.set(0, 0, 0);
    }
    placeCarrier();

    carrier.updateMatrixWorld(true);
    readAnchors(state);

    resolveCrystals(state);
    if (!primed) {
      primed = true;
      for (const block of Object.values(state.blocks)) block.previous.copy(block.emit);
    }
    updateFacing(state);

    // Root lock, computed in the group's own frame so the correction is a function of the animation
    // only and never of the correction already applied.
    /**
     * A SEQUENCED action is locked throughout, whatever its current phase says.
     *
     * Per-clip locking cannot work across a seam. The Knockout runs in on `run`, which carries its
     * root 2.720 H per loop — about 4.5 world units by the time the phase ends — and that drift is
     * only invisible because the lock is cancelling it. Hand over to an unlocked clip and the
     * cancellation stops while the drift is still in the pose, so the figure snaps across the stage
     * by whatever had accumulated. Measured before this: a bone 5.85 units from the carrier and 2.6
     * from the lens, mid-fade.
     *
     * Locking every phase is also the right answer on its own terms: all of this action's intended
     * travel comes from the carrier's glide, so any root motion in any of its clips is drift.
     */
    if (options.holdStance || activeAction?.sequence !== undefined
      || ROOT_LOCKED_CLIPS[activeClip] !== undefined) {
      /**
       * Pinned to the STAGE ORIGIN, not to wherever the hip happened to be on the first locked frame.
       * Latching a reference is the obvious implementation and it is wrong twice over: the first
       * locked frame lands part-way through the 0.22 s cross-fade, so the figure parks wherever the
       * stride had already carried it — measured, 0.5-0.9 world units downrange — and it parks
       * somewhere DIFFERENT every time the button is pressed.
       *
       * Computed as a WORLD offset from the carrier rather than through `worldToLocal`, so a fighter
       * who is facing sideways is still held on the spot instead of being pushed along his own yaw.
       */
      compensation.set(
        carrier.position.x - state.joints.hip.world.x,
        0,
        carrier.position.z - state.joints.hip.world.z,
      );
      placeCarrier();
      // Re-resolve the bones: the effects spawn off world positions, and a stride's worth of
      // correction — up to 0.1 world units in one frame — is a visible offset on the embers.
      carrier.updateMatrixWorld(true);
      readAnchors(state);
      resolveCrystals(state);
      updateFacing(state);
    }

    const inverse = step > 1e-6 ? 1 / step : 0;
    const duration = clip.duration;
    const reference = CLIP_PLUME_REFERENCE[activeClip] ?? 2.5;
    /**
     * The contacts this action fires in the clip that is playing, resolved at construction.
     *
     * Falls back to the unscoped table when the active id is not one of the panel's actions, which is
     * the case for anything a host plays directly.
     */
    const forAction = strikesByAction.get(activeId);
    const strikes = (forAction ?? strikesByClip).get(activeClip) ?? EMPTY_STRIKES;
    // Which contact throws the ball, for a projectile action: the last one the clip schedules.
    let lastStrikeTime = -1;
    for (const strike of strikes) if (strike.time > lastStrikeTime) lastStrikeTime = strike.time;

    // --- the four crystals: velocity, plume, and the windup gather
    for (const name of JADE_BLOCKS) {
      const block = state.blocks[name];
      block.velocity.copy(block.emit).sub(block.previous).multiplyScalar(inverse);
      block.speed = block.velocity.length() / FIGURE_HEIGHT;
      block.previous.copy(block.emit);
      block.history[block.cursor].copy(block.emit);
      block.cursor = (block.cursor + 1) % block.history.length;
      block.filled = Math.min(block.filled + 1, block.history.length);

      const ratio = block.speed / reference;
      const gained = ratio <= PLUME_GATE ? 0 : Math.min(1, (ratio - PLUME_GATE) / (1 - PLUME_GATE));
      // Never zero: the brief is that these crystals burn, so a motionless block still smokes.
      vfx.plume(name, block.emit, block.velocity, PLUME_FLOOR + gained * (1 - PLUME_FLOOR), dt);

      /**
       * The windup, on the action's own lead rather than one global number.
       *
       * A jab telegraphed for half a second is not a jab, and a knockout that loads for two frames
       * is not a knockout — so the lead belongs to the action, and only the knockout asks for a
       * longer one. Every action without a lunge profile keeps `CHARGE_LEAD`.
       */
      const chargeLead = lunge?.chargeLead ?? CHARGE_LEAD;
      let charge = 0;
      for (const strike of strikes) {
        if (strike.block !== name) continue;
        const lead = ahead(strike.time, clipTime, duration);
        if (lead > chargeLead) continue;
        charge = Math.max(charge, Math.pow(1 - lead / chargeLead, 1.6));
      }
      if (charge > 0) vfx.charge(name, block.emit, charge);
    }

    // --- afterimages, while the figure is still gaining ground. Captured on the ACCELERATION only:
    //     ghosts left behind during the slide home read as the figure being dragged backwards.
    const ghostFrom = lunge?.ghostFrom ?? lunge?.start ?? 0;
    const ghostTo = lunge?.ghostTo ?? lunge?.arrive ?? 0;
    if (lunge && lungeClock >= ghostFrom && lungeClock < ghostTo) {
      ghostTimer -= dt;
      if (ghostTimer <= 0) {
        ghostTimer = lunge.ghostInterval;
        vfx.afterimage(lunge.ghostGain);
      }
    } else {
      ghostTimer = 0;
    }

    // --- scheduled events
    const nextTime = (clipTime + step) % duration;
    for (const strike of strikes) {
      if (!crossed(strike.time, clipTime, nextTime)) continue;
      const block = state.blocks[strike.block];
      const family = strike.block === 'handL' || strike.block === 'handR' ? 'hand' : 'foot';
      strikeDirection(block, state, travel);
      contact.copy(block.emit).addScaledVector(travel, CONTACT_OFFSET[family]);
      const range = POWER_RANGE[family];
      /**
       * A LUNGING BLOW CARRIES THE BODY, and the table only measures the limb.
       *
       * `strike.speed` is the crystal's speed relative to the world in the clip as animated, and the
       * clip animates a fighter standing still. When the action also drives him downrange, the mass
       * behind the contact is the sum of the two, so the closing speed is added — converted into the
       * same figure-heights-per-second the table is written in, and credited only to the contact the
       * lunge is timed to ARRIVE on, never to some other contact in the same clip.
       *
       * The corrected uppercut is already fast locally; the closing term ensures the run-up still
       * contributes body mass and clamps the finisher to full power on its authored arrival frame.
       */
      /**
       * Matched with a tolerance, NOT with `===`.
       *
       * `arrive` is authored to land on a measured contact, and an author rounds: the dash's 0.62 is
       * `box_01`'s 0.619 s written out to two places. A 25 ms window is far tighter than the gap to
       * any other contact in these clips and immune to how many decimals the profile is written with.
       */
      /**
       * BOTH SIDES ON THE SAME CLOCK. This comparison was broken for a sequenced action.
       *
       * `strike.time` is clip-local. `lunge.arrive` is clip-local for `DASH` and COMPOSITE for
       * `KNOCKOUT`, because the knockout's profile is written on the action's own 2.78 s timeline.
       * The conversion must also divide the clip-local delta by the phase speed; otherwise slowing
       * the uppercut changes the pose without moving its composite contact time.
       *
       * It went unnoticed because nothing fails loudly when a blow is merely weaker: measured, the
       * knockout's hitstop read below its full-power target — power 0.575 rather than the clamped 1.0
       * — and "the knockout has the largest hitstop" stayed true the whole time. The lesson is that
       * the check was on the ranking, not on the value.
       */
      const phaseNow = sequence?.phases[seqPhase];
      const strikeOnLungeClock = phaseNow
        ? phaseNow.at + (strike.time - phaseNow.offset) / phaseNow.speed
        : strike.time;
      const closing = lunge && Math.abs(strikeOnLungeClock - lunge.arrive) <= 0.025
        ? (lunge.distance / (lunge.arrive - lunge.start)) / FIGURE_HEIGHT
        : 0;
      const power = Math.min(1, Math.max(0, (strike.speed + closing - range.from) / (range.to - range.from)));
      const target = options.projectileTarget;
      if (activeAction?.projectile && strike.time === lastStrikeTime) {
        /**
         * The ball goes where the KICK points, which is NOT where the foot is travelling.
         *
         * Every other effect here is aimed with `strikeDirection`, the crystal's motion over the
         * last six frames, and for an impact that is right — a blow lands along its travel. A
         * projectile is the one case where it is wrong, and wrong in the worst way: the launch fires
         * at the extension APEX, which is by definition the frame the limb reverses, so the six-frame
         * window straddles the turn and the vector it returns is short, noisy and as likely to point
         * back at the figure as away from it. Measured, it launched the ball at yaw 86 degrees while
         * the leg pointed at 156 — the ball flew off sideways and, read against the kick, backwards.
         *
         * The leg itself has no such ambiguity. Hip to crystal, flattened, is the axis the kick is
         * extended along at the exact instant of maximum reach: it is long (0.532 H here), it is
         * stable, and it points at whatever the kick was aimed at.
         */
        aim.copy(block.emit).sub(state.joints.hip.world);
        aim.y = 0;
        if (aim.lengthSq() < 1e-6) aim.copy(facing);
        aim.normalize();

        /**
         * With an opponent on the stage, AIM AT HIM.
         *
         * The leg axis is the right answer when there is nothing to hit — it is where the kick was
         * thrown, and a shot into empty air should go there. It is the wrong answer the moment there
         * is a target of a different height: the duel's Roblin stands 1.502 tall under a launch at
         * 1.835, so a shot down the level leg axis passes cleanly over his head.
         *
         * The leg still decides everything else. It decides WHEN the ball leaves, it decides that a
         * ball leaves at all, and it still has a veto here — a target more than 70 degrees off the
         * kick's own bearing is behind or beside the fighter, and no kick throws a ball there. Inside
         * that cone the aim is taken from the contact to the target's centre, which is what makes the
         * shot arrive at a chest instead of at a height.
         */
        if (target && target.radius > 0) {
          toTarget.copy(target.at).sub(block.emit);
          if (toTarget.lengthSq() > 1e-6) {
            scratch.set(toTarget.x, 0, toTarget.z);
            if (scratch.lengthSq() > 1e-6 && scratch.normalize().dot(aim) > 0.34) {
              aim.copy(toTarget).normalize();
            }
          }
        }
        // Launched off the toe along that same axis, not along the noisy travel vector.
        contact.copy(block.emit).addScaledVector(aim, CONTACT_OFFSET[family]);
        // The ball leaves instead of the blow landing: no shock rings at the boot, no hitstop —
        // nothing was struck. What the foot did was let go.
        vfx.fireball(contact, aim, power);
        firedFireballs += 1;
      } else {
        hitstop = vfx.burst(strike.kind, contact, travel, power);
        /**
         * The finish closes with the victory burst, at the FEET rather than at the contact.
         *
         * It is the same call the duel makes when a bout is won, and it belongs here for the same
         * reason: a knockout is the fight being over. Anchored on the floor under the fighter because
         * that is what it draws — rings out across the ground and a column of fire up the body — and
         * fired from the hip's ground projection so it stays under him wherever the lunge left him.
         */
        if (activeAction?.knockout) {
          scratch.set(state.joints.hip.world.x, 0, state.joints.hip.world.z);
          vfx.celebrate(scratch, power);
        }
        /**
         * A LANDED BLOW REPORTS TOO, not only a projectile.
         *
         * The duel's first roster was one ranged attack, because the fireball was the only thing that
         * carried a hit test. Measured, every one of Raz's blows already lands somewhere specific —
         * the lead at 1.57 world units out on a bearing of -4 degrees, the hook at 1.35 on -11, the
         * cross at 1.08 on -5 — so a punch has exactly as much claim to hitting an opponent standing
         * there as a ball does. The same capsule answers both; only the thing being tested differs.
         */
        if (target && target.radius > 0) {
          const dx = contact.x - target.at.x;
          const dz = contact.z - target.at.z;
          if (dx * dx + dz * dz <= target.radius * target.radius
            && Math.abs(contact.y - target.at.y) <= target.halfHeight) {
            target.onHit(contact);
          }
        }
      }
      lastContact.copy(contact);
      lastContactKind = strike.kind;
      firedStrikes += 1;
    }
    for (const footfall of footfallsByClip.get(activeClip) ?? []) {
      if (!crossed(footfall.time, clipTime, nextTime)) continue;
      vfx.footfall(state.blocks[footfall.block].emit, footfall.drop);
      firedFootfalls += 1;
    }
    clipTime = nextTime;

    vfx.update(dt);
  };

  options.onHandle?.({
    celebrate: (power: number) => {
      // From the FEET, not the chest: the rings run along the floor and the column rises through him.
      scratch.set(0, 0, 0);
      if (bound) {
        bound.joints.hip.bone.getWorldPosition(scratch);
        scratch.y = 0;
      }
      vfx.celebrate(scratch, power);
    },
    stance: (out: THREE.Vector3) => {
      if (bound) bound.joints.hip.bone.getWorldPosition(out);
      else out.set(0, 0, 0);
      return out;
    },
    chest: (out: THREE.Vector3) => {
      if (bound) bound.joints.chest.bone.getWorldPosition(out);
      else out.set(0, 0, 0);
      return out;
    },
    head: (out: THREE.Vector3) => {
      if (bound) bound.joints.head.bone.getWorldPosition(out);
      else out.set(0, 0, 0);
      return out;
    },
    forward: (out: THREE.Vector3) => out.copy(facing),
    crystal: (block: JadeBlock, out: THREE.Vector3) => {
      // Guarded on the lookup, not just on `bound`: a caller that hands over a BONE name instead of
      // one of the four crystals used to take the whole ticker down with it, and a frozen demo is a
      // much worse failure than an effect that does not fire.
      const state = bound?.blocks[block];
      if (state) out.copy(state.emit);
      else out.set(0, 0, 0);
      return out;
    },
    throwFireball: (at, dir, power, tint) => vfx.fireball(at, dir, power, tint),
    clash: (at, axisDir, power) => vfx.clash(at, axisDir, power),
    onProjectilesCollide: (handler) => vfx.onProjectilesCollide(handler),
    face: (yaw: number) => {
      stanceYaw = yaw;
      carrier.rotation.y = stanceYaw + spinAngle;
    },
    recoil: (from: THREE.Vector3, strength: number) => {
      if (!bound) return;
      bound.joints.hip.bone.getWorldPosition(scratch);
      recoilDir.set(scratch.x - from.x, 0, scratch.z - from.z);
      if (recoilDir.lengthSq() < 1e-8) recoilDir.set(1, 0, 0);
      recoilDir.normalize();
      recoilAcross.set(-recoilDir.z, 0, recoilDir.x);
      recoilStrength = strength;
      recoilAge = 0;
    },
    impact: (kind, at, dir, power) => { vfx.burst(kind, at, dir, power); },
  });

  root.userData.sculptRuntime = {
    animationController,
    provenance:
      'Tripo measurement embedded as code by the img2threejs GLB fast lane; a 41-bone '
      + 'rig and 25 clips embedded as Float32 keyframes, including the supplied retargeted uppercut. '
      + 'Strike contacts are measured from their source clips; the knockout phase timing, carrier '
      + 'travel, lift, and afterimage window are explicitly authored in strikeEvents.ts.',
    clips: RAZ_ACTIONS.map((action) => ({ id: action.id, clip: action.clip, note: action.note })),
    /**
     * Live schedule, for the capture harness. Whether an effect fired is not answerable from a
     * screenshot — an unfired detonation and a mistimed one look the same — so the numbers the frame
     * was rendered with are published next to it.
     */
    state: () => ({
      activeId,
      activeClip,
      clipTime: Number(clipTime.toFixed(4)),
      /**
       * The composite clock and the authored draw-down, for the capture harness.
       *
       * Published for the same reason `clipTime` is: a sequenced action has two clocks, and a frame
       * cannot be explained — or a gate written against it — from the clip's alone.
       */
      seqTime: Number(seqTime.toFixed(4)),
      seqPhase,
      phaseSpeed: activeAction?.sequence?.phases[seqPhase]?.speed ?? 1,
      hitstop: Number(hitstop.toFixed(4)),
      fired: { strikes: firedStrikes, footfalls: firedFootfalls, fireballs: firedFireballs },
      lastContact: lastContactKind
        ? { kind: lastContactKind, at: [Number(lastContact.x.toFixed(3)), Number(lastContact.y.toFixed(3)), Number(lastContact.z.toFixed(3))] }
        : null,
      dash: Number(dashAmount.toFixed(3)),
      lift: Number(lift.toFixed(3)),
      crouch: Number(crouch.toFixed(3)),
      spin: Number((spinAngle / (Math.PI * 2)).toFixed(3)),
      poseHeld,
      inPlace: Boolean(activeAction?.knockout
        && seqTime >= KNOCKOUT.spinFrom && seqTime <= KNOCKOUT.liftTo),
      stance: bound
        ? [Number(bound.joints.hip.world.x.toFixed(4)), Number(bound.joints.hip.world.y.toFixed(4)), Number(bound.joints.hip.world.z.toFixed(4))]
        : null,
      proportions: (() => {
        if (!bound) return null;
        let maxPositionError = 0;
        let maxScaleError = 0;
        bound.skeleton.bones.forEach((bone, index) => {
          const bind = bound!.bindPose[index];
          maxPositionError = Math.max(maxPositionError, bone.position.distanceTo(bind.position));
          maxScaleError = Math.max(
            maxScaleError,
            Math.abs(bone.scale.x - bind.scale.x),
            Math.abs(bone.scale.y - bind.scale.y),
            Math.abs(bone.scale.z - bind.scale.z),
          );
        });
        return {
          maxPositionError: Number(maxPositionError.toFixed(7)),
          maxScaleError: Number(maxScaleError.toFixed(7)),
          rootHipLength: Number(bound.skeleton.bones[1].position.length().toFixed(4)),
        };
      })(),
      blockSpeed: bound
        ? Object.fromEntries(JADE_BLOCKS.map((name) => [name, Number(bound!.blocks[name].speed.toFixed(2))]))
        : null,
      facing: [Number(facing.x.toFixed(2)), Number(facing.y.toFixed(2)), Number(facing.z.toFixed(2))],
      vfx: vfx.counts(),
    }),
    measured: {
      strikes: STRIKE_EVENTS.length,
      footfalls: FOOTFALL_EVENTS.length,
      figureHeight: FIGURE_HEIGHT,
      rootLocked: Object.keys(ROOT_LOCKED_CLIPS),
    },
  };

  // ----------------------------------------------------------------------------------- binding
  function bind(): void {
    const { projectileTarget: _target, ...buildOptions } = options;
    const rigged = createRazRigged(buildOptions);
    const skeleton = rigged.mesh.skeleton;
    const anchorFor = (name: string): Anchor => {
      const bone = skeleton.getBoneByName(name);
      if (!bone) throw new Error(`raz rig has no bone named ${name}`);
      return { bone, world: new THREE.Vector3() };
    };
    const clipByName = new Map(rigged.clips.map((entry) => [entry.name, entry]));
    const bindPose = skeleton.bones.map((bone) => ({
      position: bone.position.clone(),
      scale: bone.scale.clone(),
    }));
    const requiredClips = new Set([
      ...RAZ_ACTIONS.map((action) => action.clip),
      ...RAZ_ACTIONS.flatMap((action) => action.sequence?.phases.map((phase) => phase.clip) ?? []),
      RAZ_IDLE_CLIP,
    ]);
    for (const name of requiredClips) {
      if (!clipByName.has(name)) throw new Error(`raz rig has no clip ${name}`);
    }
    const joints = Object.fromEntries(
      Object.entries(VFX_JOINTS).map(([key, bone]) => [key, anchorFor(bone)]),
    ) as Record<keyof typeof VFX_JOINTS, Anchor>;

    const makeBlock = (anchor: Anchor): BlockState => ({
      anchor,
      emit: new THREE.Vector3(),
      previous: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      history: Array.from({ length: 6 }, () => new THREE.Vector3()),
      cursor: 0,
      filled: 0,
      speed: 0,
    });

    carrier.add(rigged.group);
    // The afterimages are copies of THIS mesh, so they cannot exist until the geometry has landed.
    vfx.bindGhosts(rigged.mesh);
    bound = {
      play: rigged.play,
      update: rigged.update,
      modelGroup: rigged.group,
      skeleton,
      bindPose,
      clipByName,
      joints,
      blocks: {
        handL: makeBlock(joints.handL),
        handR: makeBlock(joints.handR),
        // The crystal is under the SOLE, so the toe joint is the anchor and not the ankle: a plume
        // hung off `L_Foot` sits a boot's height above the glow it is supposed to be coming out of.
        footL: makeBlock(joints.toeL),
        footR: makeBlock(joints.toeR),
      },
    };
    // A button pressed while the level was still downloading is honoured here rather than dropped.
    const requested = pending ? RAZ_ACTIONS.find((entry) => entry.id === pending) : undefined;
    pending = null;
    primed = false;
    clipTime = 0;
    switchTo(requested?.id ?? RAZ_IDLE_ID, requested?.clip ?? RAZ_IDLE_CLIP, 0);
  }

  // Same task when the level is already in memory — the landing workbench reads the parts and
  // triangle counts off this group in the task `build()` returns in, and a deferred bind left it
  // reporting an empty model. Deferred only when the geometry genuinely has not arrived yet.
  if (razReady()) bind();
  else void prewarmRaz().then(bind);

  return root;
}

/**
 * A rig balanced against the fact that the effects are ADDITIVE and GREEN — in both directions.
 *
 * Additive blending can only brighten what is behind it, so a bright stage leaves a detonation
 * nowhere to go: light the figure warmly and the fire is a pale wash on an already-bright shoulder.
 * The first pass over-corrected on exactly that reasoning and took the key down to 42 with the
 * exposure at 0.85 — and the reference's brushed-steel plates and silver pauldrons came out as a
 * black silhouette with four green lamps stuck to it. The figure has to be READABLE for the fire on
 * it to mean anything.
 *
 * So: a cold key bright enough to find the steel, a fill weak enough that the shadow side is shaped
 * rather than filled, and mid-tones that still sit well below the burst. Cold, because the one thing
 * that genuinely does eat a green effect is green ambient.
 *
 * The two rims ARE jade, and they are the one place the palette is allowed onto the model itself —
 * they read as the crystals' own light spilling onto the plate around them, which is what ties the
 * effect to the figure instead of leaving it floating in front of it.
 */
export function createRazLights(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'raz-lights';

  // Aimed from the side the figure faces — measured, not assumed: the shoulder-and-toe sweep puts
  // its facing between +X and +Z across the curated clips.
  const key = new THREE.SpotLight(0xd8e6f2, 90, 14, 0.70, 0.45, 1.7);
  key.position.set(2.6, 4.3, 2.2);
  key.target.position.set(0, 0.95, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 14;
  key.shadow.bias = -0.0008;
  group.add(key, key.target);

  // Across the stage, dimmer, so the shadow side is SHAPED rather than filled.
  const opposite = new THREE.SpotLight(0x9fb4c8, 34, 14, 0.76, 0.55, 1.7);
  opposite.position.set(-2.0, 3.4, -2.6);
  opposite.target.position.set(0, 0.9, 0);
  group.add(opposite, opposite.target);

  const rimLow = new THREE.DirectionalLight(0x2bff8c, 1.8);
  rimLow.position.set(-2.4, 0.5, 2.2);
  group.add(rimLow);

  const rimBack = new THREE.DirectionalLight(0x0f9e59, 1.3);
  rimBack.position.set(1.2, 0.9, -3.0);
  group.add(rimBack);

  // Just enough bounce that the floor side of the boots does not go to pure black — and it is tinted
  // green from below, as if the soles were lighting the ground they stand on.
  group.add(new THREE.HemisphereLight(0x2c3d44, 0x0b1f14, 0.9));

  /**
   * Jade haze: a hundred and twenty motes on a slow upward drift, recycled at the top. It is the
   * cheapest possible way to say "this air has been burned in", and it gives the cold key something
   * to catch so the beam reads as a beam.
   */
  const MOTES = 120;
  const position = new Float32Array(MOTES * 3);
  const seed = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i += 1) {
    position[i * 3] = (Math.random() - 0.5) * 2.6;
    position[i * 3 + 1] = Math.random() * 2.8;
    position[i * 3 + 2] = (Math.random() - 0.5) * 2.6;
    seed[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColour: { value: new THREE.Color(0x7dffbd) }, uScale: { value: 130 } },
    vertexShader: `
      attribute float aSeed;
      uniform float uScale;
      varying float vSeed;
      void main() {
        vSeed = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (0.35 + aSeed * 0.8) * uScale / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColour;
      varying float vSeed;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float mask = smoothstep(0.5, 0.0, length(uv) * 2.0);
        gl_FragColor = vec4(uColour, mask * (0.04 + vSeed * 0.08));
      }`,
  });
  const motes = new THREE.Points(geometry, material);
  motes.frustumCulled = false;
  motes.userData.isHighlight = true;
  motes.userData.tick = (delta: number): void => {
    const dt = Math.min(0.05, Math.max(0, delta));
    for (let i = 0; i < MOTES; i += 1) {
      position[i * 3 + 1] += (0.02 + seed[i] * 0.05) * dt;
      position[i * 3] += Math.sin(position[i * 3 + 1] * 3.1 + seed[i] * 6.28) * 0.22 * dt;
      if (position[i * 3 + 1] > 2.9) position[i * 3 + 1] = 0;
    }
    positionAttribute.needsUpdate = true;
  };
  group.add(motes);

  return group;
}
