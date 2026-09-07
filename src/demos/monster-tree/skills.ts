import * as THREE from 'three';
import { EchoChorus, ECHO_RIM, type EchoChorusOptions } from './echoes';
import {
  BEATS, blendPose, clearPose, embracePose, fallingTreePose, type Key, lifeSeedPose, passivePose,
  recoilPose, sporePose, vinePose,
} from './poses';
import { beats, clipEvents, HANDS, loudestArrest } from './events';
import { PALETTE } from './measured';
import type { MonsterTreeRig } from './rig';
import type { MonsterTreeVfx } from './vfx';

/**
 * Attack skills: a shipped clip, plus effects cued to the frame that clip actually peaks on.
 *
 * NAMED BY MEASUREMENT, NOT BY PRESET NAME. The rig ships 16 clips called things like
 * `preset:biped:box_01` and `preset:biped:fire`; those names came from Tripo's retarget library and
 * nobody has confirmed what they look like. So each skill's name, its lead limb and its impact time
 * were taken from `tools/measure-rig.mjs`, which walks every clip at 40 poses and records how far
 * each tracked bone travels from rest and when it peaks:
 *
 *     clip             dur    lead limb        peak     note
 *     box_01           1.80   L_Hand  1.321    0.54s    left lead, right foot nearly still
 *     box_02           2.27   R_Hand  1.168    1.87s    both hands over 1.0 — a two-hand exchange
 *     box_03           2.07   L_Hand  1.099    0.62s    left again, with the body behind it
 *     front_kick_01    2.03   R_ToeBase 2.323  1.02s    the largest single excursion in the set
 *     front_kick_02    1.13   R_ToeBase 1.820  0.68s    faster, lower
 *     fire             1.23   L_Hand  0.771    1.23s    head 0.035, spine 0.040 — the body barely
 *                                                       moves, so this is a planted cast, not a swing
 *     defeat_03        4.47   L_Hand  1.838    2.68s    head travels 1.408 — going down
 *     idle             15.38  L_Hand  0.811    —        long enough not to read as a loop
 *
 * `fire` is the interesting one: its name suggests a projectile, and the kinematics agree for a
 * different reason — the torso is effectively static while an arm extends, which is what a planted
 * cast looks like and what a running attack does not. That is inference from measurement, and it is
 * still inference: nobody has confirmed the pose visually.
 *
 * Everything an effect attaches to is a socket on a real bone. Nothing is placed by coordinate.
 */

export interface SkillCue {
  /** Seconds into the clip. */
  at: number;
  run(rig: MonsterTreeRig, vfx: MonsterTreeVfx): void;
}

export interface Skill {
  id: string;
  label: string;
  /** The shipped clip this skill drives. A real clip name from the rig. */
  clip: string;
  /** Cross-fade seconds into this clip. Short for a strike, long for a settle. */
  fade: number;
  /** What the measurement says this clip does. Shown in the showcase. */
  measured: string;
  /** Whether the clip should hold at the end or keep looping. */
  loop: boolean;
  cues: SkillCue[];
  /** Sockets whose trail runs for the duration of the swing. */
  trails?: Array<'grip-l' | 'grip-r'>;
  /** The colour every impact effect this skill spawns is tinted with. */
  accent?: THREE.Color;
  /**
   * Driven every frame while this skill plays, with the clip's own playhead.
   *
   * Cues fire once at an instant; this runs continuously, which is what a limb growing needs — the
   * stretch has to be re-applied on every frame because the mixer rewrites bone scale each update.
   */
  drive?: (rig: MonsterTreeRig, vfx: MonsterTreeVfx, time: number, duration: number) => void;
  /**
   * The authored gesture, if this skill has one.
   *
   * Declared rather than driven inside `drive`, so the RUNNER owns it — which is what lets one move
   * cross-fade into the next. A skill that posed itself could only ever snap.
   */
  pose?: (time: number) => Key[];
  /** Copies of the figure this skill puts on stage. See `echoes.ts`. */
  chorus?: EchoChorusOptions & {
    /** Clip time the copies appear on. */
    at: number;
    /** Clip time they converge back in on. */
    until: number;
  };
}

/**
 * A continuous 0..1 build that finishes exactly ON a measured beat.
 *
 * This is what replaced the step cues — `charge = 0.5` at one time and `charge = 1` at another.
 * Those put two hard jumps inside what the viewer is being told is one gathering, and a gathering
 * that arrives in two visible steps does not read as tension, it reads as the effects being
 * switched on. The curve is eased at both ends so it leaves nothing and arrives at full without a
 * corner at either.
 */
function buildTo(time: number, beat: number, lead: number): number {
  if (time >= beat) return 0;
  const t = (time - (beat - lead)) / lead;
  if (t <= 0) return 0;
  return t * t * (3 - 2 * t);
}

/**
 * A hit: the instant effects, plus the damage it leaves behind.
 *
 * The burst and the shockwave are gone inside a second — they are the moment of contact. The
 * cracks and the toxin run for ten, which is what makes an exchange accumulate: by the third blow
 * of a combo the ground under the figure is fractured and contaminated, and it stays that way long
 * enough to still be there when the next move starts. Without the long tail every attack resets
 * the stage to clean ground and nothing the character does appears to cost anything.
 *
 * The lingering pair is centred on the ground UNDER the socket, not at the socket itself. A fist
 * connects in mid-air, but what a treant that size breaks is the floor beneath it.
 */
const impact = (socket: string, options?: { radius?: number; count?: number; speed?: number; toxin?: number }) =>
  (rig: MonsterTreeRig, vfx: MonsterTreeVfx) => {
    vfx.burst(rig.sockets[socket], { count: options?.count ?? 70, speed: options?.speed ?? 1.3, spread: 0.9 });
    vfx.shockwave(rig.sockets[socket], options?.radius ?? 0.9, 0.7);
    vfx.cracks(rig.sockets[socket], { radius: (options?.radius ?? 0.9) * 0.85 });
    vfx.toxin(rig.sockets[socket], { radius: options?.toxin ?? 0.8 });
    // The creature registers its own hit, and the scene lights up for an instant.
    vfx.flash(0.9);
    IMPACT_AT.setFromMatrixPosition(rig.sockets[socket].matrixWorld);
    vfx.impactFlash(IMPACT_AT, 7, 0.26);
  };


/**
 * The character's stage-facing, flattened to the ground, in world space.
 *
 * The decoded bind geometry establishes +X as forward. Deriving forward from the live eye sockets
 * looked more sophisticated but was wrong for a full-body gesture: the head and spine deliberately
 * counter-rotate during the lash, turning the socket vector backwards on the release frame and
 * firing the branch through the torso. Transforming the measured bind-frame axis by the root keeps
 * a viewer turntable valid without letting an acting choice redefine where the stage is.
 */
function facing(rig: MonsterTreeRig): THREE.Vector3 {
  FACE_FORWARD.set(1, 0, 0).transformDirection(rig.group.matrixWorld);
  FACE_FORWARD.y = 0;
  return FACE_FORWARD.lengthSq() > 1e-10 ? FACE_FORWARD.normalize() : FACE_FORWARD.set(1, 0, 0);
}

