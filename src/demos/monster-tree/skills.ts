import * as THREE from 'three';
import { clipEvents, loudestArrest } from './events';
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
  } = {},
): SkillCue[] {
  const cues: SkillCue[] = [];
  const table = clipEvents(clip);
  const loudest = loudestArrest(clip);

  if (loudest) {
    const lead = options.lead ?? 0.22;
    if (loudest.at > lead) {
      cues.push({
        at: loudest.at - lead,
        run: (_rig, vfx) => { vfx.charge = Math.max(vfx.charge, 0.7); },
      });
    }
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
          vfx.impact('light', at, rig);
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
    if (e.kind === 'driven') {
      // The body being shoved by something outside the clip is a blow TAKEN.
      if ((e.decel ?? 0) >= 20) {
        cues.push({ at: e.at, run: (rig, vfx) => vfx.struck(rig.bones.Spine02) });
      }
    }
  }
  return cues.sort((a, b) => a.at - b.at);
}

/** Which grip socket carries each hand bone's impacts; feet map to their own sockets. */
const GRIP_OF: Record<string, string> = {
  L_Hand: 'grip-l', R_Hand: 'grip-r', L_ToeBase: 'foot-l', R_ToeBase: 'foot-r',
};

/** Every bone any skill lengthens, so a change of move can reset all of them. */
const STRETCHED = ['L_Forearm', 'L_Upperarm', 'R_Forearm', 'R_Upperarm'] as const;

/** 0 at the edges of a window, 1 in the middle — for a limb that grows and then comes back. */
function swell(time: number, start: number, end: number): number {
  if (time <= start || time >= end) return 0;
  const t = (time - start) / (end - start);
  return Math.sin(t * Math.PI) ** 0.7;
}

