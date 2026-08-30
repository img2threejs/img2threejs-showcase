import * as THREE from 'three';
import { VFX } from './palette';
import type { Animator } from './animator';
import type { RigFrame } from './rigFrame';
import type { SocketRig } from './sockets';
import type { VfxSystem } from './vfx/vfxSystem';
import type { LightRig } from './lighting';
import type { LimbMotion } from './motion';

/**
 * Roblin's three ranged skills.
 *
 * Each one is a REAL clip driving a real skeleton, with effects released by cues read off the
 * mixer's own clock, fired from a real socket on a real bone, aimed down the MEASURED forward
 * axis. There is no hand-placed muzzle position anywhere in this file.
 *
 * AIM COMES FROM THE HAND, not from the torso. Every cast reads `motion.aim(socket)`, which is the
 * direction the forearm points blended toward the direction the hand is actually travelling — see
 * motion.ts. The first version fired everything down the body's forward axis, and it showed: the
 * `fire` clip brings both arms across the chest, so the bolt left sideways from a hand pointing
 * somewhere else entirely.
 *
 * Colour discipline: `toxic` is the signature and carries the two skills that come out of the
 * hands; `ember` carries the volley so two casts in a row do not look identical; `steel` appears
 * only as impact sparks, in small amounts, because it is the one authored hue in the palette.
 *
 * The clip assignments are honest reuse of a preset library, not bespoke animation:
 *   toxic-bolt   preset:biped:fire         a firing motion — the closest match in the set
 *   ember-volley preset:biped:box_02       a boxing combination, read here as three palm blasts
 *   spore-nova   preset:biped:dance_05     a spin. It is a dance clip and it reads as one; it was
 *                                          chosen because it is the only short clip that turns the
 *                                          figure through 360 degrees, which a radial burst needs.
 */

export interface SkillContext {
  /**
   * Lets a skill recolour the hand and foot wakes while it runs. Without it Roblin throws a
   * TOXIC GREEN wake through an ember punch, because the trails are keyed to limb speed and know
   * nothing about which skill is casting.
   */
  tintTrails?(head: THREE.Color, tail: THREE.Color, seconds: number): void;
  frame: RigFrame;
  sockets: SocketRig;
  /** Per-limb measured velocity and pointing axis. Every cast direction comes from here. */
  motion: LimbMotion;
  animator: Animator;
  vfx: VfxSystem;
  lights: LightRig;
  groundY: number;
  /**
   * The group the figure sits under. Its world rotation is applied to the bind-time body axes on
   * every cast, because the sprint yaws this group: without it Roblin turns while every bolt keeps
   * firing down the direction the body happened to face when the rig was first measured.
   */
  root: THREE.Object3D;
}

export interface Skill {
  id: string;
  label: string;
  clip: string;
  colour: string;
  /** One line for the HUD and the report. */
  description: string;
  cast(): boolean;
}

const TOXIC = new THREE.Color(VFX.toxic.value);
const VENOM = new THREE.Color(VFX.venom.value);
const SPORE = new THREE.Color(VFX.spore.value);
const EMBER = new THREE.Color(VFX.ember.value);
const EMBER_DEEP = new THREE.Color(VFX.emberDeep.value);
const STEEL = new THREE.Color(VFX.steel.value);
// The volley's own ramp, hottest first. Fire is not one colour and the volley used to be painted in
// exactly one: `ember` everywhere, from the fist to the last spark.
// 0.62 toward the ember hue, not 0.22. At 0.22 this was 78% white and every hot thing in the
// volley — wake head, muzzle, impact shell — rendered as white confetti with an orange fringe.
// Fire's hottest visible part is still distinctly warm.
const EMBER_WHITE = new THREE.Color(0xffffff).lerp(EMBER, 0.62);
const EMBER_ASH = new THREE.Color(VFX.bounce.value).multiplyScalar(1.6);