/**
 * Heartwood Lash crosses forward and toward the character's left instead of disappearing into
 * camera depth. The vector is authored in the measured character frame (+X forward, -Z left),
 * then transformed by the root so orbiting the figure still rotates the entire action together.
 */
function lashDirection(rig: MonsterTreeRig): THREE.Vector3 {
  LASH_FORWARD.set(0.72, 0, -0.694).transformDirection(rig.group.matrixWorld);
  LASH_FORWARD.y = 0;
  return LASH_FORWARD.normalize();
}

// Runtime effect coordinates. They are overwritten synchronously by each cue; keeping them here
// means an impact frame does not create a handful of short-lived vectors for the collector.
const FACE_FORWARD = new THREE.Vector3(1, 0, 0);
const LASH_FORWARD = new THREE.Vector3(0.72, 0, -0.694);
const IMPACT_AT = new THREE.Vector3();
const SKILL_AT = new THREE.Vector3();
const SKILL_GROUND = new THREE.Vector3();
const SKILL_CROWN = new THREE.Vector3();

/**
 * Each skill's accent, taken from the reference's own measured palette.
 *
 * Not invented hues: the photograph's eye ramp runs from a deep #36581c through the iris #799d3d
 * to a near-white #d6faca, and its bark and moss give the earth tones. Using that range instead of
 * one point on it is what lets a punch, a stomp and a cast be told apart at a glance — before
 * this, every effect in the demo arrived in the same green and a busy frame read as one smear.
 *
 * The assignment is by what the move DOES, not by taste:
 *   strikes      the hot core — the flash of contact
 *   earth moves  moss and deep green — what is being torn out of the ground
 *   the cast     near-white, hottest of all: this is the sap itself being spent
 *   the fall     bark, drained of green, because the light is going out of the wood
 */
const ACCENT = {
  strike: new THREE.Color(PALETTE.eyeCore),
  iris: new THREE.Color(PALETTE.eyeIris),
  deep: new THREE.Color(PALETTE.eyeDeep).multiplyScalar(2.2),
  moss: new THREE.Color(PALETTE.mossLight),
  bark: new THREE.Color(PALETTE.barkLight),
  seed: new THREE.Color(PALETTE.leatherLight).multiplyScalar(1.65),
} as const;

/**
 * Build a skill's cue list from the measured event table instead of hand-typed times.
 *
 * Two things fall out of scheduling that a live "it just decelerated" test can never give:
 * the cue fires on the exact frame the sweep found, and a WINDUP can exist at all — the sap
 * starts gathering `lead` seconds before the arrest because the table knows the strike is
 * coming, and nothing that watches live motion knows any such thing.
 */
function impactCues(
  clip: string,
  options: {
    /** Seconds of gathering glow before the loudest arrest. */
    lead?: number;
    /** Which impact kind the loudest arrest lands as. */
    kind?: 'light' | 'heavy';
    /** Play every remaining arrest as a light hit (a flurry), or only the loudest. */
    flurry?: boolean;
    /** Give foot plants a ground impact. */
    plants?: boolean;
    /**
     * Play the clip's `driven` events as blows TAKEN.
     *
     * Off by default, and that default is a correction. Every offensive clip in this set carries
     * driven hip spikes — they are how a body throws its own weight behind a punch — so playing
     * them all as blows received put debris coming off the character's chest in the middle of its
     * own combo. box_02 alone fired two. A move is only receiving a hit if the move is about
     * receiving a hit, which here is `defeat_03` and nothing else.
     */
    taken?: boolean;
    /** Which bones count as the strike. Defaults to the hands. */
    strikeWith?: readonly string[];
  } = {},
): SkillCue[] {
  const cues: SkillCue[] = [];
  const table = clipEvents(clip);
  const loudest = loudestArrest(clip, options.strikeWith ?? HANDS);

  if (loudest) {
    cues.push({
      at: loudest.at,
      run: (rig, vfx) => {
        vfx.charge = 0;
        IMPACT_AT.setFromMatrixPosition(
          (rig.sockets[GRIP_OF[loudest.bone] ?? ''] ?? rig.bones[loudest.bone]).matrixWorld);
        vfx.impact(options.kind ?? 'heavy', IMPACT_AT, rig);
      },
    });
  }

  for (const e of table.events) {
    if (e.kind === 'arrest' && options.flurry && e !== loudest) {
      cues.push({
        at: e.at,
        run: (rig, vfx) => {
          IMPACT_AT.setFromMatrixPosition(
            (rig.sockets[GRIP_OF[e.bone] ?? ''] ?? rig.bones[e.bone]).matrixWorld);
          // No `rig`, so no hitstop. A jab in a flurry is 167 ms from the next one and holding
          // the clip on every one of them turns a combo into eight stalls; the payoff below is
          // the hit that stops time, and it can only read that way if the jabs do not.
          vfx.impact('light', IMPACT_AT);
        },
      });
    }
    if (e.kind === 'plant' && options.plants) {
      cues.push({
        at: e.at,
        run: (rig, vfx) => {
          IMPACT_AT.setFromMatrixPosition(rig.bones[e.bone].matrixWorld);
          vfx.impact('ground', IMPACT_AT, rig);
        },
      });
    }
    if (e.kind === 'driven' && options.taken) {
      // The body being shoved by something outside the clip is a blow TAKEN. No extra threshold
      // on top of the sweep's own: DRIVEN_ACCEL already required 9 H/s² with no limb arrest
      // within 120 ms, and defeat_03's four spikes all sit between 9.2 and 14.6 — a second gate
      // at 20 silently threw away every blow in the one clip that is about being hit.
      cues.push({ at: e.at, run: (rig, vfx) => vfx.struck(rig.bones.Spine02) });
    }
  }
  return cues.sort((a, b) => a.at - b.at);
}

/** A continuous windup into a clip's measured payoff, for skills whose cues are generated. */
function chargeInto(clip: string, lead = 0.34, strikeWith: readonly string[] = HANDS) {
  const loudest = loudestArrest(clip, strikeWith);
  if (!loudest) return undefined;
  return (_rig: MonsterTreeRig, vfx: MonsterTreeVfx, time: number) => {
    const build = buildTo(time, loudest.at, lead);
    if (build > vfx.charge) vfx.charge = build;
  };
}

/** Which grip socket carries each hand bone's impacts; feet map to their own sockets. */
const GRIP_OF: Record<string, string> = {
  L_Hand: 'grip-l', R_Hand: 'grip-r', L_ToeBase: 'foot-l', R_ToeBase: 'foot-r',
};

/** Every bone any skill lengthens, so a change of move can reset all of them. */
const STRETCHED = [
  'L_Forearm', 'L_Upperarm', 'R_Forearm', 'R_Upperarm',
  // Crown of First Seeds grows the trunk itself, so the spine and the legs are stretched too.
  'Spine01', 'Spine02', 'Waist', 'L_Thigh', 'R_Thigh',
] as const;

