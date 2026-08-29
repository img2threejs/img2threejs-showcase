import * as THREE from 'three';
import { createChunLiRigged, prewarmChunLi, type ChunLiOptions } from './createChunLiModel';
import { createChunLiVfx, type ChunLiVfx } from './chunLiVfx';
import {
  AURA_SURGES,
  CHUN_LI_ACTIONS,
  CHUN_LI_IDLE_ID,
  FIGURE_HEIGHT,
  GROUND_SLAM,
  KIKOKEN,
  LEAP,
  ROOT_LOCKED_CLIPS,
  STRIKE_EVENTS,
  TRAIL_GATE,
  TRAIL_REFERENCE,
  VFX_JOINTS,
  actionFor,
  footfallsForClip,
  strikesForClip,
  type ChunLiAction,
} from './chunLiEvents';

/**
 * The showcase build: the rigged figure, nine curated clips, and an effects layer scheduled against
 * the measured tables in `chunLiEvents.ts`.
 *
 * WHY A SCHEDULE AND NOT A LIVE DETECTOR. "Fire when the foot decelerates" can only know a kick
 * landed AFTER it lands, because the deceleration takes ~0.1 s to observe. That is two faults at
 * once: the flash is late, and a windup charge cannot exist at all, since nothing knows a strike is
 * coming. Scheduling against the measured table fixes both — the burst fires on the frame the limb
 * arrives, and the 0.2 s before it are spent gathering ki into the limb that is about to arrive.
 *
 * HITSTOP. On contact the clip drops to a fifth speed for 40-105 ms, scaled by the measured strike
 * speed. It is the single largest contributor to how hard a hit reads, and it costs one multiply,
 * because the mixer is driven from here — so the schedule stays consistent with the slowed clip for
 * free.
 *
 * ROOT LOCK. `sprint` carries the hips 3.71 H per loop and `dash-leap` 7.61 H. Both are held by
 * subtracting the hip's own horizontal displacement from the model group, measured in the group's
 * LOCAL frame so the correction cannot chase itself. The stride is untouched: contact times, dust
 * and ribbons all still happen where the sweep measured them.
 *
 * BUILD ORDER, AND WHY THE BIND IS DEFERRED. `build()` is synchronous by the registry's contract
 * and the viewer calls it BEFORE the registry's `prewarm` has resolved — it awaits `prewarm` only
 * afterwards, to rebuild the parts list around the geometry that lands late. The level of detail
 * lives in its own chunk, so at `build()` time there is nothing to bind to and `createChunLiRigged`
 * would throw. This therefore returns a root holding only the effects layer and binds the figure
 * when `prewarmChunLi` resolves.
 *
 * The ticker and the animation controller are published immediately, before the bind: the viewer
 * collects tickers on its own schedule and the demo panel reads the controller on the frame after
 * `build()`, so both have to exist before the geometry does. An action pressed inside that window
 * is remembered in `pending` and applied on binding rather than dropped.
 */

/** How long before a scheduled strike the limb starts gathering ki. */
const CHARGE_LEAD = 0.2;
const HITSTOP_SCALE = 0.2;
/** Above this fraction of the clip's own reference speed, a moving body throws speed lines. */
const SPEEDLINE_GATE = 0.45;

type JointName = keyof typeof VFX_JOINTS;

interface Anchor {
  bone: THREE.Bone;
  world: THREE.Vector3;
}

interface LimbState {
  anchor: Anchor;
  previous: THREE.Vector3;
  /** Six frames of travel, so a strike's direction survives the frame the limb stops on. */
  history: THREE.Vector3[];
  cursor: number;
  filled: number;
  speed: number;
}

interface Bound {
  play: (clip: string, fade: number) => boolean;
  update: (delta: number) => void;
  modelGroup: THREE.Group;
  baseOffset: THREE.Vector3;
  clipByName: Map<string, THREE.AnimationClip>;
  joints: Record<JointName, Anchor>;
  limbs: Record<string, LimbState>;
}