export function createSkills(ctx: SkillContext): Skill[] {
  const { frame, sockets, animator, vfx, lights, groundY, root, motion, tintTrails } = ctx;
  const h = frame.figureHeight;
  const orientation = new THREE.Quaternion();

  /** The bind-time forward axis carried into the figure's current orientation. */
  const forwardNow = (): THREE.Vector3 =>
    frame.forward.clone().applyQuaternion(root.getWorldQuaternion(orientation)).normalize();

  /**
   * Charge glow that gathers at a socket before release.
   *
   * The swirl axis is the HAND'S axis, so the gathering spirals around the forearm and reads as
   * energy being drawn into the palm rather than as a cloud that happens to sit near a hand.
   */
  const charge = (socketId: string, colour: THREE.Color, count: number): void => {
    const at = sockets.get(socketId).worldPosition();
    const axis = motion.axis(socketId);
    vfx.burst(at, {
      count,
      colour: colour.clone().multiplyScalar(1.4),
      colourEnd: colour,
      // Emitted backwards along the arm and swirled around it: with drag this high the particles
      // stall and curl into the palm instead of escaping.
      direction: axis.clone().negate(),
      spread: 1.25,
      speed: [0.12, 0.65],
      life: [0.22, 0.5],
      size: [h * 0.01, h * 0.028],
      gravity: -0.35,
      drag: 4.2,
      swirl: 7.0,
      jitter: h * 0.045,
      inherit: motion.velocity(socketId).multiplyScalar(0.5),
    });
    vfx.flash(at, colour, 3.2, 0.3, h * 1.6);
  };

  /**
   * The volley's wind-up: embers drawn into the fist rather than a generic swirl.
   *
   * Two layers. A tight ring orbiting the hand's own axis — emitted sideways with a strong swirl
   * and heavy drag so it curls into a disc instead of escaping — and a slow rise of guttering
   * embers off it. The disc is what makes a fist read as loaded; the rise is what makes it read as
   * hot rather than merely bright.
   */
  const emberCharge = (socketId: string, count: number, radius: number): void => {
    const at = sockets.get(socketId).worldPosition();
    const axis = motion.axis(socketId);
    const carried = motion.velocity(socketId).multiplyScalar(0.6);
    vfx.burst(at, {
      count,
      colour: EMBER_WHITE,
      colourEnd: EMBER_DEEP,
      // Sideways to the arm, then swirled hard about it: the particles never get away from the
      // fist, they wrap around it.
      direction: axis.clone(),
      spread: Math.PI * 0.5,
      speed: [0.3, 1.0],
      life: [0.2, 0.45],
      size: [h * radius * 0.35, h * radius],
      gravity: -0.6,
      drag: 6.5,
      swirl: 16,
      jitter: h * 0.03,
      flicker: 0.85,
      inherit: carried,
    });
    vfx.burst(at, {
      count: Math.round(count * 0.4),
      colour: EMBER,
      colourEnd: EMBER_ASH,
      direction: frame.up.clone(),
      spread: 0.9,
      speed: [0.15, 0.7],
      life: [0.45, 1.0],
      size: [h * 0.005, h * 0.015],
      gravity: -0.75,
      drag: 1.6,
      jitter: h * 0.05,
      flicker: 1,
      inherit: carried,
    });
    vfx.flash(at, EMBER, 6, 0.32, h * 1.8);
  };

  /**
   * A fireball, not a green splash: the volley's own impact.
   *
   * The order matters as much as the parts. A white flare and a hard light on the first frame, then
   * a fast outward shell of hot debris, then embers that RISE off it instead of falling, then a
   * scorch that stays after all of it has gone. Without the last one the whole thing reads as a
   * flash; without the rising embers it reads as gravel.
   */
  const emberImpact = (at: THREE.Vector3, direction: THREE.Vector3, scale: number): void => {
    const height = Math.max(0, at.y - groundY);
    const grounded = THREE.MathUtils.clamp(1 - height / (h * 0.45), 0, 1);
    const onGround = at.clone();
    onGround.y = groundY + 0.004;

    // Two flares on the first frame: a ROUND one for the detonation itself and a directional one
    // punched back along the way the bolt came in. The round one is what an airburst was missing —
    // with the volley detonating at chest height it never triggers the ground rings, so without it
    // the impact was a cloud of particles and no event.
    vfx.flare(at, direction, EMBER_WHITE, h * 0.34 * scale, h * 0.32 * scale, 0.13);
    vfx.flare(at, direction, EMBER, h * 0.52 * scale, h * 0.1 * scale, 0.17);
    vfx.flash(at, EMBER, 120 * scale * scale, 0.34, h * (3.5 + 2 * scale));

    // The shell: hot, fast, short-lived, thrown back along the way the bolt came in.
    vfx.burst(at, {
      count: Math.round(120 * scale),
      colour: EMBER_WHITE,
      colourEnd: EMBER_DEEP,
      direction: direction.clone().negate(),
      spread: Math.PI * 0.75,
      speed: [2.2 * scale, 6.5 * scale],
      life: [0.16, 0.38],
      size: [h * 0.012, h * 0.042],
      gravity: 6.5,
      drag: 2.2,
      jitter: h * 0.02,
      flicker: 0.5,
    });
    // The embers: slow, buoyant, guttering, long-lived. This is the half that reads as fire.
    vfx.burst(at, {
      count: Math.round(70 * scale),
      colour: EMBER,
      colourEnd: EMBER_ASH,
      direction: frame.up.clone(),
      spread: Math.PI * 0.55,
      speed: [0.4 * scale, 2.0 * scale],
      life: [0.7, 1.7],
      size: [h * 0.005, h * 0.018],
      gravity: -0.55,
      drag: 1.3,
      swirl: 1.4,
      jitter: h * 0.05,
      flicker: 1,
    });
    // A few steel sparks that survive the fire and skip away hard.
    vfx.burst(at, {
      count: Math.round(18 * scale),
      colour: STEEL,
      colourEnd: EMBER,
      direction: direction.clone().negate(),
      spread: 0.5,
      speed: [4, 10],
      life: [0.2, 0.45],
      size: [h * 0.004, h * 0.011],
      gravity: 7.5,
      drag: 1.0,
    });

    if (grounded > 0.05) {
      vfx.shockwave(onGround, h * 0.34 * scale * grounded, EMBER_WHITE, 0.24, 0.34);
      vfx.shockwave(onGround, h * 0.7 * scale * grounded, EMBER, 0.5, 0.2);
    }
    // The slow half, and ONLY for something that actually hit the floor. Laid under an airburst it
    // is a metre-wide mark on ground the blast never touched, and with the camera looking slightly
    // down it lands mostly below the bottom of the frame — a distracting sliver of glow with no
    // event attached to it.
    if (grounded > 0.05) {
      vfx.scorch(onGround, h * (0.2 + 0.2 * scale) * grounded, EMBER, EMBER_ASH, 1.1 + 0.5 * scale);
    }
    lights.surge(EMBER, 0.6 * scale);
  };

  /** Fire one ember comet from a socket, down that hand's own aim. */
  const emberBolt = (socketId: string, radius: number, scale: number): void => {
    const from = sockets.get(socketId).worldPosition();
    const direction = motion.aim(socketId, undefined, 0.3);
    const maxReach = h * 1.15;
    let range = maxReach;
    if (direction.y < -0.08) {
      const toFloor = (groundY - from.y) / direction.y;
      if (toFloor > 0) range = Math.min(range, toFloor);
    }
    range = Math.max(h * 0.45, range);

    vfx.bolt({
      from,
      direction,
      speed: h * 4.6,
      range,
      core: EMBER_WHITE,
      halo: EMBER,
      radius: h * radius,
      sparkRate: 240,
      // A wake that cools along its length, and embers that RISE off it — the single change that
      // stops a recoloured green bolt from looking like a recoloured green bolt.
      trailHead: EMBER_WHITE,
      trailTail: EMBER_DEEP,
      sparkEnd: EMBER_ASH,
      sparkGravity: -0.9,
      sparkSize: 0.8,
      flicker: 0.7,
      onImpact: (at, dir) => emberImpact(at, dir, scale),
    });

    vfx.flare(from, direction, EMBER_WHITE, h * 0.36 * scale, h * 0.075 * scale, 0.11);
    vfx.burst(from, {
      count: Math.round(44 * scale),
      colour: EMBER_WHITE,
      colourEnd: EMBER_DEEP,
      direction,
      spread: 0.5,
      speed: [2.5, 7.0],
      life: [0.1, 0.3],
      size: [h * 0.005, h * 0.02],
      gravity: 1.0,
      drag: 3.8,
      flicker: 0.6,
      inherit: motion.velocity(socketId).multiplyScalar(0.4),
    });
    vfx.flash(from, EMBER, 30, 0.18, h * 2.6);
    lights.surge(EMBER, 0.7);
  };

  /**
   * What every bolt does when it arrives. Shared so all three impacts read as the same world.
   *
   * A floor hit and an airburst are not the same event and no longer render as one. The ground ring
   * is the signature of something striking the floor, so it is scaled by how close the detonation
   * actually was to it: a bolt that goes off at chest height gets a faint mark under it and spends
   * its energy on the burst instead. The first version drew a full-size ring under every airburst,
   * which read as two unrelated effects going off at once.
   */
  const impact = (at: THREE.Vector3, direction: THREE.Vector3, colour: THREE.Color, scale: number): void => {
    const height = Math.max(0, at.y - groundY);
    const grounded = THREE.MathUtils.clamp(1 - height / (h * 0.45), 0, 1);

    vfx.burst(at, {
      count: Math.round(170 * scale),
      colour: colour.clone().multiplyScalar(1.7),
      colourEnd: colour.clone().multiplyScalar(0.08),
      speed: [1.4 * scale, 4.2 * scale],
      // Short-lived and heavy. The first version lived up to 0.8s under low gravity and high drag,
      // which left the debris hanging in the air as sparse dots — fireflies, not a splash.
      life: [0.22, 0.5],
      size: [h * 0.016, h * 0.055],
      // A floor hit throws its splash UP off the ground; an airburst throws it everywhere. The
      // cone opens out as the detonation gets further from the floor.
      direction: frame.up.clone(),
      spread: Math.PI * (0.45 + 0.55 * (1 - grounded)),
      gravity: 5.5,
      drag: 1.5,
      jitter: h * 0.03,
    });
    // A thin fan of steel-white sparks back along the travel direction — the reflected shrapnel.
    vfx.burst(at, {
      count: Math.round(26 * scale),
      colour: STEEL,
      colourEnd: colour,
      direction: direction.clone().negate(),
      spread: 0.7,
      speed: [3, 8.5],
      life: [0.18, 0.4],
      size: [h * 0.006, h * 0.016],
      gravity: 5.5,
      drag: 1.2,
    });
    // Sub-linear on purpose: eight impacts at scale 0.34 should not add up to more light than
    // one impact at scale 1.
    vfx.flash(at, colour, 78 * scale * scale, 0.3, h * (3.5 + 1.5 * scale));
    // A flare punched back along the bolt's own path — the direction it came in on, kept visible
    // for the one frame the detonation reads in.
    vfx.flare(at, direction, colour, h * 0.38 * scale, h * 0.12 * scale, 0.15);

    const onGround = at.clone();
    onGround.y = groundY + 0.004;
    if (grounded > 0.05) {
      // Two rings, not one: a tight fast one for the hit and a wider slow one for the aftermath.
      vfx.shockwave(onGround, h * 0.3 * scale * grounded, new THREE.Color(0xffffff).lerp(colour, 0.6), 0.26, 0.32);
      vfx.shockwave(onGround, h * 0.62 * scale * grounded, colour, 0.55, 0.2);
    } else {
      // Nothing struck the floor, but the light from the burst still lands on it.
      vfx.shockwave(onGround, h * 0.5 * scale, colour.clone().multiplyScalar(0.25), 0.5, 0.45);
    }
    lights.surge(colour, 0.55 * scale);
  };

  /**
   * Fire a bolt from a socket, down the direction that socket is actually pointing.
   *
   * The range is solved, not authored: the aim is intersected with the floor, so a hand pointing
   * down puts the impact on the ground where it is pointing, and a hand pointing level or up sends
   * the bolt out to its maximum reach and detonates it in the air. That is what makes the effect
   * follow the animation instead of the animation happening next to the effect.
   */
  const launch = (
    socketId: string,
    colour: THREE.Color,
    halo: THREE.Color,
    radius: number,
    scale: number,
  ): void => {
    const from = sockets.get(socketId).worldPosition();
    // Cap 0.3: a projectile is aimed by where the arm POINTS. Letting the hand's travel direction
    // dominate sent bolts 21 degrees into the sky off a level jab, because a striking hand is still
    // rising as the arm reaches full extension.
    const direction = motion.aim(socketId, undefined, 0.3);

    // Solved against the default framing, not chosen: projecting the firing line shows the last
    // on-screen point at about 2.8 world units along forward, and the muzzle already sits ~0.4 out.
    // 2.4 was fine while the aim still angled downward into the floor; once the cues were fixed and
    // the bolts left level, that same reach put every detonation past the right edge. Measured back
    // down from there: 1.45 landed at ndc.x 0.83, hard against the edge; 1.15 sits near 0.55.
    const maxReach = h * 1.15;
    let range = maxReach;
    // Only a meaningfully downward aim gets a floor solution; near-horizontal would solve to a
    // distance out past the stage and read as a mistake.
    if (direction.y < -0.08) {
      const toFloor = (groundY - from.y) / direction.y;
      if (toFloor > 0) range = Math.min(range, toFloor);
    }
    range = Math.max(h * 0.45, range);

    vfx.bolt({
      from,
      direction,
      // Slow enough to read as a travelling object rather than a hitscan line — at the earlier
      // 6.2 the whole flight was over inside four frames.
      speed: h * 4.2,
      range,
      core: new THREE.Color(0xffffff).lerp(colour, 0.55),
      halo,
      radius: h * radius,
      sparkRate: 190,
      onImpact: (at, dir) => impact(at, dir, halo, scale),
    });

    // Muzzle: a directional flare along the aim, a cone of sparks down it, and a light.
    vfx.flare(from, direction, new THREE.Color(0xffffff).lerp(halo, 0.45),
      h * 0.4 * scale, h * 0.08 * scale, 0.12);
    vfx.burst(from, {
      count: Math.round(46 * scale),
      colour: halo.clone().multiplyScalar(1.5),
      colourEnd: halo.clone().multiplyScalar(0.1),
      direction,
      spread: 0.55,
      speed: [2.0, 6.5],
      life: [0.12, 0.34],
      size: [h * 0.006, h * 0.024],
      gravity: 1.2,
      drag: 3.6,
      inherit: motion.velocity(socketId).multiplyScalar(0.4),
    });
    // A thin ring of blowback perpendicular to the aim — the recoil the muzzle pushes sideways.
    vfx.burst(from, {
      count: Math.round(14 * scale),
      colour: STEEL,
      colourEnd: halo,
      direction: direction.clone().negate(),
      spread: 1.4,
      speed: [0.6, 2.2],
      life: [0.14, 0.3],
      size: [h * 0.004, h * 0.011],
      gravity: 2.0,
      drag: 4.0,
    });
    vfx.flash(from, halo, 26, 0.2, h * 2.6);
    lights.surge(halo, 0.75);
  };

  return [
    {
      id: 'toxic-bolt',
      label: 'Toxic Bolt',
      clip: 'preset:biped:box_03',
      colour: VFX.toxic.hex,
      description: 'one heavy bolt on the scanned strike at 22.6% of box_03 — left hand, aim 0.90 forward and level',
      cast: () => animator.once('preset:biped:box_03', {
        fade: 0.14,
        cues: [
          { at: 0.08, fire: () => charge('effect:cast-secondary', TOXIC, 70) },
          { at: 0.16, fire: () => charge('effect:cast-secondary', SPORE, 50) },
          // 0.226 comes out of cueScan.ts, not out of anyone's judgement: seeking box_03 puts the
          // left hand's only real strike there — aim 0.896 along forward, 0.007 above level (as
          // level as anything in the set), 3.67 units per second.
          { at: 0.226, fire: () => launch('effect:cast-secondary', SPORE, TOXIC, 0.052, 1.15) },
        ],
      }),
    },
    {
      id: 'ember-volley',
      label: 'Ember Volley',
      clip: 'preset:biped:box_02',
      colour: VFX.ember.hex,
      description: 'a one-two-cross on the three scanned strikes of box_02 — right 27.7%, left 28.9%, right 68.6%',
      cast: () => animator.once('preset:biped:box_02', {
        fade: 0.12,
        cues: [
          // Every one of these is a scanned peak, not a guess at where a punch might be. box_02 is
          // a genuine combination and the scan finds all of it:
          //   R 0.277  fwd 0.960  up -0.212  3.03 u/s
          //   L 0.289  fwd 0.976  up -0.017  3.55 u/s   <- twelve thousandths later: a real one-two
          //   R 0.686  fwd 0.989  up  0.191  4.40 u/s   <- the cross, and the fastest hand in the clip
          //
          // The three ESCALATE — 0.55, 0.68, then 1.05 — so the combination builds instead of
          // firing the same pellet three times. The cross is the payoff and is scaled to look it.
          // Recolour the hand wakes for the length of the combination, so the streaks the punches
          // throw belong to this skill rather than to the character's resting palette.
          { at: 0.0, fire: () => tintTrails?.(EMBER, EMBER_DEEP, 2.6) },
          { at: 0.16, fire: () => emberCharge('effect:cast-primary', 30, 0.022) },
          { at: 0.21, fire: () => emberCharge('effect:cast-secondary', 26, 0.02) },
          { at: 0.277, fire: () => emberBolt('effect:cast-primary', 0.028, 0.55) },
          { at: 0.289, fire: () => emberBolt('effect:cast-secondary', 0.031, 0.68) },
          // A long, visible wind-up on the cross: the fist is loaded for a quarter of the clip.
          { at: 0.46, fire: () => emberCharge('effect:cast-primary', 34, 0.022) },
          { at: 0.56, fire: () => emberCharge('effect:cast-primary', 46, 0.028) },
          { at: 0.63, fire: () => emberCharge('effect:cast-primary', 60, 0.034) },
          { at: 0.686, fire: () => emberBolt('effect:cast-primary', 0.046, 1.05) },
        ],
      }),
    },
    {
      id: 'spore-nova',
      label: 'Spore Nova',
      clip: 'preset:biped:dance_05',
      colour: VFX.spore.hex,
      description: 'eight bolts fanned around the measured up axis, plus a column from effect:crown',
      cast: () => animator.once('preset:biped:dance_05', {
        fade: 0.2,
        cues: [
          {
            at: 0.18,
            fire: () => {
              charge('effect:core', VENOM, 90);
              const crown = sockets.get('effect:crown').worldPosition();
              vfx.burst(crown, {
                count: 90,
                colour: SPORE,
                colourEnd: VENOM,
                direction: frame.up.clone(),
                spread: 0.32,
                speed: [1.5, 4.5],
                life: [0.7, 1.5],
                size: [h * 0.01, h * 0.03],
                gravity: -0.9,
                drag: 1.1,
                swirl: 3.5,
                jitter: h * 0.04,
              });
            },
          },
          {
            at: 0.42,
            fire: () => {
              const core = sockets.get('effect:core').worldPosition();
              const ground = core.clone();
              ground.y = groundY + 0.002;
              vfx.shockwave(ground, h * 1.9, TOXIC, 0.85, 0.11);
              vfx.shockwave(ground, h * 1.1, SPORE, 0.6, 0.08);
              // 70 at five figure-heights of reach blew the entire frame to white once the eight
              // bolt lights and their eight impact flashes landed on top of it.
              vfx.flash(core, TOXIC, 13, 0.34, h * 2.2);
              lights.surge(TOXIC, 0.55);
              // A flare up the body's own up axis, so the nova reads as erupting out of the figure.
              vfx.flare(core, frame.up, SPORE, h * 0.8, h * 0.2, 0.28);
              // Eight bolts fanned about the MEASURED up axis, so the ring is level with the
              // figure's own stance rather than with world +Y. Tilted slightly down so they land.
              for (let i = 0; i < 8; i += 1) {
                const direction = forwardNow()
                  .applyAxisAngle(frame.up, (i / 8) * Math.PI * 2)
                  .addScaledVector(frame.up, -0.28)
                  .normalize();
                vfx.bolt({
                  from: core.clone(),
                  direction,
                  speed: h * 3.4,
                  range: h * 1.7,
                  core: new THREE.Color(0xffffff).lerp(SPORE, 0.5),
                  halo: TOXIC,
                  radius: h * 0.022,
                  sparkRate: 110,
                  lightScale: 0.2,
                  onImpact: (at, dir) => impact(at, dir, TOXIC, 0.34),
                });
              }
            },
          },
        ],
      }),
    },
  ];
}