/**
 * Where the figure stands and which way its lunge goes.
 *
 * Heartwood Lash steps forward along the branch it grows. The step is bounded to a
 * quarter of a unit and eased back to `HOME` inside the same move, so the character finishes where
 * the viewer framed it — a move that leaves the figure somewhere else has moved the subject of the
 * shot, which is not a thing an attack is allowed to do in a fixed-camera showcase.
 */
const HOME = new THREE.Vector3();
const LUNGE = new THREE.Vector3(1, 0, 0);

/** 0 at the edges of a window, 1 in the middle — for a limb that grows and then comes back. */
function swell(time: number, start: number, end: number): number {
  if (time <= start || time >= end) return 0;
  const t = (time - start) / (end - start);
  return Math.sin(t * Math.PI) ** 0.7;
}

export const SKILLS: Skill[] = [
  {
    id: 'passive',
    accent: ACCENT.moss,
    label: 'Nội tại · Đất Mẹ',
    pose: (time) => passivePose(time),
    clip: 'authored:passive',
    fade: 0.45,
    loop: true,
    measured: 'QUIETEST. Groot enters living grass, draws a 2% max-health pulse from the soil, and carries a five-second +60 movement-speed wake. The activation is table-scheduled; the calm asymmetric sway stays calibrated to the quietest embedded clip instead of using a global motion threshold.',
    drive: (_rig, vfx, time) => {
      const speedWindow = time < 5 ? 1 - time / 5 : 0;
      vfx.signature.passiveStrength = 0.58 + speedWindow * 0.22 + Math.sin(time * 0.73) * 0.06;
      vfx.charge = 0.055 + speedWindow * 0.10 + Math.sin(time * 1.1) * 0.018;
    },
    cues: [{
      at: 0,
      run: (rig, vfx) => {
        SKILL_AT.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
        SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-r'].matrixWorld).add(SKILL_AT).multiplyScalar(0.5).setY(0);
        vfx.grass(SKILL_GROUND, { radius: 1.16, duration: 8, count: 300 });
        vfx.drawUp(SKILL_GROUND, { radius: 0.76, count: 64 });
        vfx.runeCircle(SKILL_GROUND, 0.70, 1.15);
      },
    }],
  },
  {
    id: 'thornline',
    accent: ACCENT.iris,
    label: 'Chiêu 1 · Dây Gai',
    pose: () => vinePose(),
    clip: 'authored:thornline',
    fade: 0.14,
    loop: false,
    measured: 'LOUD RANGED STRIKE. Groot bends his whole trunk away for 0.58s, holds the living limb loaded until 0.72s, then elongates arm and thornwood together. The branch reaches maximum extension at the authored 0.86s arrest; 65ms of hitstop belongs to that stop.',
    trails: ['grip-l'],
    drive: (rig, vfx, time) => {
      const reach = swell(time, BEATS.vine.release, BEATS.vine.recover + 0.18) * 0.38;
      rig.stretch('L_Forearm', reach);
      rig.stretch('L_Upperarm', reach * 0.46);
      const build = buildTo(time, BEATS.vine.release, 0.60);
      vfx.signature.gather(build, 0);
      vfx.charge = Math.max(vfx.charge, build * 0.34);
      LUNGE.copy(facing(rig));
      rig.group.position.copy(HOME).addScaledVector(
        LUNGE,
        swell(time, BEATS.vine.release, BEATS.vine.recover + 0.28) * 0.12,
      );
    },
    cues: [
      {
        at: BEATS.vine.release,
        run: (rig, vfx) => {
          vfx.charge = 0;
          const heading = lashDirection(rig);
          vfx.signature.castLash(
            rig.sockets['grip-l'], heading, 0.56, BEATS.vine.arrest - BEATS.vine.release,
          );
          SKILL_AT.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          SKILL_AT.addScaledVector(heading, 0.12).setY(0);
          vfx.signature.aftershock(SKILL_AT, heading, 0.48);
          vfx.burst(rig.sockets['grip-l'], {
            count: 26, speed: 0.46, duration: 0.62, spread: 0.62, gravity: -0.45, lightness: 0.78,
          });
        },
      },
      {
        at: BEATS.vine.arrest,
        run: (rig, vfx) => {
          const at = vfx.signature.arrestLash(rig, 1.08);
          vfx.impactFlash(at, 9, 0.26);
          vfx.flash(0.68);
          vfx.burstAt(at, {
            count: 108, speed: 1.75, duration: 0.78, spread: 0.68, gravity: -1.05, lightness: 0.82,
          });
        },
      },
    ],
  },
  {
    id: 'falling-tree',
    accent: ACCENT.deep,
    label: 'Chiêu 1 · Cây Đổ',
    pose: () => fallingTreePose(),
    clip: 'authored:falling-tree',
    fade: 0.16,
    loop: false,
    measured: 'HEAVY DASH. Groot compresses into a hardened bark shield at 0.42s, launches at 0.62s, and drives shoulder, hips, and root mass into one 0.94s directional arrest. The stop emits a forward splinter crown and root wedge, visually separating knockback from an ordinary hand hit.',
    drive: (rig, vfx, time) => {
      const armorIn = Math.min(1, time / BEATS.fallingTree.coil);
      const armorOut = time < BEATS.fallingTree.recover
        ? 1
        : Math.max(0, 1 - (time - BEATS.fallingTree.recover) / (BEATS.fallingTree.duration - BEATS.fallingTree.recover));
      const armor = armorIn * armorIn * (3 - 2 * armorIn) * armorOut;
      vfx.signature.wardStrength = armor;
      vfx.charge = Math.max(vfx.charge, armor * 0.20);
      const dash = time <= BEATS.fallingTree.launch
        ? 0
        : time < BEATS.fallingTree.arrest
          ? (time - BEATS.fallingTree.launch) / (BEATS.fallingTree.arrest - BEATS.fallingTree.launch)
          : Math.max(0, 1 - (time - BEATS.fallingTree.arrest) / (BEATS.fallingTree.duration - BEATS.fallingTree.arrest));
      const eased = dash * dash * (3 - 2 * dash);
      LUNGE.copy(facing(rig));
      rig.group.position.copy(HOME).addScaledVector(LUNGE, eased * 0.34);
    },
    cues: [
      {
        at: BEATS.fallingTree.launch,
        run: (rig, vfx) => {
          SKILL_AT.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld).setY(0);
          vfx.roots(SKILL_AT, { count: 7, spread: 0.22, duration: 0.70 });
        },
      },
      {
        at: BEATS.fallingTree.arrest,
        run: (rig, vfx) => {
          const heading = facing(rig);
          SKILL_AT.setFromMatrixPosition(rig.sockets['chest-core'].matrixWorld).addScaledVector(heading, 0.16);
          vfx.signature.knockback(SKILL_AT, heading, rig, 1.24);
          SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld).setY(0);
          vfx.roots(SKILL_GROUND, { count: 12, spread: 0.36, duration: 1.10 });
          vfx.burstAt(SKILL_AT, { count: 128, speed: 1.65, duration: 0.92, spread: 0.44, gravity: -1.35, lightness: 0.70 });
          vfx.impactFlash(SKILL_AT, 10, 0.30);
          vfx.flash(0.82);
        },
      },
    ],
  },
  {
    id: 'natures-embrace',
    accent: ACCENT.deep,
    label: 'Chiêu 2 · Thiên Nhiên Vỗ Về',
    pose: () => embracePose(),
    clip: 'authored:embrace',
    fade: 0.18,
    loop: false,
    measured: 'GATHER / STUN. Both arms open to the full front arc at 0.58s, then close into the centre at 0.94s. Leaves and bark move inward before colour changes; the converging field holds for one second, making this control move read differently from Dây Gai and Cây Đổ.',
    trails: ['grip-l', 'grip-r'],
    drive: (_rig, vfx, time) => {
      const build = buildTo(time, BEATS.embrace.gather, 0.70);
      const hold = time >= BEATS.embrace.gather && time <= BEATS.embrace.stunEnds ? 0.28 : 0;
      vfx.signature.gather(Math.max(build, hold), Math.max(build, hold));
      vfx.charge = Math.max(vfx.charge, build * 0.28 + hold * 0.20);
    },
    cues: [
      {
        at: BEATS.embrace.open,
        run: (rig, vfx) => {
          const heading = facing(rig);
          SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld).setY(0).addScaledVector(heading, 0.44);
          vfx.runeCircle(SKILL_GROUND, 1.28, 1.62);
          vfx.vortex(SKILL_GROUND, { radius: 1.62, duration: 0.72, count: 168 });
        },
      },
      {
        at: BEATS.embrace.gather,
        run: (rig, vfx) => {
          const heading = facing(rig);
          SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld).setY(0).addScaledVector(heading, 0.44);
          rig.hitstop(0.058, 0.04);
          vfx.vortex(SKILL_GROUND, { radius: 0.80, duration: 1.02, count: 112 });
          vfx.roots(SKILL_GROUND, { count: 9, spread: 0.25, duration: 1.18 });
          vfx.flash(0.48);
        },
      },
    ],
  },
  {
    id: 'life-seed',
    accent: ACCENT.seed,
    label: 'Chiêu Cuối · Hạt Giống Sinh Mệnh',
    pose: () => lifeSeedPose(),
    clip: 'authored:life-seed',
    fade: 0.22,
    loop: false,
    measured: 'ULTIMATE CHANNEL. Groot crouches, jumps, and arrests on the ground at 0.78s, then sleeps inside hardened heartwood for a six-second shield/slow zone. Seven life-seed volleys are table-scheduled; repeated hits culminate in an inward stun-and-pull at 5.30s while earth pulses climb back into the body.',
    drive: (rig, vfx, time) => {
      const inT = Math.min(1, Math.max(0, (time - BEATS.lifeSeed.land) / 0.36));
      const outT = time < BEATS.lifeSeed.wake
        ? 1
        : Math.max(0, 1 - (time - BEATS.lifeSeed.wake) / (BEATS.lifeSeed.duration - BEATS.lifeSeed.wake));
      const channel = inT * inT * (3 - 2 * inT) * outT;
      rig.stretch('Waist', channel * 0.10);
      rig.stretch('Spine01', channel * 0.08);
      rig.stretch('Spine02', channel * 0.07);
      rig.stretch('L_Thigh', channel * 0.05);
      rig.stretch('R_Thigh', channel * 0.05);
      vfx.signature.wardStrength = channel;
      vfx.signature.canopyStrength = channel * 0.64;
      vfx.signature.passiveStrength = channel * 0.78;
      vfx.charge = Math.max(vfx.charge, channel * 0.24);
    },
    cues: [
      {
        at: BEATS.lifeSeed.land,
        run: (rig, vfx) => {
          const heading = lashDirection(rig);
          SKILL_AT.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-r'].matrixWorld).add(SKILL_AT).multiplyScalar(0.5).setY(0);
          vfx.signature.groundContact(SKILL_GROUND, heading, rig, 1.30);
          vfx.runeCircle(SKILL_GROUND, 1.68, 5.22);
          vfx.roots(SKILL_GROUND, { count: 14, spread: 0.44, duration: 1.44 });
          vfx.burstAt(SKILL_GROUND, { count: 132, speed: 1.10, duration: 1.12, spread: 0.52, gravity: -1.15, lightness: 0.76 });
          vfx.flash(0.92);
        },
      },
      {
        at: BEATS.lifeSeed.rooted,
        run: (rig, vfx) => {
          SKILL_AT.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-r'].matrixWorld).add(SKILL_AT).multiplyScalar(0.5).setY(0);
          vfx.drawUp(SKILL_GROUND, { radius: 0.82, count: 72 });
        },
      },
      ...BEATS.lifeSeed.volleys.map((at, index) => ({
        at,
        run: (rig: MonsterTreeRig, vfx: MonsterTreeVfx) => {
          SKILL_CROWN.setFromMatrixPosition(rig.sockets.crown.matrixWorld);
          vfx.seeds(SKILL_CROWN, { count: 9 + (index % 3) * 2, spread: 0.92 + index * 0.09, flight: 0.58 + (index % 2) * 0.10 });
          vfx.burst(rig.sockets.crown, { count: 16, speed: 0.28, duration: 0.90, spread: 0.82, gravity: 0.38, lightness: 0.82 });
          if (index === 2 || index === 5) {
            SKILL_AT.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
            SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-r'].matrixWorld).add(SKILL_AT).multiplyScalar(0.5).setY(0);
            vfx.drawUp(SKILL_GROUND, { radius: 0.72, count: 48 });
          }
        },
      })),
      {
        at: BEATS.lifeSeed.pull,
        run: (rig, vfx) => {
          const heading = facing(rig);
          SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld).setY(0).addScaledVector(heading, 0.38);
          rig.hitstop(0.072, 0.025);
          vfx.vortex(SKILL_GROUND, { radius: 1.54, duration: 0.88, count: 190 });
          vfx.roots(SKILL_GROUND, { count: 12, spread: 0.34, duration: 1.08 });
          vfx.flash(0.74);
        },
      },
    ],
  },
  {
    id: 'regrowth',
    accent: ACCENT.bark,
    label: 'Groot · Tái Sinh Tế Bào',
    pose: () => recoilPose(),
    clip: 'authored:regrowth',
    fade: 0.10,
    loop: false,
    measured: 'TAKEN HIT / REGENERATION. There is no windup before the outside force arrives at 0.34s. Bark leaves the torso and the ring contracts inward; only after the fast 0.14s compression does root-to-heart sap regrow the silhouette over 0.70s. No flash appears at either hand.',
    drive: (_rig, vfx, time) => {
      const recovery = Math.min(1, Math.max(0,
        (time - BEATS.recoil.compressed) / (BEATS.recoil.regrow - BEATS.recoil.compressed),
      ));
      const life = recovery * recovery * (3 - 2 * recovery);
      vfx.signature.passiveStrength = life * 0.80;
      vfx.charge = Math.max(vfx.charge, life * 0.18);
    },
    cues: [
      {
        at: BEATS.recoil.hit,
        run: (rig, vfx) => {
          SKILL_AT.setFromMatrixPosition(rig.sockets['chest-core'].matrixWorld);
          rig.hitstop(0.046, 0.03);
          vfx.signature.taken(SKILL_AT, facing(rig));
        },
      },
      {
        at: BEATS.recoil.compressed,
        run: (rig, vfx) => {
          SKILL_AT.setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          SKILL_GROUND.setFromMatrixPosition(rig.sockets['foot-r'].matrixWorld).add(SKILL_AT).multiplyScalar(0.5);
          vfx.drawUp(SKILL_GROUND.setY(0), { radius: 0.58, count: 52 });
        },
      },
    ],
  },
  {
    id: 'spore-light',
    accent: ACCENT.seed,
    label: 'Groot · Bào Tử Phát Quang',
    pose: () => sporePose(),
    clip: 'authored:spore',
    fade: 0.24,
    loop: false,
    measured: 'QUIET GROOT SIGNATURE. Palms cup toward the heartwood, the crown warms at 0.92s, then the whole silhouette opens at 1.22s and releases slow golden spores. Motion is a buoyant lift with no impact ring, debris burst, or hitstop.',
    drive: (_rig, vfx, time) => {
      const gather = buildTo(time, BEATS.spore.release, 0.72);
      const open = swell(time, BEATS.spore.release, BEATS.spore.duration);
      vfx.signature.gather(gather * 0.70, gather * 0.70);
      vfx.signature.canopyStrength = Math.max(gather * 0.48, open * 0.38);
      vfx.charge = Math.max(vfx.charge, gather * 0.20 + open * 0.08);
    },
    cues: [
      {
        at: BEATS.spore.glow,
        run: (rig, vfx) => {
          vfx.burst(rig.sockets.crown, { count: 38, speed: 0.20, duration: 1.52, spread: 1, gravity: 0.48, lightness: 0.88 });
        },
      },
      {
        at: BEATS.spore.release,
        run: (rig, vfx) => {
          vfx.burst(rig.sockets.crown, { count: 118, speed: 0.38, duration: 1.88, spread: 1, gravity: 0.58, lightness: 0.92 });
          vfx.burst(rig.sockets['grip-l'], { count: 34, speed: 0.26, duration: 1.42, spread: 1, gravity: 0.46, lightness: 0.86 });
          vfx.burst(rig.sockets['grip-r'], { count: 34, speed: 0.26, duration: 1.42, spread: 1, gravity: 0.46, lightness: 0.86 });
          vfx.flash(0.32);
        },
      },
    ],
  },
  {
    id: 'echoes',
    accent: ECHO_RIM,
    label: 'Fivefold Coppice',
    clip: 'preset:biped:dance_05',
    fade: 0.18,
    loop: false,
    measured: 'dance_05 carries 18 arrests in 2.333s — one every ~130ms, the densest strike sequence in the library, with the hardest single stop anywhere (L_Hand 574.8 H/s² at 0.433). Five copies take one measured beat each: 0.200, 0.433, 0.833, 1.233, 1.633.',
    trails: ['grip-l', 'grip-r'],
    // Five copies of the figure, each running the clip a fixed interval behind the last. `beats`
    // picks one arrest per window rather than the five loudest, which all cluster at 0.433 and
    // 1.633; see `events.ts`. `until` leaves the last copy room to finish its own beat before the
    // clip ends, since a copy lagging by 0.40s reaches 1.633 at wall time 2.033.
    chorus: {
      clip: 'preset:biped:dance_05',
      beats: beats('preset:biped:dance_05', 5, { only: HANDS, until: 1.93 })
        .map((e) => ({ at: e.at, bone: e.bone })),
      // 0.07 and a cast at 0.10 put the five blows at wall times 0.37, 0.67, 1.14, 1.61 and 2.08 —
      // the last one comfortably inside the 2.20 convergence. The arithmetic matters: a copy
      // strikes at its beat plus its own lag, so a lag step large enough to read as an afterimage
      // can push the last copy past the end of the move and it never lands at all.
      lagStep: 0.07,
      radius: 0.46,
      at: 0.10,
      until: 2.20,
    },
    drive: (_rig, vfx, time) => {
      // The split is the payoff, so the gather runs into 0.14 and everything after it is spend.
      const build = buildTo(time, 0.10, 0.10);
      if (build > vfx.charge) vfx.charge = build;
    },
    cues: [
      {
        // Built on Wildfire Sap's shape — a planted cast, the eyes coming up, sap thrown off the
        // hand and the chest at once — with a TIGHTER ring under it. Wildfire Sap inscribes 1.35
        // because the whole move is that patch of ground; this one is about the copies standing
        // around him, so the circle is pulled in to 0.7 and stops competing with them.
        at: 0.10,
        run: (rig, vfx) => {
          vfx.charge = 0;
          vfx.eyes.intensity = 2.2;
          vfx.runeCircle(rig.sockets['foot-l'], 0.7, 2.1);
          vfx.burst(rig.sockets['grip-l'], { count: 140, speed: 2.1, spread: 0.85, gravity: -0.5, lightness: 0.72 });
          vfx.burst(rig.sockets['chest-core'], { count: 70, speed: 1.1, spread: 1, lightness: 0.78 });
          vfx.impactFlash(new THREE.Vector3().setFromMatrixPosition(rig.sockets['chest-core'].matrixWorld), 11, 0.34);
          vfx.flash(1.4);
        },
      },
      {
        // The copies come back in. One heavy hit, because five bodies arriving in the same place
        // is the only moment in this move that anything actually collides.
        at: 2.20,
        run: (rig, vfx) => {
          const at = new THREE.Vector3().setFromMatrixPosition(rig.sockets['chest-core'].matrixWorld);
          vfx.impact('heavy', at, rig);
          vfx.eyes.intensity = 1;
          vfx.runeCircle(rig.sockets['foot-l'], 0.55, 1.4);
          vfx.toxin(rig.sockets['foot-l'], { radius: 1.2, duration: 11 });
        },
      },
    ],
  },
  {
    id: 'grove',
    accent: ACCENT.deep,
    label: 'Grove Awakening',
    clip: 'preset:biped:fire',
    fade: 0.22,
    loop: false,
    measured: 'fire is the only clip with NO measured events — handPeak 0.134 H/s, Head 0.035, a planted cast. Nothing arrests, so nothing here is cued off an impact; the whole move is one continuous 0.95s gather and a spend.',
    // Both arms lift and lengthen as the forest comes up: the character is pulling it out of the
    // ground rather than pointing at it.
    drive: (rig, vfx, time) => {
      const reach = swell(time, 0.10, 1.15) * 0.55;
      rig.stretch('L_Forearm', reach);
      rig.stretch('R_Forearm', reach * 0.8);
      // One unbroken 0.85s gather into the release. This clip has no arrest to hang cues on — it
      // is the quietest thing in the library — so the build IS the move, and it has to be
      // continuous or there is nothing there at all.
      const build = buildTo(time, 0.95, 0.85);
      if (build > vfx.charge) vfx.charge = build;
    },
    cues: [
      { at: 0.06, run: (rig, vfx) => { vfx.runeCircle(rig.sockets['foot-l'], 1.15, 2.6); } },
      // A second, wider ring turning under the first while the gather runs, so the ground is
      // already answering before the forest arrives.
      { at: 0.48, run: (rig, vfx) => { vfx.runeCircle(rig.sockets['foot-l'], 1.85, 2.4); } },
      {
        at: 0.95,
        run: (rig, vfx) => {
          vfx.charge = 0;
          const centre = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          centre.y = 0;
          // A FOREST OPENING OUTWARD, not a ring of posts. Two stands at different radii, the
          // outer one a third of a second behind, and each stand grows as its own wave travelling
          // out from its centre — so the whole thing unrolls from under the character's feet
          // instead of appearing all at once at one distance. The inner stand clears the figure's
          // own footprint; the outer sits at 1.95, just inside the frame edge measured on the
          // demo's own canvas, so the character ends up standing inside the wood rather than in
          // front of it.
          vfx.grove(centre, { count: 7, spread: 0.48, duration: 12 });
          vfx.shockwave(rig.sockets['foot-l'], 1.7, 1.1);
          vfx.delay(0.32, () => {
            vfx.grove(centre, { count: 11, spread: 0.85, duration: 12 });
          });
          // Spores lifting off the new canopy as it opens — the forest exhaling.
          vfx.delay(0.55, () => vfx.burstAt(centre.clone().setY(0.9), {
            count: 90, speed: 0.42, duration: 3.4, spread: 1, gravity: 0.28, lightness: 0.7,
          }));
          vfx.toxin(rig.sockets['foot-l'], { radius: 1.4, duration: 12 });
        },
      },
    ],
  },
  {
    id: 'idle',
    label: 'Idle',
    clip: 'preset:biped:idle',
    fade: 0.45,
    loop: true,
    measured: '15.38s; lead limb L_Hand, 0.811 travel — a long breathing cycle',
    cues: [],
  },
  {
    id: 'strike',
    accent: ACCENT.strike,
    label: 'Bark Strike',
    clip: 'preset:biped:box_01',
    fade: 0.14,
    loop: false,
    measured: 'L_Hand leads at 1.321, peaking 0.54s in',
    trails: ['grip-l'],
    // Cues generated from the measured table: every arrest above threshold lands as a light hit,
    // the loudest as the payoff, plants as ground contacts, and the windup leads the loudest by
    // 0.18s because the table knows it is coming.
    cues: impactCues('preset:biped:box_01', { kind: 'light', flurry: true, plants: true }),
    drive: chargeInto('preset:biped:box_01', 0.30),
  },
  {
    id: 'combo',
    accent: ACCENT.strike,
    label: 'Splinter Combo',
    clip: 'preset:biped:box_02',
    fade: 0.14,
    loop: false,
    measured: 'both hands clear 1.0; R_Hand peaks 1.87s, L_Hand earlier — a two-hand exchange',
    trails: ['grip-l', 'grip-r'],
    cues: impactCues('preset:biped:box_02', { kind: 'heavy', flurry: true, plants: true }),
    drive: chargeInto('preset:biped:box_02', 0.40),
  },
  {
    id: 'uppercut',
    accent: ACCENT.strike,
    label: 'Heartwood Uppercut',
    clip: 'preset:biped:box_03',
    fade: 0.14,
    loop: false,
    measured: 'L_Hand 1.099 at 0.62s with Spine02 at 0.626 — the body goes with the arm',
    trails: ['grip-l'],
    cues: [
      { at: 0.62, run: impact('grip-l', { radius: 0.8, count: 85, speed: 1.6 }) },
      {
        at: 0.66,
        run: (rig, vfx) => {
          vfx.burst(rig.sockets['crown'], { count: 55, speed: 1.0, spread: 0.5, lightness: 0.7 });
          vfx.runeCircle(rig.sockets['foot-l'], 0.85, 1.1);
        },
      },
    ],
  },
  {
    id: 'kick',
    accent: ACCENT.moss,
    label: 'Rootfall Kick',
    clip: 'preset:biped:front_kick_01',
    fade: 0.16,
    loop: false,
    measured: 'R_ToeBase 2.323 at 1.02s — the largest excursion of any bone in any shipped clip',
    cues: [
      {
        at: 1.02,
        run: (rig, vfx) => {
          // Burst off the kicking foot, shockwave under the PLANTED one. At the peak of this clip
          // the right foot is high in the air, so centring the ground ring on it puts a shockwave
          // under a foot that is not touching anything.
          vfx.burst(rig.sockets['foot-r'], { count: 110, speed: 1.7, spread: 0.35, gravity: -2.4 });
          vfx.shockwave(rig.sockets['foot-l'], 1.5, 0.95);
          // A kick lands with the whole body behind it: the widest fracture in the set.
          vfx.cracks(rig.sockets['foot-l'], { radius: 1.45 });
          vfx.toxin(rig.sockets['foot-l'], { radius: 1.25 });
          vfx.roots(rig.sockets['foot-l'], { count: 10, spread: 0.34, duration: 1.15 });
          vfx.flash(1.3);
          vfx.impactFlash(new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld), 10, 0.34);
        },
      },
    ],
  },
  {
    id: 'stomp',
    accent: ACCENT.moss,
    label: 'Grovebreaker Stomp',
    clip: 'preset:biped:front_kick_02',
    fade: 0.14,
    loop: false,
    measured: 'R_ToeBase 1.820 at 0.68s — shorter and lower than the kick',
    cues: [
      {
        at: 0.68,
        run: (rig, vfx) => {
          // A stomp lands, so the big ring goes under the stomping foot; the smaller, slower one
          // under the planted foot is the ground answering a beat later.
          vfx.burst(rig.sockets['foot-r'], { count: 90, speed: 1.4, spread: 0.25, gravity: -2.6 });
          vfx.shockwave(rig.sockets['foot-r'], 1.2, 0.8);
          vfx.runeCircle(rig.sockets['foot-r'], 1.0, 1.3);
          vfx.roots(rig.sockets['foot-r'], { count: 8, spread: 0.26, duration: 0.95 });
          vfx.cracks(rig.sockets['foot-r'], { radius: 1.15 });
          vfx.toxin(rig.sockets['foot-r'], { radius: 1.0 });
          vfx.flash(1.1);
          vfx.impactFlash(new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-r'].matrixWorld), 9, 0.3);
        },
      },
    ],
  },
  {
    id: 'ignite',
    accent: ACCENT.strike,
    label: 'Wildfire Sap',
    clip: 'preset:biped:fire',
    fade: 0.2,
    loop: false,
    measured: 'L_Hand 0.771 while Head moves 0.035 and Spine02 0.040 — a planted cast, not a swing',
    trails: ['grip-l'],
    cues: [
      { at: 0.0, run: (rig, vfx) => { vfx.charge = 0; vfx.eyes.intensity = 1; vfx.runeCircle(rig.sockets['foot-l'], 1.35, 1.9); } },
      // Charge visibly gathers in the chest before the arm finishes, so the release reads as caused.
      { at: 0.12, run: (_rig, vfx) => { vfx.charge = 0.45; vfx.eyes.intensity = 1.6; } },
      { at: 0.55, run: (_rig, vfx) => { vfx.charge = 1; vfx.eyes.intensity = 2.4; } },
      {
        at: 1.18,
        run: (rig, vfx) => {
          vfx.burst(rig.sockets['grip-l'], { count: 160, speed: 2.2, spread: 0.8, gravity: -0.5, lightness: 0.7 });
          vfx.burst(rig.sockets['chest-core'], { count: 60, speed: 1.0, spread: 1, lightness: 0.75 });
          // No cracks here — nothing struck the ground. What a cast leaves is contamination, and
          // the widest patch of it, since spreading the toxin IS the move.
          vfx.toxin(rig.sockets['grip-l'], { radius: 1.5, duration: 12 });
          vfx.charge = 0;
          vfx.eyes.intensity = 1;
        },
      },
    ],
  },
  {
    id: 'fall',
    accent: ACCENT.bark,
    label: 'Deadfall',
    clip: 'preset:biped:defeat_03',
    fade: 0.25,
    loop: false,
    measured: 'L_Hand 1.838 at 2.68s, Head 1.408 — the figure goes down. The only skill that plays its clip\'s driven hip spikes as blows TAKEN: rings converging inward, debris off the body, no flash at the hand.',
    cues: [
      ...impactCues('preset:biped:defeat_03', { taken: true }).filter((c) => c.at > 0.5 && c.at < 2.6),
      { at: 0.0, run: (_rig, vfx) => { vfx.eyes.intensity = 1; vfx.charge = 0; } },
      { at: 2.68, run: (rig, vfx) => { vfx.shockwave(rig.sockets['foot-l'], 1.3, 1.1); vfx.roots(rig.sockets['foot-l'], { count: 6, spread: 0.30, duration: 1.4 }); vfx.eyes.intensity = 0.45; } },
      {
        at: 3.4,
        run: (rig, vfx) => {
          vfx.eyes.intensity = 0.15;
          vfx.burst(rig.sockets['chest-core'], { count: 60, speed: 0.5, spread: 1, gravity: -0.2, lightness: 0.45 });
          vfx.toxin(rig.sockets['foot-l'], { radius: 1.3, duration: 12 });
        },
      },
    ],
  },
];

