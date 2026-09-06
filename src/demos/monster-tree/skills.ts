import * as THREE from 'three';
import { EchoChorus, ECHO_RIM, type EchoChorusOptions } from './echoes';
import { BEATS, blendPose, clearPose, type Key, logsPose, passivePose, ultimatePose, vinePose } from './poses';
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
    vfx.impactFlash(new THREE.Vector3().setFromMatrixPosition(rig.sockets[socket].matrixWorld), 7, 0.26);
  };


/**
 * The direction the character is FACING, flattened to the ground, in world space.
 *
 * Measured, and rotation-safe: it is the midpoint of the two eye sockets minus the head bone. The
 * eyes were found as the green-dominant vertex clusters on the head and sit forward of the head
 * centroid, so that vector is the face's normal however the figure is turned — including under the
 * viewer's turntable, which a hard-coded +X would not survive.
 *
 * Effects that travel need this rather than the arm's heading. A downward punch has the forearm
 * pointing at the floor, so its horizontal component is near zero and essentially arbitrary; a
 * shockwave sent along it goes nowhere, or somewhere random.
 */
function facing(rig: MonsterTreeRig): THREE.Vector3 {
  const head = new THREE.Vector3().setFromMatrixPosition(rig.bones.Head.matrixWorld);
  const left = new THREE.Vector3().setFromMatrixPosition(rig.sockets['eye-l'].matrixWorld);
  const right = new THREE.Vector3().setFromMatrixPosition(rig.sockets['eye-r'].matrixWorld);
  const forward = left.add(right).multiplyScalar(0.5).sub(head);
  forward.y = 0;
  return forward.lengthSq() > 1e-10 ? forward.normalize() : new THREE.Vector3(1, 0, 0);
}

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
  strike: new THREE.Color(PALETTE.eyeCore).convertSRGBToLinear(),
  iris: new THREE.Color(PALETTE.eyeIris).convertSRGBToLinear(),
  deep: new THREE.Color(PALETTE.eyeDeep).convertSRGBToLinear().multiplyScalar(2.2),
  moss: new THREE.Color(PALETTE.mossLight).convertSRGBToLinear(),
  bark: new THREE.Color(PALETTE.barkLight).convertSRGBToLinear(),
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
        const at = new THREE.Vector3().setFromMatrixPosition(
          (rig.sockets[GRIP_OF[loudest.bone] ?? ''] ?? rig.bones[loudest.bone]).matrixWorld);
        vfx.impact(options.kind ?? 'heavy', at, rig);
      },
    });
  }

  for (const e of table.events) {
    if (e.kind === 'arrest' && options.flurry && e !== loudest) {
      cues.push({
        at: e.at,
        run: (rig, vfx) => {
          const at = new THREE.Vector3().setFromMatrixPosition(
            (rig.sockets[GRIP_OF[e.bone] ?? ''] ?? rig.bones[e.bone]).matrixWorld);
          // No `rig`, so no hitstop. A jab in a flurry is 167 ms from the next one and holding
          // the clip on every one of them turns a combo into eight stalls; the payoff below is
          // the hit that stops time, and it can only read that way if the jabs do not.
          vfx.impact('light', at);
        },
      });
    }
    if (e.kind === 'plant' && options.plants) {
      cues.push({
        at: e.at,
        run: (rig, vfx) => {
          const at = new THREE.Vector3().setFromMatrixPosition(rig.bones[e.bone].matrixWorld);
          vfx.impact('ground', at, rig);
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
  // Hạt Giống Thần Mệnh grows the trunk itself, so the spine and the legs are stretched too.
  'Spine01', 'Spine02', 'Waist', 'L_Thigh', 'R_Thigh',
] as const;

/**
 * Where the figure stands and which way its lunge goes.
 *
 * Dây Leo's empowered form steps forward along the vine it just caught. The step is bounded to a
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
    label: 'Passive · Greatwood Body',
    pose: (time) => passivePose(time),
    clip: 'authored:passive',
    fade: 0.45,
    loop: true,
    measured: 'POSED, not borrowed. The body plays a trimmed standing_relax — the quietest clip in the library, bodyMean 0.006 H/s, not one measured event — and the arms are aimed on top of it: low and open, palms turned down over the undergrowth he is drawing out of.',
    // Undergrowth comes up under him and he draws out of it: sap climbs from the floor into the
    // chest, and the bark hardens as it arrives. The direction matters — an effect leaving the
    // body is the character spending something, and this is the character TAKING something from
    // the ground it is standing on.
    drive: (rig, vfx, time) => {
      const foot = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
      // Armour, breathing. Held well below a skill's release so the passive never reads as a cast
      // about to happen — it is a state, not an event.
      const rooted = vfx.inGrass(foot);
      vfx.charge = rooted ? 0.14 + Math.sin(time * 1.5) * 0.05 : 0.04;
    },
    cues: [
      // Undergrowth and nothing else. No inscribed circle: a rune ring is something DRAWN, which
      // makes the passive read as a spell being cast rather than as ground he happens to be
      // standing on — and standing on it is the whole condition.
      { at: 0.2, run: (rig, vfx) => {
        const foot = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
        vfx.grass(foot, { radius: 0.9, duration: 20, count: 190 });
      } },
      // Regeneration, on a slow repeating beat for as long as he stands in it. Every draw checks
      // the patch first, so the passive stops the moment the undergrowth is gone — the condition
      // is real, not decorative.
      ...[1.2, 2.6, 4.0, 5.4, 6.8, 8.2, 9.6, 11.0, 12.4, 13.8].map((at) => ({
        at,
        run: (rig: MonsterTreeRig, vfx: MonsterTreeVfx) => {
          const foot = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          if (!vfx.inGrass(foot)) return;
          vfx.drawUp(foot, { radius: 0.7, count: 46 });
          vfx.flash(0.45);
        },
      })),
    ],
  },
  {
    id: 'vine',
    accent: ACCENT.iris,
    label: 'Vine Lash',
    pose: () => vinePose(),
    clip: 'authored:vine',
    fade: 0.14,
    loop: false,
    measured: 'POSED, SLOW UP AND FAST OUT. The arm takes 0.55s to lift and load, holds still for a tenth of a second, and then fires in 0.09s — the fastest thing in the kit. The vine leaves only once the arm is up, and it does not come back: it detaches and travels away downrange, thinning to nothing.',
    // The arm lengthens into the throw so the reach peaks exactly as the hand stops.
    drive: (rig, vfx, time) => {
      // Enough to read as "duỗi tay" without the forearm becoming a tentacle: at 0.85 the arm
      // stretched most of a metre and the shoulder pinched away from the body.
      // The lengthening belongs to the SHOT, not to the raise. Starting it during the lift made the
      // arm grow while it was still winding up, which is the one thing that told a viewer the whole
      // gesture was a single continuous move.
      const reach = swell(time, BEATS.vine.release - 0.06, BEATS.vine.release + 0.42) * 0.42;
      rig.stretch('L_Forearm', reach);
      rig.stretch('L_Upperarm', reach * 0.55);
      // Sap gathers through the whole slow raise, so the still frame before the fire is visibly
      // loaded rather than just paused.
      const build = buildTo(time, BEATS.vine.release, 0.52);
      if (build > vfx.charge) vfx.charge = build;
      // The lunge of the empowered form. Bounded and self-returning: it is a step, not a
      // relocation, so the figure is back where the viewer framed it by the time the move ends.
      if (rig.group.userData.empowered) {
        rig.group.position.copy(HOME).addScaledVector(LUNGE, swell(time, BEATS.vine.release, BEATS.vine.recover + 0.3) * 0.26);
      }
    },
    cues: [
      // Weight arriving on the back foot as he loads, not a strike — no hold on the clip for it.
      { at: 0.24, run: (rig, vfx) => vfx.impact('ground', new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld)) },
      {
        at: BEATS.vine.release,
        run: (rig, vfx) => {
          vfx.charge = 0;
          const heading = facing(rig);
          const foot = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          // THE CONDITION, asked of a real object. `vfx.grass` planted a patch with a position and
          // a radius; this is a genuine test against it, so the empowered form only appears when
          // the undergrowth the passive laid down is actually still standing under his feet.
          const empowered = vfx.inGrass(foot);
          rig.group.userData.empowered = empowered;
          LUNGE.copy(heading);

          vfx.vine(rig.sockets['grip-l'], heading, {
            bend: empowered ? 0.55 : 0.40,
            // Empowered reaches further and holds longer: the same move with more of it.
            // Re-measured against the leading camera: his feet now sit at px 214 of a 628-pixel
            // canvas and a point 1.6 units downrange projects to px 610, so the usable reach grew
            // by about 40%. 0.62 figure heights is 1.18 units, which lands the tip at px 505 and
            // leaves the fracture room to open around it. The bow lifts the middle of the vine
            // well above the straight line, so the path is longer still than the ground it covers.
            reach: empowered ? 0.78 : 0.66,
            // Out FAST — 0.11s to full reach, against a raise that took 0.55 — then barely any
            // hold, then it detaches and travels away. The move is a shot, not a whip crack.
            out: 0.11,
            hold: empowered ? 0.10 : 0.07,
            back: 0.34,
            onCatch: (at) => {
              // Plain: it holds and it SLOWS — a stain of creeping toxin under whatever it caught,
              // and nothing thrown. Empowered: it catches and it THROWS, so the same instant gets
              // a knockback burst driven along the heading and the ground fails under it.
              // THE VOID BREAKING. The far end does not just land — it puts a fracture through
              // the air itself, a sheet of glass failing at a point and throwing its pieces out.
              // This is the one effect in the demo that is not made of wood, sap or earth, and it
              // is deliberately the payoff of the move that reaches furthest away from him.
              // Lifted to chest height rather than left at the vine's own tip. The fracture is
              // the payoff of the move and it has to be seen: at the far end of the reach the
              // ground is already near the bottom-right corner of the frame.
              vfx.shatter(at.clone().setY(Math.max(0.85, at.y)), {
                size: empowered ? 0.44 : 0.36,
                duration: empowered ? 0.82 : 0.70,
              });
              vfx.impact('light', at, rig);
              const ground = new THREE.Object3D();
              ground.position.set(at.x, 0, at.z);
              ground.updateMatrixWorld(true);
              vfx.roots(ground, { count: empowered ? 7 : 4, spread: 0.22, duration: 0.9 });
              vfx.cracks(ground, { radius: empowered ? 0.75 : 0.55, duration: 6 });
              vfx.toxin(ground, { radius: empowered ? 0.82 : 0.62, duration: 7 });
              if (empowered) {
                vfx.burstAt(at.clone().setY(0.35), {
                  count: 46, speed: 1.7, duration: 0.68, spread: 0.42, gravity: -1.4, lightness: 0.64,
                });
                vfx.shockwave(ground, 0.82, 0.65);
              }
            },
          });
        },
      },
    ],
  },
  {
    id: 'natures-call',
    accent: ACCENT.deep,
    label: "Nature's Call",
    pose: () => logsPose(),
    clip: 'authored:logs',
    fade: 0.18,
    loop: false,
    measured: 'POSED as a HOLD. Both arms rise by 0.42s and stay there while a widening root wave answers from the ground at 0.62, 0.95 and 1.28, then opens into a young grove at 1.70. He is the source, not the hammer.',
    drive: (_rig, vfx, time) => {
      // The coils fade in as the arms arrive and out as they drop, so the light belongs to the
      // hold rather than being switched on beside it.
      const up = Math.min(1, Math.max(0, (time - 0.14) / (BEATS.logs.raised - 0.14)));
      const down = time > BEATS.logs.finish + 0.45
        ? Math.max(0, 1 - (time - BEATS.logs.finish - 0.45) / 0.5)
        : 1;
      vfx.coils = up * down;
      const build = buildTo(time, BEATS.logs.finish, 0.5);
      if (build > vfx.charge) vfx.charge = Math.max(build, up * down * 0.35);
    },
    cues: [
      ...BEATS.logs.calls.map((at, i) => ({
        // A root answer moves outward from the caster one beat at a time. Grounded growth has a
        // visible source and contact point; the former falling props floated in from off-screen.
        at,
        run: (rig: MonsterTreeRig, vfx: MonsterTreeVfx) => {
          const from = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          const ground = new THREE.Object3D();
          ground.position.copy(from.addScaledVector(facing(rig), 0.44 + i * 0.30)).setY(0);
          ground.updateMatrixWorld(true);
          vfx.roots(ground, { count: 3 + i * 2, spread: 0.11 + i * 0.035, duration: 0.82 + i * 0.08 });
          vfx.shockwave(ground, 0.32 + i * 0.10, 0.48);
        },
      })),
      {
        at: BEATS.logs.finish,
        run: (rig, vfx) => {
          const from = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          const at = from.clone().addScaledVector(facing(rig), 1.34).setY(0);
          const ground = new THREE.Object3D();
          ground.position.copy(at);
          ground.updateMatrixWorld(true);
          vfx.charge = 0;
          vfx.runeCircle(ground, 1.0, 1.6);
          vfx.roots(ground, { count: 7, spread: 0.32, duration: 1.2 });
          vfx.grove(at, { count: 3, spread: 0.24, duration: 3.1 });
          vfx.toxin(ground, { radius: 0.78, duration: 7 });
        },
      },
    ],
  },
  {
    id: 'ultimate',
    accent: ACCENT.iris,
    label: 'Ultimate · Seeds of Destiny',
    pose: () => ultimatePose(),
    clip: 'authored:ultimate',
    fade: 0.26,
    loop: false,
    measured: 'POSED as a CHANNEL. He sinks, roots — legs straight and wide and never moving again — the trunk grows, and the canopy is thrown open at 0.80s and held open for the whole downpour. A barrage that covers the field is not aimed at anything, so he opens and stays open.',
    drive: (rig, vfx, time) => {
      const grow = Math.min(1, time / BEATS.ultimate.rooted)
        * (time > BEATS.ultimate.rainEnds ? Math.max(0, 1 - (time - BEATS.ultimate.rainEnds) / 0.5) : 1);
      // The growth COMPOUNDS down the chain — waist, then spine, then chest — so these are much
      // smaller than they look. At 0.42/0.38/0.30 the product is 2.55x and the crown left the top
      // of the frame entirely; at these values it is about 1.45x.
      rig.stretch('Waist', grow * 0.16);
      rig.stretch('Spine01', grow * 0.14);
      rig.stretch('Spine02', grow * 0.12);
      rig.stretch('L_Thigh', grow * 0.10);
      rig.stretch('R_Thigh', grow * 0.10);
      vfx.charge = Math.max(vfx.charge, grow * 0.40);
    },
    cues: [
      {
        at: 0.0,
        run: (rig, vfx) => {
          // Roots take the feet: he is planted for the duration, which is what makes an ultimate
          // that channels a commitment rather than a pose.
          vfx.roots(rig.sockets['foot-l'], { count: 12, spread: 0.40, duration: 3.0 });
          vfx.roots(rig.sockets['foot-r'], { count: 10, spread: 0.36, duration: 3.0 });
          const foot = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          vfx.grass(foot, { radius: 1.25, duration: 10, count: 340 });
          vfx.runeCircle(rig.sockets['foot-l'], 1.7, 2.8);
        },
      },
      // The crown opens: a canopy pulled out of his own head as the trunk finishes growing.
      { at: BEATS.ultimate.rooted, run: (rig, vfx) => {
        const crown = new THREE.Vector3().setFromMatrixPosition(rig.sockets['crown'].matrixWorld);
        vfx.grove(crown, { count: 5, spread: 0.26, duration: 3.6 });
        vfx.burst(rig.sockets['crown'], { count: 90, speed: 0.9, spread: 1, gravity: 0.4, lightness: 0.78 });
      } },
      {
        // THE RELEASE. Three widening seed volleys leave the crown and arc back into the ground.
        // The former full-screen bolt rain obscured the pose and had no visible source; this keeps
        // every projectile connected to the character, then lets one young grove answer the whole
        // spread instead of allocating a separate tree for every landing.
        at: BEATS.ultimate.open,
        run: (rig, vfx) => {
          const foot = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          foot.y = 0;
          const crown = new THREE.Vector3().setFromMatrixPosition(rig.sockets['crown'].matrixWorld);
          vfx.vortex(foot, { radius: 0.92, duration: 0.72, count: 72 });
          vfx.seeds(crown, { count: 10, spread: 0.82, flight: 0.58 });
          vfx.delay(0.20, () => vfx.seeds(crown, { count: 13, spread: 1.15, flight: 0.70 }));
          vfx.delay(0.44, () => vfx.seeds(crown, { count: 16, spread: 1.55, flight: 0.84 }));
          vfx.delay(0.78, () => {
            vfx.grove(foot, { count: 7, spread: 0.62, duration: 3.3 });
            const ground = new THREE.Object3D();
            ground.position.copy(foot);
            ground.updateMatrixWorld(true);
            vfx.shockwave(ground, 1.05, 0.82);
          });
          vfx.impactFlash(new THREE.Vector3().setFromMatrixPosition(rig.sockets['crown'].matrixWorld), 10, 0.4);
          vfx.burst(rig.sockets['crown'], { count: 72, speed: 0.82, duration: 1.0, spread: 0.72, gravity: 0.2 });
          vfx.flash(1.15);
        },
      },
      {
        at: BEATS.ultimate.rainEnds,
        run: (rig, vfx) => {
          vfx.charge = 0;
          vfx.coils = 0;
          vfx.toxin(rig.sockets['foot-l'], { radius: 1.15, duration: 8 });
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
   * Vine Lash's empowered form steps forward. Snapping the figure back to `HOME` on the frame the
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
    // The figure's resting place, captured before any move can have shifted it. Dây Leo steps
    // forward and steps back, and a move that is interrupted halfway through its step has to hand
    // the figure back where it found it rather than leaving it a quarter of a unit downrange.
    HOME.copy(rig.group.position);
    // The kit's clips do not ship with the rig — they are authored here. Each is a trimmed copy of
    // standing_relax at the length its gesture needs, so the body keeps breathing under a pose
    // that is driven bone by bone. Registered before the first `play`, or the runner would look
    // for a clip that does not exist yet and refuse to start.
    rig.authorClip('authored:passive', 8.0);
    rig.authorClip('authored:vine', BEATS.vine.duration);
    rig.authorClip('authored:logs', BEATS.logs.duration);
    rig.authorClip('authored:ultimate', BEATS.ultimate.duration);
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
    // clip -> Vine Lash. With no outgoing pose the blend is simply the incoming one fading in
    // against the clip underneath, which is the third case `blendPose` already handles.
    this.handover = 0;
    if (!this.outgoing && !skill.pose) clearPose(this.rig);
    // Continuous layers a skill turned ON have to be turned off by the CHANGE, not by the skill
    // that set them — a move interrupted halfway never reaches its own cleanup. The coils outlived
    // Nature's Call this way and were still winding around the arms during the ultimate.
    this.vfx.coils = 0;
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