export const SKILLS: Skill[] = [
  {
    id: 'surge',
    accent: ACCENT.deep,
    label: 'Deep Root Surge',
    clip: 'preset:biped:box_02',
    fade: 0.16,
    loop: false,
    measured: 'box_02 carries the loudest arrest in the whole set: R_Hand at 1.800s, decel 366.5 H/s² — and L_Hand arrests on the same frame. A double-hand slam, measured, not assumed.',
    trails: ['grip-l', 'grip-r'],
    // Both arms lengthen toward the measured slam. The old drive peaked at 0.40s — a window with
    // no event in it at all; the sweep found the real climax 1.4 seconds later.
    drive: (rig, _vfx, time) => {
      const reach = swell(time, 1.30, 2.05) * 0.85;
      rig.stretch('R_Forearm', reach);
      rig.stretch('R_Upperarm', reach * 0.45);
      rig.stretch('L_Forearm', reach * 0.7);
    },
    cues: [
      // The flurry: every measured arrest before the slam lands as a LIGHT hit — quick flat
      // flick, 35ms hold — so the exchange reads as jabs building toward something.
      {
        at: 0.667,
        run: (rig, vfx) => vfx.impact('light', new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-r'].matrixWorld), rig),
      },
      {
        at: 0.833,
        run: (rig, vfx) => vfx.impact('light', new THREE.Vector3().setFromMatrixPosition(rig.sockets['grip-l'].matrixWorld), rig),
      },
      {
        at: 1.0,
        run: (rig, vfx) => vfx.impact('light', new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-r'].matrixWorld), rig),
      },
      // The windup exists because the table knows the slam is coming: sap gathers from 1.40s.
      { at: 1.40, run: (_rig, vfx) => { vfx.charge = 0.5; } },
      { at: 1.65, run: (_rig, vfx) => { vfx.charge = 1; } },
      {
        // The measured frame, not a guess: both hands arrest at 1.800s.
        at: 1.80,
        run: (rig, vfx) => {
          vfx.charge = 0;
          const at = new THREE.Vector3().setFromMatrixPosition(rig.sockets['grip-r'].matrixWorld);
          vfx.impact('heavy', at, rig);
          vfx.surge(rig.sockets['grip-r'], facing(rig), {
            // 1.7, for the same measured reason as the spear's 1.8: projected on the demo's own
            // canvas the landing sits inside the frame at up to ~2.1 units and off it beyond.
            distance: 1.7,
            links: 5,
            onArrive: (arrive) => {
              vfx.grove(arrive, { count: 14, spread: 0.6 });
              vfx.impact('ground', arrive);
            },
          });
        },
      },
    ],
  },
  {
    id: 'impale',
    accent: ACCENT.bark,
    label: 'Impaling Bough',
    clip: 'preset:biped:box_01',
    fade: 0.12,
    loop: false,
    measured: 'box_01: L_ToeBase plants at 0.375s, then L_Hand arrests at extension at 0.467s, decel 67.4 — the spear leaves on that frame',
    // The arm grows through the windup and the throw leaves at the measured arrest, so the
    // stretch peaks exactly when the hand stops — the launch is the arm's own momentum arriving
    // at the end of a limb that ran out of length.
    drive: (rig, _vfx, time) => {
      const reach = swell(time, 0.20, 0.75) * 1.0;
      rig.stretch('L_Forearm', reach);
      rig.stretch('L_Upperarm', reach * 0.6);
    },
    cues: [
      {
        // Weight arrives before the throw: the measured L foot plant.
        at: 0.375,
        run: (rig, vfx) => vfx.impact('ground', new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld), rig),
      },
      { at: 0.30, run: (_rig, vfx) => { vfx.charge = 0.6; } },
      {
        // The measured arrest at extension. The strike STOPS here; that stop is the release.
        at: 0.467,
        run: (rig, vfx) => {
          vfx.charge = 0;
          vfx.impact('light', new THREE.Vector3().setFromMatrixPosition(rig.sockets['grip-l'].matrixWorld), rig);
          vfx.hurlSpear(rig.sockets['grip-l'], facing(rig), {
            length: 0.55, distance: 1.8, flightTime: 0.30, linger: 2.6,
          });
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
    measured: 'fire holds the torso still (Head 0.035) while an arm extends — a planted cast',
    // Both arms lift and lengthen as the ring comes up: the character is pulling the grove out of
    // the ground rather than pointing at it.
    drive: (rig, _vfx, time) => {
      const reach = swell(time, 0.10, 1.15) * 0.55;
      rig.stretch('L_Forearm', reach);
      rig.stretch('R_Forearm', reach * 0.8);
    },
    cues: [
      { at: 0.0, run: (_rig, vfx) => { vfx.charge = 0.35; } },
      { at: 0.35, run: (rig, vfx) => { vfx.charge = 1; vfx.runeCircle(rig.sockets['foot-l'], 1.6, 2.2); } },
      {
        at: 0.95,
        run: (rig, vfx) => {
          vfx.charge = 0;
          // A ring of trees around the figure, at a radius that clears its own footprint.
          const centre = new THREE.Vector3().setFromMatrixPosition(rig.sockets['foot-l'].matrixWorld);
          centre.y = 0;
          vfx.grove(centre, { count: 8, spread: 1.35, duration: 11 });
          vfx.shockwave(rig.sockets['foot-l'], 1.7, 1.1);
          vfx.toxin(rig.sockets['foot-l'], { radius: 1.4, duration: 11 });
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
    id: 'guard',
    label: 'Guard',
    clip: 'preset:biped:standing_relax',
    fade: 0.45,
    loop: true,
    measured: '14.10s; R_Hand 0.743 at 6.35s, feet under 0.26 — weight stays planted',
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
    cues: impactCues('preset:biped:box_01', { kind: 'light', flurry: true, plants: true, lead: 0.18 }),
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
    measured: 'L_Hand 1.838 at 2.68s, Head 1.408 — the figure goes down',
    cues: [
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
  /** The skill returned to when a one-shot finishes. */
  restingId = 'idle';

  constructor(
    private readonly rig: MonsterTreeRig,
    private readonly vfx: MonsterTreeVfx,
    startId = 'idle',
  ) {
    this.active = SKILL_BY_ID[startId];
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
    // A skill that lengthened a limb must not hand it over stretched. Cleared on every change
    // rather than by the skill that set it, so a move interrupted halfway still tidies up.
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

    this.active.drive?.(this.rig, this.vfx, time, clip.duration);

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