export function createChunLiShowcase(options: ChunLiOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'chun-li';

  const vfx: ChunLiVfx = createChunLiVfx();
  root.add(vfx.group);

  let bound: Bound | null = null;
  let action: ChunLiAction = CHUN_LI_ACTIONS.find((a) => a.id === CHUN_LI_IDLE_ID)!;
  let pending: string | null = null;
  let clipTime = 0;
  let hitstop = 0;
  let lockArmed = false;
  let primed = false;
  const fired = { strikes: 0, footfalls: 0, orbs: 0, strides: 0 };

  const lockReference = new THREE.Vector3();
  const compensation = new THREE.Vector3();
  const travel = new THREE.Vector3();
  const contact = new THREE.Vector3();
  const palms = new THREE.Vector3();
  const facing = new THREE.Vector3(1, 0, 0);
  const shoulder = new THREE.Vector3();
  const stance = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const listeners = new Set<(active: string) => void>();
  const notify = (): void => listeners.forEach((listener) => listener(action.id));

  function switchTo(next: ChunLiAction, fade: number): void {
    action = next;
    clipTime = 0;
    hitstop = 0;
    lockArmed = false;
    compensation.set(0, 0, 0);
    // A Kikoken in flight belongs to the action that threw it. Leaving it alive across a switch
    // puts an orb in the middle of a sprint with nothing that fired it.
    vfx.reset();
    if (bound) {
      bound.play(next.clip, fade);
      bound.modelGroup.position.copy(bound.baseOffset);
      for (const limb of Object.values(bound.limbs)) limb.filled = 0;
    } else {
      pending = next.id;
    }
    notify();
  }

  const animationController = {
    actions: CHUN_LI_ACTIONS.map(({ id, label }) => ({ id, label, loop: true })),
    get active(): string { return action.id; },
    play(id: string): void {
      const next = actionFor(id);
      if (next) switchTo(next, 0.22);
    },
    stop(): void {
      switchTo(CHUN_LI_ACTIONS.find((a) => a.id === CHUN_LI_IDLE_ID)!, 0.3);
    },
    subscribe(listener: (active: string) => void): () => void {
      listeners.add(listener);
      listener(action.id);
      return () => listeners.delete(listener);
    },
  };

  // ------------------------------------------------------------------------ schedule helpers
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
    for (const anchor of Object.values(state.joints)) anchor.bone.getWorldPosition(anchor.world);
  }

  /**
   * Which way she is looking, taken from measured geometry rather than off a bone quaternion: the
   * rig's bone axes are its own, so reading a "forward" out of one would be a guess.
   *
   * The clavicle line gives the AXIS precisely — this figure's shoulders span Z and she faces X,
   * which is why the demo's camera is on +X and not on the download's +Z. It cannot give the SIDE:
   * the normal of a line is equally the chest and the back. The ankle-to-toe vector settles that,
   * because toes point forward on every human and on this rig.
   *
   * The sign is then held by CONTINUITY rather than re-decided every frame. In `front_kick_02` and
   * `cast_a_spell` the feet turn far enough that the toe test alone flips 180 degrees mid-clip, and
   * a Kikoken thrown on that frame flies backwards through her.
   */
  function updateFacing(state: Bound): void {
    shoulder.copy(state.joints.clavicleL.world).sub(state.joints.clavicleR.world);
    shoulder.y = 0;
    if (shoulder.lengthSq() < 1e-8) return;
    scratch.copy(up).cross(shoulder.normalize()).normalize();
    if (!primed) {
      stance.copy(state.joints.toeL.world).sub(state.joints.footL.world);
      stance.add(contact.copy(state.joints.toeR.world).sub(state.joints.footR.world));
      stance.y = 0;
      if (stance.lengthSq() > 1e-8 && scratch.dot(stance.normalize()) < 0) scratch.negate();
    } else if (scratch.dot(facing) < 0) {
      scratch.negate();
    }
    facing.copy(scratch);
  }

  /**
   * Direction of TRAVEL over the last few frames, not the instantaneous velocity: on the frame a
   * strike lands the limb has already stopped, and its velocity there points nowhere useful.
   */
  function strikeDirection(limb: LimbState, state: Bound, out: THREE.Vector3): void {
    const size = limb.history.length;
    if (limb.filled >= 2) {
      const newest = limb.history[(limb.cursor - 1 + size) % size];
      const oldest = limb.history[(limb.cursor - Math.min(limb.filled, size) + size * 2) % size];
      out.copy(newest).sub(oldest);
    } else {
      out.set(0, 0, 0);
    }
    if (out.lengthSq() < 1e-6) {
      // Reaching away from the chest, which is where a strike goes by definition.
      out.copy(limb.anchor.world).sub(state.joints.chest.world);
      out.y *= 0.35;
    }
    if (out.lengthSq() < 1e-9) out.copy(facing);
    out.normalize();
  }

  const limbKeys = ['hand:left', 'hand:right', 'foot:left', 'foot:right'] as const;
  const anchorKeyFor: Record<string, JointName> = {
    'hand:left': 'handL', 'hand:right': 'handR', 'foot:left': 'toeL', 'foot:right': 'toeR',
  };

  // ---------------------------------------------------------------------------- per frame
  root.userData.tick = (delta: number): void => {
    const dt = Math.min(0.05, Math.max(0, delta));
    const state = bound;
    if (!state) { vfx.update(dt); return; }
    const clip = state.clipByName.get(action.clip);
    if (!clip) { vfx.update(dt); return; }

    // Hitstop: the clip crawls for a few frames after a strike lands. Charged down in REAL time,
    // so a slowed clip cannot stretch its own hitstop.
    let scale = 1;
    if (hitstop > 0) {
      hitstop = Math.max(0, hitstop - dt);
      scale = HITSTOP_SCALE;
    }
    state.update(dt * scale);
    state.modelGroup.updateMatrixWorld(true);
    readAnchors(state);

    if (!primed) {
      updateFacing(state);
      primed = true;
      for (const limb of Object.values(state.limbs)) limb.previous.copy(limb.anchor.world);
    } else {
      updateFacing(state);
    }

    // Root lock, computed in the group's own frame so the correction is a function of the animation
    // only and never of the correction already applied.
    if (ROOT_LOCKED_CLIPS[action.clip] !== undefined) {
      scratch.copy(state.joints.hip.world);
      state.modelGroup.worldToLocal(scratch);
      if (!lockArmed) { lockReference.copy(scratch); lockArmed = true; }
      compensation.set(lockReference.x - scratch.x, 0, lockReference.z - scratch.z);
      state.modelGroup.position.copy(state.baseOffset).add(compensation);
      // Re-resolve the bones: the effects spawn off world positions, and a stride's worth of
      // correction is a visible offset on the dust it throws.
      state.modelGroup.updateMatrixWorld(true);
      readAnchors(state);
      updateFacing(state);
    }

    const step = dt * scale;
    const inverse = step > 1e-6 ? 1 / step : 0;
    const duration = clip.duration;
    const reference = TRAIL_REFERENCE[action.clip] ?? 2.5;
    const strikes = strikesForClip(action.clip);

    // --- limb speed, ribbons and windup charge
    for (const key of limbKeys) {
      const limb = state.limbs[key];
      limb.speed = limb.anchor.world.distanceTo(limb.previous) * inverse / FIGURE_HEIGHT;
      limb.previous.copy(limb.anchor.world);
      limb.history[limb.cursor].copy(limb.anchor.world);
      limb.cursor = (limb.cursor + 1) % limb.history.length;
      limb.filled = Math.min(limb.filled + 1, limb.history.length);

      const ratio = limb.speed / reference;
      const strength = ratio <= TRAIL_GATE ? 0 : Math.min(1, (ratio - TRAIL_GATE) / (1 - TRAIL_GATE));
      const [limbKind, limbSide] = key.split(':') as ['hand' | 'foot', 'left' | 'right'];
      vfx.trail(limbKind, limbSide, limb.anchor.world, strength);

      // Windup: only for the limb that is actually about to arrive.
      let charge = 0;
      for (const strike of strikes) {
        if (`${strike.limb}:${strike.side}` !== key) continue;
        const lead = ahead(strike.time, clipTime, duration);
        if (lead > CHARGE_LEAD) continue;
        charge = Math.max(charge, Math.pow(1 - lead / CHARGE_LEAD, 1.6));
      }
      if (charge > 0) vfx.charge(limb.anchor.world, charge, true);

      // Travelling clips: anything moving hard leaves a motion streak behind it.
      if (action.kind === 'move' && ratio > SPEEDLINE_GATE) {
        strikeDirection(limb, state, travel);
        vfx.speedline(limb.anchor.world, travel, Math.min(1, (ratio - SPEEDLINE_GATE) / 0.9));
      }
    }

    const nextTime = (clipTime + step) % duration;

    // --- scheduled strikes
    for (const strike of strikes) {
      if (!crossed(strike.time, clipTime, nextTime)) continue;
      const key = `${strike.limb}:${strike.side}`;
      const limb = state.limbs[key];
      strikeDirection(limb, state, travel);
      // Contact is a limb-length ahead of the joint the bone actually sits on.
      contact.copy(limb.anchor.world).addScaledVector(travel, strike.limb === 'foot' ? 0.11 : 0.075);
      // Power off the measured speed: 1.6 H/s is the softest arrival kept, 7.42 the hardest.
      const power = Math.min(1, Math.max(0, (strike.speed - 1.6) / 4.2));
      if (action.kind === 'move') {
        // A stride is a push against the floor, not a blow: dust, no flash, no hitstop.
        vfx.stride(limb.anchor.world, travel, power);
        fired.strides += 1;
      } else if (action.clip === GROUND_SLAM.clip && Math.abs(strike.time - GROUND_SLAM.time) < 0.02) {
        // Both hands arrive on the same frame here; only the first of them makes the crater.
        if (strike.side === 'left') { vfx.slam(contact, power); fired.strikes += 1; }
        hitstop = Math.max(hitstop, 0.1);
      } else {
        hitstop = Math.max(hitstop, vfx.strike(strike.limb, contact, travel, power));
        fired.strikes += 1;
      }
    }

    // --- scheduled footfalls
    for (const footfall of footfallsForClip(action.clip)) {
      if (!crossed(footfall.time, clipTime, nextTime)) continue;
      const toe = footfall.side === 'left' ? state.joints.toeL : state.joints.toeR;
      vfx.footfall(toe.world, footfall.drop);
      fired.footfalls += 1;
    }

    // --- Kikoken, choreographed against the measured palm curves
    if (action.clip === KIKOKEN.clip) {
      palms.copy(state.joints.handL.world).add(state.joints.handR.world).multiplyScalar(0.5);
      let gathering = 0;
      let forming = false;
      for (const window of KIKOKEN.gather) {
        if (clipTime < window.from || clipTime > window.to) continue;
        gathering = Math.max(gathering, (clipTime - window.from) / (window.to - window.from));
        forming = forming || window.forms;
      }
      if (gathering > 0) {
        vfx.charge(palms, gathering);
        if (forming) vfx.formOrb(palms, gathering);
      }
      if (crossed(KIKOKEN.flare, clipTime, nextTime)) vfx.flare(palms, 0.6);
      if (crossed(KIKOKEN.fire, clipTime, nextTime)) {
        // Launched along the measured facing, lifted slightly so it clears the floor ring.
        scratch.copy(facing);
        scratch.y = 0.05;
        vfx.fireOrb(palms, scratch.normalize(), KIKOKEN.flight, KIKOKEN.range * FIGURE_HEIGHT);
        hitstop = Math.max(hitstop, 0.07);
        fired.orbs += 1;
      }
    }

    // --- battle aura, swelling to each measured reach peak
    if (action.kind === 'aura') {
      let surge = 0.28;
      for (const at of AURA_SURGES) {
        const distance = Math.abs(((clipTime - at + duration * 1.5) % duration) - duration * 0.5);
        surge = Math.max(surge, Math.pow(Math.max(0, 1 - distance / 0.55), 1.4));
      }
      scratch.copy(state.joints.hip.world);
      vfx.aura(scratch, surge);
    }

    // --- the leap at the end of the dash: a launch ring at the apex, dust when she comes back
    if (action.clip === LEAP.clip && crossed(LEAP.apex, clipTime, nextTime)) {
      scratch.copy(state.joints.hip.world);
      vfx.flare(scratch, 0.85);
    }

    // --- an idle guard is never completely still
    if (action.kind === 'idle') {
      vfx.breathe(state.joints.handL.world);
      vfx.breathe(state.joints.handR.world);
    }

    clipTime = nextTime;
    vfx.update(dt);
  };

  root.userData.sculptRuntime = {
    animationController,
    provenance:
      'Tripo v3.1-20260211 measurement embedded as code by the img2threejs GLB fast lane: a 41-bone '
      + 'rig and 27 clips as Float32 keyframes, nothing fetched. Every effect timing was measured '
      + 'off those clips at 400 samples rather than authored by eye.',
    clips: CHUN_LI_ACTIONS.map((entry) => ({ id: entry.id, clip: entry.clip, kind: entry.kind, note: entry.note })),
    /**
     * Live schedule, for the capture harness. Whether an effect fired is not answerable from a
     * screenshot — an unfired burst and a mistimed one look the same — so the numbers the frame was
     * rendered with are published next to it.
     */
    state: () => ({
      action: action.id,
      clip: action.clip,
      clipTime: Number(clipTime.toFixed(4)),
      hitstop: Number(hitstop.toFixed(4)),
      fired: { ...fired },
      facing: [Number(facing.x.toFixed(2)), Number(facing.y.toFixed(2)), Number(facing.z.toFixed(2))],
      limbSpeed: bound
        ? Object.fromEntries(limbKeys.map((key) => [key, Number(bound!.limbs[key].speed.toFixed(2))]))
        : null,
      vfx: vfx.counts(),
    }),
    measured: {
      strikes: STRIKE_EVENTS.length,
      actions: CHUN_LI_ACTIONS.length,
      rootLocked: Object.keys(ROOT_LOCKED_CLIPS),
    },
  };

  // ----------------------------------------------------------------------------- binding
  function bind(): void {
    const rigged = createChunLiRigged(options);
    const skeleton = rigged.mesh.skeleton;
    const anchorFor = (name: string): Anchor => {
      const bone = skeleton.getBoneByName(name);
      if (!bone) throw new Error(`chun-li rig has no bone named ${name}`);
      return { bone, world: new THREE.Vector3() };
    };
    const clipByName = new Map(rigged.clips.map((entry) => [entry.name, entry]));
    for (const entry of CHUN_LI_ACTIONS) {
      if (!clipByName.has(entry.clip)) throw new Error(`chun-li rig has no clip ${entry.clip}`);
    }
    const joints = Object.fromEntries(
      Object.entries(VFX_JOINTS).map(([key, boneName]) => [key, anchorFor(boneName)]),
    ) as Record<JointName, Anchor>;
    const limbs: Record<string, LimbState> = {};
    for (const key of limbKeys) {
      limbs[key] = {
        anchor: joints[anchorKeyFor[key]],
        previous: new THREE.Vector3(),
        history: Array.from({ length: 6 }, () => new THREE.Vector3()),
        cursor: 0,
        filled: 0,
        speed: 0,
      };
    }
    root.add(rigged.group);
    bound = {
      play: rigged.play,
      update: rigged.update,
      modelGroup: rigged.group,
      baseOffset: rigged.group.position.clone(),
      clipByName,
      joints,
      limbs,
    };
    // Whatever the panel asked for while the geometry was still arriving.
    const wanted = pending ? actionFor(pending) : undefined;
    pending = null;
    bound.play(wanted?.clip ?? action.clip, 0);
    if (wanted) action = wanted;
    notify();
  }

  // `prewarmChunLi` caches and hands back the same resolved promise, so calling it here as well as
  // from the registry costs one extra microtask and never fetches the level twice.
  void prewarmChunLi().then(bind);
  return root;
}
