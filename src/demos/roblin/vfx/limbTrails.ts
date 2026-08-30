import * as THREE from 'three';
import { Ribbon } from './ribbon';
import type { VfxSystem } from './vfxSystem';
import type { LimbMotion } from '../motion';
import type { SocketRig } from '../sockets';

/**
 * Speed-driven trails on both hands and both feet.
 *
 * HAND-WRITTEN, like the rest of `vfx/`. This is the piece that makes the effect layer belong to
 * the animation rather than sit on top of it: nothing here is triggered by a clip name or a cue.
 * Each limb is watched, and when it exceeds a measured speed it draws a wake along the path it is
 * actually travelling and sheds sparks backwards down that path. A punch, a kick, a cast wind-up
 * and a dance flourish all get the right streak for free, and a limb that is not moving gets
 * nothing.
 *
 * The thresholds are in FIGURE HEIGHTS per second, not world units, so they hold for any subject.
 */

interface Limb {
  socketId: string;
  ribbon: Ribbon;
  colour: THREE.Color;
  spark: THREE.Color;
  sparkEnd: THREE.Color;
  width: number;
  /** Below this the limb is considered still. */
  quiet: number;
  /** At this speed the trail is at full strength. */
  loud: number;
  sparkRate: number;
  opacity: number;
  live: boolean;
  debt: number;
}

export interface LimbTrails {
  readonly group: THREE.Group;
  update(delta: number, cameraPosition: THREE.Vector3): void;
  /** Peak trail opacity across all four limbs — the HUD reads it. */
  readonly intensity: number;
  dispose(): void;
}

export interface LimbTrailSpec {
  socketId: string;
  colour: number;
  spark: number;
  sparkEnd: number;
  /** Multiple of figure height. */
  width: number;
  quiet: number;
  loud: number;
  sparkRate: number;
}

export function createLimbTrails(
  specs: readonly LimbTrailSpec[],
  sockets: SocketRig,
  motion: LimbMotion,
  vfx: VfxSystem,
  figureHeight: number,
): LimbTrails {
  const group = new THREE.Group();
  group.name = 'roblin-limb-trails';

  const limbs: Limb[] = specs.map((spec) => {
    // 18 segments is about a third of a second of travel at punch speed — long enough to read as an
    // arc, short enough that the wake does not outlive the motion that made it.
    const ribbon = new Ribbon(18, figureHeight * spec.width, new THREE.Color(spec.colour));
    ribbon.setOpacity(0);
    group.add(ribbon.mesh);
    return {
      socketId: spec.socketId,
      ribbon,
      colour: new THREE.Color(spec.colour),
      spark: new THREE.Color(spec.spark),
      sparkEnd: new THREE.Color(spec.sparkEnd),
      width: figureHeight * spec.width,
      quiet: figureHeight * spec.quiet,
      loud: figureHeight * spec.loud,
      sparkRate: spec.sparkRate,
      opacity: 0,
      live: false,
      debt: 0,
    };
  });

  const here = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  let intensity = 0;

  return {
    group,
    get intensity() { return intensity; },

    update(delta, cameraPosition) {
      if (delta <= 0) return;
      intensity = 0;

      for (const limb of limbs) {
        const socket = sockets.get(limb.socketId);
        socket.worldPosition(here);
        const speed = motion.speed(limb.socketId);
        motion.velocity(limb.socketId, velocity);

        const target = THREE.MathUtils.clamp(
          (speed - limb.quiet) / Math.max(1e-4, limb.loud - limb.quiet), 0, 1,
        );
        // Rise fast, fall slow: a wake should still be there for a moment after the limb stops,
        // which is what makes a punch land rather than simply switch off.
        const rate = target > limb.opacity ? 14 : 4.5;
        limb.opacity += (target - limb.opacity) * Math.min(1, delta * rate);

        if (!limb.live && limb.opacity > 0.02) {
          // Seed the whole spine at the current position. Without this the ribbon draws a streak
          // from wherever the limb was the last time it was moving, straight across the figure.
          limb.ribbon.reset(here);
          limb.live = true;
        }

        if (limb.live) {
          limb.ribbon.push(here);
          limb.ribbon.setWidth(limb.width * (0.45 + 0.55 * limb.opacity));
          limb.ribbon.setOpacity(limb.opacity * 0.9);
          limb.ribbon.build(cameraPosition);
          if (limb.opacity <= 0.02) {
            limb.opacity = 0;
            limb.live = false;
            limb.ribbon.setOpacity(0);
          }
        }

        intensity = Math.max(intensity, limb.opacity);

        // Sparks shed BACKWARDS along the path, carrying a fraction of the limb's own velocity, so
        // they hang in the air where the limb has been instead of flying off in a fixed direction.
        limb.debt += limb.sparkRate * limb.opacity * delta;
        const count = Math.floor(limb.debt);
        if (count > 0 && speed > limb.quiet) {
          limb.debt -= count;
          vfx.burst(here, {
            count,
            colour: limb.spark,
            colourEnd: limb.sparkEnd,
            direction: velocity.clone().normalize().negate(),
            spread: 0.65,
            speed: [speed * 0.05, speed * 0.28],
            life: [0.16, 0.42],
            size: [figureHeight * 0.004, figureHeight * 0.013],
            gravity: 0.8,
            drag: 3.2,
            jitter: figureHeight * 0.012,
            inherit: velocity.clone().multiplyScalar(0.22),
          });
        }
      }
    },

    dispose() {
      for (const limb of limbs) limb.ribbon.dispose();
    },
  };
}
