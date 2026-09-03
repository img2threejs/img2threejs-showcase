import * as THREE from 'three';
import {
  createMonsterRigged,
  monsterReady,
  prewarmMonster,
  type MonsterOptions,
} from './createMonsterModel';
import { createAbyssVfx, type AbyssVfx, type Claw } from './abyssVfx';
import {
  CLIP_TRAIL_REFERENCE,
  FIGURE_HEIGHT,
  FOOTFALL_EVENTS,
  MONSTER_ACTIONS,
  MONSTER_IDLE_CLIP,
  ROOT_LOCKED_CLIPS,
  STAGGER_EVENTS,
  STRIKE_EVENTS,
  TRAIL_GATE,
  VFX_JOINTS,
  type Limb,
} from './strikeEvents';

/**
 * The showcase build: the rigged monster, thirteen curated clips, and an abyss layer driven off the
 * measured events in `strikeEvents.ts`.
 *
 * WHY A SCHEDULER AND NOT A LOOK-AT-THE-SPEED TRIGGER. A live detector — "tear the air when the
 * claw decelerates" — can only know a strike happened AFTER it has happened, because the
 * deceleration takes about 0.1 s to observe. That is two faults at once: the tear is late, and the
 * windup cannot exist at all, because nothing knows a strike is coming. Scheduling against the
 * measured table answers both: the crescent is drawn on the frame the claw stops, and the 0.26 s
 * before it are spent pulling matter into the claw.
 *
 * HITSTOP. On impact the clip drops to a quarter speed for 50-95 ms depending on the strike. This
 * is the single largest contributor to how hard an attack reads, and it costs one multiply — the
 * mixer is driven from here, so the schedule stays consistent with the slowed clip automatically.
 *
 * ROOT LOCK. `run` carries the figure 3.042 H forward per loop, `walk` 1.558 H and `jump_down`
 * 1.133 H. All three are held in place by subtracting the hip's own horizontal displacement from
 * the model group, measured in the group's local frame so the correction cannot chase itself. The
 * stride is untouched: contacts, ash and trails still happen where the sweep measured them.
 *
 * WHAT THE AURA IS ANCHORED TO. Eleven bones, not one: hands, shoulders, chest, waist, hip, head
 * and both feet. A cloud anchored to the hip alone rotates as one body when the monster turns and
 * reads as a parented system; a cloud spread over eleven anchors with per-mote lag deforms with the
 * pose, so a claw thrown forward drags its own wisps out of the mass.
 *
 * BUILD ORDER. `build()` is synchronous by the registry's contract while the level of detail lives
 * in its own chunk, so this returns a root holding only the effects layer and binds the figure when
 * `prewarmMonster` resolves. The ticker and the animation controller are published immediately —
 * the viewer collects tickers exactly once, and the demo panel reads the controller on the frame
 * after `build()` — so both have to exist before the geometry does. A button pressed in that window
 * is remembered and applied on binding rather than dropped.
 */

/** Seconds of windup before a scheduled strike, spent gathering matter into the claw. */
const GATHER_LEAD = 0.26;
const HITSTOP_SCALE = 0.25;
const BREATH_INTERVAL = 3.1;
/** Base aura intensity while the monster is merely standing there. */
const AURA_REST = 0.58;

interface Anchor {
  bone: THREE.Bone;
  world: THREE.Vector3;
}

interface LimbState {
  anchor: Anchor;
  previous: THREE.Vector3;
  /** Six frames of travel, so a strike's direction survives the frame the claw stops on. */
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
  joints: Record<keyof typeof VFX_JOINTS, Anchor>;
  limbs: Record<Limb, LimbState>;
  /** The world vectors the aura orbits — the same objects the joints write into every frame. */
  auraAnchors: THREE.Vector3[];
}

