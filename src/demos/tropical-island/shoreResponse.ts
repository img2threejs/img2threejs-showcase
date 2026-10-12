const SIZE = 33;
const HALF_EXTENT = 14;
const SPACING = HALF_EXTENT * 2 / (SIZE - 1);
const WAVE_SPEED = 7;
const RESTORING = 12;
const LOAD_GAIN = 18;

interface ShoreLoads {
  readonly size: number;
  readonly axis: Float32Array;
  readonly cellWidths: Float64Array;
  readonly bed: Float64Array;
  readonly shoreImpulseX: Float64Array;
  readonly shoreImpulseZ: Float64Array;
}

export interface ShoreMotion {
  x: number;
  z: number;
  velocityX: number;
  velocityZ: number;
}

/** A damped elastic response driven ONLY by resolved shoreline loads.
 * This is an art-directed ground/prop response, not a rigid-body or splash solver.
 * Finite propagation speed prevents a sea click from shaking the whole island at once.
 */
export class ShoreResponse {
  readonly displacementX = new Float64Array(SIZE * SIZE);
  readonly displacementZ = new Float64Array(SIZE * SIZE);
  private readonly velocityX = new Float64Array(SIZE * SIZE);
  private readonly velocityZ = new Float64Array(SIZE * SIZE);
  private readonly nextX = new Float64Array(SIZE * SIZE);
  private readonly nextZ = new Float64Array(SIZE * SIZE);
  private readonly damping = new Float64Array(SIZE * SIZE);
  private readonly sourceCells: number[] = [];
  private readonly targetCells: number[] = [];
  private readonly weights: number[] = [];

