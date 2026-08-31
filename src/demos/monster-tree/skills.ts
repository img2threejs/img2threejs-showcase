import * as THREE from 'three';
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
    label: 'Deep Root Surge',
    clip: 'preset:biped:box_02',
    fade: 0.16,
    loop: false,
    measured: 'box_02 brings a hand to y 0.446 at 0.40s — the lowest beat of any punch in the set',
    trails: ['grip-l'],
    // The arm LENGTHENS on the way down, which is what puts the fist on the floor. The clip only
    // ever gets the hand to 0.446 on a 1.9 m figure; no shipped animation in this library has a
    // treant punching the ground, so the limb makes up the difference itself.
    drive: (rig, _vfx, time) => {
      const reach = swell(time, 0.16, 0.62) * 0.85;
      rig.stretch('L_Forearm', reach);
      rig.stretch('L_Upperarm', reach * 0.45);
    },
    cues: [
      {
        at: 0.40,
        run: (rig, vfx) => {
          vfx.burst(rig.sockets['grip-l'], { count: 90, speed: 1.5, spread: 0.4, gravity: -2.2 });
          vfx.shockwave(rig.sockets['grip-l'], 1.0, 0.8);
          vfx.cracks(rig.sockets['grip-l'], { radius: 1.0 });
          // The fracture runs away from the figure along the arm's own heading and the ground
          // fails where it arrives — a grove tearing up out of the far end of the punch.
          vfx.surge(rig.sockets['grip-l'], facing(rig), {
            distance: 3.4,
            links: 6,
            onArrive: (at) => {
              // Dense: this is the point of the move, a stand of trees tearing up where the
              // fracture arrives. Packed tighter than it is wide so it reads as a thicket rather
              // than a scattering.
              vfx.grove(at, { count: 18, spread: 0.7 });
              vfx.burstAt(at, { count: 130, speed: 1.9, spread: 0.6 });
            },
          });
        },
      },
    ],
  },
  {
    id: 'impale',
    label: 'Impaling Bough',
    clip: 'preset:biped:box_01',
    fade: 0.12,
    loop: false,
    measured: 'box_01 is the straightest lead punch — L_Hand 1.321, forward reach 0.804 at 0.49s',
    // No swing trail on this one. The trail is additive and blazing, the shaft is lit wood, and
    // side by side the eye reads the trail and never finds the lance — which is how a move whose
    // whole subject is a thrown branch came back looking like "just a light streak".
    // The signature of the whole set: the arm roughly doubles in length through the thrust and
    // comes back. Along local +Y, which is measured — every arm bone's child sits on its parent's
    // +Y at 100% of the segment length, so scale.y IS length for this skeleton.
    drive: (rig, _vfx, time) => {
      const reach = swell(time, 0.22, 0.95) * 1.0;
      rig.stretch('L_Forearm', reach);
      rig.stretch('L_Upperarm', reach * 0.6);
    },
    cues: [
      {
        at: 0.46,
        run: (rig, vfx) => {
          // Thrown, not held. It leaves the hand along the character's facing and everything that
          // happens downrange happens because it got there.
          vfx.hurlSpear(rig.sockets['grip-l'], facing(rig), {
            // 2.1 units, not 3.4. The demo's own camera frames the figure, and a throw that
            // carries further than that lands the impact — the cracks, the toxin, the whole point
            // of the move — outside the shot nobody has moved the camera off.
            length: 0.55, distance: 2.2, flightTime: 0.34, linger: 2.6,
          });
          vfx.burst(rig.sockets['grip-l'], { count: 70, speed: 1.7, spread: 0.5 });
        },
      },
    ],
  },
  {
    id: 'grove',
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
    label: 'Bark Strike',
    clip: 'preset:biped:box_01',
    fade: 0.14,
    loop: false,
    measured: 'L_Hand leads at 1.321, peaking 0.54s in',
    trails: ['grip-l'],
    cues: [{ at: 0.54, run: impact('grip-l', { radius: 0.75, count: 80 }) }],
  },
  {
    id: 'combo',
    label: 'Splinter Combo',
    clip: 'preset:biped:box_02',
    fade: 0.14,
    loop: false,
    measured: 'both hands clear 1.0; R_Hand peaks 1.87s, L_Hand earlier — a two-hand exchange',
    trails: ['grip-l', 'grip-r'],
    cues: [
      { at: 0.42, run: impact('grip-l', { radius: 0.6, count: 50 }) },
      { at: 1.87, run: impact('grip-r', { radius: 0.95, count: 90, speed: 1.5 }) },
    ],
  },
  {
    id: 'uppercut',
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
        },
      },
    ],
  },
  {
    id: 'stomp',
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
        },
      },
    ],
  },
  {
    id: 'ignite',
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
    for (const key of ['grip-l', 'grip-r'] as const) {
      this.vfx.trails[key].strength = skill.trails?.includes(key) ? 1 : 0;
    }
    // A skill that lengthened a limb must not hand it over stretched. Cleared on every change
    // rather than by the skill that set it, so a move interrupted halfway still tidies up.
    for (const bone of STRETCHED) this.rig.stretch(bone, 0);
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
      const strength = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
      for (const key of this.active.trails) this.vfx.trails[key].strength = strength;

      // Embers shed off the swing while it is fast. A trail alone is a clean surface moving through
      // clean air, which is most of why one reads as a drawn streak rather than as something
      // burning: nothing is coming OFF it. A few sparks a frame, thrown backwards along the arc,
      // give the ribbon a wake.
      this.emberClock += _dt;
      if (strength > 0.35 && this.emberClock > 0.045) {
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
