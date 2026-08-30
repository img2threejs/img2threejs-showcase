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
   * How much of the drifting colour bloom this skill leaves on, 0..1. Default 1.
   *
   * Full while the figure is standing — the layer is what it does at rest. Pulled down during a
   * strike so the swing trail and the impact have the frame to themselves; a bloom at full
   * strength competes with them and the hit stops reading.
   */
  aura?: number;
}

/**
 * The direction a limb is POINTING, in world space, read off its own two bones.
 *
 * Every directed effect takes its axis from here rather than from a constant. The arm swings
 * through a huge arc during a punch and a cast holds a specific line; an effect fired along a
 * fixed vector detaches from the pose within a few frames, and one fired isotropically never
 * agreed with it in the first place. `L_Forearm -> L_Hand` is the forearm's own axis, so it
 * tracks whatever the clip is doing at the instant the cue fires.
 */
function aim(rig: MonsterTreeRig, from: string, to: string): THREE.Vector3 {
  // `to` resolves to a SOCKET first, then a bone. That matters for the arms: this rig has no
  // finger bones, so `L_Forearm -> L_Hand` only gives the forearm's axis and stops at the wrist,
  // while `L_Forearm -> grip-l` runs from the elbow out through the fingertips — grip-l being the
  // measured centroid of the 150 most distal vertices of the hand. That line is where the arm is
  // actually pointing, which is what a cast has to follow.
  const target = rig.sockets[to] ?? rig.bones[to];
  const a = new THREE.Vector3().setFromMatrixPosition(rig.bones[from].matrixWorld);
  const b = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld);
  const d = b.sub(a);
  return d.lengthSq() > 1e-10 ? d.normalize() : new THREE.Vector3(0, 1, 0);
}

/** Which forearm/hand pair feeds each grip socket. */
const ARM: Record<string, [string, string]> = {
  'grip-l': ['L_Forearm', 'grip-l'],
  'grip-r': ['R_Forearm', 'grip-r'],
};

const impact = (socket: string, options?: { radius?: number; count?: number; speed?: number }) =>
  (rig: MonsterTreeRig, vfx: MonsterTreeVfx) => {
    const [from, to] = ARM[socket] ?? [];
    // A strike throws splinters the way the fist is travelling. Wide cone: this is an impact
    // scattering, not a projected beam.
    vfx.burst(rig.sockets[socket], {
      count: options?.count ?? 70,
      speed: options?.speed ?? 1.3,
      direction: from ? aim(rig, from, to) : null,
      cone: 1.05,
    });
    vfx.shockwave(rig.sockets[socket], options?.radius ?? 0.9, 0.7);
  };

export const SKILLS: Skill[] = [
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
    aura: 0.35,
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
    aura: 0.3,
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
    aura: 0.35,
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
          // Up through the antlers, along the head's own axis.
          vfx.burst(rig.sockets['crown'], {
            count: 55, speed: 1.2, lightness: 0.7,
            direction: aim(rig, 'NeckTwist02', 'Head'), cone: 0.7,
          });
          vfx.runeCircle(rig.sockets['foot-l'], 0.85, 1.1);
        },
      },
    ],
  },
  {
    id: 'kick',
    aura: 0.4,
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
          vfx.burst(rig.sockets['foot-r'], { count: 110, speed: 1.7, gravity: -2.4, direction: aim(rig, 'R_Calf', 'foot-r'), cone: 1.15 });
          vfx.shockwave(rig.sockets['foot-l'], 1.5, 0.95);
          vfx.roots(rig.sockets['foot-l'], { count: 10, spread: 0.34, duration: 1.15 });
        },
      },
    ],
  },
  {
    id: 'stomp',
    aura: 0.4,
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
          vfx.burst(rig.sockets['foot-r'], { count: 90, speed: 1.4, gravity: -2.6, direction: aim(rig, 'R_Calf', 'foot-r'), cone: 1.0 });
          vfx.shockwave(rig.sockets['foot-r'], 1.2, 0.8);
          vfx.runeCircle(rig.sockets['foot-r'], 1.0, 1.3);
          vfx.roots(rig.sockets['foot-r'], { count: 8, spread: 0.26, duration: 0.95 });
        },
      },
    ],
  },
  {
    id: 'ignite',
    // The cast RAISES it — the bloom is the power gathering before it is thrown.
    aura: 1.35,
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
          // The release goes where the arm points, in a tight cone, and barely falls — a cast
          // thrown out of the hand rather than a puff that blooms around it.
          vfx.burst(rig.sockets['grip-l'], {
            count: 170, speed: 2.6, gravity: -0.22, lightness: 0.7,
            direction: aim(rig, 'L_Forearm', 'grip-l'), cone: 0.30,
          });
          // The chest, by contrast, stays a bloom: nothing is being aimed out of the torso.
          vfx.burst(rig.sockets['chest-core'], { count: 60, speed: 1.0, spread: 1, lightness: 0.75 });
          vfx.charge = 0;
          vfx.eyes.intensity = 1;
        },
      },
    ],
  },
  {
    id: 'fall',
    aura: 0.15,
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
    this.vfx.aura = skill.aura ?? 1;
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

    // Taper the swing trails off through the back half of a strike.
    if (this.active.trails?.length) {
      const t = time / clip.duration;
      const strength = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
      for (const key of this.active.trails) this.vfx.trails[key].strength = strength;
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
