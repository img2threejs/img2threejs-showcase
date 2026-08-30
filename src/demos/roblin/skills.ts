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
 * WHAT ROBLIN IS, because the first two versions of this file ignored it. He is a barefoot goblin
 * skirmisher in rotting leather with crude steel strapped to his shins. He is not a wizard. The
 * effects started as polished spheres and then as FIRE, and neither belongs to him: there is no
 * fire anywhere in his design, and the `ember` hue that carried the volley was measured off his
 * LEATHER — it is a dirt colour, not a flame colour. So the vocabulary is now his own:
 *
 *   BILE     corrosive, thrown in lumps, leaves puddles that bubble and eat the floor
 *   SCRAP    scavenged metal and grit, flung by the handful, strikes sparks and raises dust
 *   SPORES   a fungal bloom off a body that has been in a swamp
 *
 * Colour discipline is unchanged and still measured: `toxic`/`venom`/`spore` are his skin hue,
 * `ember`/`ember-deep` his leather, `steel` the hardware. What changed is what those colours are
 * asked to represent.
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
const STEEL = new THREE.Color(VFX.steel.value);
// Dust and ash, the cooled end of the leather hue. Used by the scrap volley and the footfalls,
// which are the two things in this showcase that are literally dirt.
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
   * The wind-up: a fist tightening, seen as the air being dragged with it.
   *
   * No gathering charge — a boxer does not power up, he loads. What is drawn is the disturbance the
   * knuckles pull along: a few fine streaks trailing the fist, carrying most of its own velocity so
   * they sit in its wake rather than flying off it.
   */
  const knuckleDrag = (socketId: string, count: number): void => {
    const at = sockets.get(socketId).worldPosition();
    const velocity = motion.velocity(socketId);
    if (velocity.lengthSq() < 1e-4) return;
    vfx.burst(at, {
      count,
      colour: STEEL.clone().multiplyScalar(0.5),
      colourEnd: EMBER_ASH.clone().multiplyScalar(0.5),
      direction: velocity.clone().normalize().negate(),
      spread: 0.7,
      speed: [0.3, 1.4],
      life: [0.1, 0.28],
      size: [h * 0.004, h * 0.011],
      gravity: 1.4,
      drag: 4.5,
      jitter: h * 0.03,
      inherit: velocity.clone().multiplyScalar(0.75),
      shape: 'streak',
      stretch: 0.2,
    });
  };

  /**
   * A landed punch.
   *
   * `box_02` is a boxing combination and this is the only skill on it, so the effect belongs AT the
   * fist, at the moment it connects — not flying away from it. The previous versions threw things:
   * first fire, then scavenged metal, and both fought the animation, because a clip that punches
   * and an effect that departs are telling two different stories.
   *
   * What a connecting punch reads as, in order of how fast each part happens:
   *
   *   1. a hard white flash on the frame of contact, and a point light so the figure is lit by it
   *   2. a FRACTURE racing outward from the point struck — the signature that says something took
   *      the force rather than absorbed it quietly
   *   3. a flat ring of air punched outward in the plane of the blow
   *   4. debris thrown back along the punch, as streaks
   *   5. dust, arriving last and lingering after everything bright has gone
   *
   * Nothing here glows warm. Fire was never Roblin's, and a punch is not hot — it is force, so the
   * palette is the steel of his own bracers with the leather hue only in the dust.
   */
  const punchImpact = (at: THREE.Vector3, direction: THREE.Vector3, scale: number): void => {
    const hot = new THREE.Color(0xffffff).lerp(STEEL, 0.35);

    // 1. Contact.
    // Sized to the EVENT, not to the figure. A punch connects over roughly a fist, so these radii
    // are fractions of a forearm — the first pass used figure-height fractions and produced a ring
    // wider than the character with a two-unit fracture behind it.
    vfx.flash(at, STEEL, 34 * scale * scale, 0.12, h * (1.4 + 0.9 * scale));
    vfx.flare(at, direction, hot, h * 0.16 * scale, h * 0.1 * scale, 0.07);

    // 2. The fracture. Bigger and longer-lived as the combination escalates, so the cross visibly
    // breaks more than the jab did.
    vfx.crack(at, h * (0.09 + 0.14 * scale), STEEL, hot, 0.3 + 0.25 * scale);

    // 3. The ring of displaced air, in the plane the punch travelled through.
    vfx.shockwave(at, h * 0.11 * scale, hot, 0.16, 0.34, direction);
    vfx.shockwave(at, h * 0.2 * scale, STEEL.clone().multiplyScalar(0.55), 0.3, 0.2, direction);

    // 4. Debris, thrown back the way the fist came. Streaks, because at this speed they are lines.
    vfx.burst(at, {
      count: Math.round(70 * scale),
      colour: hot,
      colourEnd: EMBER_ASH,
      direction: direction.clone().negate(),
      spread: 1.0,
      speed: [3, 8],
      life: [0.1, 0.28],
      size: [h * 0.004, h * 0.01],
      gravity: 10,
      drag: 0.9,
      shape: 'streak',
      stretch: 0.28,
    });
    // A tight forward spray as well: some of what is struck goes on through.
    vfx.burst(at, {
      count: Math.round(22 * scale),
      colour: STEEL,
      colourEnd: EMBER_ASH,
      direction,
      spread: 0.4,
      speed: [3, 8],
      life: [0.1, 0.26],
      size: [h * 0.004, h * 0.01],
      gravity: 9,
      drag: 1.2,
      shape: 'streak',
      stretch: 0.24,
    });

    // 5. Dust, alpha-blended so it has weight, and slow enough to outlive the flash.
    vfx.burst(at, {
      // Sparse: this connects in the AIR, not on the floor, so there is little to raise. At a
      // dozen puffs it veiled the character it was supposed to be hitting in front of.
      count: Math.round(6 * scale),
      colour: EMBER.clone().lerp(new THREE.Color(0xffffff), 0.16).multiplyScalar(0.6),
      colourEnd: EMBER_ASH.clone().multiplyScalar(0.45),
      direction: direction.clone().negate(),
      spread: Math.PI * 0.55,
      speed: [0.5 * scale, 2.4 * scale],
      life: [0.5, 1.4],
      size: [h * 0.06, h * 0.24],
      gravity: 0.6,
      drag: 2.6,
      swirl: 0.9,
      jitter: h * 0.05,
      shape: 'smoke',
      spin: 1.2,
      layer: 'matter',
      opacity: 0.12,
    });

    lights.surge(STEEL, 0.5 * scale);
  };

  /**
   * Land one punch: find where the fist connects and put the impact there.
   *
   * The contact point is the knuckles plus a short reach down the hand's own aim — a punch connects
   * essentially AT the fist, so this is a fraction of the forearm, not a projectile range.
   */
  const punch = (socketId: string, scale: number): void => {
    const from = sockets.get(socketId).worldPosition();
    const direction = motion.aim(socketId, undefined, 0.3);
    const at = from.clone().addScaledVector(direction, frame.forearmLength * 0.45);
    punchImpact(at, direction, scale);
  };

  /**
   * A bile hit: splatter, not detonation.
   *
   * The difference from a blast is where the energy goes. A blast throws everything outward fast
   * and is over; a thrown liquid arrives, bursts FORWARD along its own travel, throws heavy gobs
   * that fall, and then sits there corroding. So the cone opens down the direction of travel
   * rather than backward, gravity is high enough that the gobs visibly arc, and the pool is the
   * point of the whole thing rather than a decoration after it.
   */
  const bileImpact = (at: THREE.Vector3, direction: THREE.Vector3, scale: number): void => {
    const height = Math.max(0, at.y - groundY);
    const grounded = THREE.MathUtils.clamp(1 - height / (h * 0.5), 0, 1);
    const onGround = at.clone();
    onGround.y = groundY + 0.004;

    // A short wet flash, not a fireball: bile is not a light source, it is briefly lit BY the
    // reaction. Kept dim on purpose so the puddle is what the eye ends on.
    vfx.flare(at, direction, SPORE, h * 0.3 * scale, h * 0.26 * scale, 0.1);
    vfx.flash(at, VENOM, 34 * scale * scale, 0.26, h * (2.6 + 1.4 * scale));

    // The splatter: forward, wet, heavy.
    vfx.burst(at, {
      count: Math.round(90 * scale),
      colour: SPORE,
      colourEnd: VENOM,
      direction: direction.clone(),
      spread: Math.PI * 0.55,
      speed: [1.2 * scale, 4.4 * scale],
      life: [0.3, 0.7],
      size: [h * 0.016, h * 0.06],
      gravity: 8.5,
      drag: 1.1,
      jitter: h * 0.02,
      // Wet gobs stretch as they are flung and round off as they slow, which is what the stretch
      // term does for free: it scales with the particle's own speed.
      shape: 'streak',
      stretch: 0.16,
    });
    // Mist that HANGS. Alpha-blended so it reads as vapour occupying space rather than as a glow.
    vfx.burst(at, {
      count: Math.round(18 * scale),
      colour: TOXIC.clone().multiplyScalar(0.55),
      colourEnd: VENOM.clone().multiplyScalar(0.45),
      spread: Math.PI,
      speed: [0.25 * scale, 1.2 * scale],
      life: [1.0, 2.4],
      size: [h * 0.1, h * 0.44],
      gravity: -0.3,
      drag: 1.9,
      swirl: 1.1,
      jitter: h * 0.07,
      shape: 'smoke',
      spin: 0.9,
      layer: 'matter',
      opacity: 0.17,
    });

    // The puddle. Laid under an airburst too — what bursts in the air still rains down.
    vfx.pool(onGround, h * (0.22 + 0.3 * scale), TOXIC, VENOM, 2.4 + 1.2 * scale);
    if (grounded > 0.05) {
      vfx.shockwave(onGround, h * 0.5 * scale * grounded, SPORE, 0.45, 0.3);
    }
    lights.surge(TOXIC, 0.5 * scale);
  };

  /** Lob one glob of bile from a socket, down that hand's own aim. */
  const bileLob = (socketId: string, radius: number, scale: number): void => {
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
      // Slower than a bolt. A thrown lump of liquid is a heavy, readable object, and the wobble and
      // the dripping only register if there is time to see them.
      speed: h * 3.4,
      range,
      style: 'gel',
      core: SPORE,
      deep: VENOM,
      halo: TOXIC,
      radius: h * radius,
      sparkRate: 90,
      trailHead: TOXIC,
      trailTail: VENOM,
      sparkEnd: VENOM,
      // Positive: bile DRIPS off the glob and falls, where a fire trail's embers rise.
      sparkGravity: 5.5,
      sparkSize: 1.5,
      onImpact: (at, dir) => bileImpact(at, dir, scale),
    });

    // The throw: a wet spray off the hand, no muzzle flash. Nothing about a lobbed glob is a gun.
    vfx.burst(from, {
      count: Math.round(30 * scale),
      colour: SPORE,
      colourEnd: VENOM,
      direction,
      spread: 0.8,
      speed: [0.8, 3.0],
      life: [0.2, 0.5],
      size: [h * 0.006, h * 0.022],
      gravity: 5.0,
      drag: 2.4,
      inherit: motion.velocity(socketId).multiplyScalar(0.55),
    });
    vfx.flash(from, TOXIC, 14, 0.22, h * 2.0);
    lights.surge(TOXIC, 0.5);
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

  return [
    {
      id: 'toxic-bolt',
      label: 'Bile Lob',
      clip: 'preset:biped:box_03',
      colour: VFX.toxic.hex,
      description: 'one heavy glob of bile on the scanned strike at 22.6% of box_03 — left hand, aim 0.90 forward and level',
      cast: () => animator.once('preset:biped:box_03', {
        fade: 0.14,
        cues: [
          { at: 0.08, fire: () => charge('effect:cast-secondary', TOXIC, 70) },
          { at: 0.16, fire: () => charge('effect:cast-secondary', SPORE, 50) },
          // 0.226 comes out of cueScan.ts, not out of anyone's judgement: seeking box_03 puts the
          // left hand's only real strike there — aim 0.896 along forward, 0.007 above level (as
          // level as anything in the set), 3.67 units per second.
          { at: 0.226, fire: () => bileLob('effect:cast-secondary', 0.062, 1.15) },
        ],
      }),
    },
    {
      id: 'ember-volley',
      label: 'Shatter Combo',
      clip: 'preset:biped:box_02',
      colour: VFX.steel.hex,
      description: 'a one-two-cross on the three scanned strikes of box_02 — each punch cracks where it lands',
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
          // Steel, not ember: this skill is force, and the fire palette never belonged to it.
          { at: 0.0, fire: () => tintTrails?.(STEEL, EMBER_ASH, 2.6) },
          { at: 0.20, fire: () => knuckleDrag('effect:cast-primary', 10) },
          { at: 0.24, fire: () => knuckleDrag('effect:cast-secondary', 10) },
          { at: 0.277, fire: () => punch('effect:cast-primary', 0.62) },
          { at: 0.289, fire: () => punch('effect:cast-secondary', 0.74) },
          // The cross is loaded for longer and lands hardest — a bigger fracture, held longer.
          { at: 0.56, fire: () => knuckleDrag('effect:cast-primary', 12) },
          { at: 0.63, fire: () => knuckleDrag('effect:cast-primary', 16) },
          { at: 0.686, fire: () => punch('effect:cast-primary', 1.15) },
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
 *
 * Toned right down from what it was. The idle used to push a steady column of bright motes UPWARD
 * off the chest and shoulders, which read as a character ascending — a halo on a goblin who has
 * been sleeping in a swamp. What is left is a thin seep of spores off the body; the swarm of gnats
 * around him (vfx/swarm.ts) now carries the ambient character instead.
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
      debt += delta * 11 * intensity;
      const count = Math.floor(debt);
      if (count <= 0) return;
      debt -= count;

      vfx.burst(sockets.get('effect:core').worldPosition(), {
        count,
        colour: new THREE.Color(VFX.venom.value).multiplyScalar(0.9),
        colourEnd: new THREE.Color(VFX.venom.value).multiplyScalar(0.1),
        direction: frame.up.clone(),
        spread: 1.1,
        speed: [0.06, 0.3],
        life: [0.9, 2.1],
        size: [h * 0.004, h * 0.011],
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
    count: Math.round(11 * strength),
    colour: new THREE.Color(VFX.ember.value).lerp(new THREE.Color(0xffffff), 0.14).multiplyScalar(0.5),
    colourEnd: new THREE.Color(VFX.bounce.value).multiplyScalar(0.5),
    direction: spray,
    spread: 0.95,
    speed: [0.35 * strength, 1.9 * strength],
    life: [0.5, 1.2],
    size: [figureHeight * 0.1, figureHeight * 0.38],
    gravity: 0.35,
    drag: 2.6,
    jitter: figureHeight * 0.03,
    inherit,
    shape: 'smoke',
    spin: 1.1,
    layer: 'matter',
    opacity: 0.18,
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
    size: [figureHeight * 0.009, figureHeight * 0.026],
    gravity: 2.2,
    drag: 1.8,
    inherit,
    shape: 'streak',
    stretch: 0.18,
  });
  // NO glowing ring. Roblin is barefoot and this is a bare foot hitting dirt — the ring was a
  // magic-impact signature borrowed from the casts, and it made every step look like a spell. What
  // is left is a low dull ring of displaced dust and a very soft bounce of light off the floor.
  vfx.shockwave(ground, figureHeight * 0.26 * strength, new THREE.Color(VFX.emberDeep.value), 0.5, 0.42);
  vfx.flash(ground, new THREE.Color(VFX.emberDeep.value), 3.5 * strength, 0.22, figureHeight * 1.1);
}