export const SKILL_BY_ID = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

/**
 * Runs one skill at a time and fires its cues as the clip's own playhead crosses them.
 *
 * Cues are keyed off `action.time`, not off wall-clock seconds since the skill started, so a cue
 * still lands on the right frame if the clip is retimed or the tab stalls. A non-looping skill
 * returns to the resting skill on its own when the clip ends.
 */
export class SkillRunner {
  private active: Skill;
  private fired = new Set<number>();
  private previousTime = 0;
  private emberClock = 0;
  private trailStrength = 1;
  private emberEvery = 0.1;
  /** The copies. Built on their first cast, then reused for every one after. */
  private readonly chorus: EchoChorus;
  /**
   * The gesture being handed over FROM, frozen at the frame the change happened, and how far
   * through the hand-over we are.
   *
   * A clip cross-fades and a pose does not, so without this the whole authored gesture snapped back
   * to the resting animation between two frames. Measured on the review harness: ending the
   * ultimate moved a hand **1.10 units in a single frame**, the largest discontinuity in the demo
   * and one that no still frame shows.
   */
  private outgoing: { keys: Key[]; time: number } | null = null;
  /** The gesture being driven now, kept so the next change has something to fade FROM. */
  private activePose: { keys: Key[]; time: number } | null = null;
  private handover = 1;
  private handoverSpan = 0.3;
  /**
   * Where the figure was standing when the last change happened, and how far it has walked back.
   *
   * Heartwood Lash steps forward. Snapping the figure back to `HOME` on the frame the
   * next move starts moves the whole subject of the shot between two frames — measured at 0.35
   * units of hand jump, and it is the body that moved, not the arm. It eases back over the same
   * window everything else hands over in.
   */
  private readonly lungeFrom = new THREE.Vector3();
  private lungeK = 1;
  /** What the outgoing move had stretched, faded out across the hand-over. */
  private outgoingStretch: Array<[string, number]> = [];
  /** The skill returned to when a one-shot finishes. */
  restingId: string;

