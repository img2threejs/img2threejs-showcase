import * as THREE from 'three';
import {
  boxingManReady,
  createBoxingManRigged,
  prewarmBoxingMan,
  type BoxingManOptions,
} from './createBoxingManModel';
import { createBoxingVfx, type BoxingVfx } from './boxingVfx';
import {
  ABSORB_EVENTS,
  BOXING_ACTIONS,
  BOXING_IDLE_CLIP,
  BOXING_IDLE_ID,
  CLIP_TRAIL_REFERENCE,
  FIGURE_HEIGHT,
  FOOTFALL_EVENTS,
  PUNCH_EVENTS,
  ROOT_LOCKED_CLIPS,
  TRAIL_GATE,
  VFX_JOINTS,
  type Glove,
} from './punchEvents';

/**
 * The showcase build: the rigged figure, the nine curated clips, and the effects driven off the
 * measured events in `punchEvents.ts`.
 *
 * WHY A SCHEDULER AND NOT A LOOK-AT-THE-SPEED TRIGGER. A live detector — "fire when the hand
 * decelerates" — can only know a punch landed AFTER it has landed, because the deceleration takes
 * about 0.1 s to observe. That is two things wrong at once: the flare is late, and the windup glow
 * cannot exist at all, because nothing knows a punch is coming. Both are answered by scheduling
 * against the measured table: the effect fires on the frame the glove stops, and the 0.22 s before
 * it are spent gathering charge into the knuckles.
 *
 * HITSTOP. On impact the clip itself drops to a quarter speed for 45-85 ms depending on the punch.
 * This is the single largest contributor to how hard a punch reads, and it costs one multiply — the
 * mixer is driven from here, so the schedule stays consistent with the slowed clip automatically.
 *
 * ROOT LOCK. `run` carries the figure 2.725 H forward per loop and `walk` 1.396 H. Both are held in
 * place by subtracting the hip's own horizontal displacement from the model group, measured in the
 * group's local frame so the correction cannot chase itself. The stride is untouched: contact times,
 * dust and trails all still happen exactly where the sweep measured them.
 *
 * BUILD ORDER. `build()` is synchronous by the registry's contract while the level of detail lives
 * in its own chunk, so this returns a root holding only the effects layer and binds the figure when
 * `prewarmBoxingMan` resolves. The ticker and the animation controller are published immediately —
 * the viewer collects tickers exactly once, and the demo panel reads the controller on the frame
 * after `build()` — so both have to exist before the geometry does. A button pressed in that window
 * is remembered and applied on binding rather than dropped.
 */

const CHARGE_LEAD = 0.22;
const HITSTOP_SCALE = 0.25;
const BREATH_INTERVAL = 2.4;

interface Anchor {
  bone: THREE.Bone;
  world: THREE.Vector3;
}

interface HandState {
  anchor: Anchor;
  previous: THREE.Vector3;
  /** Six frames of travel, so a punch's direction survives the frame the glove stops on. */
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
  joints: Record<
    'handL' | 'handR' | 'toeL' | 'toeR' | 'footL' | 'footR' | 'head' | 'chest' | 'hip'
    | 'shoulderL' | 'shoulderR',
    Anchor
  >;
  hands: Record<Glove, HandState>;
}

