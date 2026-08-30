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
import { ACCENT, CLIP_PROFILES, FIGURE_HEIGHT, FRAME, PALETTE, SOCKETS } from '../characterProfile';
import { ParticleField } from './particles';
import { Ribbon } from './ribbon';
import { Beam, ChargeOrb, Hearts, HornArc, Shockwaves } from './shapes';
import { Blink } from './blink';
import { EyeGlow, installRimLight } from './rimLight';

const H = FIGURE_HEIGHT;

export type CueName = 'cast' | 'blast' | 'slam' | 'hurt' | 'sparkle';

export type EffectName =
  | 'motes' | 'aura' | 'rimLight' | 'blink' | 'eyeGlow' | 'handTrails' | 'footDust' | 'landingWave'
  | 'hornArc' | 'palmCharge' | 'hearts';

export interface ClipBinding {
  effect: EffectName;
  basis: 'measured' | 'inferred';
  reason: string;
}

export interface MonsterCuteVfx {
  group: THREE.Group;
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
  /** Hold the eyes at a closure (0 open, 1 shut), or null to hand them back to the blink rhythm. */
  forceBlink(amount: number | null): void;
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
  const dust = new ParticleField(900);
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
  group.add(shockwaves.group, hornArc.group, orbs.l.group, orbs.r.group, beam.group, hearts.group, eyeGlow.group);

  // Drawn into the eye's own vertex colours; there are no eyelid joints to pose.
  const blink = new Blink(rigged.mesh);

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
    motes: true, aura: true, rimLight: true, blink: true, eyeGlow: true,
    handTrails: false, footDust: false,
    landingWave: false, hornArc: false, palmCharge: false, hearts: false,
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