  constructor(
    private readonly rig: MonsterTreeRig,
    private readonly vfx: MonsterTreeVfx,
    startId = 'idle',
  ) {
    this.active = SKILL_BY_ID[startId];
    this.restingId = startId;
    // The figure's resting place, captured before any move can have shifted it. Heartwood Lash steps
    // forward and steps back, and a move that is interrupted halfway through its step has to hand
    // the figure back where it found it rather than leaving it a quarter of a unit downrange.
    HOME.copy(rig.group.position);
    // The kit's clips do not ship with the rig — they are authored here. Each is a trimmed copy of
    // standing_relax at the length its gesture needs, so the body keeps breathing under a pose
    // that is driven bone by bone. Registered before the first `play`, or the runner would look
    // for a clip that does not exist yet and refuse to start.
    rig.authorClip('authored:passive', 8.0);
    rig.authorClip('authored:thornline', BEATS.vine.duration);
    rig.authorClip('authored:falling-tree', BEATS.fallingTree.duration);
    rig.authorClip('authored:embrace', BEATS.embrace.duration);
    rig.authorClip('authored:life-seed', BEATS.lifeSeed.duration);
    rig.authorClip('authored:regrowth', BEATS.recoil.duration);
    rig.authorClip('authored:spore', BEATS.spore.duration);
    // Parented to the rig's own root, so a copy placed at a world offset from the character
    // travels with the character when the viewer turns the turntable.
    this.chorus = new EchoChorus(
      rig, 5,
      new THREE.Box3().setFromObject(rig.group).getSize(new THREE.Vector3()).y,
      SKILLS.find((s) => s.chorus)?.chorus?.clip ?? 'preset:biped:idle',
    );
    rig.group.add(this.chorus.group);
    this.rig.play(this.active.clip, 0);
  }

