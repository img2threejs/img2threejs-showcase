/**
 * The VFX layer for Monster Cute.
 *
 * HAND-WRITTEN, all of it. img2threejs ships no particle, trail or shader subsystem — the skill
 * emits geometry, materials, a rig and clips, and stops there. Everything under `src/vfx/` is code
 * authored for this showcase, and it is called out as such rather than presented as pipeline
 * output.
 *
 * What is *not* hand-waved is where the effects go. Every emitter is parented to a socket whose
 * position was measured out of the character's own vertices and expressed in the local space of a
 * bone this rig really has (`Head`, `L_Hand`, `R_ToeBase`, `Spine02`, …). There is not a magic
 * coordinate anywhere in this file: an effect either rides a real bone or it does not exist.
 *
 * The clip bindings are split into two kinds and the split is deliberate:
 *
 *   MEASURED — the effect is on because the clip's Stage R3 feature vector says so. A trail turns
 *              on for a clip whose hands measured a large hip-relative range; a landing wave arms
 *              for a clip whose hip rise cleared 0.15H. These are provable.
 *   INFERRED — the effect is on because of what the clip is *called*. No kinematic feature
 *              distinguishes a strike from a stumble, so "fire the beam on preset:shoot" rests on
 *              the name and nothing else. Marked `inferred` everywhere it appears, including in
 *              the UI.
 */
import * as THREE from 'three';
import type { RiggedModel } from '../meshCodec';
import { ACCENT, CLIP_PROFILES, FIGURE_HEIGHT, FRAME, GROUND_DUST, PALETTE, SOCKETS } from '../characterProfile';
import { ParticleField } from './particles';
import { Ribbon } from './ribbon';
import { Beam, ChargeOrb, Hearts, HornArc, Shockwaves } from './shapes';
import { Blush, EyeGlow, installRimLight } from './rimLight';
import { Sfx } from './sfx';

const H = FIGURE_HEIGHT;

export type CueName = 'cast' | 'blast' | 'slam' | 'hurt' | 'sparkle';

export type EffectName =
  | 'motes' | 'aura' | 'rimLight' | 'eyeGlow' | 'handTrails' | 'footDust' | 'landingWave'
  | 'hornArc' | 'palmCharge' | 'hearts' | 'blush';

export interface ClipBinding {
  effect: EffectName;
  basis: 'measured' | 'inferred';
  reason: string;
}

export interface MonsterCuteVfx {
  group: THREE.Group;
  /** Synthesised sound. Nothing is fetched; every effect is built from oscillators when it fires. */
  readonly sfx: Sfx;
  /**
   * Advance the effects. DELTA seconds, then elapsed seconds.
   *
   * The camera is optional. Two of these effects billboard — the trail strip faces the viewer, and
   * a flat heart seen edge-on disappears — so they need one. Rather than require every host to
   * plumb it through, the system captures the real camera in an `onBeforeRender` hook the frame
   * before. Hosts whose per-frame hook is `(dt, elapsed)` and nothing else (the img2threejs
   * showcase gallery, for one) can therefore just call `update(dt, elapsed)`.
   */
  update(dt: number, elapsed: number, camera?: THREE.Camera): void;
  cue(name: CueName): void;
  /** Rebind the continuous effects for a clip. Returns what was bound and why. */
  setClip(clipName: string): ClipBinding[];
  setEffectEnabled(effect: EffectName, on: boolean): void;
  isEffectEnabled(effect: EffectName): boolean;
  setViewport(pixelHeight: number, fovDegrees: number): void;
  bindingsFor(clipName: string): ClipBinding[];
  socketWorldPosition(id: string, out: THREE.Vector3): THREE.Vector3 | null;
  readonly socketIds: string[];
  /** Live counts, for the capture harness — an effect that is "on" but drawing nothing is the
   * failure mode a screenshot is worst at showing. */
  debug(): Record<string, unknown>;
  dispose(): void;
}

/**
 * Attach an empty to each measured socket.
 *
 * The offset is in the bone's own local space, so the empty tracks the bone through every clip for
 * free — no per-frame lookup, no re-solving, and it inherits the mesh scale the same way the skin
 * does.
 */
