/* Foam source scan, transport and per-cell update.
 * Strict float64, no fast-math, reassociation or FMA. Float32 axis operands
 * promote to double before subtraction. No heap, no per-cell JS callbacks;
 * the host iterates returned candidates to close Math.hypot / Math.exp on
 * the same libm path as the original JS. */

#include "water-fields.h"

static const double GRAVITY = 9.81;
static const double DRY_DEPTH = 1e-5;

/* Per-instance scratch; updated after the full sweep to keep the read
 * and write sets disjoint, matching the original foamNext / offsetNext
 * pair that gets copied back once. */
static double foam_next[NN];
static double offset_next_x[NN];
static double offset_next_z[NN];

/* CFL-limited transport normally stays beside its source cell. Verify the
 * interval before taking that shortcut; retain the lower bracket at knots
 * and the full search for longer displacements or non-finite input. */
static int32_t bracket(double value, int32_t source_cell) {
  int32_t nearby = value <= (double)axis[source_cell] ? source_cell - 1 : source_cell;
  if (nearby >= 0 && nearby < N - 1
      && (double)axis[nearby] < value && value <= (double)axis[nearby + 1]) {
    return nearby;
  }
  int32_t low = 0;
  int32_t high = 128 - 1;
  for (int32_t iteration = 0; iteration < 8; iteration += 1) {
    int32_t middle = (low + high) >> 1;
    double knot = (double)axis[middle];
    if (knot < value) low = middle; else high = middle;
  }
  return low < 128 - 2 ? low : 128 - 2;
}

/* Foam + weighted offsets at an arbitrary (x, z); mirrors the original
 * (a + b) + c + d grouping. Stack scalar results; no allocation. */
static void transport_foam(double x, double z, int32_t source_x, int32_t source_z,
                           double *out_foam,
                           double *out_offset_x,
                           double *out_offset_z) {
  int32_t ix = bracket(x, source_x);
  int32_t iz = bracket(z, source_z);
  double ax_lo = (double)axis[ix];
  double ax_hi = (double)axis[ix + 1];
  double az_lo = (double)axis[iz];
  double az_hi = (double)axis[iz + 1];
  double span_x = ax_hi - ax_lo;
  double span_z = az_hi - az_lo;
  double fx = (x - ax_lo) / span_x;
  double fz = (z - az_lo) / span_z;
  fx = __builtin_wasm_min_f64(1.0, __builtin_wasm_max_f64(0.0, fx));
  fz = __builtin_wasm_min_f64(1.0, __builtin_wasm_max_f64(0.0, fz));
  int32_t i = iz * 128 + ix;
  double a = foam[i] * (1.0 - fx) * (1.0 - fz);
  double b = foam[i + 1] * fx * (1.0 - fz);
  double c = foam[i + 128] * (1.0 - fx) * fz;
  double d = foam[i + 128 + 1] * fx * fz;
  double total = a + b + c + d;
  *out_foam = total;
  if (total > 1e-12) {
    *out_offset_x = (a * foam_offset_x[i]
                     + b * foam_offset_x[i + 1]
                     + c * foam_offset_x[i + 128]
                     + d * foam_offset_x[i + 128 + 1]) / total;
    *out_offset_z = (a * foam_offset_z[i]
                     + b * foam_offset_z[i + 1]
                     + c * foam_offset_z[i + 128]
                     + d * foam_offset_z[i + 128 + 1]) / total;
  } else {
    *out_offset_x = 0.0;
    *out_offset_z = 0.0;
  }
}

/* Depth-driven wetness saturation, same smoothstep as the JS helper. */
static double wetness_target(double h, double film, double full) {
  if (!__builtin_isfinite(h) || h <= film) return 0.0;
  if (h >= full) return 1.0;
  double span = full - film;
  double t = (h - film) / span;
  return t * t * (3.0 - 2.0 * t);
}

static double wetness_step(double current, double h,
                           double rise, double fall,
                           double film, double full) {
  double target = wetness_target(h, film, full);
  double tau = target > current ? rise : fall;
  return current + (target - current) * tau;
}

/* Eligibility + compression. The host closes Math.hypot / Math.exp on the
 * returned candidates; this routine records the per-cell compression that
 * survived the gate. */
