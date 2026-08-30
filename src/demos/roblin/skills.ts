import * as THREE from 'three';
import { VFX } from './palette';
import type { Animator } from './animator';
import type { RigFrame } from './rigFrame';
import type { SocketRig } from './sockets';
import type { VfxSystem } from './vfx/vfxSystem';
import type { LightRig } from './lighting';

/**
 * Roblin's three ranged skills.
 *
 * Each one is a REAL clip driving a real skeleton, with effects released by cues read off the
 * mixer's own clock, fired from a real socket on a real bone, aimed down the MEASURED forward
 * axis. There is no hand-placed muzzle position anywhere in this file.
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
  frame: RigFrame;
  sockets: SocketRig;
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

export function createSkills(ctx: SkillContext): Skill[] {
  const { frame, sockets, animator, vfx, lights, groundY, root } = ctx;
  const h = frame.figureHeight;
  const orientation = new THREE.Quaternion();

  /** The bind-time forward axis carried into the figure's current orientation. */
  const forwardNow = (): THREE.Vector3 =>
    frame.forward.clone().applyQuaternion(root.getWorldQuaternion(orientation)).normalize();

  /** Charge glow that gathers at a socket before release. */
  const charge = (socketId: string, colour: THREE.Color, count: number): void => {
    const at = sockets.get(socketId).worldPosition();
    vfx.burst(at, {
      count,
      colour: colour.clone().multiplyScalar(1.4),
      colourEnd: colour,
      // Inward speeds: negative radius is not a thing, so the swirl does the gathering instead.
      speed: [0.1, 0.5],
      life: [0.22, 0.5],
      size: [h * 0.012, h * 0.03],
      spread: Math.PI,
      gravity: -0.35,
      drag: 3.4,
      swirl: 5.5,
      jitter: h * 0.05,
    });
    vfx.flash(at, colour, 3.2, 0.3, h * 1.6);
  };

  /** What every bolt does when it arrives. Shared so all three impacts read as the same world. */
  const impact = (at: THREE.Vector3, direction: THREE.Vector3, colour: THREE.Color, scale: number): void => {
    vfx.burst(at, {
      count: Math.round(170 * scale),
      colour: colour.clone().multiplyScalar(1.7),
      colourEnd: colour.clone().multiplyScalar(0.08),
      speed: [1.4 * scale, 4.2 * scale],
      // Short-lived and heavy. The first version lived up to 0.8s under low gravity and high drag,
      // which left the debris hanging in the air as sparse dots — fireflies, not a splash.
      life: [0.22, 0.5],
      size: [h * 0.016, h * 0.055],
      // A hemisphere opening upward: a floor hit throws its splash up, not into the floor.
      direction: frame.up.clone(),
      spread: Math.PI * 0.45,
      gravity: 5.5,
      drag: 1.5,
      jitter: h * 0.03,
    });
    // A thin fan of steel-white sparks along the travel direction — the reflected shrapnel.
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
    // `at` is already on the floor for the aimed skills; the nudge keeps the ring off the stage
    // surface so the two do not z-fight.
    const onGround = at.clone();
    onGround.y = groundY + 0.004;
    // Two rings, not one: a tight fast one for the hit and a wider slow one for the aftermath. A
    // single ring at the old 0.95 x height was so wide it ran off the bottom of the frame.
    vfx.shockwave(onGround, h * 0.3 * scale, new THREE.Color(0xffffff).lerp(colour, 0.6), 0.26, 0.32);
    vfx.shockwave(onGround, h * 0.62 * scale, colour, 0.55, 0.2);
    lights.surge(colour, 0.55 * scale);
  };

  const launch = (
    socketId: string,
    colour: THREE.Color,
    halo: THREE.Color,
    radius: number,
    scale: number,
  ): void => {
    const from = sockets.get(socketId).worldPosition();
    const forward = forwardNow();

    // Aim at a point ON THE FLOOR rather than straight down the forward axis. A level shot
    // detonates in mid-air and throws its ground ring somewhere else entirely, so the burst, the
    // ring and the flash all read as three unrelated events. Landing the bolt on the floor puts
    // them in one place and lets the impact light the ground, which is the whole point of giving
    // the impact a real light.
    const aim = sockets.get('effect:core').worldPosition();
    aim.y = groundY;
    // Measured, not solved on paper: the flight was sampled frame by frame through the debug
    // handle and projected to normalised device coordinates. At 1.85 the detonation landed at
    // ndc.x 1.11, off the right edge; a floor hit at 1.5 sat at ndc.y -0.73, close enough to the
    // bottom edge that the ring ran off it. 1.25 keeps the whole impact inside the frame.
    aim.addScaledVector(forward, h * 1.15);
    const direction = aim.clone().sub(from).normalize();

    vfx.bolt({
      from,
      direction,
      // Slow enough to read as a travelling object rather than a hitscan line — at the earlier
      // 6.2 the whole flight was over inside four frames.
      speed: h * 4.2,
      range: aim.distanceTo(from),
      core: new THREE.Color(0xffffff).lerp(colour, 0.55),
      halo,
      radius: h * radius,
      sparkRate: 190,
      onImpact: (at, dir) => impact(at, dir, halo, scale),
    });
    vfx.burst(from, {
      count: 40,
      colour: halo.clone().multiplyScalar(1.5),
      colourEnd: halo.clone().multiplyScalar(0.1),
      direction,
      spread: 0.9,
      speed: [1.5, 5],
      life: [0.16, 0.4],
      size: [h * 0.008, h * 0.028],
      gravity: 1.2,
      drag: 3,
    });
    vfx.flash(from, halo, 26, 0.2, h * 2.6);
    lights.surge(halo, 0.75);
  };

  return [
    {
      id: 'toxic-bolt',
      label: 'Toxic Bolt',
      clip: 'preset:biped:fire',
      colour: VFX.toxic.hex,
      description: 'single heavy bolt from effect:cast-primary (R_Hand), released at 40% of the fire clip',
      cast: () => animator.once('preset:biped:fire', {
        fade: 0.14,
        cues: [
          { at: 0.10, fire: () => charge('effect:cast-primary', TOXIC, 70) },
          { at: 0.26, fire: () => charge('effect:cast-primary', SPORE, 50) },
          { at: 0.40, fire: () => launch('effect:cast-primary', SPORE, TOXIC, 0.052, 1.15) },
        ],
      }),
    },
    {
      id: 'ember-volley',
      label: 'Ember Volley',
      clip: 'preset:biped:box_02',
      colour: VFX.ember.hex,
      description: 'three lighter bolts alternating between both hand sockets, on the boxing clip',
      cast: () => animator.once('preset:biped:box_02', {
        fade: 0.12,
        timeScale: 1.15,
        cues: [
          { at: 0.14, fire: () => charge('effect:cast-primary', EMBER, 34) },
          { at: 0.22, fire: () => launch('effect:cast-primary', EMBER, EMBER, 0.03, 0.6) },
          { at: 0.40, fire: () => charge('effect:cast-secondary', EMBER, 34) },
          { at: 0.48, fire: () => launch('effect:cast-secondary', EMBER, EMBER_DEEP, 0.03, 0.6) },
          { at: 0.66, fire: () => charge('effect:cast-primary', EMBER, 44) },
          { at: 0.74, fire: () => launch('effect:cast-primary', EMBER, EMBER, 0.036, 0.8) },
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
              // Eight bolts fanned about the MEASURED up axis, so the ring is level with the
              // figure's own stance rather than with world +Y.
              for (let i = 0; i < 8; i += 1) {
                const direction = forwardNow()
                  .applyAxisAngle(frame.up, (i / 8) * Math.PI * 2);
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

/** Dust and a ring for one measured footfall. Colour is the ground bounce, not the magic. */
export function footstepEffect(
  vfx: VfxSystem,
  at: THREE.Vector3,
  impactSpeed: number,
  figureHeight: number,
  up: THREE.Vector3,
  groundY: number,
  clearance = 0,
  /** Velocity the dust inherits — the floor's, so a puff drifts backwards under a runner. */
  inherit?: THREE.Vector3,
): void {
  // Scaled by the MEASURED descent speed, so a heavy landing is visibly heavier than a shuffle.
  // Then faded by how far above the floor the toe actually planted: the stair-climb clip lands one
  // foot a fifth of a figure-height up, and that foot should not throw the same dust as one that
  // hit the floor.
  const contact = THREE.MathUtils.clamp(1 - clearance / 0.28, 0.15, 1);
  const strength = THREE.MathUtils.clamp(impactSpeed / (figureHeight * 1.2), 0.25, 1.8) * contact;
  const ground = at.clone();
  ground.y = groundY + 0.002;

  // Dust first, in the leather colours: it is displaced ground, not magic, so it must not compete
  // with the casts for the toxic hue. The first pass used `ember-deep` at 22 particles and it was
  // invisible under a running figure — dark particles on a dark floor.
  vfx.burst(ground, {
    count: Math.round(40 * strength),
    colour: new THREE.Color(VFX.ember.value).multiplyScalar(0.55),
    colourEnd: new THREE.Color(VFX.bounce.value),
    direction: up.clone(),
    spread: 1.35,
    speed: [0.35 * strength, 1.8 * strength],
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
    direction: up.clone(),
    spread: 0.8,
    speed: [0.7 * strength, 2.8 * strength],
    life: [0.25, 0.6],
    size: [figureHeight * 0.007, figureHeight * 0.022],
    gravity: 2.2,
    drag: 1.8,
    inherit,
  });
  vfx.shockwave(ground, figureHeight * 0.34 * strength, new THREE.Color(VFX.toxic.value), 0.4, 0.28);
  vfx.flash(ground, new THREE.Color(VFX.toxic.value), 8 * strength, 0.2, figureHeight * 1.4);
}
