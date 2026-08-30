import * as THREE from 'three';
import type { RigFrame } from './rigFrame';
import type { SocketRig } from './sockets';

/**
 * How each limb is actually moving, measured every frame.
 *
 * This exists because the first version of the effect layer aimed everything down the body's
 * forward axis. That is wrong the moment a clip does anything: the `fire` clip brings both arms
 * across the chest, the boxing clips throw a hand out to one side, and a kick swings a foot
 * through an arc — and a bolt that leaves along the torso's forward axis while the hand points
 * somewhere else reads as an effect stuck onto the animation rather than coming out of it.
 *
 * Two quantities per socket, both measured from bone world matrices:
 *
 *   AXIS      where the limb POINTS — the direction from a named parent bone to the socket. For a
 *             hand that is the forearm running out through the palm; for a foot it is the ankle
 *             running out through the toe.
 *   VELOCITY  where the limb is GOING — the world displacement of the socket per second, smoothed,
 *             because a raw frame-to-frame difference on a 60Hz clip is far too noisy to aim with.
 *
 * `aim` blends them by speed. A hand held still aims where it points; a hand thrown in a punch aims
 * where it is travelling. That single rule covers casting, punching and kicking without a special
 * case for any of them.
 */

export interface LimbMotion {
  /** Call once per frame, AFTER the animator has advanced and matrices are updated. */
  update(delta: number): void;
  /** Smoothed world velocity, units per second. */
  velocity(id: string, out?: THREE.Vector3): THREE.Vector3;
  /** Magnitude of the above. */
  speed(id: string): number;
  /** Unit direction the limb points, from its parent bone through the socket. */
  axis(id: string, out?: THREE.Vector3): THREE.Vector3;
  /**
   * Unit direction the action is going: `axis` at rest, travel direction when moving fast.
   *
   * `velocityCap` bounds how far the travel direction is allowed to pull the aim away from where
   * the limb points, and the right value depends on what is asking. A TRAIL wants the travel
   * direction — it is drawing the path. A PROJECTILE wants where the arm points: measured on a
   * real jab, an uncapped blend threw the bolt 21 degrees above horizontal, because at the strike
   * the hand is still rising even though the arm is extended level. Casting therefore caps it low.
   */
  aim(id: string, out?: THREE.Vector3, velocityCap?: number): THREE.Vector3;
}

interface Tracked {
  id: string;
  from: THREE.Bone;
  previous: THREE.Vector3;
  velocity: THREE.Vector3;
  axis: THREE.Vector3;
  speed: number;
  started: boolean;
}

export function createLimbMotion(sockets: SocketRig, frame: RigFrame): LimbMotion {
  const tracked = new Map<string, Tracked>();
  for (const socket of sockets.all.values()) {
    const fromName = socket.def.axisFrom;
    if (!fromName) continue;
    tracked.set(socket.def.id, {
      id: socket.def.id,
      from: frame.bone(fromName),
      previous: socket.worldPosition(),
      velocity: new THREE.Vector3(),
      axis: new THREE.Vector3(),
      speed: 0,
      started: false,
    });
  }

  const here = new THREE.Vector3();
  const root = new THREE.Vector3();
  const raw = new THREE.Vector3();
  // Fast enough to follow a punch, slow enough that a single dropped frame does not swing the aim.
  // Raised from 18 so the live velocity lags the clip less and agrees with the seek-based scan in
  // cueScan.ts; the two disagreeing is what put a scanned cue at up -0.17 and the live launch at
  // up +0.36.
  const smoothing = 26;
  // Speed at which travel direction fully takes over from where the limb points. Expressed in
  // figure heights per second so it holds for any subject this is reused on.
  const takeoverSpeed = frame.figureHeight * 2.2;
  // A limb cannot cross a third of the figure's height in one frame. Anything that does is a
  // TELEPORT, not motion: a hard clip change snaps the pose, and measuring across that snap read
  // 9.2 units per second on a kick whose real peak is under 6 — enough to fire a full-strength
  // trail and a spark burst out of a cut. Such a frame is dropped rather than smoothed, because
  // smoothing a teleport just spreads it over the next few frames.
  const teleportStep = frame.figureHeight / 3;

  return {
    update(delta) {
      if (delta <= 0) return;
      const blend = 1 - Math.exp(-smoothing * delta);
      for (const limb of tracked.values()) {
        const socket = sockets.get(limb.id);
        socket.worldPosition(here);
        root.setFromMatrixPosition(limb.from.matrixWorld);

        limb.axis.subVectors(here, root);
        if (limb.axis.lengthSq() < 1e-10) limb.axis.copy(frame.forward);
        else limb.axis.normalize();

        raw.subVectors(here, limb.previous);
        const step = raw.length();
        // The first frame has no previous position worth differencing — a socket that has just been
        // created would otherwise report the whole bind-pose offset as one frame of velocity.
        if (!limb.started) {
          limb.started = true;
        } else if (step > teleportStep) {
          // Discontinuity: keep the previous velocity, do not learn from the jump.
        } else {
          limb.velocity.lerp(raw.divideScalar(delta), blend);
        }
        limb.speed = limb.velocity.length();
        limb.previous.copy(here);
      }
    },

    velocity(id, out = new THREE.Vector3()) {
      const limb = tracked.get(id);
      return limb ? out.copy(limb.velocity) : out.set(0, 0, 0);
    },

    speed(id) {
      return tracked.get(id)?.speed ?? 0;
    },

    axis(id, out = new THREE.Vector3()) {
      const limb = tracked.get(id);
      return limb ? out.copy(limb.axis) : out.copy(frame.forward);
    },

    aim(id, out = new THREE.Vector3(), velocityCap = 0.85) {
      const limb = tracked.get(id);
      if (!limb) return out.copy(frame.forward);
      const weight = Math.min(velocityCap, limb.speed / takeoverSpeed);
      out.copy(limb.axis).multiplyScalar(1 - weight);
      if (limb.speed > 1e-4) out.addScaledVector(limb.velocity, weight / limb.speed);
      return out.lengthSq() < 1e-10 ? out.copy(limb.axis) : out.normalize();
    },
  };
}