WASM_EXPORT(int32_t, prepare_foam_sources) (void) {
  int32_t count = 0;
  for (int32_t z = 0; z < 128; z += 1) {
    int32_t lower_z = z - 1; if (lower_z < 0) lower_z = 0;
    int32_t upper_z = z + 1; if (upper_z > 128 - 1) upper_z = 128 - 1;
    double span_z = (double)axis[upper_z] - (double)axis[lower_z];
    for (int32_t x = 0; x < 128; x += 1) {
      int32_t i = z * 128 + x;
      foam_source_step[i] = 0.0;
      double h = depth[i];
      double nx = shore_normal_x[i];
      double nz = shore_normal_z[i];
      int32_t in_shore = (nx != 0.0) || (nz != 0.0);
      if (!in_shore) continue;
      if (!(h > DRY_DEPTH)) continue;
      double u = velocity_x[i];
      double v = velocity_z[i];
      double eta = h + bed[i];
      double incoming = u * nx + v * nz;
      if (!(incoming > 0.03)) continue;
      if (!(eta > 0.025)) continue;
      int32_t lower_x = x - 1; if (lower_x < 0) lower_x = 0;
      int32_t upper_x = x + 1; if (upper_x > 128 - 1) upper_x = 128 - 1;
      double span_x = (double)axis[upper_x] - (double)axis[lower_x];
      int32_t left = z * 128 + lower_x;
      int32_t right = z * 128 + upper_x;
      int32_t lower = lower_z * 128 + x;
      int32_t upper = upper_z * 128 + x;
      double dvx = velocity_x[right] - velocity_x[left];
      double dvz = velocity_z[upper] - velocity_z[lower];
      double compression_raw = __builtin_wasm_max_f64(0.0, -dvx / span_x - dvz / span_z);
      if (!(compression_raw > 0.08)) continue;
      foam_candidates[count] = (uint32_t)i;
      foam_compression[count] = compression_raw;
      count += 1;
    }
  }
  return count;
}

/* Original updateFoam remainder: shore impulses, transport via the 9-cell
 * non-zero stencil, residual / concentration / offsets, depth-driven
 * wetness. Scratch is copied back after the sweep. */
WASM_EXPORT(void, update_foam) (double dt,
                                double decay,
                                double wet_rise,
                                double wet_fall,
                                double wet_film,
                                double wet_full) {
  for (int32_t z = 0; z < 128; z += 1) {
    int32_t lower_z = z - 1; if (lower_z < 0) lower_z = 0;
    int32_t upper_z = z + 1; if (upper_z > 128 - 1) upper_z = 128 - 1;
    for (int32_t x = 0; x < 128; x += 1) {
      int32_t lower_x = x - 1; if (lower_x < 0) lower_x = 0;
      int32_t upper_x = x + 1; if (upper_x > 128 - 1) upper_x = 128 - 1;
      int32_t i = z * 128 + x;
      int32_t left = z * 128 + lower_x;
      int32_t right = z * 128 + upper_x;
      int32_t lower = lower_z * 128 + x;
      int32_t upper = upper_z * 128 + x;
      double h = depth[i];
      double u = velocity_x[i];
      double v = velocity_z[i];
      double eta = h + bed[i];
      double nx = shore_normal_x[i];
      double nz = shore_normal_z[i];
      int32_t in_shore = (nx != 0.0) || (nz != 0.0);
      double incoming = u * nx + v * nz;

      if (h > DRY_DEPTH && in_shore && incoming > 0.03 && eta > 0.06) {
        double resting = __builtin_wasm_max_f64(0.0, -bed[i]);
        double load = 0.5 * GRAVITY * __builtin_wasm_max_f64(0.0, h * h - resting * resting)
          + h * incoming * incoming;
        shore_impulse_x[i] += load * dt * nx;
        shore_impulse_z[i] += load * dt * nz;
      }

      double transported = foam[i];
      double offset_x = foam_offset_x[i];
      double offset_z = foam_offset_z[i];
      if (h > DRY_DEPTH && (u != 0.0 || v != 0.0)) {
        int32_t ll = lower_z * 128 + lower_x;
        int32_t lu = lower_z * 128 + upper_x;
        int32_t ul = upper_z * 128 + lower_x;
        int32_t uu = upper_z * 128 + upper_x;
        int32_t nonzero = transported != 0.0
          || foam[left] != 0.0
          || foam[right] != 0.0
          || foam[lower] != 0.0
          || foam[upper] != 0.0
          || foam[ll] != 0.0
          || foam[lu] != 0.0
          || foam[ul] != 0.0
          || foam[uu] != 0.0;
        if (nonzero) {
          double sample_x = (double)axis[x] - u * dt;
          double sample_z = (double)axis[z] - v * dt;
          double t_foam = 0.0, t_ox = 0.0, t_oz = 0.0;
          transport_foam(sample_x, sample_z, x, z, &t_foam, &t_ox, &t_oz);
          transported = t_foam;
          offset_x = t_ox - u * dt;
          offset_z = t_oz - v * dt;
        }
      }

      double residual = transported * decay;
      double entrainment = foam_source_step[i];
      double inv_residual = 1.0 - residual;
      double concentration = residual + inv_residual * entrainment;
      foam_next[i] = concentration;
      double retained = concentration > 1e-6 ? residual / concentration : 0.0;
      offset_next_x[i] = offset_x * retained;
      offset_next_z[i] = offset_z * retained;
      wetness[i] = wetness_step(wetness[i], h, wet_rise, wet_fall, wet_film, wet_full);

    }
  }
  for (int32_t i = 0; i < NN; i += 1) {
    foam[i] = foam_next[i];
    foam_offset_x[i] = offset_next_x[i];
    foam_offset_z[i] = offset_next_z[i];
  }
}