/**
 * Ambient emission — what Roblin does when nobody is casting.
 *
 * Rate-based rather than per-frame, so the look does not change with the frame rate. Anchored to
 * `effect:core` and the two shoulder sockets; all three are real bones.
 */
export function createAmbientAura(ctx: Pick<SkillContext, 'frame' | 'sockets' | 'vfx'>) {
  const { frame, sockets, vfx } = ctx;
  const h = frame.figureHeight;
  let debt = 0;
  const shoulders = ['effect:shoulder-l', 'effect:shoulder-r'];
  let flip = 0;

  return {
    /** `intensity` scales the rate; a cast can push it up briefly. */
    update(delta: number, intensity = 1): void {
      debt += delta * 26 * intensity;
      const count = Math.floor(debt);
      if (count <= 0) return;
      debt -= count;

      vfx.burst(sockets.get('effect:core').worldPosition(), {
        count,
        colour: new THREE.Color(VFX.toxic.value).multiplyScalar(0.7),
        colourEnd: new THREE.Color(VFX.venom.value).multiplyScalar(0.2),
        direction: frame.up.clone(),
        spread: 1.1,
        speed: [0.08, 0.42],
        life: [0.9, 2.1],
        size: [h * 0.005, h * 0.016],
        // Negative gravity: spores drift UP off a body that is warmer than the air around it.
        gravity: -0.22,
        drag: 0.5,
        swirl: 0.9,
        jitter: h * 0.09,
      });

      flip = (flip + 1) % 2;
      vfx.burst(sockets.get(shoulders[flip]).worldPosition(), {
        count: Math.max(1, Math.floor(count * 0.4)),
        colour: new THREE.Color(VFX.spore.value).multiplyScalar(0.55),
        colourEnd: new THREE.Color(VFX.toxic.value).multiplyScalar(0.08),
        direction: frame.up.clone(),
        spread: 0.9,
        speed: [0.1, 0.5],
        life: [0.7, 1.6],
        size: [h * 0.004, h * 0.012],
        gravity: -0.3,
        drag: 0.7,
        jitter: h * 0.04,
      });
    },
  };
}