  get current(): Skill {
    return this.active;
  }

  play(id: string): boolean {
    const skill = SKILL_BY_ID[id];
    if (!skill) return false;
    if (!this.rig.play(skill.clip, skill.fade)) return false;
    this.active = skill;
    this.fired.clear();
    this.previousTime = 0;
    // A move interrupted mid-cast must not leave five copies standing on the floor, nor the
    // figure standing where a lunge left it.
    this.chorus.dismiss();
    // Freeze the gesture being left and hand it over across the same window the clip cross-fades
    // in, so the body and the pose arrive together. A move with no gesture to leave clears
    // outright — there is nothing to fade.
    this.outgoing = this.activePose;
    this.handoverSpan = Math.max(0.08, skill.fade);
    // ALWAYS from zero, even with nothing to fade out of. Coming from a clip with no authored
    // gesture at all — the incoming pose was previously applied at full weight on its first frame,
    // so the arms snapped into the new stance in one step: measured at 0.28 units of hand jump on
    // clip -> Heartwood Lash. With no outgoing pose the blend is simply the incoming one fading in
    // against the clip underneath, which is the third case `blendPose` already handles.
    this.handover = 0;
    if (!this.outgoing && !skill.pose) clearPose(this.rig);
    // Continuous layers a skill turned ON have to be turned off by the CHANGE, not by the skill
    // that set them — a move interrupted halfway never reaches its own cleanup. The coils outlived
    // the former ground cast this way and were still winding around the arms during the ultimate.
    this.vfx.coils = 0;
    this.vfx.signature.passiveStrength = 0;
    this.vfx.signature.canopyStrength = 0;
    this.vfx.signature.wardStrength = 0;
    this.vfx.signature.gather(0, 0);
    this.lungeFrom.copy(this.rig.group.position);
    this.lungeK = this.lungeFrom.distanceToSquared(HOME) > 1e-8 ? 0 : 1;
    this.rig.group.userData.empowered = false;
    // A skill that does not raise the eyes itself gets them back at rest, so a cancelled Wildfire
    // Sap cannot leave the character permanently over-lit.
    if (!skill.cues.some((c) => c.at === 0)) {
      this.vfx.eyes.intensity = 1;
      this.vfx.core.charge = 0;
    }
    // Continuous layers, calibrated against THIS clip's measured motion budget rather than a
    // global threshold. The set spans handPeak 0.134 (fire) to 5.231 (box_02) — a factor of 39 —
    // so one threshold either smears the fast clips or leaves the slow ones bare. Trails scale
    // with how fast the hands actually go; embers shed in proportion; breath rides the torso's
    // own mean speed so a still clip breathes gently and a dance hardly breathes at all.
    const budget = clipEvents(skill.clip);
    const speedFactor = Math.min(1, budget.handPeak / 3.5);
    this.trailStrength = 0.45 + 0.55 * speedFactor;
    this.emberEvery = budget.handPeak > 0.5 ? 0.10 / Math.max(0.35, speedFactor) : Infinity;
    this.vfx.breath = Math.max(0.25, 1 - budget.bodyMean * 2.2);
    for (const key of ['grip-l', 'grip-r'] as const) {
      this.vfx.trails[key].strength = skill.trails?.includes(key) ? this.trailStrength : 0;
    }
    // A skill that lengthened a limb must not hand it over stretched — but it must not SNAP back
    // either. The outgoing amounts are kept and faded across the hand-over; the incoming move
    // overwrites whichever bones it stretches itself.
    this.outgoingStretch = this.rig.stretchSnapshot();
    for (const bone of STRETCHED) this.rig.stretch(bone, 0);
    this.vfx.accent = skill.accent ?? ACCENT.iris;
    return true;
  }