export function createMonsterShowcase(options: MonsterOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'monster';

  const vfx: AbyssVfx = createAbyssVfx();
  root.add(vfx.group);

  let bound: Bound | null = null;
  let activeId = 'idle';
  let activeClip = MONSTER_IDLE_CLIP;
  let pending: string | null = null;
  let clipTime = 0;
  let hitstop = 0;
  let breathTimer = BREATH_INTERVAL * 0.5;
  let shedTimer = 0;
  let lockArmed = false;
  let primed = false;
  let firedStrikes = 0;
  let firedFootfalls = 0;
  let firedStaggers = 0;
  /** Decays after every strike; drives the aura, the eyes and the floor together. */
  let arousal = 0;
  let auraLevel = AURA_REST;

  const lockReference = new THREE.Vector3();
  const compensation = new THREE.Vector3();
  const travel = new THREE.Vector3();
  const contact = new THREE.Vector3();
  const facing = new THREE.Vector3(0, 0, 1);
  const shoulderLine = new THREE.Vector3();
  const stance = new THREE.Vector3();
  const side = new THREE.Vector3();
  const eyeLeft = new THREE.Vector3();
  const eyeRight = new THREE.Vector3();
  const drift = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const listeners = new Set<(active: string) => void>();
  const notify = (): void => listeners.forEach((listener) => listener(activeId));

  function switchTo(id: string, clip: string, fade: number): void {
    activeId = id;
    activeClip = clip;
    clipTime = 0;
    hitstop = 0;
    lockArmed = false;
    compensation.set(0, 0, 0);
    if (bound) {
      bound.play(clip, fade);
      bound.modelGroup.position.copy(bound.baseOffset);
      for (const limb of Object.values(bound.limbs)) limb.filled = 0;
    } else {
      pending = id;
    }
    notify();
  }

  const animationController = {
    actions: MONSTER_ACTIONS.map(({ id, label }) => ({ id, label, loop: true })),
    get active(): string { return activeId; },
    play(id: string): void {
      const action = MONSTER_ACTIONS.find((entry) => entry.id === id);
      if (!action) return;
      switchTo(action.id, action.clip, 0.22);
    },
    stop(): void {
      switchTo('idle', MONSTER_IDLE_CLIP, 0.30);
    },
    subscribe(listener: (active: string) => void): () => void {
      listeners.add(listener);
      listener(activeId);
      return () => listeners.delete(listener);
    },
  };

  // -------------------------------------------------------------------------- measured schedule
  const strikesByClip = new Map<string, typeof STRIKE_EVENTS>();
  const footfallsByClip = new Map<string, typeof FOOTFALL_EVENTS>();
  const staggersByClip = new Map<string, typeof STAGGER_EVENTS>();
  for (const event of STRIKE_EVENTS) {
    strikesByClip.set(event.clip, STRIKE_EVENTS.filter((entry) => entry.clip === event.clip));
  }
  for (const event of FOOTFALL_EVENTS) {
    footfallsByClip.set(event.clip, FOOTFALL_EVENTS.filter((entry) => entry.clip === event.clip));
  }
  for (const event of STAGGER_EVENTS) {
    staggersByClip.set(event.clip, STAGGER_EVENTS.filter((entry) => entry.clip === event.clip));
  }

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
   * Which way the monster is looking, taken from measured geometry rather than off a bone
   * quaternion: the rig's bone axes are its own — the root alone carries a 120-degree quaternion —
   * so reading a "forward" out of one would be a guess.
   *
   * The shoulder line gives the AXIS precisely, because the torso leads a swing. It cannot give the
   * SIDE: its normal is equally the chest and the back. The ankle-to-toe vector settles that — toes
   * point forward on this rig as on any biped — so the sign comes from the feet and the precision
   * from the shoulders. `front_kick_02` turns through 130 degrees inside 1.4 s, so a sign decided
   * once at rest would be inverted halfway through the spin.
   */
  function updateFacing(state: Bound): void {
    shoulderLine.copy(state.joints.shoulderL.world).sub(state.joints.shoulderR.world);
    shoulderLine.y = 0;
    if (shoulderLine.lengthSq() < 1e-8) return;
    facing.copy(up).cross(shoulderLine.normalize()).normalize();
    stance.copy(state.joints.toeL.world).sub(state.joints.footL.world);
    scratch.copy(state.joints.toeR.world).sub(state.joints.footR.world);
    stance.add(scratch);
    stance.y = 0;
    if (stance.lengthSq() > 1e-8 && facing.dot(stance.normalize()) < 0) facing.negate();
  }

  function strikeDirection(limb: LimbState, state: Bound, out: THREE.Vector3): void {
    // Direction of TRAVEL over the last few frames, not the instantaneous velocity: on the frame a
    // strike lands the claw has already stopped, and its velocity there points nowhere useful.
    const size = limb.history.length;
    if (limb.filled >= 2) {
      const newest = limb.history[(limb.cursor - 1 + size) % size];
      const oldest = limb.history[(limb.cursor - Math.min(limb.filled, size) + size * 2) % size];
      out.copy(newest).sub(oldest);
    } else {
      out.set(0, 0, 0);
    }
    if (out.lengthSq() < 1e-6) {
      // Reaching away from the chest, which is where a swing goes by definition.
      out.copy(limb.anchor.world).sub(state.joints.chest.world);
      out.y *= 0.35;
    }
    if (out.lengthSq() < 1e-9) out.copy(facing);
    out.normalize();
  }

  /** The joint a limb swings about: the shoulder for a claw, the hip for a leg. */
  function pivotFor(limb: Limb, state: Bound): THREE.Vector3 {
    if (limb === 'clawL') return state.joints.shoulderL.world;
    if (limb === 'clawR') return state.joints.shoulderR.world;
    return state.joints.hip.world;
  }

  // --------------------------------------------------------------------------------- per frame
  root.userData.tick = (delta: number): void => {
    const dt = Math.min(0.05, Math.max(0, delta));
    const state = bound;
    if (!state) {
      vfx.update(dt);
      return;
    }
    const clip = state.clipByName.get(activeClip);
    if (!clip) return;

    // Hitstop: the clip crawls for a few frames after a strike lands. Charged down in REAL time, so
    // a slowed clip cannot stretch its own hitstop.
    let scale = 1;
    if (hitstop > 0) {
      hitstop = Math.max(0, hitstop - dt);
      scale = HITSTOP_SCALE;
    }
    state.update(dt * scale);
    state.modelGroup.updateMatrixWorld(true);
    readAnchors(state);

    if (!primed) {
      primed = true;
      for (const limb of Object.values(state.limbs)) limb.previous.copy(limb.anchor.world);
    }
    updateFacing(state);

    // Root lock, computed in the group's own frame so the correction is a function of the animation
    // only and never of the correction already applied.
    if (ROOT_LOCKED_CLIPS[activeClip] !== undefined) {
      scratch.copy(state.joints.hip.world);
      state.modelGroup.worldToLocal(scratch);
      if (!lockArmed) {
        lockReference.copy(scratch);
        lockArmed = true;
      }
      compensation.set(lockReference.x - scratch.x, 0, lockReference.z - scratch.z);
      state.modelGroup.position.copy(state.baseOffset).add(compensation);
      // Re-resolve the bones: the effects spawn off world positions, and a stride's worth of
      // correction is a visible offset on the ash.
      state.modelGroup.updateMatrixWorld(true);
      readAnchors(state);
      updateFacing(state);
    }

    const step = dt * scale;
    const inverse = step > 1e-6 ? 1 / step : 0;
    const duration = clip.duration;
    const reference = CLIP_TRAIL_REFERENCE[activeClip] ?? 2.5;
    const strikes = strikesByClip.get(activeClip) ?? [];

    // --- limb speed, claw trails and the windup
    let fastest = 0;
    for (const name of ['clawL', 'clawR', 'toeL', 'toeR'] as Limb[]) {
      const limb = state.limbs[name];
      limb.speed = limb.anchor.world.distanceTo(limb.previous) * inverse / FIGURE_HEIGHT;
      limb.previous.copy(limb.anchor.world);
      limb.history[limb.cursor].copy(limb.anchor.world);
      limb.cursor = (limb.cursor + 1) % limb.history.length;
      limb.filled = Math.min(limb.filled + 1, limb.history.length);
      fastest = Math.max(fastest, limb.speed);
    }
    for (const name of ['clawL', 'clawR'] as Claw[]) {
      const limb = state.limbs[name];
      const ratio = limb.speed / reference;
      const strength = ratio <= TRAIL_GATE ? 0 : Math.min(1, (ratio - TRAIL_GATE) / (1 - TRAIL_GATE));
      vfx.claw(name, limb.anchor.world, strength);

      let charge = 0;
      for (const strike of strikes) {
        if (strike.limb !== name) continue;
        const lead = ahead(strike.time, clipTime, duration);
        if (lead > GATHER_LEAD) continue;
        charge = Math.max(charge, Math.pow(1 - lead / GATHER_LEAD, 1.6));
      }
      // `fire` is the channel pose: the clip is still, so the windup has nothing to schedule
      // against and is driven by the clip's own phase instead.
      if (activeClip === 'preset:biped:fire') {
        charge = Math.max(charge, Math.min(1, clipTime / duration) * 0.85);
      }
      if (charge > 0) vfx.gather(name, limb.anchor.world, charge);
      arousal = Math.max(arousal, charge * 0.7);
    }

    // --- scheduled events
    const nextTime = (clipTime + step) % duration;
    for (const strike of strikes) {
      if (!crossed(strike.time, clipTime, nextTime)) continue;
      const limb = state.limbs[strike.limb];
      strikeDirection(limb, state, travel);
      // The contact is a claw-length ahead of the wrist joint the bone sits on.
      contact.copy(limb.anchor.world).addScaledVector(travel, 0.08);
      // Power off the measured speed: 3.9 H/s is an ordinary strike in this set, 6.57 the hardest.
      const power = Math.min(1, Math.max(0, (strike.speed - 3.2) / 3.0));
      hitstop = vfx.strike(strike.kind, contact, travel, pivotFor(strike.limb, state), power);
      arousal = 1;
      firedStrikes += 1;
    }
    for (const footfall of footfallsByClip.get(activeClip) ?? []) {
      if (!crossed(footfall.time, clipTime, nextTime)) continue;
      const toe = footfall.foot === 'left' ? state.joints.toeL : state.joints.toeR;
      vfx.footfall(toe.world, footfall.drop);
      arousal = Math.max(arousal, Math.min(1, footfall.drop / 2.4));
      firedFootfalls += 1;
    }
    for (const stagger of staggersByClip.get(activeClip) ?? []) {
      if (!crossed(stagger.time, clipTime, nextTime)) continue;
      const target = stagger.joint === 'head' ? state.joints.head : state.joints.chest;
      // The blow arrives from in front, so it travels along -facing and takes the ash with it.
      scratch.copy(facing).multiplyScalar(-1);
      contact.copy(target.world).addScaledVector(facing, 0.10);
      vfx.stagger(contact, scratch, Math.min(1, stagger.speed / 1.2));
      arousal = Math.max(arousal, 0.75);
      firedStaggers += 1;
    }
    clipTime = nextTime;

    // --- the aura, the floor and the eyes, all off one arousal value so they never disagree
    arousal = Math.max(0, arousal - dt * 0.85);
    // The collapse takes the aura out with the body; nothing else dims it.
    const ceiling = activeId === 'collapse' ? Math.max(0, 1 - clipTime / duration) : 1;
    const target = Math.min(ceiling, AURA_REST + arousal * 0.48 + Math.min(0.25, fastest * 0.05));
    auraLevel += (target - auraLevel) * Math.min(1, dt * 3.2);
    vfx.aura(state.auraAnchors, auraLevel, dt);
    vfx.miasma(state.joints.hip.world, auraLevel * 0.85);

    side.copy(facing).cross(up).normalize();
    scratch.copy(state.joints.head.world).addScaledVector(facing, 0.085).addScaledVector(up, 0.035);
    eyeLeft.copy(scratch).addScaledVector(side, 0.042);
    eyeRight.copy(scratch).addScaledVector(side, -0.042);
    vfx.eyes(eyeLeft, eyeRight, Math.min(1, 0.55 + arousal * 0.65) * ceiling);

    // --- smoke off the body, at a rate the motion sets
    shedTimer -= dt * (0.6 + fastest * 0.5 + arousal);
    if (shedTimer <= 0) {
      shedTimer = 0.09;
      const anchors = state.auraAnchors;
      drift.copy(facing).multiplyScalar(-0.05 * fastest);
      drift.y += 0.05;
      vfx.shed(anchors[Math.floor(Math.random() * anchors.length)], drift);
    }

    // --- breath. Between attacks this is what says the thing is alive rather than paused.
    breathTimer -= dt;
    if (breathTimer <= 0) {
      breathTimer = BREATH_INTERVAL * (0.7 + Math.random() * 0.6);
      scratch.copy(state.joints.head.world).addScaledVector(up, -0.03);
      vfx.breathe(scratch, facing);
    }

    vfx.update(dt);
  };

  root.userData.sculptRuntime = {
    animationController,
    provenance:
      'Tripo v3.1-20260211 measurement embedded as code by the img2threejs GLB fast lane; a 41-bone '
      + 'rig and 27 clips embedded as Float32 keyframes. Every effect timing in this demo was '
      + 'measured off those clips at 400 samples by scripts/measure-monster-events.mjs rather than '
      + 'authored by eye.',
    clips: MONSTER_ACTIONS.map((action) => ({ id: action.id, clip: action.clip, note: action.note })),
    /**
     * Live schedule, for the capture harness. Whether an effect fired is not answerable from a
     * screenshot — an unfired tear and a mistimed one look the same — so the numbers the frame was
     * rendered with are published next to it.
     */
    state: () => ({
      activeId,
      activeClip,
      clipTime: Number(clipTime.toFixed(4)),
      hitstop: Number(hitstop.toFixed(4)),
      arousal: Number(arousal.toFixed(3)),
      aura: Number(auraLevel.toFixed(3)),
      fired: { strikes: firedStrikes, footfalls: firedFootfalls, staggers: firedStaggers },
      clawSpeed: bound
        ? { left: Number(bound.limbs.clawL.speed.toFixed(2)), right: Number(bound.limbs.clawR.speed.toFixed(2)) }
        : null,
      facing: [Number(facing.x.toFixed(2)), Number(facing.y.toFixed(2)), Number(facing.z.toFixed(2))],
      vfx: vfx.counts(),
    }),
    measured: {
      strikes: STRIKE_EVENTS.length,
      footfalls: FOOTFALL_EVENTS.length,
      staggers: STAGGER_EVENTS.length,
      rootLocked: Object.keys(ROOT_LOCKED_CLIPS),
      figureHeight: FIGURE_HEIGHT,
    },
  };

  // ----------------------------------------------------------------------------------- binding
  function bind(): void {
    const rigged = createMonsterRigged(options);
    const skeleton = rigged.mesh.skeleton;
    const anchorFor = (name: string): Anchor => {
      const bone = skeleton.getBoneByName(name);
      if (!bone) throw new Error(`monster rig has no bone named ${name}`);
      return { bone, world: new THREE.Vector3() };
    };
    const clipByName = new Map(rigged.clips.map((entry) => [entry.name, entry]));
    for (const name of [...MONSTER_ACTIONS.map((action) => action.clip), MONSTER_IDLE_CLIP]) {
      if (!clipByName.has(name)) throw new Error(`monster rig has no clip ${name}`);
    }
    const joints = Object.fromEntries(
      Object.entries(VFX_JOINTS).map(([key, bone]) => [key, anchorFor(bone)]),
    ) as Record<keyof typeof VFX_JOINTS, Anchor>;
    const makeLimb = (anchor: Anchor): LimbState => ({
      anchor,
      previous: new THREE.Vector3(),
      history: Array.from({ length: 6 }, () => new THREE.Vector3()),
      cursor: 0,
      filled: 0,
      speed: 0,
    });
    root.add(rigged.group);
    bound = {
      play: rigged.play,
      update: rigged.update,
      modelGroup: rigged.group,
      baseOffset: rigged.group.position.clone(),
      clipByName,
      joints,
      limbs: {
        clawL: makeLimb(joints.clawL),
        clawR: makeLimb(joints.clawR),
        toeL: makeLimb(joints.toeL),
        toeR: makeLimb(joints.toeR),
      },
      // The aura reads these vectors every frame; they are the joints' own, written in place by
      // `readAnchors`, so the cloud never lags behind by a frame or needs a copy.
      auraAnchors: [
        joints.head.world, joints.chest.world, joints.chest.world, joints.waist.world,
        joints.hip.world, joints.hip.world, joints.shoulderL.world, joints.shoulderR.world,
        joints.clawL.world, joints.clawR.world, joints.footL.world, joints.footR.world,
      ],
    };
    // A button pressed while the level was still downloading is honoured here rather than dropped.
    const requested = pending ? MONSTER_ACTIONS.find((entry) => entry.id === pending) : undefined;
    pending = null;
    primed = false;
    clipTime = 0;
    switchTo(requested?.id ?? 'idle', requested?.clip ?? MONSTER_IDLE_CLIP, 0);
  }

  // Bind in the same task when the level is already in memory: the landing workbench reads the
  // parts and triangle counts off this group in the task `build()` returns in, and a deferred bind
  // leaves it reporting an empty model. Deferred only when the geometry genuinely has not arrived.
  if (monsterReady()) bind();
  else void prewarmMonster().then(bind);

  return root;
}