/**
 * Dust and a ring for one measured footfall.
 *
 * The spray is aimed, not symmetric. A planting foot is still sliding — backwards under a runner,
 * forwards into a stamp — and the dust it throws goes the other way, fanned around the reversed
 * travel direction and tilted up off the floor. The foot's own pointing axis sets which way the
 * fan leans, so a foot landing side-on throws its dust sideways. A symmetric puff, which is what
 * this was first, reads as a decal switching on under the ankle.
 *
 * Colour is the ground bounce, not the magic: displaced floor should not compete with the casts.
 */
export function footstepEffect(
  vfx: VfxSystem,
  at: THREE.Vector3,
  impactSpeed: number,
  figureHeight: number,
  up: THREE.Vector3,
  groundY: number,
  clearance = 0,
  /** Velocity the dust inherits — the floor's under a runner, plus the foot's own slide. */
  inherit?: THREE.Vector3,
  /** The foot's world velocity at contact. Sets which way the spray fans. */
  footVelocity?: THREE.Vector3,
  /** The foot's pointing axis (ankle through toe). Tilts the fan. */
  footAxis?: THREE.Vector3,
): void {
  // Scaled by the MEASURED descent speed, so a heavy landing is visibly heavier than a shuffle.
  // Then faded by how far above the floor the toe actually planted: the stair-climb clip lands one
  // foot a fifth of a figure-height up, and that foot should not throw the same dust as one that
  // hit the floor.
  const contact = THREE.MathUtils.clamp(1 - clearance / 0.28, 0.15, 1);
  const strength = THREE.MathUtils.clamp(impactSpeed / (figureHeight * 1.2), 0.25, 1.8) * contact;
  const ground = at.clone();
  ground.y = groundY + 0.002;

  // Away from where the foot came from, lifted off the floor. Falls back to straight up when the
  // foot planted with no measurable horizontal travel.
  const spray = new THREE.Vector3();
  if (footVelocity && footVelocity.lengthSq() > 1e-6) {
    spray.copy(footVelocity).setY(0).negate();
    if (footAxis) spray.addScaledVector(footAxis, figureHeight * 0.35);
    spray.normalize().addScaledVector(up, 0.55).normalize();
  } else {
    spray.copy(up);
  }

  // Dust first, in the leather colours: it is displaced ground, not magic, so it must not compete
  // with the casts for the toxic hue.
  vfx.burst(ground, {
    count: Math.round(40 * strength),
    colour: new THREE.Color(VFX.ember.value).multiplyScalar(0.55),
    colourEnd: new THREE.Color(VFX.bounce.value),
    direction: spray,
    spread: 0.95,
    speed: [0.35 * strength, 1.9 * strength],
    life: [0.35, 0.9],
    size: [figureHeight * 0.016, figureHeight * 0.055],
    gravity: 0.55,
    drag: 2.6,
    jitter: figureHeight * 0.025,
    inherit,
  });
  // Then a few bright sparks in the character's own hue, so a footfall still belongs to Roblin.
  vfx.burst(ground, {
    count: Math.round(18 * strength),
    colour: new THREE.Color(VFX.spore.value),
    colourEnd: new THREE.Color(VFX.venom.value),
    direction: spray,
    spread: 0.6,
    speed: [0.7 * strength, 3.0 * strength],
    life: [0.25, 0.6],
    size: [figureHeight * 0.007, figureHeight * 0.022],
    gravity: 2.2,
    drag: 1.8,
    inherit,
  });
  vfx.shockwave(ground, figureHeight * 0.34 * strength, new THREE.Color(VFX.toxic.value), 0.4, 0.28);
  vfx.flash(ground, new THREE.Color(VFX.toxic.value), 8 * strength, 0.2, figureHeight * 1.4);
}