  update(_dt: number): void {
    const clip = this.rig.clips.find((c) => c.name === this.active.clip);
    if (!clip) return;
    const action = this.rig.mixer.existingAction(clip);
    if (!action) return;
    const time = action.time;

    // Fire every cue the playhead has crossed since the last frame. A cue is never skipped because
    // the frame was long, and never fired twice because the clip looped past it.
    this.active.cues.forEach((cue, i) => {
      if (this.fired.has(i)) return;
      if (time >= cue.at && (time >= this.previousTime || cue.at <= time)) {
        this.fired.add(i);
        cue.run(this.rig, this.vfx);
      }
    });

    // Walk back from a lunge rather than teleporting back from it.
    if (this.lungeK < 1) {
      this.lungeK = Math.min(1, this.lungeK + _dt / this.handoverSpan);
      const k = this.lungeK * this.lungeK * (3 - 2 * this.lungeK);
      this.rig.group.position.lerpVectors(this.lungeFrom, HOME, k);
    }

    // The outgoing stretch, decaying. Applied BEFORE the incoming drive so a move that stretches
    // the same bone simply wins.
    if (this.handover < 1 && this.outgoingStretch.length) {
      const left = 1 - this.handover;
      for (const [bone, amount] of this.outgoingStretch) this.rig.stretch(bone, amount * left);
    } else if (this.outgoingStretch.length) {
      for (const [bone] of this.outgoingStretch) this.rig.stretch(bone, 0);
      this.outgoingStretch = [];
    }

    // The gesture, and the hand-over from whatever was posed before it.
    const incoming = this.active.pose ? { keys: this.active.pose(time), time } : null;
    this.activePose = incoming;
    if (this.handover < 1) {
      this.handover = Math.min(1, this.handover + _dt / this.handoverSpan);
      blendPose(this.rig, this.outgoing, incoming, this.handover);
      if (this.handover >= 1) this.outgoing = null;
    } else if (incoming) {
      blendPose(this.rig, null, incoming, 1);
    }

    this.active.drive?.(this.rig, this.vfx, time, clip.duration);
    this.chorus.tick();

    // The copies. Cast on the frame the skill says, driven against the ORIGINAL's playhead every
    // frame after, and each one's blow landed where ITS OWN fist is — which is up to 0.40s and
    // most of a metre away from the character's.
    const spec = this.active.chorus;
    if (spec) {
      if (!this.chorus.live && time >= spec.at && time < spec.until) {
        const origin = new THREE.Vector3().setFromMatrixPosition(this.rig.sockets['foot-l'].matrixWorld);
        origin.y = 0;
        this.chorus.cast(spec, origin, facing(this.rig));
      }
      if (this.chorus.live) {
        if (time >= spec.until) {
          this.chorus.dismiss();
        } else {
          for (const at of this.chorus.update(time - spec.at, spec.until - spec.at)) {
            // No hitstop on a copy's blow. Five holds inside 2.3s is the stutter this whole pass
            // was for; the convergence at the end is the one hit that stops the clip.
            this.vfx.impact('light', at);
          }
        }
      }
    }

    // Taper the swing trails off through the back half of a strike.
    if (this.active.trails?.length) {
      const t = time / clip.duration;
      const strength = (t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3)) * this.trailStrength;
      for (const key of this.active.trails) this.vfx.trails[key].strength = strength;

      // Embers shed off the swing while it is fast. A trail alone is a clean surface moving through
      // clean air, which is most of why one reads as a drawn streak rather than as something
      // burning: nothing is coming OFF it. A few sparks a frame, thrown backwards along the arc,
      // give the ribbon a wake.
      this.emberClock += _dt;
      if (strength > 0.3 && this.emberClock > this.emberEvery) {
        this.emberClock = 0;
        for (const key of this.active.trails) {
          this.vfx.burst(this.rig.sockets[key], {
            count: 3, speed: 0.35, duration: 0.75, spread: 1, gravity: -0.9, lightness: 0.72,
          });
        }
      }
    }

    if (!this.active.loop && time < this.previousTime) {
      // The clip wrapped, so the one-shot is done — hand back to the resting skill.
      this.play(this.restingId);
      return;
    }
    this.previousTime = time;
  }
}

/** Bounding box of the built figure, used to size the spore field and the shockwaves. */
export function figureBounds(rig: MonsterTreeRig): THREE.Box3 {
  return new THREE.Box3().setFromObject(rig.group);
}