function attachSockets(rigged: RiggedModel): Map<string, THREE.Object3D> {
  const bones = new Map(rigged.mesh.skeleton.bones.map((b) => [b.name, b]));
  const sockets = new Map<string, THREE.Object3D>();
  const missing: string[] = [];
  for (const spec of SOCKETS) {
    const bone = bones.get(spec.bone);
    if (!bone) { missing.push(`${spec.id} -> ${spec.bone}`); continue; }
    const node = new THREE.Object3D();
    node.name = spec.id;
    node.position.set(spec.offset[0], spec.offset[1], spec.offset[2]);
    bone.add(node);
    sockets.set(spec.id, node);
  }
  if (missing.length) {
    // Loud rather than silent: a socket whose bone is gone means the rig changed under the VFX,
    // and an effect quietly parked at the origin is much harder to notice than this line.
    console.warn(`[monster-cute vfx] sockets with no matching bone, skipped: ${missing.join(', ')}`);
  }
  return sockets;
}

export function createMonsterCuteVfx(rigged: RiggedModel): MonsterCuteVfx {
  const group = new THREE.Group();
  group.name = 'monster-cute-vfx';

  // three hands `onBeforeRender` the camera it is actually drawing with, which is the only place
  // the camera is reachable without the host passing it in. One frame of latency on a billboard
  // orientation is not visible.
  let lastCamera: THREE.Camera | null = null;

  const sockets = attachSockets(rigged);
  const head = rigged.mesh.skeleton.bones.find((b) => b.name === 'Head') ?? null;
  const hip = rigged.mesh.skeleton.bones.find((b) => b.name === 'Hip') ?? null;

  // ---------------------------------------------------------------- emitters

  const sparks = new ParticleField(1400);
  const dust = new ParticleField(1600, false);   // false = alpha-blended matter, not additive light
  const motes = new ParticleField(320);
  group.add(sparks.points, dust.points, motes.points);
  // `onBeforeRender` only fires on something that is actually drawn, so it hangs off the mote
  // field: it is the one emitter that is never empty.
  motes.points.onBeforeRender = (_renderer, _scene, camera) => { lastCamera = camera; };

  const trails: Record<'l' | 'r', Ribbon> = {
    l: new Ribbon(26, 0.075 * H, ACCENT.energy),
    r: new Ribbon(26, 0.075 * H, ACCENT.energy),
  };
  group.add(trails.l.mesh, trails.r.mesh);

  const shockwaves = new Shockwaves(4, ACCENT.energy);
  const hornArc = new HornArc(22, ACCENT.energy, ACCENT.core);
  const orbs: Record<'l' | 'r', ChargeOrb> = {
    l: new ChargeOrb(0.075 * H, ACCENT.energy, ACCENT.core),
    r: new ChargeOrb(0.075 * H, ACCENT.energy, ACCENT.core),
  };
  const beam = new Beam(ACCENT.core);
  const hearts = new Hearts(14, 0.075 * H, ACCENT.impact);
  const eyeGlow = new EyeGlow(0.026 * H, ACCENT.core);

  /**
   * Sound, tied to the SAME measured events the visuals are.
   *
   * A footstep fires when the sole socket crosses the ground band while descending, not on a timer
   * keyed to the clip — so the sound lands with the foot in every one of the 33 clips, including
   * the ones nobody authored a footfall for.
   */
  const sfx = new Sfx();

  // Blush on the cheeks, placed from the two measured eye sockets and parented to the Head joint.
  const headBone = rigged.mesh.skeleton.bones.find((b) => b.name === 'Head');
  const eyeSpecL = SOCKETS.find((s) => s.id === 'effect:eye.l');
  const eyeSpecR = SOCKETS.find((s) => s.id === 'effect:eye.r');
  const blush = headBone && eyeSpecL && eyeSpecR
    ? new Blush(headBone, eyeSpecL.offset, eyeSpecR.offset, ACCENT.blush)
    : null;
  /**
   * The colours a mote can be.
   *
   * All five are the character's own — the pale belly, the lit fur, the shaded fur, the horn grey
   * warmed, and the wristband violet lifted. A field in one flat colour reads as fog; a field that
   * varies across the subject's own palette reads as air with something in it, without introducing
   * a hue the monster does not wear.
   */
  const MOTE_COLOURS = [ACCENT.mote, PALETTE.belly, ACCENT.energy, PALETTE.furLight, ACCENT.impact];
  group.add(shockwaves.group, hornArc.group, orbs.l.group, orbs.r.group, beam.group, hearts.group, eyeGlow.group);


  // ---------------------------------------------------------------- emissive channel

  /**
   * The surface material already carries an emissive channel — measured as #000000, i.e. unused.
   * Driving it is how the monster glows from inside rather than being lit from outside, and it
   * costs no extra draw call. The base material colour is never touched.
   */
  const material = rigged.mesh.material as THREE.MeshStandardMaterial;
  const emissiveBase = material.emissive.clone();
  // A fresnel contour on the fur. The subject is a round matte silhouette in a dark scene, and this
  // is what lifts its edge off the background without adding a fifth light to flatten it further.
  const rim = installRimLight(material, ACCENT.energy, 0.5, 2.6);
  let flash = 0;
  let flashColour = ACCENT.impact.clone();
  let auraDrive = 0;

  // ---------------------------------------------------------------- state

  const enabled: Record<EffectName, boolean> = {
    motes: true, aura: true, rimLight: true, eyeGlow: true,
    handTrails: false, footDust: false,
    landingWave: false, hornArc: false, palmCharge: false, hearts: false, blush: true,
  };

  const world = new Map<string, THREE.Vector3>();
  const previousWorld = new Map<string, THREE.Vector3>();
  const velocity = new Map<string, THREE.Vector3>();
  for (const id of sockets.keys()) {
    world.set(id, new THREE.Vector3());
    previousWorld.set(id, new THREE.Vector3());
    velocity.set(id, new THREE.Vector3());
  }

  const readSockets = (dt: number, first: boolean): void => {
    for (const [id, node] of sockets) {
      const now = world.get(id)!;
      const before = previousWorld.get(id)!;
      before.copy(now);
      node.getWorldPosition(now);
      if (first || dt <= 0) velocity.get(id)!.set(0, 0, 0);
      else velocity.get(id)!.subVectors(now, before).divideScalar(dt);
    }
  };

  const socketWorldPosition = (id: string, out: THREE.Vector3): THREE.Vector3 | null => {
    const v = world.get(id);
    return v ? out.copy(v) : null;
  };

  /** Where the face points, in world space, from the measured head-local forward vector. */
  const forward = new THREE.Vector3(0, 0, -1);
  const headForward = FRAME.headForwardLocal as number[] | null;
  const readForward = (): THREE.Vector3 => {
    if (head && headForward) {
      forward.set(headForward[0], headForward[1], headForward[2]).transformDirection(head.matrixWorld);
      forward.y = 0;
      if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
      forward.normalize();
    }
    return forward;
  };

  // Foot contact is detected from the animated bone, not from a timer keyed to the clip: the sole
  // socket's own height and vertical speed are what say a foot landed.
  // The band is absolute, not relative to whatever height the foot happened to be at on frame 1:
  // the model is normalised feet-at-zero, so "near the ground" is a fact about the world, and
  // sampling it from the first frame anchored it to a mid-stride pose instead.
  const GROUND_BAND = 0.055 * H;
  const footState: Record<'l' | 'r', { down: boolean; since: number }> = {
    l: { down: true, since: 0 },
    r: { down: true, since: 0 },
  };
  let hipY = 0;
  let hipVy = 0;
  let firstFrame = true;

  const scratch = new THREE.Vector3();
  const scratchB = new THREE.Vector3();
  const scratchC = new THREE.Vector3();

  // ---------------------------------------------------------------- one-shots

  function burst(at: THREE.Vector3, count: number, speed: number, colour: THREE.Color, size: number, life: number, field = sparks, shape = 0.85): void {
    for (let i = 0; i < count; i += 1) {
      // Direction on a sphere by the standard rejection-free polar method, so the burst is even
      // rather than clustered at the poles.
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      scratchB.set(r * Math.cos(theta), u, r * Math.sin(theta)).multiplyScalar(speed * (0.45 + Math.random() * 0.55));
      field.spawn({
        position: scratch.copy(at).addScaledVector(scratchB, 0.01),
        velocity: scratchB.clone(),
        colour,
        size: size * (0.6 + Math.random() * 0.8),
        life: life * (0.6 + Math.random() * 0.7),
        drag: 0.12,
        gravity: -0.55 * H,
        // Twinkles rather than dots. On a round pastel character the four-point sparkle is what
        // reads as charm; a cloud of circles reads as smoke.
        shape,
        spinRate: (Math.random() - 0.5) * 6,
      });
    }
  }

  /**
   * A cloud of dust thrown off the floor.
   *
   * Rebuilt to behave like dirt rather than like an expanding ring of light. Four things do that,
   * and all four matter:
   *
   *   - it goes out LOW and fast, then stops hard. Real dust loses its speed almost immediately —
   *     a drag of 0.88/s against the old 0.06 is the difference between a puff and a shockwave;
   *   - it SWELLS as it slows, though only to about 2.7x. Pushed further it stops being a puff and
   *     becomes fog, which is what the first attempt did;
   *   - it is DENSER at the impact than at the rim, because it was thrown from a point;
   *   - it is thrown at a shallow angle with a spread, not on a flat circle. A perfect ring is the
   *     tell that says "effect";
   *   - it drifts up only slightly and lingers, because settling dust is the part the eye reads as
   *     weight.
   */
  function dustPuff(at: THREE.Vector3, count: number, speed: number, size: number, life: number): void {
    for (let i = 0; i < count; i += 1) {
      // Jittered around the circle rather than evenly spaced, so no ring artefact forms.
      const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 1.4;
      /**
       * Biased toward the impact.
       *
       * `random()` squared puts most particles near the foot and only a few out at the rim, which
       * is how a real puff is distributed. Spreading them evenly over the radius — the first
       * version — produces a uniform disc of haze: a smear on the floor rather than something
       * that was thrown from a point.
       */
      const reach = Math.random() ** 2;
      const s = speed * (0.25 + reach * 0.95);
      // Mostly outward, curling up. The few that go up hardest are what give the cloud a top.
      const rise = 0.15 + Math.random() * Math.random() * 0.9;
      dust.spawn({
        position: scratch.set(
          at.x + Math.cos(a) * 0.025 * H * Math.random(),
          Math.max(at.y, 0.004) + Math.random() * 0.02 * H,
          at.z + Math.sin(a) * 0.025 * H * Math.random(),
        ),
        velocity: scratchB.set(Math.cos(a) * s, s * rise, Math.sin(a) * s),
        colour: GROUND_DUST,
        size: size * (0.55 + Math.random() * 1.0),
        life: life * (0.65 + Math.random() * 0.75),
        drag: 0.88,             // stops fast, the way air stops dust
        gravity: 0.01 * H,      // barely buoyant; it hangs rather than climbs
        growth: 2.7,            // diffuses, but still reads as a puff rather than fog
        alpha: 0.2 + Math.random() * 0.22,
        shape: 0,               // grit, never glitter
      });
    }
  }

  function fireBeam(): void {
    const palm = world.get('effect:palm.r') ?? world.get('effect:palm.l');
    if (!palm) return;
    const direction = readForward();
    beam.fire(palm, direction, 1.5 * H, 0.035 * H, 0.45);
    burst(palm, 30, 1.5 * H, ACCENT.core, 0.03 * H, 0.4);
    orbs.r.setCharge(0);
    flash = Math.max(flash, 0.35);
    flashColour = ACCENT.energy.clone();
  }

  function cue(name: CueName): void {
    switch (name) {
      case 'cast': {
        sfx.play('cast');
        hornArc.setStrength(1);
        castHold = 1.1;
        const l = world.get('effect:horn.l');
        const r = world.get('effect:horn.r');
        if (l) burst(l, 16, 0.5 * H, ACCENT.core, 0.022 * H, 0.5);
        if (r) burst(r, 16, 0.5 * H, ACCENT.core, 0.022 * H, 0.5);
        orbs.l.setCharge(1); orbs.r.setCharge(1);
        chargeHold = 1.1;
        break;
      }
      case 'blast':
        fireBeam();
        break;
      case 'slam': {
        sfx.play('slam');
        const foot = world.get('effect:foot.l') ?? world.get('effect:foot.r');
        if (!foot) break;
        // The one place a glowing ring is still right: `slam` is a cast skill, not a footstep, so
        // it is allowed to be energy. It gets a real dust cloud underneath it as well.
        shockwaves.fire(foot, 0.75 * H, 0.75, ACCENT.energy);
        dustPuff(foot, 42, 0.9 * H, 0.1 * H, 1.1);
        burst(foot, 22, 0.8 * H, ACCENT.energy, 0.025 * H, 0.5);
        break;
      }
      case 'hurt': {
        sfx.play('hurt');
        const core = world.get('effect:core');
        flash = 1;
        flashColour = ACCENT.impact.clone();
        if (core) burst(core, 40, 1.1 * H, ACCENT.impact, 0.03 * H, 0.55);
        break;
      }
      case 'sparkle': {
        sfx.play('sparkle');
        const core = world.get('effect:core');
        if (!core) break;
        for (let i = 0; i < 28; i += 1) {
          const a = Math.random() * Math.PI * 2;
          const rise = 0.25 + Math.random() * 0.75;
          motes.spawn({
            position: scratch.copy(core).add(scratchB.set(Math.cos(a) * 0.22 * H, (Math.random() - 0.4) * 0.3 * H, Math.sin(a) * 0.22 * H)),
            velocity: scratchC.set(Math.cos(a) * 0.06 * H, rise * 0.22 * H, Math.sin(a) * 0.06 * H),
            colour: MOTE_COLOURS[(Math.random() * MOTE_COLOURS.length) | 0],
            size: 0.03 * H * (0.6 + Math.random()),
            life: 1.5 + Math.random(),
            drag: 0.5,
            alpha: 1,
            shape: 1,
            spinRate: (Math.random() - 0.5) * 4,
          });
        }
        break;
      }
    }
  }

  let castHold = 0;
  let chargeHold = 0;

  // ---------------------------------------------------------------- clip bindings

  function bindingsFor(clipName: string): ClipBinding[] {
    const profile = CLIP_PROFILES[clipName];
    const out: ClipBinding[] = [];
    if (!profile) {
      return [{ effect: 'motes', basis: 'inferred', reason: `no measured profile for "${clipName}" — ambient only` }];
    }
    const f = profile.features;
    const has = (c: string) => profile.classes.includes(c);

    // ---- measured ----
    if ((f.handRange ?? 0) >= 0.40 || has('dash') || has('run')) {
      out.push({ effect: 'handTrails', basis: 'measured', reason: `handRange ${f.handRange?.toFixed(2)}H${has('dash') ? ', classified dash' : has('run') ? ', classified run' : ''}` });
    }
    if (!has('planted')) {
      out.push({ effect: 'footDust', basis: 'measured', reason: `footRange ${f.footRange?.toFixed(2)}H — the feet participate (planted is < 0.10H)` });
    }
    if (has('jump') || has('leap')) {
      out.push({ effect: 'landingWave', basis: 'measured', reason: `rise ${f.rise?.toFixed(2)}H — classified ${has('leap') ? 'leap' : 'jump'}` });
    }
    if (has('gesture')) {
      out.push({ effect: 'palmCharge', basis: 'measured', reason: `handRange ${f.handRange?.toFixed(2)}H while in-place — classified gesture` });
    }

    // ---- inferred from the clip's name, and nothing else ----
    if (/angry|freaky|frustrated/.test(clipName)) {
      out.push({ effect: 'hornArc', basis: 'inferred', reason: 'the clip is NAMED angry/freaky/frustrated; no measured feature separates anger from any other in-place gesture' });
    }
    if (/heart_pose/.test(clipName)) {
      out.push({ effect: 'hearts', basis: 'inferred', reason: 'the clip is NAMED heart_pose; the pose itself is not measurable as affection' });
    }
    if (/shoot/.test(clipName)) {
      out.push({ effect: 'palmCharge', basis: 'inferred', reason: 'the clip is NAMED shoot; nothing kinematic distinguishes a shot from a reach' });
    }
    return out;
  }

  let activeClip = '';
  let activeBindings: ClipBinding[] = [];

  function setClip(clipName: string): ClipBinding[] {
    activeClip = clipName;
    activeBindings = bindingsFor(clipName);
    const wanted = new Set(activeBindings.map((b) => b.effect));
    for (const key of ['handTrails', 'footDust', 'landingWave', 'hornArc', 'palmCharge', 'hearts'] as EffectName[]) {
      enabled[key] = wanted.has(key);
    }
    trails.l.reset();
    trails.r.reset();
    heartTimer = 0;
    // A little pop of twinkles on the cut. Punctuation: it marks the change without the figure
    // having to do anything, and it covers the instant where the cross-fade is weakest.
    const core = world.get('effect:core');
    if (core) burst(core, 16, 0.75 * H, ACCENT.core, 0.028 * H, 0.55, motes, 1);
    sfx.play('switch');
    return activeBindings;
  }

  let heartTimer = 0;
  let moteTimer = 0;
  let shootTimer = 0;

  // ---------------------------------------------------------------- frame

  function update(dt: number, elapsed: number, cameraArgument?: THREE.Camera): void {
    const camera = cameraArgument ?? lastCamera;
    const step = Math.min(dt, 1 / 20);   // a tab that was backgrounded must not teleport every effect
    readSockets(step, firstFrame);

    if (hip) {
      const y = hip.getWorldPosition(scratch).y;
      hipVy = firstFrame || step <= 0 ? 0 : (y - hipY) / step;
      hipY = y;
    }
    if (firstFrame) firstFrame = false;

    // Before the first render there is no camera yet; the trails simply hold off a frame.
    const cameraPosition = camera ? camera.getWorldPosition(scratchC) : null;

    // ---- ambient motes: always on, slow, cold, from the belly's pale blue ----
    if (enabled.motes) {
      moteTimer -= step;
      if (moteTimer <= 0) {
        moteTimer = 0.05;
        const core = world.get('effect:core');
        if (core) {
          const a = Math.random() * Math.PI * 2;
          const radius = (0.35 + Math.random() * 0.35) * H;
          motes.spawn({
            position: scratch.set(core.x + Math.cos(a) * radius, 0.05 * H + Math.random() * 1.15 * H, core.z + Math.sin(a) * radius),
            velocity: scratchB.set(Math.cos(a + 1.4) * 0.02 * H, 0.035 * H * (0.5 + Math.random()), Math.sin(a + 1.4) * 0.02 * H),
            colour: MOTE_COLOURS[(Math.random() * MOTE_COLOURS.length) | 0],
            size: 0.024 * H * (0.45 + Math.random()),
            life: 2.6 + Math.random() * 2,
            drag: 0.85,
            alpha: 0.9,
            // Most are twinkles; a few stay round so the field is not uniformly spiky.
            shape: Math.random() < 0.72 ? 1 : 0,
            spinRate: (Math.random() - 0.5) * 1.6,
          });
        }
      }
    }

    // ---- hand trails ----
    for (const side of ['l', 'r'] as const) {
      const palm = world.get(`effect:palm.${side}`);
      const ribbon = trails[side];
      if (!palm) continue;
      const speed = velocity.get(`effect:palm.${side}`)!.length();
      // Strength follows how fast the hand is actually moving, so a trail thins out when the hand
      // slows instead of hanging in the air at full brightness.
      const target = enabled.handTrails ? THREE.MathUtils.clamp(speed / (1.9 * H), 0, 1) * 0.8 : 0;
      ribbon.setStrength(cameraPosition ? target : 0);
      if (cameraPosition) ribbon.update(palm, cameraPosition, step);
    }

    // ---- foot contact -> dust, and a landing -> shockwave ----
    for (const side of ['l', 'r'] as const) {
      const state = footState[side];
      state.since += step;
      const p = world.get(`effect:foot.${side}`);
      const v = velocity.get(`effect:foot.${side}`);
      if (!p || !v) continue;
      const nearGround = p.y < GROUND_BAND;
      const descending = v.y < -0.05 * H;
      if (nearGround && descending && !state.down && state.since > 0.12) {
        state.down = true;
        state.since = 0;
        // How hard the landing was, read from the hip's fall speed at the moment of contact.
        const force = THREE.MathUtils.clamp(-hipVy / (0.8 * H), 0, 1);
        if (enabled.footDust) {
          dustPuff(p, 12 + Math.round(force * 16), (0.20 + force * 0.45) * H, 0.07 * H, 0.6);
          // A couple of glinting motes catch the light above the cloud. Kept sparse: the dust is
          // the effect, and burying it in sparkles is what made it read as magic before.
          burst(p, 1 + Math.round(force * 3), 0.3 * H, ACCENT.mote, 0.016 * H, 0.4, motes, 1);
        }
        sfx.play(force > 0.4 ? 'land' : 'step', force > 0.4 ? force : 1 - force * 0.6);
        if (enabled.landingWave && force > 0.28) {
          // A harder, wider, longer-lived cloud — no glowing ring. The bright expanding rings that
          // used to fire here are what read as ripples on water: a landing displaces dirt, it does
          // not emit light.
          dustPuff(p, 24 + Math.round(force * 30), (0.45 + force * 0.75) * H, 0.09 * H, 0.9);
          // A second, slower wave just behind the first, so the cloud has depth rather than being
          // one shell expanding at a single speed.
          dustPuff(p, 12, (0.16 + force * 0.3) * H, 0.13 * H, 1.3);
        }
      } else if (!nearGround) {
        state.down = false;
      }
    }

    // ---- horn arc ----
    castHold = Math.max(0, castHold - step);
    const arcOn = enabled.hornArc || castHold > 0;
    hornArc.setStrength(arcOn ? 0.95 : 0);
    const hornL = world.get('effect:horn.l');
    const hornR = world.get('effect:horn.r');
    if (hornL && hornR) {
      hornArc.update(step, hornL, hornR, 0.05 * H);
      if (arcOn) sfx.play('arc');
      if (arcOn && Math.random() < step * 40) {
        // Sparks shed off the bolt, spawned along it rather than at the tips.
        const t = Math.random();
        scratch.lerpVectors(hornL, hornR, t);
        scratch.y += Math.sin(Math.PI * t) * 0.08 * H;
        burst(scratch, 2, 0.35 * H, ACCENT.core, 0.014 * H, 0.35);
      }
    }

    // ---- palm charge ----
    chargeHold = Math.max(0, chargeHold - step);
    for (const side of ['l', 'r'] as const) {
      const orb = orbs[side];
      const palm = world.get(`effect:palm.${side}`);
      if (palm) orb.group.position.copy(palm);
      const target = chargeHold > 0 ? 1 : enabled.palmCharge ? 0.55 + 0.2 * Math.sin(elapsed * 2.3 + (side === 'l' ? 0 : 1.7)) : 0;
      orb.setCharge(target);
      orb.update(step, elapsed);
      if (orb.level > 0.35 && palm && Math.random() < step * 22 * orb.level) {
        // Motes fall INTO the palm rather than out of it: the orb is gathering, not emitting.
        const a = Math.random() * Math.PI * 2;
        const r = 0.16 * H;
        sparks.spawn({
          position: scratch.set(palm.x + Math.cos(a) * r, palm.y + (Math.random() - 0.5) * r, palm.z + Math.sin(a) * r),
          velocity: scratchB.subVectors(palm, scratch).multiplyScalar(2.6),
          colour: ACCENT.energy,
          size: 0.014 * H,
          life: 0.35,
          drag: 1,
        });
      }
    }

    // The named shoot clip fires the bolt on a cadence rather than continuously; this is an
    // inferred binding and it is timed, not triggered by anything the clip measurably does.
    if (activeClip.includes('shoot')) {
      shootTimer -= step;
      if (shootTimer <= 0) { shootTimer = 1.6; fireBeam(); }
    } else {
      shootTimer = 0.5;
    }

    // ---- beam ----
    if (beam.running) {
      const before = beam.progress;
      beam.update(step);
      // One impact burst, at the moment the bolt reaches full extension.
      if (before < 0.62 && beam.progress >= 0.62) {
        // Burst only. A shockwave is a ground ring by construction — it is pinned to y = 0 — so
        // firing one at the bolt's tip drew a ring on the floor several units away from the
        // impact it was meant to mark.
        burst(beam.tipAt(1), 34, 1.1 * H, ACCENT.energy, 0.032 * H, 0.5);
        burst(beam.tipAt(1), 14, 0.5 * H, ACCENT.core, 0.045 * H, 0.32);
      }
    }

    // ---- hearts ----
    if (enabled.hearts) {
      heartTimer -= step;
      if (heartTimer <= 0) {
        heartTimer = 0.42;
        sfx.play('heart');
        const core = world.get('effect:core');
        if (core) {
          // In FRONT of the chest, along the measured facing. The core socket is the centroid of
          // the skin Spine02 drives, which is inside the body: hearts emitted there were alive and
          // updating but hidden behind the monster for their whole life.
          const out = readForward();
          scratch.copy(core)
            .addScaledVector(out, 0.34 * H)
            .add(scratchB.set((Math.random() - 0.5) * 0.22 * H, 0.06 * H, (Math.random() - 0.5) * 0.22 * H));
          hearts.emit(
            scratch,
            scratchB.set(out.x * 0.05 * H, (0.2 + Math.random() * 0.12) * H, out.z * 0.05 * H),
            2.0,
          );
        }
      }
    }
    if (camera) hearts.update(step, camera.quaternion);

    const charging = Math.max(orbs.l.level, orbs.r.level);

    // ---- blush ----
    blush?.setLevel(enabled.blush ? 1 : 0);
    blush?.update(step, elapsed);

    // ---- eye glow ----
    eyeGlow.setLevel(enabled.eyeGlow ? Math.max(charging * 0.9, arcOn ? 0.7 : 0, flash * 0.8) : 0);
    if (camera) {
      eyeGlow.update(step, elapsed, world.get('effect:eye.l'), world.get('effect:eye.r'), camera.quaternion);
    }

    // ---- rim ----
    rim.uRimStrength.value = enabled.rimLight ? 0.5 : 0;
    // The contour brightens with a charge and with a hit, so the silhouette carries the beat too.
    rim.uRimPulse.value = enabled.rimLight ? charging * 0.5 + flash * 0.9 : 0;

    // ---- emissive ----
    flash = Math.max(0, flash - step * 2.4);
    if (activeClip.includes('hurt') && Math.random() < step * 0.7) {
      flash = Math.max(flash, 0.8);
      flashColour = ACCENT.impact.clone();
      const core = world.get('effect:core');
      if (core) burst(core, 24, 0.9 * H, ACCENT.impact, 0.026 * H, 0.5);
    }
    if (enabled.aura) {
      // A slow two-rate breath so it never lands on an obvious period.
      auraDrive = 0.06 + 0.045 * (0.5 + 0.5 * Math.sin(elapsed * 1.15)) + 0.02 * Math.sin(elapsed * 2.7);
    } else {
      auraDrive = 0;
    }
    material.emissive.copy(emissiveBase)
      .lerp(ACCENT.energy, auraDrive + charging * 0.16)
      .lerp(flashColour, flash * 0.85);
    material.emissiveIntensity = 1 + flash * 1.3;

    // ---- pools ----
    sparks.update(step);
    dust.update(step);
    motes.update(step);
    shockwaves.update(step);
  }

  function setViewport(pixelHeight: number, fovDegrees: number): void {
    sparks.setViewport(pixelHeight, fovDegrees);
    dust.setViewport(pixelHeight, fovDegrees);
    motes.setViewport(pixelHeight, fovDegrees);
  }

  function dispose(): void {
    sparks.dispose(); dust.dispose(); motes.dispose();
    trails.l.dispose(); trails.r.dispose();
    shockwaves.dispose(); hornArc.dispose();
    orbs.l.dispose(); orbs.r.dispose();
    beam.dispose(); hearts.dispose(); eyeGlow.dispose(); blush?.dispose(); sfx.dispose();
    rim.uRimStrength.value = 0;
    rim.uRimPulse.value = 0;
    material.emissive.copy(emissiveBase);
    material.emissiveIntensity = 1;
  }

  return {
    group,
    sfx,
    update,
    cue,
    setClip,
    setEffectEnabled: (effect, on) => { enabled[effect] = on; if (effect === 'handTrails' && !on) { trails.l.reset(); trails.r.reset(); } },
    isEffectEnabled: (effect) => enabled[effect],
    setViewport,
    bindingsFor,
    socketWorldPosition,
    socketIds: [...sockets.keys()],
    debug: () => ({
      sparks: sparks.liveCount,
      dust: dust.liveCount,
      motes: motes.liveCount,
      trailL: { visible: trails.l.mesh.visible, opacity: Number(trails.l.opacity.toFixed(3)) },
      trailR: { visible: trails.r.mesh.visible, opacity: Number(trails.r.opacity.toFixed(3)) },
      hornArc: { visible: hornArc.group.visible, opacity: Number(hornArc.opacity.toFixed(3)) },
      orbL: Number(orbs.l.level.toFixed(3)),
      orbR: Number(orbs.r.level.toFixed(3)),
      beam: beam.running,
      shockwaves: shockwaves.liveCount,
      hearts: hearts.liveCount,
      emissive: `#${material.emissive.getHexString()} x${material.emissiveIntensity.toFixed(2)}`,
      rim: Number(rim.uRimStrength.value.toFixed(2)) + rim.uRimPulse.value,
      eyeGlowVisible: eyeGlow.group.visible,
      sound: { enabled: sfx.isEnabled, unlocked: sfx.isUnlocked, state: sfx.state, voices: sfx.voicesStarted },
      enabled: { ...enabled },
      clip: activeClip,
    }),
    dispose,
  };
}

export { PALETTE, ACCENT };
