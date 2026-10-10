// Deterministic irregular directional swell spectrum applied at the localised
// offshore wavemaker strip of the depth-averaged shallow-water solver. Five
// linearly independent Airy components are summed with a small directional
// spread around +Z; each component carries finite-depth linear dispersion
//
//     ω² = g·k·tanh(k·h)   →   c = ω/k = √(g·tanh(k·h) / k)
//
// so its phase speed varies with wavelength AND water depth instead of the old
// single shallow-water c = √(g·1.4) shared by every wavelength. The total
// field is written to the preallocated `target`; no allocation in the hot
// call, no analytic displacement anywhere over the solved shore.
//
// SCENE UNITS / SOLVER LIMITATION
// - World axes are metres: g = 9.81 m/s², wavelengths and depths in metres.
// - Inner cell width is ≈0.292 m so the shortest λ_min = 4 m resolves to
//   ≈13.7 cells and the longest λ_max = 17 m to ≈58 cells.
// - The host solver is depth-averaged; dispersion terms are only used to
//   derive the analytic supply at the forcing strip. Real propagation inside
//   the SWE remains governed by Audusse hydrostatic reconstruction plus
//   CFL. The amplitudes are physically plausible shapes — NOT engineering-
//   grade ocean spectra.

export interface IncidentWaveTarget {
  height: number;
  momentumX: number;
  momentumZ: number;
}

const G = 9.81;

// Recommended spectrum (main solver integration target).
//   λ [m]      : 4,    5.5,  8,    12,   17
//   A [m]      : .014, .022, .043, .027, .013     (ΣA ≈ 0.119 — bounded)
//   φ [rad]    : 0.0,  1.7,  3.4,  0.9,  2.3       (deterministic offsets)
//   θ [rad]    : +.07, -.04,  0,    +.05, -.08     (modest spread around +Z)
// Energy concentrates on the 8 m component (peak A = 0.043) with shorter
// 4–5.5 m ripples and a long 17 m swell underneath — irregular but zero-mean
// over time because each cosine is zero-mean in isolation.
const LAMBDA: readonly number[] = [4, 5.5, 8, 12, 17];
const AMPLITUDE: readonly number[] = [0.014, 0.022, 0.043, 0.027, 0.013];
const PHASE_OFFSET: readonly number[] = [0.0, 1.7, 3.4, 0.9, 2.3];
const THETA: readonly number[] = [0.07, -0.04, 0.0, 0.05, -0.08];

// Pre-computed, allocation-free component table. Filled once at module load;
// the hot path reads only typed-array slots.
const N = LAMBDA.length;
const KX = new Float64Array(N);
const KZ = new Float64Array(N);
const K = new Float64Array(N);
const GK = new Float64Array(N);
const DIRECTION_X = new Float64Array(N);
const DIRECTION_Z = new Float64Array(N);
const AMPS = new Float64Array(N);
const PHI = new Float64Array(N);
{
  const TWO_PI = 2 * Math.PI;
  for (let i = 0; i < N; i += 1) {
    const k = TWO_PI / LAMBDA[i]!;
    const theta = THETA[i]!;
    K[i] = k;
    KX[i] = k * Math.sin(theta);
    KZ[i] = k * Math.cos(theta);
    GK[i] = G * k;
    // Preserve the original rounded k-component ratios, rather than substituting trig.
    DIRECTION_X[i] = KX[i]! / k;
    DIRECTION_Z[i] = KZ[i]! / k;
    AMPS[i] = AMPLITUDE[i]!;
    PHI[i] = PHASE_OFFSET[i]!;
  }
}

// Consecutive offshore cells normally share a resting depth. Cache only that
// exact depth, so changing bathymetry or interleaving water instances cannot
// reuse another depth's dispersion. No approximation or per-sample allocation.
let dispersionDepth = NaN;
const OMEGA = new Float64Array(N);
const PHASE_SPEED = new Float64Array(N);

/**
 * Sample the incident-wave field at (x, z) at simulation time `time` over local
 * water column `depth`. Writes height and two horizontal momentum components
 * to `target` and returns. Never allocates. NaN/Infinity/≤0 inputs → zeroed
 * target so the SWE never ingests a poisoned source.
 */
export function sampleIncidentWave(
  x: number,
  z: number,
  time: number,
  depth: number,
  target: IncidentWaveTarget,
): void {
  if (
    !Number.isFinite(x) || !Number.isFinite(z) ||
    !Number.isFinite(time) || !Number.isFinite(depth) ||
    depth <= 0
  ) {
    target.height = 0;
    target.momentumX = 0;
    target.momentumZ = 0;
    return;
  }

  if (depth !== dispersionDepth) {
    for (let i = 0; i < N; i += 1) {
      const k = K[i]!;
      const kh = k * depth;
      const tanhKh = Math.tanh(kh);
      const omega = Math.sqrt(GK[i]! * tanhKh);
      OMEGA[i] = omega;
      PHASE_SPEED[i] = omega / k;
    }
    dispersionDepth = depth;
  }

  let etaSum = 0;
  let qxSum = 0;
  let qzSum = 0;

  for (let i = 0; i < N; i += 1) {
    const kx = KX[i]!;
    const kz = KZ[i]!;
    const omega = OMEGA[i]!;
    const c = PHASE_SPEED[i]!;

    // Traveling-wave phase: cos(k·r − ω·t + φ). Sign convention is the
    // physically consistent one for +k propagation; with θ ≈ 0 the wave
    // travels toward +Z, matching the host's wavemaker strip orientation.
    const phase = kx * x + kz * z - omega * time + PHI[i]!;
    const eta = AMPS[i]! * Math.cos(phase);

    etaSum += eta;
    // Linear-wave momentum flux q' = h̄·u ≈ c·η along the propagation
    // direction. Decomposed into world axes: qx = c·η·sin(θ), qz = c·η·cos(θ).
    // kx/k and kz/k are precomputed above — no per-sample trig or direction division.
    const qComp = c * eta;
    qxSum += qComp * DIRECTION_X[i]!;
    qzSum += qComp * DIRECTION_Z[i]!;
  }

  target.height = etaSum;
  target.momentumX = qxSum;
  target.momentumZ = qzSum;
}