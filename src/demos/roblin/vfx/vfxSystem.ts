import * as THREE from 'three';
import { ParticleField } from './particles';
import { BoltPool, type BoltOptions } from './projectile';
import { Shockwave } from './shockwave';
import { GroundGlow } from './groundGlow';
import { Flare } from './flare';

/**
 * The whole effect layer, in one object.
 *
 * SCOPE NOTE, because the brief asked for it plainly: the img2threejs skill has NO particle
 * subsystem, no trail renderer, no shockwave and no impact-flash primitive. Every one of those in
 * `src/roblin/vfx/` is written by hand for this showcase against plain three — no new dependency,
 * no texture files, no fetched assets. What the pipeline supplied is the measured surface, the
 * rig, the clips and the palette they are coloured from.
 *
 * Effects live at the SCENE ROOT, not under a bone. The skinned mesh carries the rig's
 * normalisation scale (2.113), so anything parented into the skeleton inherits it and a
 * 10-centimetre spark becomes a 21-centimetre one. Sockets are read for their world position each
 * frame instead.
 */

export interface BurstOptions {
  count: number;
  colour: THREE.Color;
  colourEnd?: THREE.Color;
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  direction?: THREE.Vector3;
  spread?: number;
  gravity?: number;
  drag?: number;
  swirl?: number;
  jitter?: number;
  /** Velocity added to every particle, e.g. the floor's motion under a runner. */
  inherit?: THREE.Vector3;
}

interface Flash {
  light: THREE.PointLight;
  t: number;
  duration: number;
  peak: number;
}

export class VfxSystem {
  readonly root = new THREE.Group();
  readonly particles: ParticleField;
  readonly bolts: BoltPool;
  readonly glow: GroundGlow;
  private readonly waves: Shockwave[];
  private readonly flares: Flare[];
  private readonly flashes: Flash[];
  private elapsed = 0;

  constructor(figureHeight: number, auraColour: THREE.Color) {
    this.root.name = 'roblin-vfx';
    this.particles = new ParticleField(6000);
    this.bolts = new BoltPool(this.particles, 14);
    this.glow = new GroundGlow(figureHeight * 0.72, auraColour);
    this.waves = Array.from({ length: 8 }, () => new Shockwave());
    this.flares = Array.from({ length: 6 }, () => new Flare());
    // Impact lights are pooled for the same reason bolts are: `new PointLight` mid-cast forces the
    // renderer to recompile every material that can receive light, which drops a frame every time.
    // Five, not eight: a radial skill lands its impacts together, and the sixth simultaneous
    // point light adds nothing a viewer can see while costing a shader recompile.
    this.flashes = Array.from({ length: 5 }, () => ({
      light: new THREE.PointLight(0xffffff, 0, 8, 2),
      t: 0,
      duration: 0,
      peak: 0,
    }));

    this.root.add(this.particles.points, this.bolts.group, this.glow.mesh);
    for (const wave of this.waves) this.root.add(wave.mesh);
    for (const flare of this.flares) this.root.add(flare.mesh);
    for (const flash of this.flashes) this.root.add(flash.light);
  }

  bolt(options: BoltOptions): boolean {
    return this.bolts.launch(options);
  }

  burst(at: THREE.Vector3, options: BurstOptions): void {
    this.particles.emit({
      position: at,
      direction: options.direction,
      spread: options.spread ?? Math.PI,
      count: options.count,
      speed: options.speed,
      life: options.life,
      size: options.size,
      colour: options.colour,
      colourEnd: options.colourEnd ?? options.colour.clone().multiplyScalar(0.15),
      gravity: options.gravity ?? 0,
      drag: options.drag ?? 1.4,
      swirl: options.swirl ?? 0,
      jitter: options.jitter ?? 0,
      inherit: options.inherit,
    });
  }

  shockwave(at: THREE.Vector3, radius: number, colour: THREE.Color, duration = 0.6, thickness = 0.16): void {
    const free = this.waves.find((w) => !w.busy);
    free?.fire(at, radius, colour, duration, thickness);
  }

  /**
   * A directional muzzle flare. Unlike `flash`, this one has an ORIENTATION — it is what puts the
   * hand's aim into the single frame a discharge is visible for.
   */
  flare(
    at: THREE.Vector3,
    aim: THREE.Vector3,
    colour: THREE.Color,
    length: number,
    girth: number,
    duration = 0.13,
  ): void {
    const free = this.flares.find((f) => !f.busy);
    free?.fire(at, aim, colour, length, girth, duration);
  }

  /** A short, bright point light. This is what makes an impact read as light rather than as paint. */
  flash(at: THREE.Vector3, colour: THREE.Color, peak: number, duration = 0.24, distance = 8): void {
    const free = this.flashes.find((f) => f.t >= f.duration);
    if (!free) return;
    free.light.position.copy(at);
    free.light.color.copy(colour);
    free.light.distance = distance;
    free.t = 0;
    free.duration = duration;
    free.peak = peak;
    free.light.intensity = peak;
  }

  update(delta: number, cameraPosition: THREE.Vector3): void {
    this.elapsed += delta;
    this.particles.update(delta);
    this.bolts.update(delta, cameraPosition);
    for (const wave of this.waves) wave.update(delta);
    for (const flare of this.flares) flare.update(delta, cameraPosition);
    for (const flash of this.flashes) {
      if (flash.t >= flash.duration) continue;
      flash.t += delta;
      const k = Math.min(1, flash.t / flash.duration);
      // Sharp attack, exponential decay — a linear falloff reads as a dimmer being turned down.
      flash.light.intensity = flash.peak * (1 - k) ** 2.4;
      if (k >= 1) flash.light.intensity = 0;
    }
    this.glow.update(this.elapsed);
  }

  setViewportHeight(pixels: number): void {
    this.particles.setViewportHeight(pixels);
  }

  stats(): { particles: number; bolts: number } {
    return { particles: this.particles.liveCount, bolts: this.bolts.flying };
  }

  dispose(): void {
    this.particles.dispose();
    this.bolts.dispose();
    this.glow.dispose();
    for (const wave of this.waves) wave.dispose();
    for (const flare of this.flares) flare.dispose();
  }
}
