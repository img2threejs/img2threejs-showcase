const GRAVITY = 9.81;
const DRY_DEPTH = 1e-5;
const SIZE = 128;
const CENTRAL_CELLS = 96;
const OUTER_CELLS = (SIZE - CENTRAL_CELLS) / 2;
const CENTRAL_WIDTH = 28 / CENTRAL_CELLS;
/** Shared optical-film thresholds: subvisual residue stops replenishing wetness
 *  while the retained moisture continues drying on the physical clock. */
export const WET_FILM_DEPTH = 0.002;
export const WET_DEPTH_WET = 0.012;
const WET_TAU = 0.2;
const WET_DRY_TAU = 12;
/** Permeable above-sea-level soil; bounded infiltration, metres per second. */
const SOIL_INFILTRATION_SPEED = 0.0015;

/** Depth-driven saturation, independent of the retained moisture history. */
function wetnessTargetForDepth(depth: number): number {
  if (!Number.isFinite(depth) || depth <= WET_FILM_DEPTH) return 0;
  if (depth >= WET_DEPTH_WET) return 1;
  const span = WET_DEPTH_WET - WET_FILM_DEPTH;
  const t = (depth - WET_FILM_DEPTH) / span;
  return t * t * (3 - 2 * t);
}

/** Fast wetting and slower drying; exponential weights preserve [0, 1]. */
function updateWetness(
  current: number, depth: number, rise: number, fall: number,
): number {
  const target = wetnessTargetForDepth(depth);
  return current + (target - current) * (target > current ? rise : fall);
}

import { sampleIncidentWave } from './incidentWaves';
import type { EntryWater } from './waterEntryDynamics';

/** Live water parcel withdrawn by takeWater. Volume is the actual cubic
 *  metres of water pulled from the field; momentum is kg·m/s (rho·V·u),
 *  matching the physical X/Z impulse the parcel carries into the ejecta
 *  layer; kineticEnergy is the parcel's ½·rho·V·|u|² share in joules.
 *  potentialEnergy is the ACTUAL hydrostatic potential energy of the
 *  withdrawn column referenced to y=0:
 *    rho * g * Σ (removedVolume * (bed + hBefore - removedDepth/2)).
 *  May be negative for parcels pulled from below y=0 (deep cells whose
 *  surface sits beneath sea level). */
export interface WaterParcel {
  volume: number;
  momentumX: number;
  momentumZ: number;
  kineticEnergy: number;
  potentialEnergy: number;
}

/** Nonuniform finite-volume shallow water: limited MUSCL free-surface/velocity
 * reconstruction, hydrostatic HLL flux, SSP-RK2 time integration. Wet/dry faces
 * fall back to first order; bottom drag and breaking foam are closures. */
export class ShallowWater {
  static readonly size = SIZE;
  readonly size = SIZE;
  readonly axis = new Float32Array(SIZE);
  readonly cellWidths = new Float64Array(SIZE);
  readonly bed = new Float64Array(SIZE * SIZE);
  readonly depth = new Float64Array(SIZE * SIZE);
  readonly momentumX = new Float64Array(SIZE * SIZE);
  readonly momentumZ = new Float64Array(SIZE * SIZE);
  readonly foam = new Float64Array(SIZE * SIZE);
  readonly wetness = new Float64Array(SIZE * SIZE);
  /** Cubic metres transferred from surface water into the soil. */
  absorbedVolume = 0;
  readonly surfaceData = new Float32Array(SIZE * SIZE * 4);
  readonly flowData = new Float32Array(SIZE * SIZE * 4);
  /** Nonzero unit shoreward normals only on the sloping beach band. */
  private readonly shoreNormalX = new Float64Array(SIZE * SIZE);
  private readonly shoreNormalZ = new Float64Array(SIZE * SIZE);
  /** Directional shore impulse integrated over the most recent advance(). */
  readonly shoreImpulseX = new Float64Array(SIZE * SIZE);
  readonly shoreImpulseZ = new Float64Array(SIZE * SIZE);
  private readonly deltaDepth = new Float64Array(SIZE * SIZE);
  private readonly deltaX = new Float64Array(SIZE * SIZE);
  private readonly deltaZ = new Float64Array(SIZE * SIZE);
  private readonly slopeEta = new Float64Array(SIZE * SIZE);
  private readonly slopeU = new Float64Array(SIZE * SIZE);
  private readonly slopeV = new Float64Array(SIZE * SIZE);
  private readonly saveDepth = new Float64Array(SIZE * SIZE);
  private readonly saveX = new Float64Array(SIZE * SIZE);
  private readonly saveZ = new Float64Array(SIZE * SIZE);
  // Touched-cell scratch for incremental source APIs. Indices and weights are
  // filled in by each call; allocations are reused across callers.
  private readonly touchedIndices = new Int32Array(SIZE * SIZE);
  private readonly touchedWeight = new Float64Array(SIZE * SIZE);
  private readonly touchedCellArea = new Float64Array(SIZE * SIZE);
  private readonly touchedCoeff = new Float64Array(SIZE * SIZE);
  private readonly touchedRadialX = new Float64Array(SIZE * SIZE);
  private readonly touchedRadialZ = new Float64Array(SIZE * SIZE);
  private touchedCount = 0;

  private readonly velocityX = new Float64Array(SIZE * SIZE);
  private readonly velocityZ = new Float64Array(SIZE * SIZE);
  private readonly foamNext = new Float64Array(SIZE * SIZE);
  private readonly foamOffsetX = new Float64Array(SIZE * SIZE);
  private readonly foamOffsetZ = new Float64Array(SIZE * SIZE);
  private readonly offsetNextX = new Float64Array(SIZE * SIZE);
  private readonly offsetNextZ = new Float64Array(SIZE * SIZE);
  private transportedFoam = 0;
  private transportedOffsetX = 0;
  private transportedOffsetZ = 0;
  private readonly ambient: boolean;
  private time = 0;
  // Preallocated cubic B-spline scratch space for sample(). Reused across calls
  // so the per-sample hot path allocates nothing; weight slots are written by
  // index and consumed inline.
  private readonly splineKnotX = new Int32Array(4);
  private readonly splineKnotZ = new Int32Array(4);
  private readonly splineWeightX = new Float64Array(4);
  private readonly splineWeightZ = new Float64Array(4);
  private readonly splineDerivX = new Float64Array(4);
  private readonly splineDerivZ = new Float64Array(4);
  // Single shared preallocated target for sampleIncidentWave — no per-call
  // allocation in the forcing strip hot path.
  private readonly incidentTarget = { height: 0, momentumX: 0, momentumZ: 0 };
  // Shared preallocated target for sampleKinematics' cubic B-spline read —
  // no per-call allocation.
  private readonly sampleKinematicsTarget = { x: 0, y: 0, z: 0 };