export function createBoxingManShowcase(options: BoxingManOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'boxing-man';

  const vfx: BoxingVfx = createBoxingVfx();

  root.add(vfx.group);

  let bound: Bound | null = null;
  let activeId = BOXING_IDLE_ID;
  let activeClip = BOXING_IDLE_CLIP;
  let pending: string | null = null;
  let clipTime = 0;
  let hitstop = 0;
  let breathTimer = BREATH_INTERVAL * 0.5;
  let sweatCooldown = 0;
  let headSpeed = 0;
  let previousHeadSpeed = 0;
  let lockArmed = false;
  let primed = false;
  let firedPunches = 0;
  let firedFootfalls = 0;
  let firedAbsorbs = 0;

  const headPrevious = new THREE.Vector3();
  const lockReference = new THREE.Vector3();
  const compensation = new THREE.Vector3();
  const travel = new THREE.Vector3();
  const contact = new THREE.Vector3();
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
    lockArmed = false;
    compensation.set(0, 0, 0);
    if (bound) {
      bound.play(clip, fade);
      bound.modelGroup.position.copy(bound.baseOffset);
      for (const hand of Object.values(bound.hands)) hand.filled = 0;
    } else {
      pending = id;
    }
    notify();
  }

  const animationController = {
    actions: BOXING_ACTIONS.map(({ id, label }) => ({ id, label, loop: true })),
    get active(): string { return activeId; },
    play(id: string): void {
      const action = BOXING_ACTIONS.find((entry) => entry.id === id);
      if (!action) return;
      switchTo(action.id, action.clip, 0.22);
    },
    stop(): void {
      switchTo(BOXING_IDLE_ID, BOXING_IDLE_CLIP, 0.30);
    },
    subscribe(listener: (active: string) => void): () => void {
      listeners.add(listener);
      listener(activeId);
      return () => listeners.delete(listener);
    },
  };

  // -------------------------------------------------------------------------- measured schedule
  const punchesByClip = new Map<string, typeof PUNCH_EVENTS>();
  const footfallsByClip = new Map<string, typeof FOOTFALL_EVENTS>();
  const absorbsByClip = new Map<string, typeof ABSORB_EVENTS>();
  for (const event of PUNCH_EVENTS) {
    punchesByClip.set(event.clip, PUNCH_EVENTS.filter((entry) => entry.clip === event.clip));
  }
  for (const event of FOOTFALL_EVENTS) {
    footfallsByClip.set(event.clip, FOOTFALL_EVENTS.filter((entry) => entry.clip === event.clip));
  }
  for (const event of ABSORB_EVENTS) {
    absorbsByClip.set(event.clip, ABSORB_EVENTS.filter((entry) => entry.clip === event.clip));
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
   * Which way the figure is looking, taken from measured geometry rather than off a bone
   * quaternion: the rig's bone axes are its own — the root alone carries a 120-degree quaternion —
   * so reading a "forward" out of one would be a guess.
   *
   * The shoulder line gives the AXIS, precisely, because the torso leads a punch. It cannot give
   * the SIDE: its normal is equally the chest and the back. The ankle-to-toe vector settles that —
   * toes point forward on every human and on this rig — so the sign is taken from the feet and the
   * precision from the shoulders. A boxer's stance is bladed and these clips turn through 90
   * degrees mid-combination, so a sign decided once at rest would invert halfway through the punch.
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

  function punchDirection(hand: HandState, state: Bound, out: THREE.Vector3): void {
    // Direction of TRAVEL over the last few frames, not the instantaneous velocity: on the frame a
    // punch lands the glove has already stopped, and its velocity there points nowhere useful.
    const size = hand.history.length;
    if (hand.filled >= 2) {
      const newest = hand.history[(hand.cursor - 1 + size) % size];
      const oldest = hand.history[(hand.cursor - Math.min(hand.filled, size) + size * 2) % size];
      out.copy(newest).sub(oldest);
    } else {
      out.set(0, 0, 0);
    }
    if (out.lengthSq() < 1e-6) {
      // Reaching away from the chest, which is where a punch goes by definition.
      out.copy(hand.anchor.world).sub(state.joints.chest.world);
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
    const clip = state.clipByName.get(activeClip);
    if (!clip) return;

    // Hitstop: the clip crawls for a few frames after a punch lands. Charged down in REAL time, so
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
      headPrevious.copy(state.joints.head.world);
      for (const hand of Object.values(state.hands)) hand.previous.copy(hand.anchor.world);
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
      // correction — up to 0.1 world units in one frame — is a visible offset on the dust.
      state.modelGroup.updateMatrixWorld(true);
      readAnchors(state);
      updateFacing(state);
    }

    const step = dt * scale;
    const inverse = step > 1e-6 ? 1 / step : 0;
    const duration = clip.duration;
    const reference = CLIP_TRAIL_REFERENCE[activeClip] ?? 2.5;
    const punches = punchesByClip.get(activeClip) ?? [];

    // --- glove speed, trails and windup
    for (const glove of ['left', 'right'] as Glove[]) {
      const hand = state.hands[glove];
      hand.speed = hand.anchor.world.distanceTo(hand.previous) * inverse / FIGURE_HEIGHT;
      hand.previous.copy(hand.anchor.world);
      hand.history[hand.cursor].copy(hand.anchor.world);
      hand.cursor = (hand.cursor + 1) % hand.history.length;
      hand.filled = Math.min(hand.filled + 1, hand.history.length);

      const ratio = hand.speed / reference;
      const strength = ratio <= TRAIL_GATE
        ? 0
        : Math.min(1, (ratio - TRAIL_GATE) / (1 - TRAIL_GATE));
      vfx.glove(glove, hand.anchor.world, strength);

      let charge = 0;
      for (const punch of punches) {
        if (punch.glove !== glove) continue;
        const lead = ahead(punch.time, clipTime, duration);
        if (lead > CHARGE_LEAD) continue;
        charge = Math.max(charge, Math.pow(1 - lead / CHARGE_LEAD, 1.6));
      }
      if (charge > 0) vfx.charge(glove, hand.anchor.world, charge);
    }

    // --- scheduled events
    const nextTime = (clipTime + step) % duration;
    for (const punch of punches) {
      if (!crossed(punch.time, clipTime, nextTime)) continue;
      const hand = state.hands[punch.glove];
      punchDirection(hand, state, travel);
      // The contact is a glove-front ahead of the wrist joint the bone sits on.
      contact.copy(hand.anchor.world).addScaledVector(travel, 0.075);
      // Power off the measured speed: 2.6 H/s is an ordinary punch in this set, 3.75 the hardest.
      const power = Math.min(1, Math.max(0, (punch.speed - 2.0) / 1.8));
      hitstop = vfx.punch(punch.kind, contact, travel, power);
      firedPunches += 1;
    }
    for (const footfall of footfallsByClip.get(activeClip) ?? []) {
      if (!crossed(footfall.time, clipTime, nextTime)) continue;
      const toe = footfall.foot === 'left' ? state.joints.toeL : state.joints.toeR;
      vfx.footfall(toe.world, footfall.drop);
      firedFootfalls += 1;
    }
    for (const absorb of absorbsByClip.get(activeClip) ?? []) {
      if (!crossed(absorb.time, clipTime, nextTime)) continue;
      const target = absorb.joint === 'head' ? state.joints.head : state.joints.chest;
      // The blow arrives from in front, so it travels along -facing and takes the spray with it.
      scratch.copy(facing).multiplyScalar(-1);
      contact.copy(target.world).addScaledVector(facing, 0.11);
      vfx.absorb(contact, scratch, Math.min(1, absorb.speed / 1.2));
      firedAbsorbs += 1;
    }
    clipTime = nextTime;

    // --- sweat off a head that is being stopped, whether by a slip or by a punch
    previousHeadSpeed = headSpeed;
    headSpeed = state.joints.head.world.distanceTo(headPrevious) * inverse / FIGURE_HEIGHT;
    headPrevious.copy(state.joints.head.world);
    sweatCooldown = Math.max(0, sweatCooldown - dt);
    if (sweatCooldown === 0 && previousHeadSpeed > 0.65 && headSpeed < previousHeadSpeed * 0.45) {
      vfx.sweat(state.joints.head.world, 3 + Math.round(previousHeadSpeed * 2));
      sweatCooldown = 0.22;
    }

    // --- breath. Between exchanges this is the layer that reads as a person and not a puppet.
    breathTimer -= dt;
    if (breathTimer <= 0) {
      breathTimer = BREATH_INTERVAL * (0.75 + Math.random() * 0.5);
      scratch.copy(state.joints.head.world);
      scratch.y -= 0.04;
      vfx.breathe(scratch, facing);
    }

    vfx.update(dt);
  };

  root.userData.sculptRuntime = {
    animationController,
    provenance:
      'Tripo v3.1 measurement embedded as code by the img2threejs GLB fast lane; a 41-bone rig and '
      + '19 clips embedded as Float32 keyframes. Every effect timing in this demo was measured off '
      + 'those clips at 400 samples rather than authored by eye.',
    clips: BOXING_ACTIONS.map((action) => ({ id: action.id, clip: action.clip, note: action.note })),
    /**
     * Live schedule, for the capture harness. Whether an effect fired is not answerable from a
     * screenshot — an unfired impact and a mistimed one look the same — so the numbers the frame
     * was rendered with are published next to it.
     */
    state: () => ({
      activeId,
      activeClip,
      clipTime: Number(clipTime.toFixed(4)),
      hitstop: Number(hitstop.toFixed(4)),
      fired: { punches: firedPunches, footfalls: firedFootfalls, absorbs: firedAbsorbs },
      gloveSpeed: bound
        ? { left: Number(bound.hands.left.speed.toFixed(2)), right: Number(bound.hands.right.speed.toFixed(2)) }
        : null,
      facing: [Number(facing.x.toFixed(2)), Number(facing.y.toFixed(2)), Number(facing.z.toFixed(2))],
      vfx: vfx.counts(),
    }),
    measured: {
      punches: PUNCH_EVENTS.length,
      footfalls: FOOTFALL_EVENTS.length,
      absorbed: ABSORB_EVENTS.length,
      rootLocked: Object.keys(ROOT_LOCKED_CLIPS),
    },
  };

  // ----------------------------------------------------------------------------------- binding
  function bind(): void {
    const rigged = createBoxingManRigged(options);
    const skeleton = rigged.mesh.skeleton;
    const anchorFor = (name: string): Anchor => {
      const bone = skeleton.getBoneByName(name);
      if (!bone) throw new Error(`boxing-man rig has no bone named ${name}`);
      return { bone, world: new THREE.Vector3() };
    };
    const clipByName = new Map(rigged.clips.map((entry) => [entry.name, entry]));
    for (const action of [...BOXING_ACTIONS.map((a) => a.clip), BOXING_IDLE_CLIP]) {
      if (!clipByName.has(action)) throw new Error(`boxing-man rig has no clip ${action}`);
    }
    const makeHand = (anchor: Anchor): HandState => ({
      anchor,
      previous: new THREE.Vector3(),
      history: Array.from({ length: 6 }, () => new THREE.Vector3()),
      cursor: 0,
      filled: 0,
      speed: 0,
    });
    const joints = {
      handL: anchorFor(VFX_JOINTS.handL),
      handR: anchorFor(VFX_JOINTS.handR),
      toeL: anchorFor(VFX_JOINTS.toeL),
      toeR: anchorFor(VFX_JOINTS.toeR),
      footL: anchorFor(VFX_JOINTS.footL),
      footR: anchorFor(VFX_JOINTS.footR),
      head: anchorFor(VFX_JOINTS.head),
      chest: anchorFor(VFX_JOINTS.chest),
      hip: anchorFor(VFX_JOINTS.hip),
      shoulderL: anchorFor('L_Upperarm'),
      shoulderR: anchorFor('R_Upperarm'),
    };
    root.add(rigged.group);
    bound = {
      play: rigged.play,
      update: rigged.update,
      modelGroup: rigged.group,
      baseOffset: rigged.group.position.clone(),
      clipByName,
      joints,
      hands: { left: makeHand(joints.handL), right: makeHand(joints.handR) },
    };
    // A button pressed while the level was still downloading is honoured here rather than dropped.
    const requested = pending ? BOXING_ACTIONS.find((entry) => entry.id === pending) : undefined;
    pending = null;
    primed = false;
    clipTime = 0;
    switchTo(requested?.id ?? BOXING_IDLE_ID, requested?.clip ?? BOXING_IDLE_CLIP, 0);
  }

  // Same task when the level is already in memory — the landing workbench reads the parts and
  // triangle counts off this group in the task `build()` returns in, and a deferred bind left it
  // reporting an empty model. Deferred only when the geometry genuinely has not arrived yet.
  if (boxingManReady()) bind();
  else void prewarmBoxingMan().then(bind);

  return root;
}

