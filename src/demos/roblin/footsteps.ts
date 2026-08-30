import * as THREE from 'three';
import type { Socket } from './sockets';

/**
 * Footstep detection, measured off the toe bones.
 *
 * The obvious way to spray dust on a run cycle is to fire on a timer tuned to the clip. That
 * breaks the moment the clip changes, the time scale changes or the frame rate dips. This watches
 * `attachment:step-l` and `attachment:step-r` — real sockets on the real `L_ToeBase` and
 * `R_ToeBase` bones — and calls a contact the frame a toe STOPS DESCENDING at the bottom of its
 * own arc.
 *
 * The first version of this gated on an ABSOLUTE height: a toe within a tenth of the figure height
 * of the floor was planting. It detected nothing on the left foot for four seconds of running, and
 * measuring the clip explained why — the only locomotion clip in this rig is
 * `preset:biped:run_upstairs`, a STAIR CLIMB. Over one cycle the right toe drops to 0.073 but the
 * left never comes below 0.335, because in the animation it is landing on a step that is not there
 * on a flat stage. An absolute floor test can only ever see one of this character's two feet.
 *
 * So the band is per-foot and relative: each toe's own recent travel is tracked, and a contact is
 * the bottom of THAT arc. It fires for both feet, on any clip, with nothing retuned — and the
 * clearance it reports lets the effect fade out for a foot that plants well above the floor rather
 * than pretending it kicked up dust it never touched.
 */

export interface FootstepEvent {
  socket: Socket;
  /** World position of the toe at contact. */
  at: THREE.Vector3;
  /** Descent speed at contact, world units per second. Loud steps hit faster. */
  impactSpeed: number;
  /** How far above the floor the toe actually planted, in figure heights. */
  clearance: number;
}

export interface FootstepWatcher {
  update(delta: number, onStep: (event: FootstepEvent) => void): void;
}

interface FootState {
  socket: Socket;
  previousY: number;
  previousVy: number;
  cooldown: number;
  primed: boolean;
  /** Decaying envelope of this toe's own travel, so the band follows the clip. */
  low: number;
  high: number;
}

export function createFootstepWatcher(
  sockets: Socket[],
  figureHeight: number,
  groundY: number,
): FootstepWatcher {
  const feet: FootState[] = sockets.map((socket) => {
    const y = socket.worldPosition().y;
    return { socket, previousY: y, previousVy: 0, cooldown: 0, primed: false, low: y, high: y };
  });
  const here = new THREE.Vector3();
  // The envelope has to forget: a clip change moves the whole arc, and an envelope that only ever
  // widens would keep the band where the previous clip left it.
  const relax = 0.6;
  // A toe has to rise past 60% of its own arc to re-arm, and land below 35% to count. Without the
  // gap a foot resting at the bottom jitters across the boundary and machine-guns dust.
  const armAbove = 0.6;
  const landBelow = 0.35;

  return {
    update(delta, onStep) {
      if (delta <= 0) return;
      for (const foot of feet) {
        foot.cooldown = Math.max(0, foot.cooldown - delta);
        foot.socket.worldPosition(here);
        const vy = (here.y - foot.previousY) / delta;

        foot.low = Math.min(here.y, foot.low + (foot.high - foot.low) * relax * delta);
        foot.high = Math.max(here.y, foot.high - (foot.high - foot.low) * relax * delta);
        const span = foot.high - foot.low;

        // Too flat an arc is a foot that is standing still, not stepping. Measured: the run cycle
        // swings a toe through about a third of a figure height, the idle through under 0.005.
        if (span > figureHeight * 0.03) {
          if (here.y > foot.low + span * armAbove) foot.primed = true;

          const stoppedDescending = foot.previousVy < -0.05 && vy >= foot.previousVy && vy > -0.02;
          if (foot.primed && stoppedDescending && here.y < foot.low + span * landBelow && foot.cooldown === 0) {
            foot.cooldown = 0.12;
            foot.primed = false;
            onStep({
              socket: foot.socket,
              at: here.clone(),
              impactSpeed: Math.abs(foot.previousVy),
              clearance: (here.y - groundY) / figureHeight,
            });
          }
        }

        foot.previousY = here.y;
        foot.previousVy = vy;
      }
    },
  };
}