  constructor(bedAt: (x: number, z: number) => number, options?: { ambient?: boolean }) {
    this.ambient = options?.ambient ?? false;
    // Symmetric geometric outer cells retain the original +/-100 sea extent
    // without sacrificing the ~0.292-cell shoreline resolution.
    let lower = 1, upper = 1.5;
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const ratio = (lower + upper) * 0.5;
      let sum = 0, width = CENTRAL_WIDTH;
      for (let i = 0; i < OUTER_CELLS; i += 1) { sum += width; width *= ratio; }
      if (sum < 86) lower = ratio; else upper = ratio;
    }
    const ratio = (lower + upper) * 0.5;
    let edge = 14, width = CENTRAL_WIDTH;
    for (let i = 0; i < OUTER_CELLS; i += 1) {
      const right = SIZE - OUTER_CELLS + i, left = OUTER_CELLS - 1 - i;
      this.axis[right] = edge + width * 0.5;
      this.axis[left] = -this.axis[right]!;
      this.cellWidths[right] = this.cellWidths[left] = width;
      edge += width;
      width *= ratio;
    }
    for (let i = 0; i < CENTRAL_CELLS; i += 1) {
      this.axis[OUTER_CELLS + i] = -14 + (i + 0.5) * CENTRAL_WIDTH;
      this.cellWidths[OUTER_CELLS + i] = CENTRAL_WIDTH;
    }
    for (let z = 0; z < SIZE; z += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const i = z * SIZE + x;
        const bed = bedAt(this.axis[x]!, this.axis[z]!);
        this.bed[i] = bed;
        this.depth[i] = Math.max(0, -bed);
        this.wetness[i] = bed < 0 ? 1 : 0;
      }
    }
    // Cache static shoreline membership and unit normals, not repeated square
    // roots/divisions on every fluid substep.
    for (let z = 0; z < SIZE; z += 1) {
      const lowerZ = Math.max(0, z - 1), upperZ = Math.min(SIZE - 1, z + 1);
      const spanZ = this.axis[upperZ]! - this.axis[lowerZ]!;
      for (let x = 0; x < SIZE; x += 1) {
        const lowerX = Math.max(0, x - 1), upperX = Math.min(SIZE - 1, x + 1);
        const spanX = this.axis[upperX]! - this.axis[lowerX]!;
        const i = z * SIZE + x;
        const left = z * SIZE + lowerX, right = z * SIZE + upperX;
        const lower = lowerZ * SIZE + x, upper = upperZ * SIZE + x;
        const sx = (this.bed[right]! - this.bed[left]!) / spanX;
        const sz = (this.bed[upper]! - this.bed[lower]!) / spanZ;
        const magnitude = Math.hypot(sx, sz);
        if (this.bed[i]! >= -0.35 && this.bed[i]! <= 0.30 && magnitude > 0.08) {
          this.shoreNormalX[i] = sx / magnitude;
          this.shoreNormalZ[i] = sz / magnitude;
        }
      }
    }
    this.pack();
  }

  /** Physical-axis lookup with linear extrapolation past the ends so spacing
   *  joins (e.g. dense uniform centre ↔ outer geometric ring) stay C2. */
  private axisAt(k: number): number {
    if (k < 0) return this.axis[0]! + k * (this.axis[1]! - this.axis[0]!);
    if (k >= SIZE) {
      const last = SIZE - 1;
      return this.axis[last]! + (k - SIZE + 1) * (this.axis[last]! - this.axis[last - 1]!);
    }
    return this.axis[k]!;
  }

  /** Regularized van-Albada slopes retain linear superposition for gentle
   * waves; steep fronts approach the monotone limiter instead. */
  private limitedSlope(a: number, b: number, smoothScale: number): number {
    const epsilon = smoothScale * smoothScale;
    return (a + b) * (0.5 * epsilon + Math.max(0, a * b)) / (a * a + b * b + epsilon);
  }

  advance(seconds: number): void {
    this.shoreImpulseX.fill(0);
    this.shoreImpulseZ.fill(0);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    let remaining = seconds;
    while (remaining > 1e-12) {
      let signalX = 0, signalZ = 0;
      for (let i = 0; i < this.depth.length; i += 1) {
        const h = this.depth[i]!;
        const u = h > DRY_DEPTH ? this.momentumX[i]! / h : 0;
        const v = h > DRY_DEPTH ? this.momentumZ[i]! / h : 0;
        const c = Math.sqrt(GRAVITY * h);
        // Include the two-celerity wet/dry rarefaction fan in the CFL bound.
        signalX = Math.max(signalX, Math.abs(u) + 2 * c);
        signalZ = Math.max(signalZ, Math.abs(v) + 2 * c);
      }
      const dt = Math.min(remaining, 0.05, 0.4 * CENTRAL_WIDTH / Math.max(signalX + signalZ, 1e-12));
      this.step(dt);
      this.time += dt;
      remaining -= dt;
    }
  }

  private drag(dt: number): void {
    for (let i = 0; i < this.depth.length; i += 1) {
      const h = this.depth[i]!;
      if (h <= DRY_DEPTH) {
        this.momentumX[i] = this.momentumZ[i] = 0;
      } else if (h < 0.5) {
        const divisor = 1 + dt * GRAVITY * 0.025 ** 2
          * Math.hypot(this.momentumX[i]!, this.momentumZ[i]!) / h ** (7 / 3);
        this.momentumX[i] /= divisor;
        this.momentumZ[i] /= divisor;
      }
    }
  }

  private updateVelocities(): void {
    for (let i = 0; i < this.depth.length; i += 1) {
      const h = this.depth[i]!;
      this.velocityX[i] = h > DRY_DEPTH ? this.momentumX[i]! / h : 0;
      this.velocityZ[i] = h > DRY_DEPTH ? this.momentumZ[i]! / h : 0;
    }
  }

  private step(dt: number): void {
    this.drag(dt * 0.5);
    this.saveDepth.set(this.depth);
    this.saveX.set(this.momentumX);
    this.saveZ.set(this.momentumZ);
    // U1 = U0 + dt L(U0); U2 = U1 + dt L(U1); Unext = (U0 + U2)/2.
    this.computeStage(dt);
    this.computeStage(dt);
    const infiltration = SOIL_INFILTRATION_SPEED * dt;
    for (let i = 0; i < this.depth.length; i += 1) {
      this.depth[i] = 0.5 * (this.saveDepth[i]! + this.depth[i]!);
      this.momentumX[i] = 0.5 * (this.saveX[i]! + this.momentumX[i]!);
      this.momentumZ[i] = 0.5 * (this.saveZ[i]! + this.momentumZ[i]!);
      if (this.bed[i]! > 0 && this.depth[i]! > 0) {
        const h = this.depth[i]!;
        const next = Math.max(0, h - infiltration);
        const retained = next / h;
        this.absorbedVolume += (h - next) * this.cellWidths[i % SIZE]! * this.cellWidths[(i / SIZE) | 0]!;
        this.depth[i] = next;
        this.momentumX[i] *= retained;
        this.momentumZ[i] *= retained;
      }
    }
    this.drag(dt * 0.5);
    if (this.ambient) this.forceIncident(dt);
    this.updateVelocities();
    this.updateFoam(dt);
  }

  private computeStage(dt: number): void {
    this.deltaDepth.fill(0);
    this.deltaX.fill(0);
    this.deltaZ.fill(0);
    this.updateVelocities();
    this.reconstructStates(true);
    for (let z = 0; z < SIZE; z += 1) {
      for (let x = 0; x < SIZE - 1; x += 1) this.face(z * SIZE + x, z * SIZE + x + 1, true, dt);
    }
    this.reconstructStates(false);
    for (let z = 0; z < SIZE - 1; z += 1) {
      for (let x = 0; x < SIZE; x += 1) this.face(z * SIZE + x, (z + 1) * SIZE + x, false, dt);
    }
    // Transmissive boundaries, with the same cell-centre pressure baseline
    // removed as on internal faces.
    for (let k = 0; k < SIZE; k += 1) {
      for (let side = 0; side < 4; side += 1) {
        const isX = side < 2;
        const i = side === 0 ? k * SIZE : side === 1 ? k * SIZE + SIZE - 1
          : side === 2 ? k : (SIZE - 1) * SIZE + k;
        const scale = (side % 2 === 0 ? 1 : -1) * dt / this.cellWidths[side % 2 === 0 ? 0 : SIZE - 1]!;
        const q = isX ? this.momentumX[i]! : this.momentumZ[i]!;
        this.deltaDepth[i] += scale * q;
        this.deltaX[i] += scale * q * this.velocityX[i]!;
        this.deltaZ[i] += scale * q * this.velocityZ[i]!;
      }
    }
    for (let i = 0; i < this.depth.length; i += 1) {
      const h = this.depth[i]! + this.deltaDepth[i]!;
      if (!Number.isFinite(h) || h < -1e-10) throw new Error(`Shallow-water positivity failure at cell ${i}: ${h}`);
      this.depth[i] = Math.max(0, h); // floating-point roundoff only
      this.momentumX[i] = h > DRY_DEPTH ? this.momentumX[i]! + this.deltaX[i]! : 0;
      this.momentumZ[i] = h > DRY_DEPTH ? this.momentumZ[i]! + this.deltaZ[i]! : 0;
    }
  }

  private reconstructStates(isX: boolean): void {
    const stride = isX ? 1 : SIZE;
    const normal = isX ? this.velocityX : this.velocityZ;
    const tangent = isX ? this.velocityZ : this.velocityX;
    for (let i = 0; i < this.depth.length; i += 1) {
      const k = isX ? i % SIZE : Math.floor(i / SIZE);
      const prev = i - stride, next = i + stride;
      if (k === 0 || k === SIZE - 1 || this.depth[i]! <= DRY_DEPTH
        || this.depth[prev]! <= DRY_DEPTH || this.depth[next]! <= DRY_DEPTH) {
        this.slopeEta[i] = this.slopeU[i] = this.slopeV[i] = 0;
        continue;
      }
      const before = this.axis[k]! - this.axis[k - 1]!;
      const after = this.axis[k + 1]! - this.axis[k]!;
      const half = this.cellWidths[k]! * 0.5;
      const eta = this.depth[i]! + this.bed[i]!;
      const delta = this.limitedSlope(half * (eta - this.depth[prev]! - this.bed[prev]!) / before,
        half * (this.depth[next]! + this.bed[next]! - eta) / after, 0.005 * this.depth[i]!);
      // Positivity limits the reconstructed polynomial, not the cell's water volume.
      this.slopeEta[i] = Math.sign(delta) * Math.min(Math.abs(delta), this.depth[i]!);
      const velocityScale = 0.005 * Math.sqrt(GRAVITY * this.depth[i]!);
      this.slopeU[i] = this.limitedSlope(half * (normal[i]! - normal[prev]!) / before,
        half * (normal[next]! - normal[i]!) / after, velocityScale);
      this.slopeV[i] = this.limitedSlope(half * (tangent[i]! - tangent[prev]!) / before,
        half * (tangent[next]! - tangent[i]!) / after, velocityScale);
    }
  }

  private face(left: number, right: number, isX: boolean, dt: number): void {
    const hL = Math.max(0, this.depth[left]! + this.slopeEta[left]!);
    const hR = Math.max(0, this.depth[right]! - this.slopeEta[right]!);
    const bed = Math.max(this.bed[left]!, this.bed[right]!);
    const a = Math.max(0, hL + this.bed[left]! - bed);
    const b = Math.max(0, hR + this.bed[right]! - bed);
    const normal = isX ? this.velocityX : this.velocityZ;
    const tangent = isX ? this.velocityZ : this.velocityX;
    const uL = a > DRY_DEPTH ? normal[left]! + this.slopeU[left]! : 0;
    const uR = b > DRY_DEPTH ? normal[right]! - this.slopeU[right]! : 0;
    const vL = a > DRY_DEPTH ? tangent[left]! + this.slopeV[left]! : 0;
    const vR = b > DRY_DEPTH ? tangent[right]! - this.slopeV[right]! : 0;
    const cL = Math.sqrt(GRAVITY * a), cR = Math.sqrt(GRAVITY * b);
    const sL = Math.min(0, a <= DRY_DEPTH ? uR - 2 * cR : Math.min(uL - cL, uR - cR));
    const sR = Math.max(0, b <= DRY_DEPTH ? uL + 2 * cL : Math.max(uL + cL, uR + cR));
    const inv = sR > sL ? 1 / (sR - sL) : 0;
    const mass = (sR * a * uL - sL * b * uR + sL * sR * (b - a)) * inv;
    const pressureFlux = (sR * (a * uL * uL + 0.5 * GRAVITY * a * a)
      - sL * (b * uR * uR + 0.5 * GRAVITY * b * b)
      + sL * sR * (b * uR - a * uL)) * inv;
    const transverse = (sR * a * uL * vL - sL * b * uR * vR
      + sL * sR * (b * vR - a * vL)) * inv;
    // Each side gets its own hydrostatic correction. Subtracting the centre
    // pressure here also supplies the within-cell topographic source balance.
    const normL = pressureFlux + 0.5 * GRAVITY * (hL * hL - a * a - this.depth[left]! ** 2);
    const normR = pressureFlux + 0.5 * GRAVITY * (hR * hR - b * b - this.depth[right]! ** 2);
    const scaleL = dt / this.cellWidths[isX ? left % SIZE : Math.floor(left / SIZE)]!;
    const scaleR = dt / this.cellWidths[isX ? right % SIZE : Math.floor(right / SIZE)]!;
    this.deltaDepth[left] -= scaleL * mass;
    this.deltaDepth[right] += scaleR * mass;
    const deltaNormal = isX ? this.deltaX : this.deltaZ;
    const deltaTangent = isX ? this.deltaZ : this.deltaX;
    deltaNormal[left] -= scaleL * normL;
    deltaNormal[right] += scaleR * normR;
    deltaTangent[left] -= scaleL * transverse;
    deltaTangent[right] += scaleR * transverse;
  }

  private forceIncident(dt: number): void {
    // Only this offshore strip is externally forced. Interior waves come from
    // the PDE; resting depth keeps the incident spectrum's frequencies steady.
    const relax = 1 - Math.exp(-dt / 0.35);
    const target = this.incidentTarget;
    for (let z = 0; z < SIZE; z += 1) {
      const pz = this.axis[z]!;
      if (Math.abs(pz + 12) > 1) continue;
      const weight = relax * Math.exp(-(((pz + 12) / 0.6) ** 2));
      for (let x = 0; x < SIZE; x += 1) {
        const i = z * SIZE + x;
        if (this.bed[i]! > -0.8) continue;
        const px = this.axis[x]!;
        const restingDepth = -this.bed[i]!;
        sampleIncidentWave(px, pz, this.time, restingDepth, target);
        const a = target.height;
        const wantedDepth = restingDepth + a;
        const wantedMx = target.momentumX;
        const wantedMz = target.momentumZ;
        this.depth[i] += weight * (wantedDepth - this.depth[i]!);
        this.momentumX[i] += weight * (wantedMx - this.momentumX[i]!);
        this.momentumZ[i] += weight * (wantedMz - this.momentumZ[i]!);
      }
    }
  }

  private updateFoam(dt: number): void {
    const decay = Math.exp(-dt / 3);
    // Bounded exponential approach to the depth-driven target. Wetting and
    // drying share the same 1 - exp(-dt/τ) step but use τ from the side we
    // approach, so rising tide saturates quickly while a retreating wave
    // leaves a long subvisual film that decays on the existing 12 s memory.
    const wetRise = 1 - Math.exp(-dt / WET_TAU);
    const wetFall = 1 - Math.exp(-dt / WET_DRY_TAU);
    for (let z = 0; z < SIZE; z += 1) {
      const lowerZ = Math.max(0, z - 1), upperZ = Math.min(SIZE - 1, z + 1);
      const spanZ = this.axis[upperZ]! - this.axis[lowerZ]!;
      for (let x = 0; x < SIZE; x += 1) {
        const lowerX = Math.max(0, x - 1), upperX = Math.min(SIZE - 1, x + 1);
        const spanX = this.axis[upperX]! - this.axis[lowerX]!;
        const i = z * SIZE + x;
        const left = z * SIZE + lowerX, right = z * SIZE + upperX;
        const lower = lowerZ * SIZE + x, upper = upperZ * SIZE + x;
        const h = this.depth[i]!;
        const u = this.velocityX[i]!, v = this.velocityZ[i]!;
        const compression = Math.max(0, -(this.velocityX[right]! - this.velocityX[left]!) / spanX
          - (this.velocityZ[upper]! - this.velocityZ[lower]!) / spanZ);
        const eta = h + this.bed[i]!;
        const slope = Math.hypot((this.depth[right]! + this.bed[right]! - this.depth[left]! - this.bed[left]!) / spanX,
          (this.depth[upper]! + this.bed[upper]! - this.depth[lower]! - this.bed[lower]!) / spanZ);
        const froude = h > DRY_DEPTH ? Math.hypot(u, v) / Math.sqrt(GRAVITY * Math.max(h, 0.005)) : 0;
        const relativeCrest = 2 * Math.max(0, eta) / Math.max(0.05, -this.bed[i]!);
        const nx = this.shoreNormalX[i]!, nz = this.shoreNormalZ[i]!;
        const incomingShore = u * nx + v * nz;
        const inShoreBand = nx !== 0 || nz !== 0;
        // A closure, NOT a universal 0.78*depth amplitude cap. Compression plus
        // steepness/relative crest/Froude distinguish bores from linear crossings.
        const source = h > DRY_DEPTH && compression > 0.08
          && (slope > 0.12 || relativeCrest > 0.6 || froude > 0.65)
          && inShoreBand && incomingShore > 0.03 && eta > 0.025
          ? Math.min(6, compression * 2.5) : 0;
        if (h > DRY_DEPTH && inShoreBand && incomingShore > 0.03 && eta > 0.06) {
          const restingDepth = Math.max(0, -this.bed[i]!);
          const load = 0.5 * GRAVITY * Math.max(0, h * h - restingDepth * restingDepth)
            + h * incomingShore * incomingShore;
          this.shoreImpulseX[i] += load * dt * nx;
          this.shoreImpulseZ[i] += load * dt * nz;
        }
        let transported = this.foam[i]!;
        let offsetX = this.foamOffsetX[i]!, offsetZ = this.foamOffsetZ[i]!;
        if (h > DRY_DEPTH && (u !== 0 || v !== 0)) {
          // CFL displacement is smaller than one cell. Skip the lookup entirely
          // where the entire neighbouring tracer stencil is exactly empty.
          if (transported !== 0 || this.foam[left] !== 0 || this.foam[right] !== 0
            || this.foam[lower] !== 0 || this.foam[upper] !== 0
            || this.foam[lowerZ * SIZE + lowerX] !== 0 || this.foam[lowerZ * SIZE + upperX] !== 0
            || this.foam[upperZ * SIZE + lowerX] !== 0 || this.foam[upperZ * SIZE + upperX] !== 0) {
            this.transportFoam(this.axis[x]! - u * dt, this.axis[z]! - v * dt);
            transported = this.transportedFoam;
            offsetX = this.transportedOffsetX - u * dt;
            offsetZ = this.transportedOffsetZ - v * dt;
          }
        }
        const residual = transported * decay;
        const concentration = residual + (1 - residual) * (1 - Math.exp(-source * dt));
        this.foamNext[i] = concentration;
        // Freshly entrained bubbles start at the current location; residual
        // material coordinates move/stretch with their transported concentration.
        const retained = concentration > 1e-6 ? residual / concentration : 0;
        this.offsetNextX[i] = offsetX * retained;
        this.offsetNextZ[i] = offsetZ * retained;
        this.wetness[i] = updateWetness(this.wetness[i]!, h, wetRise, wetFall);
      }
    }
    this.foam.set(this.foamNext);
    this.foamOffsetX.set(this.offsetNextX);
    this.foamOffsetZ.set(this.offsetNextZ);
  }

  private transportFoam(x: number, z: number): void {
    const ix = this.bracket(x), iz = this.bracket(z);
    const fx = Math.min(1, Math.max(0, (x - this.axis[ix]!) / (this.axis[ix + 1]! - this.axis[ix]!)));
    const fz = Math.min(1, Math.max(0, (z - this.axis[iz]!) / (this.axis[iz + 1]! - this.axis[iz]!)));
    const i = iz * SIZE + ix;
    const a = this.foam[i]! * (1 - fx) * (1 - fz);
    const b = this.foam[i + 1]! * fx * (1 - fz);
    const c = this.foam[i + SIZE]! * (1 - fx) * fz;
    const d = this.foam[i + SIZE + 1]! * fx * fz;
    const total = a + b + c + d;
    this.transportedFoam = total;
    this.transportedOffsetX = total > 1e-12 ? (a * this.foamOffsetX[i]! + b * this.foamOffsetX[i + 1]!
      + c * this.foamOffsetX[i + SIZE]! + d * this.foamOffsetX[i + SIZE + 1]!) / total : 0;
    this.transportedOffsetZ = total > 1e-12 ? (a * this.foamOffsetZ[i]! + b * this.foamOffsetZ[i + 1]!
      + c * this.foamOffsetZ[i + SIZE]! + d * this.foamOffsetZ[i + SIZE + 1]!) / total : 0;
  }

  addImpulse(x: number, z: number, strength: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(strength)
      || Math.abs(x) >= 100 || Math.abs(z) >= 100 || this.sampleScalar(this.depth, x, z) <= DRY_DEPTH) return;
    const s = Math.min(1, Math.max(0, strength));
    const ix = this.bracket(x), iz = this.bracket(z);
    const width = Math.max(0.65 + 0.35 * s, 1.5 * this.cellWidths[ix]!, 1.5 * this.cellWidths[iz]!);
    const radius = width * 4, amplitude = 0.1 + 0.5 * s;
    let removed = 0, positive = 0;
    // First pass measures the ACTUAL removable trough volume with cell areas.
    for (let j = 0; j < SIZE; j += 1) {
      const dz = this.axis[j]! - z;
      if (Math.abs(dz) > radius) continue;
      for (let k = 0; k < SIZE; k += 1) {
        const dx = this.axis[k]! - x;
        const q = (dx * dx + dz * dz) / (2 * width * width);
        const i = j * SIZE + k;
        if (q > 8 || this.depth[i]! <= DRY_DEPTH) continue;
        const kick = amplitude * (1 - q) * Math.exp(-q);
        const area = this.cellWidths[k]! * this.cellWidths[j]!;
        if (kick < 0) removed += Math.min(-kick, this.depth[i]! * 0.95) * area;
        else positive += kick * area;
      }
    }
    if (positive === 0 || removed === 0) return;
    const volume = Math.min(removed, positive);
    const balance = volume / positive, troughScale = volume / removed;
    for (let j = 0; j < SIZE; j += 1) {
      const dz = this.axis[j]! - z;
      if (Math.abs(dz) > radius) continue;
      for (let k = 0; k < SIZE; k += 1) {
        const dx = this.axis[k]! - x;
        const q = (dx * dx + dz * dz) / (2 * width * width);
        const i = j * SIZE + k;
        if (q > 8 || this.depth[i]! <= DRY_DEPTH) continue;
        const kick = amplitude * (1 - q) * Math.exp(-q);
        this.depth[i] += kick < 0 ? -Math.min(-kick, this.depth[i]! * 0.95) * troughScale : kick * balance;
      }
    }
  }

  /** Per-step physical coupling API. One frame's immersion displacement,
   *  opposite impulse and mechanical work are deposited into the conserved
   *  fields by coupleBody; parcels are withdrawn through takeWater and
   *  returned through returnWater. The PDE, not a timed decal, propagates
   *  the resolved cavity/rim/momentum. */

  /** Sample the live water kinematics the rigid-entry body integrates against.
   * Height/slope come from the existing cubic B-spline surface; bed and
   * horizontal velocity come from the real solver arrays; the vertical
   * velocity satisfies finite-volume continuity on the physical axis so a
   * converging crest lifts the free surface (positive ẇ), as the actual
   * shallow-water PDE predicts. Empty / non-finite / off-grid coordinates
   * produce a dry neutral sample. No per-call allocation. */
  sampleKinematics(x: number, z: number, out: EntryWater): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)
      || Math.abs(x) >= 100 || Math.abs(z) >= 100) {
      out.height = 0; out.depth = 0; out.bed = 0;
      out.slopeX = 0; out.slopeZ = 0;
      out.velocityX = 0; out.velocityY = 0; out.velocityZ = 0;
      return;
    }
    const sample = this.sampleKinematicsTarget;
    this.sample(x, z, sample);
    out.height = sample.x;
    out.slopeX = sample.y;
    out.slopeZ = sample.z;
    out.bed = this.sampleScalar(this.bed, x, z);
    out.depth = this.sampleScalar(this.depth, x, z);
    if (out.depth > DRY_DEPTH) {
      out.velocityX = this.sampleScalar(this.momentumX, x, z) / out.depth;
      out.velocityZ = this.sampleScalar(this.momentumZ, x, z) / out.depth;
      // Continuity on the PHYSICAL axis: dQ/dx = d(hu)/dx. Local spacings dx
      // and dz are the cell-width at (x, z); centred finite differences
      // converge to the correct derivative even on the nonuniform grid.
      //   dh/dt + d(hu)/dx + d(hv)/dz = 0
      //   dh/dt = -d(hu)/dx - d(hv)/dz
      // Converging flow (∂hu/∂x < 0) makes the free surface RISE.
      const dx = Math.max(this.cellWidths[this.bracket(x)]!, 1e-6);
      const dz = Math.max(this.cellWidths[this.bracket(z)]!, 1e-6);
      const mxp = this.sampleScalar(this.momentumX, x + dx, z);
      const mxm = this.sampleScalar(this.momentumX, x - dx, z);
      const mzp = this.sampleScalar(this.momentumZ, x, z + dz);
      const mzm = this.sampleScalar(this.momentumZ, x, z - dz);
      const dQdx = (mxp - mxm) / (2 * dx);
      const dQdz = (mzp - mzm) / (2 * dz);
      // Free-surface material velocity: w = eta_t + u*eta_x + v*eta_z.
      out.velocityY = -dQdx - dQdz
        + out.velocityX * out.slopeX + out.velocityZ * out.slopeZ;
    } else {
      out.velocityX = 0; out.velocityY = 0; out.velocityZ = 0;
    }
  }

  /** Incremental solid reaction. Net horizontal impulse is mandatory; available
   * work bounds the additional conservative displacement and radial wave.
   * Vertical momentum and the air cavity remain subgrid, not resolved 3D CFD. */
  coupleBody(
    x: number, z: number, radius: number, displacedVolume: number,
    impulseX: number, impulseZ: number, energy: number,
  ): number {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius)
      || !Number.isFinite(displacedVolume) || !Number.isFinite(impulseX)
      || !Number.isFinite(impulseZ) || !Number.isFinite(energy)
      || radius <= 0 || displacedVolume < 0 || energy < 0
      || Math.abs(x) >= 100 || Math.abs(z) >= 100) return 0;
    if (displacedVolume === 0 && impulseX === 0 && impulseZ === 0 && energy === 0) return 0;
    const width = this.sourceFootprint(x, z, radius);
    let cavityWeight = 0, rimWeight = 0, impulseWeight = 0;
    for (let n = 0; n < this.touchedCount; n++) {
      const i = this.touchedIndices[n]!, h = this.depth[i]!;
      this.touchedCoeff[n] = 0;
      if (h <= DRY_DEPTH) continue;
      const dx = this.axis[i % SIZE]! - x, dz = this.axis[(i / SIZE) | 0]! - z;
      const r2 = (dx * dx + dz * dz) / (width * width);
      const rim = r2 * Math.exp(-1.25 * r2), area = this.touchedCellArea[n]!;
      this.touchedCoeff[n] = rim;
      cavityWeight += this.touchedWeight[n]! * area;
      rimWeight += rim * area;
      impulseWeight += 1000 * h * area * this.touchedWeight[n]!;
    }
    if (impulseWeight <= 0) return 0;
    let impulseEnergy = 0;
    if (impulseX !== 0 || impulseZ !== 0) {
      for (let n = 0; n < this.touchedCount; n++) {
        const i = this.touchedIndices[n]!, h = this.depth[i]!;
        if (h <= DRY_DEPTH) continue;
        const scale = h * this.touchedWeight[n]! / impulseWeight;
        const mx = this.momentumX[i]!, mz = this.momentumZ[i]!;
        const nextX = mx + impulseX * scale, nextZ = mz + impulseZ * scale;
        impulseEnergy += 500 * this.touchedCellArea[n]!
          * (nextX * nextX + nextZ * nextZ - mx * mx - mz * mz) / h;
        // Arrays hold h*u, so rho*sum(cellArea*deltaMomentum) equals J.
        this.momentumX[i] = nextX;
        this.momentumZ[i] = nextZ;
      }
    }
    let remaining = Math.max(0, energy - Math.max(0, impulseEnergy));
    let negativeVolume = 0;
    if (cavityWeight > 0 && rimWeight > 0) {
      for (let n = 0; n < this.touchedCount; n++) {
        const i = this.touchedIndices[n]!;
        if (this.depth[i]! <= DRY_DEPTH) continue;
        const coefficient = this.touchedCoeff[n]! / rimWeight - this.touchedWeight[n]! / cavityWeight;
        this.touchedCoeff[n] = coefficient;
        negativeVolume += Math.max(0, -coefficient) * this.touchedCellArea[n]!;
      }
    }
    let volume = negativeVolume > 1e-12 ? displacedVolume : 0;
    if (volume > 0) {
      // The two kernels overlap. Normalize the signed shape so the actual
      // removed volume and added volume are both exactly the requested V.
      for (let n = 0; n < this.touchedCount; n++) {
        const coefficient = this.touchedCoeff[n]! / negativeVolume;
        this.touchedCoeff[n] = coefficient;
        if (coefficient >= 0) continue;
        const h = this.depth[this.touchedIndices[n]!]!;
        const reserve = Math.max(DRY_DEPTH * 1.01, h * 0.05);
        volume = Math.min(volume, Math.max(0, (h - reserve) / -coefficient));
      }
      let cost = this.displacementCost(volume);
      if (cost > remaining) {
        let low = 0, high = volume;
        for (let iteration = 0; iteration < 24; iteration++) {
          const mid = (low + high) * 0.5;
          if (this.displacementCost(mid) > remaining) high = mid; else low = mid;
        }
        volume = low;
        cost = this.displacementCost(volume);
      }
      for (let n = 0; n < this.touchedCount; n++) {
        const i = this.touchedIndices[n]!;
        this.depth[i] += volume * this.touchedCoeff[n]!;
      }
      // Keep momenta fixed: moving the height field must not manufacture a
      // second net impulse. Negative mechanical cost is allowed to dissipate.
      remaining = Math.max(0, remaining - Math.max(0, cost));
    }
    if (remaining > 0) this.radialWave(x, z, width, remaining);
    this.refreshTouched();
    return volume;
  }

  private displacementCost(volume: number): number {
    let cost = 0;
    for (let n = 0; n < this.touchedCount; n++) {
      const dh = volume * this.touchedCoeff[n]!;
      if (dh === 0) continue;
      const i = this.touchedIndices[n]!, h = this.depth[i]!, area = this.touchedCellArea[n]!;
      const mx = this.momentumX[i]!, mz = this.momentumZ[i]!;
      cost += 1000 * GRAVITY * area * dh * (this.bed[i]! + h + dh * 0.5)
        + 500 * area * (mx * mx + mz * mz) * (1 / (h + dh) - 1 / h);
    }
    return cost;
  }

  /** Remove actual water and its momentum/energy; never just spawn mass. */
  takeWater(
    x: number, z: number, radius: number, requestedVolume: number,
    out: WaterParcel, annular = false,
  ): void {
    out.volume = out.momentumX = out.momentumZ = out.kineticEnergy = out.potentialEnergy = 0;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius)
      || !Number.isFinite(requestedVolume) || radius <= 0 || requestedVolume <= 0
      || Math.abs(x) >= 100 || Math.abs(z) >= 100) return;
    this.sourceFootprint(x, z, radius, annular);
    let weight = 0;
    for (let n = 0; n < this.touchedCount; n++) {
      if (this.depth[this.touchedIndices[n]!]! > DRY_DEPTH) {
        weight += this.touchedWeight[n]! * this.touchedCellArea[n]!;
      }
    }
    if (weight <= 0) return;
    for (let n = 0; n < this.touchedCount; n++) {
      const i = this.touchedIndices[n]!, h = this.depth[i]!;
      if (h <= DRY_DEPTH) continue;
      const reserve = Math.max(DRY_DEPTH * 1.01, h * 0.05);
      const removed = Math.min(Math.max(0, h - reserve), requestedVolume * this.touchedWeight[n]! / weight);
      const volume = removed * this.touchedCellArea[n]!;
      const u = this.momentumX[i]! / h, v = this.momentumZ[i]! / h;
      out.volume += volume;
      out.momentumX += 1000 * volume * u;
      out.momentumZ += 1000 * volume * v;
      out.kineticEnergy += 500 * volume * (u * u + v * v);
      out.potentialEnergy += 1000 * GRAVITY * volume * (this.bed[i]! + h - removed * 0.5);
      this.depth[i] = h - removed;
      this.momentumX[i] *= (h - removed) / h;
      this.momentumZ[i] *= (h - removed) / h;
    }
    this.refreshTouched();
  }

  /** Deposit every returned parcel, including onto dry beach cells. Returns
   * the actual mechanical-energy change after mixing, not the parcel's KE. */
  returnWater(x: number, z: number, radius: number, volume: number, vx: number, vz: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius)
      || !Number.isFinite(volume) || !Number.isFinite(vx) || !Number.isFinite(vz)
      || radius <= 0 || volume <= 0 || Math.abs(x) >= 100 || Math.abs(z) >= 100) return 0;
    this.sourceFootprint(x, z, radius);
    let weight = 0, energy = 0;
    for (let n = 0; n < this.touchedCount; n++) weight += this.touchedWeight[n]! * this.touchedCellArea[n]!;
    if (weight <= 0) return 0;
    for (let n = 0; n < this.touchedCount; n++) {
      const i = this.touchedIndices[n]!, area = this.touchedCellArea[n]!;
      const dh = volume * this.touchedWeight[n]! / weight, h = this.depth[i]!;
      const mx = this.momentumX[i]!, mz = this.momentumZ[i]!;
      const nextH = h + dh, nextX = mx + dh * vx, nextZ = mz + dh * vz;
      const before = h > 0 ? (mx * mx + mz * mz) / h : 0;
      energy += 500 * area * ((nextX * nextX + nextZ * nextZ) / nextH - before)
        + 1000 * GRAVITY * area * dh * (this.bed[i]! + h + dh * 0.5);
      this.depth[i] = nextH;
      this.momentumX[i] = nextX;
      this.momentumZ[i] = nextZ;
    }
    this.refreshTouched();
    return energy;
  }

  /** Reuse bounded support for sources; cell areas appear once, in integrals. */
  private sourceFootprint(x: number, z: number, radius: number, annular = false): number {
    const width = Math.max(radius * 1.4, 1.5 * this.cellWidths[this.bracket(x)]!,
      1.5 * this.cellWidths[this.bracket(z)]!);
    const support = width * Math.sqrt(6);
    const x0 = this.bracket(x - support), x1 = Math.min(SIZE - 1, this.bracket(x + support) + 1);
    const z0 = this.bracket(z - support), z1 = Math.min(SIZE - 1, this.bracket(z + support) + 1);
    this.touchedCount = 0;
    for (let j = z0; j <= z1; j++) {
      const dz = this.axis[j]! - z;
      for (let k = x0; k <= x1; k++) {
        const dx = this.axis[k]! - x, q = (dx * dx + dz * dz) / (width * width);
        if (q > 6) continue;
        const n = this.touchedCount++;
        this.touchedIndices[n] = j * SIZE + k;
        this.touchedCellArea[n] = this.cellWidths[k]! * this.cellWidths[j]!;
        this.touchedWeight[n] = annular ? q * Math.exp(-1.25 * q) : Math.exp(-q);
      }
    }
    return width;
  }

  private radialWave(x: number, z: number, width: number, work: number): void {
    let weight = 0, meanX = 0, meanZ = 0;
    for (let n = 0; n < this.touchedCount; n++) {
      const i = this.touchedIndices[n]!, h = this.depth[i]!;
      if (h <= DRY_DEPTH) continue;
      const weightedMass = 1000 * h * this.touchedCellArea[n]! * this.touchedWeight[n]!;
      weight += weightedMass;
      meanX += weightedMass * (this.axis[i % SIZE]! - x) / width;
      meanZ += weightedMass * (this.axis[(i / SIZE) | 0]! - z) / width;
    }
    if (weight <= 0) return;
    meanX /= weight; meanZ /= weight;
    let a = 0, b = 0;
    for (let n = 0; n < this.touchedCount; n++) {
      const i = this.touchedIndices[n]!, h = this.depth[i]!;
      if (h <= DRY_DEPTH) continue;
      const kernel = this.touchedWeight[n]!, area = this.touchedCellArea[n]!;
      const rx = kernel * ((this.axis[i % SIZE]! - x) / width - meanX);
      const rz = kernel * ((this.axis[(i / SIZE) | 0]! - z) / width - meanZ);
      this.touchedRadialX[n] = rx; this.touchedRadialZ[n] = rz;
      a += 500 * h * area * (rx * rx + rz * rz);
      b += 1000 * area * (this.momentumX[i]! * rx + this.momentumZ[i]! * rz);
    }
    if (a <= 1e-20) return;
    // Exact KE increment a*s²+b*s=work, with a smooth zero-net-impulse shape.
    const root = Math.sqrt(b * b + 4 * a * work);
    const scale = b >= 0 ? 2 * work / (root + b) : (root - b) / (2 * a);
    for (let n = 0; n < this.touchedCount; n++) {
      const i = this.touchedIndices[n]!, h = this.depth[i]!;
      if (h <= DRY_DEPTH) continue;
      this.momentumX[i] += h * scale * this.touchedRadialX[n]!;
      this.momentumZ[i] += h * scale * this.touchedRadialZ[n]!;
    }
  }

  private refreshTouched(): void {
    for (let n = 0; n < this.touchedCount; n++) {
      const i = this.touchedIndices[n]!, h = this.depth[i]!, offset = i * 4;
      this.surfaceData[offset] = h + this.bed[i]!;
      this.surfaceData[offset + 1] = this.foam[i]!;
      this.surfaceData[offset + 2] = this.wetness[i]!;
      this.surfaceData[offset + 3] = h;
      this.flowData[offset] = h > DRY_DEPTH ? this.momentumX[i]! / h : 0;
      this.flowData[offset + 1] = h > DRY_DEPTH ? this.momentumZ[i]! / h : 0;
      this.flowData[offset + 2] = this.foamOffsetX[i]!;
      this.flowData[offset + 3] = this.foamOffsetZ[i]!;
    }
  }

  private bracket(value: number): number {
    let low = 0, high = SIZE - 1;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const middle = (low + high) >> 1;
      if (this.axis[middle]! < value) low = middle; else high = middle;
    }
    return Math.min(low, SIZE - 2);
  }

  private sampleScalar(data: Float64Array, x: number, z: number): number {
    const ix = this.bracket(x), iz = this.bracket(z);
    const fx = Math.min(1, Math.max(0, (x - this.axis[ix]!) / (this.axis[ix + 1]! - this.axis[ix]!)));
    const fz = Math.min(1, Math.max(0, (z - this.axis[iz]!) / (this.axis[iz + 1]! - this.axis[iz]!)));
    const i = iz * SIZE + ix;
    const a = data[i]! + (data[i + 1]! - data[i]!) * fx;
    const b = data[i + SIZE]! + (data[i + SIZE + 1]! - data[i + SIZE]!) * fx;
    return a + (b - a) * fz;
  }

  sampleChannel(data: Float32Array, x: number, z: number, channel: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const ix = this.bracket(x), iz = this.bracket(z);
    const fx = Math.min(1, Math.max(0, (x - this.axis[ix]!) / (this.axis[ix + 1]! - this.axis[ix]!)));
    const fz = Math.min(1, Math.max(0, (z - this.axis[iz]!) / (this.axis[iz + 1]! - this.axis[iz]!)));
    const i = (iz * SIZE + ix) * 4 + channel;
    const a = data[i]! + (data[i + 4]! - data[i]!) * fx;
    const b = data[i + SIZE * 4]! + (data[i + SIZE * 4 + 4]! - data[i + SIZE * 4]!) * fx;
    return a + (b - a) * fz;
  }

  sample(x: number, z: number, target: { x: number; y: number; z: number }): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) { target.x = target.y = target.z = 0; return; }
    // Nonuniform physical-axis C2 cubic B-spline. Physical knots a..f are
    // strictly increasing (axisAt() mirrors outer spacing) and bracket is
    // computed AFTER clamping so coefficients can never disagree with the
    // bracket. u = (x-c)/(d-c); control indices for the 4-tap stencil are
    // i-1, i, i+1, i+2 (i.e. b, c, d, e). GPU solvedSurface mirrors these
    // equations exactly so CPU and GLSL never disagree at a join.
    const axis0 = this.axis[0]!;
    const axisN = this.axis[SIZE - 1]!;
    const clampedX = x < axis0 ? axis0 : x > axisN ? axisN : x;
    const clampedZ = z < axis0 ? axis0 : z > axisN ? axisN : z;
    const ix = this.bracket(clampedX);
    const iz = this.bracket(clampedZ);
    const knotX = this.splineKnotX;
    const knotZ = this.splineKnotZ;
    const weightX = this.splineWeightX;
    const weightZ = this.splineWeightZ;
    const derivX = this.splineDerivX;
    const derivZ = this.splineDerivZ;
    // X physical six knots: a..f = axis(i-2)..axis(i+3) via axisAt.
    const aX = this.axisAt(ix - 2);
    const bX = this.axisAt(ix - 1);
    const cX = this.axisAt(ix);
    const dX = this.axisAt(ix + 1);
    const eX = this.axisAt(ix + 2);
    const fX = this.axisAt(ix + 3);
    // Stencil control indices for the 4-tap look: i-1, i, i+1, i+2 -> b..e.
    knotX[0] = ix - 1 < 0 ? 0 : ix - 1;
    knotX[1] = ix;
    knotX[2] = ix + 1 >= SIZE ? SIZE - 1 : ix + 1;
    knotX[3] = ix + 2 >= SIZE ? SIZE - 1 : ix + 2;
    const invDcX = 1 / (dX - cX);
    const invDbX = 1 / (dX - bX);
    const invEcX = 1 / (eX - cX);
    const invDaX = 1 / (dX - aX);
    const invEbX = 1 / (eX - bX);
    const invFcX = 1 / (fX - cX);
    const ux = (clampedX - cX) * invDcX;
    const ABx = (dX - clampedX) * invDbX * (1 - ux);
    const BBx = (clampedX - bX) * invDbX * (1 - ux) + (eX - clampedX) * invEcX * ux;
    const CBx = (clampedX - cX) * invEcX * ux;
    weightX[0] = (dX - clampedX) * invDaX * ABx;
    weightX[1] = (clampedX - aX) * invDaX * ABx + (eX - clampedX) * invEbX * BBx;
    weightX[2] = (clampedX - bX) * invEbX * BBx + (fX - clampedX) * invFcX * CBx;
    weightX[3] = (clampedX - cX) * invFcX * CBx;
    derivX[0] = -3 * ABx * invDaX;
    derivX[1] = 3 * ABx * invDaX - 3 * BBx * invEbX;
    derivX[2] = 3 * BBx * invEbX - 3 * CBx * invFcX;
    derivX[3] = 3 * CBx * invFcX;
    // Z physical six knots and stencil, same scheme.
    const aZ = this.axisAt(iz - 2);
    const bZ = this.axisAt(iz - 1);
    const cZ = this.axisAt(iz);
    const dZ = this.axisAt(iz + 1);
    const eZ = this.axisAt(iz + 2);
    const fZ = this.axisAt(iz + 3);
    knotZ[0] = iz - 1 < 0 ? 0 : iz - 1;
    knotZ[1] = iz;
    knotZ[2] = iz + 1 >= SIZE ? SIZE - 1 : iz + 1;
    knotZ[3] = iz + 2 >= SIZE ? SIZE - 1 : iz + 2;
    const invDcZ = 1 / (dZ - cZ);
    const invDbZ = 1 / (dZ - bZ);
    const invEcZ = 1 / (eZ - cZ);
    const invDaZ = 1 / (dZ - aZ);
    const invEbZ = 1 / (eZ - bZ);
    const invFcZ = 1 / (fZ - cZ);
    const uz = (clampedZ - cZ) * invDcZ;
    const ABz = (dZ - clampedZ) * invDbZ * (1 - uz);
    const BBz = (clampedZ - bZ) * invDbZ * (1 - uz) + (eZ - clampedZ) * invEcZ * uz;
    const CBz = (clampedZ - cZ) * invEcZ * uz;
    weightZ[0] = (dZ - clampedZ) * invDaZ * ABz;
    weightZ[1] = (clampedZ - aZ) * invDaZ * ABz + (eZ - clampedZ) * invEbZ * BBz;
    weightZ[2] = (clampedZ - bZ) * invEbZ * BBz + (fZ - clampedZ) * invFcZ * CBz;
    weightZ[3] = (clampedZ - cZ) * invFcZ * CBz;
    derivZ[0] = -3 * ABz * invDaZ;
    derivZ[1] = 3 * ABz * invDaZ - 3 * BBz * invEbZ;
    derivZ[2] = 3 * BBz * invEbZ - 3 * CBz * invFcZ;
    derivZ[3] = 3 * CBz * invFcZ;
    // 4x4 separable combine; dry-neighbor gating per knot so dry land never
    // lifts the rendered water surface. No per-call heap, only typed scratch.
    let eta = 0, gx = 0, gz = 0;
    for (let j = 0; j < 4; j += 1) {
      const rowOffset = knotZ[j]! * SIZE;
      const wj = weightZ[j]!, dwj = derivZ[j]!;
      let wetEta = 0, wetDu = 0;
      let p = (rowOffset + knotX[0]!) * 4;
      const g0 = this.surfaceData[p + 3]! > DRY_DEPTH ? 1 : 0;
      wetEta += g0 * weightX[0]! * this.surfaceData[p]!;
      wetDu += g0 * derivX[0]! * this.surfaceData[p]!;
      p = (rowOffset + knotX[1]!) * 4;
      const g1 = this.surfaceData[p + 3]! > DRY_DEPTH ? 1 : 0;
      wetEta += g1 * weightX[1]! * this.surfaceData[p]!;
      wetDu += g1 * derivX[1]! * this.surfaceData[p]!;
      p = (rowOffset + knotX[2]!) * 4;
      const g2 = this.surfaceData[p + 3]! > DRY_DEPTH ? 1 : 0;
      wetEta += g2 * weightX[2]! * this.surfaceData[p]!;
      wetDu += g2 * derivX[2]! * this.surfaceData[p]!;
      p = (rowOffset + knotX[3]!) * 4;
      const g3 = this.surfaceData[p + 3]! > DRY_DEPTH ? 1 : 0;
      wetEta += g3 * weightX[3]! * this.surfaceData[p]!;
      wetDu += g3 * derivX[3]! * this.surfaceData[p]!;
      eta += wj * wetEta;
      gx += wj * wetDu;
      gz += dwj * wetEta;
    }
    target.x = eta;
    // Independent per-axis outer clamps: a sample outside the grid along x
    // keeps the z gradient (and vice-versa) so a wave touching the edge still
    // has correct directional slope information on the in-bound axis.
    const insideX = x > axis0 && x < axisN ? 1 : 0;
    const insideZ = z > axis0 && z < axisN ? 1 : 0;
    target.y = gx * insideX;
    target.z = gz * insideZ;
  }

  pack(): void {
    for (let i = 0; i < this.depth.length; i += 1) {
      const h = this.depth[i]!, offset = i * 4;
      this.surfaceData[offset] = h + this.bed[i]!;
      this.surfaceData[offset + 1] = this.foam[i]!;
      this.surfaceData[offset + 2] = this.wetness[i]!;
      this.surfaceData[offset + 3] = h;
      this.flowData[offset] = h > DRY_DEPTH ? this.momentumX[i]! / h : 0;
      this.flowData[offset + 1] = h > DRY_DEPTH ? this.momentumZ[i]! / h : 0;
      this.flowData[offset + 2] = this.foamOffsetX[i]!;
      this.flowData[offset + 3] = this.foamOffsetZ[i]!;
    }
  }
}