/**
 * Light for something that should not be lit.
 *
 * The rule that shapes this rig: a monster reads as a monster when the light is BELOW it and
 * COLDER than the eye expects. A conventional key from above gives a hero's face; the same figure
 * lit from the floor keeps its brow in shadow and puts the light where the aura is. So the key here
 * is a low violet uplight, the fill is a cold moon three-quarters behind, and the only warm thing
 * in the frame is the crimson rim that separates the silhouette from the black.
 *
 * Aimed from the side the monster faces — measured, not assumed: the shoulder-and-toe sweep puts
 * the facing at yaw 91-109 degrees across every clip in the action list, which is +X.
 */
export function createAbyssLights(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'monster-abyss-lights';

  // The uplight. Narrow and close so it falls off before it reaches the head — the brow stays dark.
  const key = new THREE.SpotLight(0x8b4cff, 13, 6.5, 0.85, 0.7, 1.5);
  key.position.set(1.5, 0.18, 0.7);
  key.target.position.set(0, 1.05, 0);
  group.add(key, key.target);

  // A cold moon behind the shoulder, high and weak: this is what draws the scale plates.
  const moon = new THREE.SpotLight(0xc6d8ff, 30, 14, 0.78, 0.5, 1.6);
  moon.position.set(-2.4, 3.4, -1.9);
  moon.target.position.set(0, 0.85, 0);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.camera.near = 1;
  moon.shadow.camera.far = 12;
  moon.shadow.bias = -0.0009;
  group.add(moon, moon.target);

  // The one warm light, and it is a rim rather than a key: it exists to cut the silhouette out of
  // the black, not to describe the surface.
  const rim = new THREE.DirectionalLight(0xff4a6a, 1.15);
  rim.position.set(2.6, 1.4, -2.4);
  group.add(rim);

  // A second, violet rim on the opposite side, so the shadow side is shaped rather than filled.
  const wash = new THREE.DirectionalLight(0x6a3cd8, 0.45);
  wash.position.set(-1.8, 1.1, 2.6);
  group.add(wash);

  // Barely any ambient: the floor bounce is violet, the sky term is nearly black.
  group.add(new THREE.HemisphereLight(0x1a1430, 0x05040a, 0.45));

  return group;
}