  function burst(at: THREE.Vector3, count: number, speed: number, colour: THREE.Color, size: number, life: number, field = sparks): void {
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
      });
    }
  }

  function ringPuff(at: THREE.Vector3, count: number, speed: number, colour: THREE.Color, size: number, life: number): void {
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const s = speed * (0.5 + Math.random() * 0.7);
      dust.spawn({
        position: scratch.set(at.x, Math.max(at.y, 0.01), at.z),
        velocity: scratchB.set(Math.cos(a) * s, Math.random() * s * 0.5, Math.sin(a) * s),
        colour,
        size: size * (0.7 + Math.random() * 0.9),
        life: life * (0.7 + Math.random() * 0.6),
        drag: 0.06,
        gravity: 0.08 * H,      // dust drifts up as it thins out
        growth: 2.6,
        alpha: 0.8,
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
        const foot = world.get('effect:foot.l') ?? world.get('effect:foot.r');
        if (!foot) break;
        shockwaves.fire(foot, 0.75 * H, 0.75, ACCENT.energy);
        shockwaves.fire(foot, 0.42 * H, 0.55, ACCENT.core);
        ringPuff(foot, 26, 0.9 * H, ACCENT.dust, 0.05 * H, 0.85);
        burst(foot, 22, 0.8 * H, ACCENT.energy, 0.025 * H, 0.5);
        break;
      }
      case 'hurt': {
        const core = world.get('effect:core');
        // Eyes screwed shut on the hit, then handed back to the rhythm. Counted down in the frame
        // loop rather than on a timer, so a backgrounded tab does not come back mid-wince.
        blink.setForced(1);
        squeezeHold = 0.22;
        flash = 1;
        flashColour = ACCENT.impact.clone();
        if (core) burst(core, 40, 1.1 * H, ACCENT.impact, 0.03 * H, 0.55);
        break;
      }
      case 'sparkle': {
        const core = world.get('effect:core');
        if (!core) break;
        for (let i = 0; i < 28; i += 1) {
          const a = Math.random() * Math.PI * 2;
          const rise = 0.25 + Math.random() * 0.75;
          motes.spawn({
            position: scratch.copy(core).add(scratchB.set(Math.cos(a) * 0.22 * H, (Math.random() - 0.4) * 0.3 * H, Math.sin(a) * 0.22 * H)),
            velocity: scratchC.set(Math.cos(a) * 0.06 * H, rise * 0.22 * H, Math.sin(a) * 0.06 * H),
            colour: ACCENT.mote,
            size: 0.016 * H * (0.6 + Math.random()),
            life: 1.4 + Math.random(),
            drag: 0.5,
            alpha: 0.9,
          });
        }
        break;
      }
    }
  }

  let castHold = 0;
  let chargeHold = 0;
  let squeezeHold = 0;

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
    // A blink on the cut hides the pose discontinuity the cross-fade cannot fully cover, the same
    // way a cut on a blink works in editing.
    if (enabled.blink) blink.trigger();
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
        moteTimer = 0.055;
        const core = world.get('effect:core');
        if (core) {
          const a = Math.random() * Math.PI * 2;
          const radius = (0.35 + Math.random() * 0.35) * H;
          motes.spawn({
            position: scratch.set(core.x + Math.cos(a) * radius, 0.05 * H + Math.random() * 1.15 * H, core.z + Math.sin(a) * radius),
            velocity: scratchB.set(Math.cos(a + 1.4) * 0.02 * H, 0.035 * H * (0.5 + Math.random()), Math.sin(a + 1.4) * 0.02 * H),
            colour: ACCENT.mote,
            size: 0.019 * H * (0.5 + Math.random()),
            life: 2.6 + Math.random() * 2,
            drag: 0.85,
            alpha: 0.85,
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
          ringPuff(p, 9 + Math.round(force * 16), (0.28 + force * 0.7) * H, ACCENT.dust, 0.055 * H, 0.6);
        }
        if (enabled.landingWave && force > 0.28) {
          shockwaves.fire(p, (0.35 + force * 0.55) * H, 0.6, ACCENT.energy);
          burst(p, Math.round(8 + force * 20), (0.4 + force * 0.6) * H, ACCENT.energy, 0.02 * H, 0.4);
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

    // ---- blink ----
    if (squeezeHold > 0) {
      squeezeHold -= step;
      if (squeezeHold <= 0) blink.setForced(null);
    }
    // Runs on its own rhythm rather than on the clip's, because a blink is not part of any of these
    // 33 clips; a character that only blinks when it moves looks switched off between actions.
    if (enabled.blink) blink.update(step);
    const openness = 1 - blink.closure;

    // ---- eye glow ----
    const charging = Math.max(orbs.l.level, orbs.r.level);
    eyeGlow.setLevel(enabled.eyeGlow ? Math.max(charging * 0.9, arcOn ? 0.7 : 0, flash * 0.8) : 0);
    if (camera) {
      eyeGlow.update(step, elapsed, world.get('effect:eye.l'), world.get('effect:eye.r'), camera.quaternion, openness);
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
    beam.dispose(); hearts.dispose(); eyeGlow.dispose();
    blink.dispose();
    rim.uRimStrength.value = 0;
    rim.uRimPulse.value = 0;
    material.emissive.copy(emissiveBase);
    material.emissiveIntensity = 1;
  }

  return {
    group,
    update,
    cue,
    setClip,
    setEffectEnabled: (effect, on) => { enabled[effect] = on; if (effect === 'handTrails' && !on) { trails.l.reset(); trails.r.reset(); } },
    isEffectEnabled: (effect) => enabled[effect],
    setViewport,
    forceBlink: (amount) => blink.setForced(amount),
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
      blinkClosure: Number(blink.closure.toFixed(3)),
      rim: Number(rim.uRimStrength.value.toFixed(2)) + rim.uRimPulse.value,
      eyeGlowVisible: eyeGlow.group.visible,
      enabled: { ...enabled },
      clip: activeClip,
    }),
    dispose,
  };
}

export { PALETTE, ACCENT };