/**
 * Broadcast boxing light, which is a very specific rig: a hard warm key on a truss high above the
 * ring, nothing on the crowd, and the corners falling to black. Reference setups hang four banks
 * about twenty feet above the posts — high enough to stay out of ringside eyes, but not so high
 * that the brows shadow the eyes, which is why the key here sits forward of the figure rather than
 * directly over it.
 *
 * The two cool rims are not decoration: with one hard top key and a black surround, the shadow side
 * of the figure loses its silhouette completely.
 */
export function createRingsideLights(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'boxing-man-ringside-lights';

  // Aimed from the side the figure faces — measured, not assumed: the shoulder-and-toe sweep puts
  // its facing at yaw 62-105 degrees across every clip in the demo, which is +X.
  const key = new THREE.SpotLight(0xfff1dc, 70, 12, 0.62, 0.42, 1.6);
  key.position.set(3.0, 4.1, 1.5);
  key.target.position.set(0, 0.95, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 12;
  key.shadow.bias = -0.0008;
  group.add(key, key.target);

  // A second bank across the ring, dimmer, so the shadow side is shaped rather than filled.
  const opposite = new THREE.SpotLight(0xffe6c4, 26, 12, 0.7, 0.5, 1.6);
  opposite.position.set(-1.6, 3.6, -2.4);
  opposite.target.position.set(0, 0.9, 0);
  group.add(opposite, opposite.target);

  const rimLeft = new THREE.DirectionalLight(0x9fc4ff, 1.1);
  rimLeft.position.set(-2.2, 1.6, 2.6);
  group.add(rimLeft);

  const rimRight = new THREE.DirectionalLight(0x7fa8e0, 0.8);
  rimRight.position.set(-1.4, 1.2, -3.0);
  group.add(rimRight);

  // Just enough bounce that the canvas side of the legs does not go to pure black.
  group.add(new THREE.HemisphereLight(0x2b3242, 0x0b0b0d, 0.55));

  /**
   * Rosin haze in the key light: ninety motes on a slow upward drift, recycled at the top. It is
   * the cheapest possible way to say "this air has been fought in", and it gives the hard key
   * something to catch so the beam reads as a beam.
   */
  const MOTES = 90;
  const position = new Float32Array(MOTES * 3);
  const seed = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i += 1) {
    position[i * 3] = (Math.random() - 0.5) * 2.4;
    position[i * 3 + 1] = Math.random() * 2.6;
    position[i * 3 + 2] = (Math.random() - 0.5) * 2.4;
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
    uniforms: { uColour: { value: new THREE.Color(0xffe3bd) }, uScale: { value: 130 } },
    vertexShader: `
      attribute float aSeed;
      uniform float uScale;
      varying float vSeed;
      void main() {
        vSeed = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (0.4 + aSeed * 0.8) * uScale / max(0.001, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColour;
      varying float vSeed;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float mask = smoothstep(0.5, 0.0, length(uv) * 2.0);
        gl_FragColor = vec4(uColour, mask * (0.05 + vSeed * 0.09));
      }`,
  });
  const motes = new THREE.Points(geometry, material);
  motes.frustumCulled = false;
  motes.userData.isHighlight = true;
  motes.userData.tick = (delta: number): void => {
    const dt = Math.min(0.05, Math.max(0, delta));
    for (let i = 0; i < MOTES; i += 1) {
      position[i * 3 + 1] += (0.02 + seed[i] * 0.05) * dt;
      position[i * 3] += Math.sin(position[i * 3 + 1] * 3.1 + seed[i] * 6.28) * 0.24 * dt;
      if (position[i * 3 + 1] > 2.7) position[i * 3 + 1] = 0;
    }
    positionAttribute.needsUpdate = true;
  };
  group.add(motes);

  return group;
}
