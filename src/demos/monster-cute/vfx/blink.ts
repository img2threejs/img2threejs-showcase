/**
 * Blinking, on a rig that cannot blink.
 *
 * HAND-WRITTEN — see the note in `particles.ts`.
 *
 * There are no eyelids to move. The skeleton has 41 joints and not one of them is facial: `Head` is
 * the only joint above the neck, and the export carries no morph targets. So the eye cannot be
 * closed by posing anything, because there is nothing to pose.
 *
 * What the model does have is a per-vertex colour channel and an eye whose extent was measured. So
 * the lid is DRAWN rather than moved: each eye's vertices are swept to the colour of the fur that
 * rings them, from the top of the eye downward, and swept back open. `tools/measure.ts` collected
 * the disc of vertices around each measured eye socket and, for each one, its height within that
 * disc. That height is static — fixed to the vertex — so the sweep rides the head through every
 * clip without a single per-frame transform.
 *
 * Two details are what make it read as a blink rather than as a fading patch:
 *
 *   - the close is roughly three times faster than the open, which is how a real blink is timed;
 *   - a thin darker band travels just ahead of the lid edge, so there is a crease to follow rather
 *     than a soft gradient. Without it the eye looks like it is dissolving, not closing.
 *
 * Cost is one partial write to the colour attribute on the frames where a blink is actually in
 * progress. The rest of the time it touches nothing.
 */
import * as THREE from 'three';
import eyeEvidence from '../evidence/eyes.json';

interface EyeData {
  id: string;
  vertices: number[];
  lid: number[];
}

/** Timing, in seconds. A blink that takes the same time to open as to close reads as a wince. */
const CLOSE = 0.07;
const HOLD = 0.035;
const OPEN = 0.16;
const BLINK = CLOSE + HOLD + OPEN;

/** Gap between blinks. Humans blink every 2-8 s; a character that blinks like clockwork looks fake. */
const GAP_MIN = 2.2;
const GAP_MAX = 6.5;
/** How often a blink is a double. Doubles are what stop the rhythm reading as a metronome. */
const DOUBLE_CHANCE = 0.22;

export class Blink {
  private readonly colour: THREE.BufferAttribute;
  private readonly eyes: EyeData[];
  /** The eye's own colours, taken once before anything is written over them. */
  private readonly base: Float32Array;
  private readonly offsets: number[] = [];
  private readonly lidColour = new THREE.Color();
  private readonly creaseColour = new THREE.Color();

  private timer = 0;
  private phase = 0;
  private running = false;
  private queued = 0;
  private lastAmount = 0;
  private dirty = false;

  /** 0 = open, 1 = fully closed. Exposed so an expression can hold the eyes shut. */
  private forced: number | null = null;

  constructor(mesh: THREE.SkinnedMesh) {
    this.colour = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    this.eyes = (eyeEvidence.eyes as EyeData[]).filter((e) => e.vertices.length > 0);

    let total = 0;
    for (const eye of this.eyes) { this.offsets.push(total); total += eye.vertices.length; }
    this.base = new Float32Array(total * 3);
    let at = 0;
    for (const eye of this.eyes) {
      for (const v of eye.vertices) {
        this.base[at * 3] = this.colour.getX(v);
        this.base[at * 3 + 1] = this.colour.getY(v);
        this.base[at * 3 + 2] = this.colour.getZ(v);
        at += 1;
      }
    }

    this.lidColour.set(eyeEvidence.lidColour as string);
    // The crease is the same fur, darkened. Derived rather than picked, like every other colour here.
    this.creaseColour.copy(this.lidColour).multiplyScalar(0.55);

    this.timer = GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
  }

  /** Blink now. Used when a clip starts, so a new action opens with the eyes doing something. */
  trigger(double = Math.random() < DOUBLE_CHANCE): void {
    if (this.running) { this.queued = Math.max(this.queued, double ? 1 : 0); return; }
    this.running = true;
    this.phase = 0;
    this.queued = double ? 1 : 0;
  }

  /** Hold the eyes at a given closure, or null to hand them back to the blink rhythm. */
  setForced(amount: number | null): void { this.forced = amount; }

  /** 0 open, 1 closed — for anything that wants to fade an eye glow out as the lid comes down. */
  get closure(): number { return this.lastAmount; }

  update(dt: number): void {
    let amount: number;

    if (this.forced !== null) {
      amount = this.forced;
    } else if (this.running) {
      this.phase += dt;
      if (this.phase < CLOSE) amount = this.phase / CLOSE;
      else if (this.phase < CLOSE + HOLD) amount = 1;
      else if (this.phase < BLINK) amount = 1 - (this.phase - CLOSE - HOLD) / OPEN;
      else {
        amount = 0;
        this.running = false;
        if (this.queued > 0) { this.queued -= 1; this.timer = 0.09; }
        else this.timer = GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
      }
    } else {
      this.timer -= dt;
      if (this.timer <= 0) { this.trigger(); return; }
      amount = 0;
    }

    // Ease the sweep so the lid accelerates away from open and settles into closed.
    const eased = amount <= 0 ? 0 : amount >= 1 ? 1 : amount * amount * (3 - 2 * amount);
    if (eased === this.lastAmount && !this.dirty) return;
    this.write(eased);
    this.lastAmount = eased;
  }

  private write(amount: number): void {
    // The lid edge, plus a crease band that runs just ahead of it.
    const edge = 1 - amount;
    const CREASE = 0.16;
    const FEATHER = 0.06;

    for (let e = 0; e < this.eyes.length; e += 1) {
      const eye = this.eyes[e];
      const offset = this.offsets[e];
      for (let i = 0; i < eye.vertices.length; i += 1) {
        const v = eye.vertices[i];
        const b = (offset + i) * 3;
        if (amount <= 0) {
          this.colour.setXYZ(v, this.base[b], this.base[b + 1], this.base[b + 2]);
          continue;
        }
        const lid = eye.lid[i];
        // Above the edge is covered; a short feather stops the boundary crawling texel by texel.
        const covered = THREE.MathUtils.clamp((lid - edge) / FEATHER + 0.5, 0, 1);
        if (covered <= 0) {
          this.colour.setXYZ(v, this.base[b], this.base[b + 1], this.base[b + 2]);
          continue;
        }
        // Crease strength peaks right at the edge and fades in over the band above it.
        const crease = THREE.MathUtils.clamp(1 - (lid - edge) / CREASE, 0, 1) * covered;
        const r = this.lidColour.r * (1 - crease) + this.creaseColour.r * crease;
        const g = this.lidColour.g * (1 - crease) + this.creaseColour.g * crease;
        const bl = this.lidColour.b * (1 - crease) + this.creaseColour.b * crease;
        this.colour.setXYZ(
          v,
          this.base[b] + (r - this.base[b]) * covered,
          this.base[b + 1] + (g - this.base[b + 1]) * covered,
          this.base[b + 2] + (bl - this.base[b + 2]) * covered,
        );
      }
    }
    this.colour.needsUpdate = true;
    this.dirty = amount > 0;
  }

  /** Put the measured colours back. */
  dispose(): void {
    this.write(0);
    this.colour.needsUpdate = true;
  }
}