  constructor(private readonly loads: ShoreLoads) {
    for (let z = 0; z < SIZE; z += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const edge = Math.min(x, z, SIZE - 1 - x, SIZE - 1 - z);
        this.damping[z * SIZE + x] = 1.1 + Math.max(0, 5 - edge) * 1.5;
      }
    }
    // Sparse, immutable bilinear transfers conserve the integral of each input
    // impulse. Coordinates outside the ground patch cannot force its border.
    for (let z = 0; z < loads.size; z += 1) {
      const gz = (loads.axis[z]! + HALF_EXTENT) / SPACING;
      if (gz < 1 || gz >= SIZE - 2) continue;
      for (let x = 0; x < loads.size; x += 1) {
        const i = z * loads.size + x;
        if (loads.bed[i]! < -0.35 || loads.bed[i]! > 0.3) continue;
        const gx = (loads.axis[x]! + HALF_EXTENT) / SPACING;
        if (gx < 1 || gx >= SIZE - 2) continue;
        const ix = Math.floor(gx), iz = Math.floor(gz);
        const fx = gx - ix, fz = gz - iz;
        const area = loads.cellWidths[x]! * loads.cellWidths[z]! / (SPACING * SPACING);
        const base = iz * SIZE + ix;
        this.sourceCells.push(i, i, i, i);
        this.targetCells.push(base, base + 1, base + SIZE, base + SIZE + 1);
        this.weights.push(area * (1 - fx) * (1 - fz), area * fx * (1 - fz),
          area * (1 - fx) * fz, area * fx * fz);
      }
    }
  }

  /** Return peak probe displacement across physics substeps, not only the final
   * rendered pose: a coarse frame must not miss a short extinguishing shock. */
  advance(seconds: number, probe?: { x: number; z: number }): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    for (let j = 0; j < this.sourceCells.length; j += 1) {
      const source = this.sourceCells[j]!, target = this.targetCells[j]!;
      const weight = this.weights[j]! * LOAD_GAIN;
      this.velocityX[target] += this.loads.shoreImpulseX[source]! * weight;
      this.velocityZ[target] += this.loads.shoreImpulseZ[source]! * weight;
    }
    let probeIndex = 0, a = 0, b = 0, c = 0, d = 0, peakSquared = 0;
    if (probe) {
      const gx = Math.max(0, Math.min(SIZE - 1, (probe.x + HALF_EXTENT) / SPACING));
      const gz = Math.max(0, Math.min(SIZE - 1, (probe.z + HALF_EXTENT) / SPACING));
      const ix = Math.min(SIZE - 2, Math.floor(gx)), iz = Math.min(SIZE - 2, Math.floor(gz));
      const fx = gx - ix, fz = gz - iz;
      probeIndex = iz * SIZE + ix;
      a = (1 - fx) * (1 - fz); b = fx * (1 - fz); c = (1 - fx) * fz; d = fx * fz;
    }
    let remaining = seconds;
    while (remaining > 0) {
      // Symplectic damped wave step; unsplit two-axis CFL below 1/sqrt(2).
      const dt = Math.min(remaining, 0.02, 0.4 * SPACING / WAVE_SPEED);
      const diffusion = WAVE_SPEED * WAVE_SPEED / (SPACING * SPACING);
      for (let z = 1; z < SIZE - 1; z += 1) {
        for (let x = 1; x < SIZE - 1; x += 1) {
          const i = z * SIZE + x;
          const ux = this.displacementX[i]!, uz = this.displacementZ[i]!;
          const lapX = this.displacementX[i - 1]! + this.displacementX[i + 1]!
            + this.displacementX[i - SIZE]! + this.displacementX[i + SIZE]! - 4 * ux;
          const lapZ = this.displacementZ[i - 1]! + this.displacementZ[i + 1]!
            + this.displacementZ[i - SIZE]! + this.displacementZ[i + SIZE]! - 4 * uz;
          const damp = 1 + 2 * this.damping[i]! * dt;
          this.velocityX[i] = (this.velocityX[i]! + dt * (diffusion * lapX - RESTORING * ux)) / damp;
          this.velocityZ[i] = (this.velocityZ[i]! + dt * (diffusion * lapZ - RESTORING * uz)) / damp;
          this.nextX[i] = ux + dt * this.velocityX[i]!;
          this.nextZ[i] = uz + dt * this.velocityZ[i]!;
        }
      }
      this.displacementX.set(this.nextX);
      this.displacementZ.set(this.nextZ);
      if (probe) {
        const i = probeIndex;
        const px = a * this.displacementX[i]! + b * this.displacementX[i + 1]!
          + c * this.displacementX[i + SIZE]! + d * this.displacementX[i + SIZE + 1]!;
        const pz = a * this.displacementZ[i]! + b * this.displacementZ[i + 1]!
          + c * this.displacementZ[i + SIZE]! + d * this.displacementZ[i + SIZE + 1]!;
        peakSquared = Math.max(peakSquared, px * px + pz * pz);
      }
      remaining -= dt;
    }
    return Math.sqrt(peakSquared);
  }

  sample(x: number, z: number, target: ShoreMotion): void {
    const gx = Math.max(0, Math.min(SIZE - 1, (x + HALF_EXTENT) / SPACING));
    const gz = Math.max(0, Math.min(SIZE - 1, (z + HALF_EXTENT) / SPACING));
    const ix = Math.min(SIZE - 2, Math.floor(gx)), iz = Math.min(SIZE - 2, Math.floor(gz));
    const fx = gx - ix, fz = gz - iz, i = iz * SIZE + ix;
    const a = (1 - fx) * (1 - fz), b = fx * (1 - fz), c = (1 - fx) * fz, d = fx * fz;
    target.x = a * this.displacementX[i]! + b * this.displacementX[i + 1]!
      + c * this.displacementX[i + SIZE]! + d * this.displacementX[i + SIZE + 1]!;
    target.z = a * this.displacementZ[i]! + b * this.displacementZ[i + 1]!
      + c * this.displacementZ[i + SIZE]! + d * this.displacementZ[i + SIZE + 1]!;
    target.velocityX = a * this.velocityX[i]! + b * this.velocityX[i + 1]!
      + c * this.velocityX[i + SIZE]! + d * this.velocityX[i + SIZE + 1]!;
    target.velocityZ = a * this.velocityZ[i]! + b * this.velocityZ[i + 1]!
      + c * this.velocityZ[i + SIZE]! + d * this.velocityZ[i + SIZE + 1]!;
  }
}
