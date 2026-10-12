/* Strict float64 finite-volume RK stage; keep the JS expression/traversal order.
 * Each instance owns its C arrays. The host maps field views into exported
 * memory; scratch stays native. No fast-math, reassociation or FMA.
 * compute_stage returns -1 or a failing cell; failure_h preserves its value. */

#include "water-fields.h"
#include <wasm_simd128.h>

/* Two independent float64 lanes; ordinary arithmetic keeps scalar grouping.
 * Use IEEE min/max, not the faster pseudo-min/max that differ for NaN/-0. */
typedef double f64x2 __attribute__((vector_size(16)));
static inline f64x2 load2(const double *p) { return (f64x2)wasm_v128_load(p); }
static inline void store2(double *p, f64x2 v) { wasm_v128_store(p, (v128_t)v); }
static inline f64x2 splat2(double v) { return (f64x2){v, v}; }
static inline f64x2 min2(f64x2 a, f64x2 b) {
  return (f64x2)wasm_f64x2_min((v128_t)a, (v128_t)b);
}
static inline f64x2 max2(f64x2 a, f64x2 b) {
  return (f64x2)wasm_f64x2_max((v128_t)a, (v128_t)b);
}
static inline f64x2 sqrt2(f64x2 v) { return (f64x2)wasm_f64x2_sqrt((v128_t)v); }
static inline f64x2 abs2(f64x2 v) { return (f64x2)wasm_f64x2_abs((v128_t)v); }
static inline f64x2 choose2(v128_t mask, f64x2 yes, f64x2 no) {
  return (f64x2)wasm_v128_bitselect((v128_t)yes, (v128_t)no, mask);
}
static inline f64x2 axis2(int32_t k) {
  return (f64x2)wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(axis + k));
}

static const double GRAVITY = 9.81;
static const double DRY_DEPTH = 1e-5;

/* Instance-local fields shared by the numerical kernels and host views. */
double bed[NN], depth[NN], momentum_x[NN], momentum_z[NN];
double velocity_x[NN], velocity_z[NN], cell_widths[N];
float axis[N];
double foam[NN], wetness[NN], foam_offset_x[NN], foam_offset_z[NN];
double shore_normal_x[NN], shore_normal_z[NN], shore_impulse_x[NN], shore_impulse_z[NN];
uint32_t foam_candidates[NN];
double foam_compression[NN], foam_source_step[NN];

/* -------- Private scratch. Same lifetime as the kernel instance, in
 * native memory, never aliased to a JS view. */

static double delta_depth[N * N];
static double delta_x[N * N];
static double delta_z[N * N];
static double slope_eta[N * N];
static double slope_u[N * N];
static double slope_v[N * N];
static double face_scale[N];

static double last_failure_h = 0.0;

/* Regularised van-Albada slope, including Math.max's NaN semantics. */

static inline f64x2 limited_slope2(f64x2 a, f64x2 b, f64x2 smooth_scale) {
  f64x2 epsilon = smooth_scale * smooth_scale;
  f64x2 smooth = max2(splat2(0.0), a * b);
  f64x2 num = (a + b) * (0.5 * epsilon + smooth);
  f64x2 den = a * a + b * b + epsilon;
  return num / den;
}

/* -------- Update velocityX / velocityZ from depth and momentum. */

WASM_EXPORT(void, update_velocities) (void) {
  for (int32_t i = 0; i < NN; i += 1) {
    double h = depth[i];
    double vx = h > DRY_DEPTH ? momentum_x[i] / h : 0.0;
    double vz = h > DRY_DEPTH ? momentum_z[i] / h : 0.0;
    velocity_x[i] = vx;
    velocity_z[i] = vz;
  }
}

/* -------- MUSCL reconstruction. isX chooses the traversal direction
 * (1 = X stride, 0 = Z stride). The slopeEta / slopeU / slopeV
 * computation mirrors the JS source expression-by-expression,
 * including the `eta - depth[prev] - bed[prev]` form (NOT a single
 * `eta - (depth[prev] + bed[prev])` subtraction) so the rounding
 * matches the JS reference bit-for-bit. */

static __attribute__((always_inline)) inline void reconstruct_states(int32_t is_x) {
  int32_t stride = is_x ? 1 : N;
  const double *restrict normal = is_x ? velocity_x : velocity_z;
  const double *restrict tangent = is_x ? velocity_z : velocity_x;
  f64x2 zero = splat2(0.0);
  for (int32_t k = 0; k < N; k++) {
    int32_t first = is_x ? k * N : k;
    int32_t last = is_x ? first + N - 1 : (N - 1) * N + k;
    slope_eta[first] = slope_u[first] = slope_v[first] = 0.0;
    slope_eta[last] = slope_u[last] = slope_v[last] = 0.0;
  }
  /* Both interiors contain an even number of adjacent X cells. The last
   * lane's neighbour stays within column 127 or row 127, respectively. */
  for (int32_t z = is_x ? 0 : 1; z < (is_x ? N : N - 1); z++) {
    for (int32_t x = is_x ? 1 : 0; x < (is_x ? N - 1 : N); x += 2) {
      int32_t i = z * N + x;
      int32_t k = is_x ? x : z;
      int32_t prev = i - stride, next = i + stride;
      f64x2 h = load2(depth + i);
      f64x2 h_prev = load2(depth + prev), h_next = load2(depth + next);
      v128_t dry = (v128_t)((h <= DRY_DEPTH) | (h_prev <= DRY_DEPTH) | (h_next <= DRY_DEPTH));
      if (wasm_i64x2_all_true(dry)) {
        store2(slope_eta + i, zero);
        store2(slope_u + i, zero);
        store2(slope_v + i, zero);
        continue;
      }
      f64x2 before = is_x ? axis2(k) - axis2(k - 1)
        : splat2((double)axis[k] - (double)axis[k - 1]);
      f64x2 after = is_x ? axis2(k + 1) - axis2(k)
        : splat2((double)axis[k + 1] - (double)axis[k]);
      f64x2 half = (is_x ? load2(cell_widths + k) : splat2(cell_widths[k])) * 0.5;
      f64x2 eta = h + load2(bed + i);
      f64x2 d_left = half * (eta - h_prev - load2(bed + prev)) / before;
      f64x2 d_right = half * (h_next + load2(bed + next) - eta) / after;
      f64x2 delta = limited_slope2(d_left, d_right, 0.005 * h);
      /* Math.sign preserves both signed zero and NaN; dry masks use <=,
       * not an inverted > comparison, so a NaN lane is not silently dried. */
      f64x2 sign = choose2((v128_t)((delta == 0.0) | (delta != delta)), delta,
        choose2((v128_t)(delta < 0.0), splat2(-1.0), splat2(1.0)));
      store2(slope_eta + i, choose2(dry, zero, sign * min2(abs2(delta), h)));
      f64x2 velocity_scale = 0.005 * sqrt2(GRAVITY * h);
      f64x2 u = load2(normal + i), v = load2(tangent + i);
      f64x2 n_left = half * (u - load2(normal + prev)) / before;
      f64x2 n_right = half * (load2(normal + next) - u) / after;
      store2(slope_u + i, choose2(dry, zero, limited_slope2(n_left, n_right, velocity_scale)));
      f64x2 t_left = half * (v - load2(tangent + prev)) / before;
      f64x2 t_right = half * (load2(tangent + next) - v) / after;
      store2(slope_v + i, choose2(dry, zero, limited_slope2(t_left, t_right, velocity_scale)));
    }
  }
}

/* Hydrostatic HLL flux; the cell-centre pressure baseline balances topography. */
static __attribute__((always_inline)) inline void face(int32_t left, int32_t right, int32_t is_x) {
  double hL = __builtin_wasm_max_f64(0.0, depth[left] + slope_eta[left]);
  double hR = __builtin_wasm_max_f64(0.0, depth[right] - slope_eta[right]);
  double bed_max = __builtin_wasm_max_f64(bed[left], bed[right]);
  double a = __builtin_wasm_max_f64(0.0, hL + bed[left] - bed_max);
  double b = __builtin_wasm_max_f64(0.0, hR + bed[right] - bed_max);
  const double *restrict normal  = is_x ? velocity_x : velocity_z;
  const double *restrict tangent = is_x ? velocity_z : velocity_x;
  double uL = a > DRY_DEPTH ? normal[left]  + slope_u[left]  : 0.0;
  double uR = b > DRY_DEPTH ? normal[right] - slope_u[right] : 0.0;
  double vL = a > DRY_DEPTH ? tangent[left]  + slope_v[left]  : 0.0;
  double vR = b > DRY_DEPTH ? tangent[right] - slope_v[right] : 0.0;
  double cL = __builtin_sqrt(GRAVITY * a);
  double cR = __builtin_sqrt(GRAVITY * b);
  /* sL = Math.min(0, a <= DRY_DEPTH ? uR - 2*cR : Math.min(uL - cL, uR - cR)).
   * The outer Math.min(0, …) is preserved for BOTH branches. */
  double sL;
  {
    double inner = a <= DRY_DEPTH
      ? (uR - 2.0 * cR)
      : __builtin_wasm_min_f64(uL - cL, uR - cR);
    sL = __builtin_wasm_min_f64(0.0, inner);
  }
  double sR;
  {
    double inner = b <= DRY_DEPTH
      ? (uL + 2.0 * cL)
      : __builtin_wasm_max_f64(uL + cL, uR + cR);
    sR = __builtin_wasm_max_f64(0.0, inner);
  }
  double inv;
  if (sR > sL) inv = 1.0 / (sR - sL);
  else inv = 0.0;
  double mass = (sR * a * uL - sL * b * uR + sL * sR * (b - a)) * inv;
  double pressure_flux = (sR * (a * uL * uL + 0.5 * GRAVITY * a * a)
                         - sL * (b * uR * uR + 0.5 * GRAVITY * b * b)
                         + sL * sR * (b * uR - a * uL)) * inv;
  double transverse = (sR * a * uL * vL - sL * b * uR * vR
                       + sL * sR * (b * vR - a * vL)) * inv;
  double norm_l = pressure_flux + 0.5 * GRAVITY * (hL * hL - a * a - depth[left] * depth[left]);
  double norm_r = pressure_flux + 0.5 * GRAVITY * (hR * hR - b * b - depth[right] * depth[right]);
  int32_t kL = is_x ? (left % N) : (left / N);
  int32_t kR = is_x ? (right % N) : (right / N);
  double scaleL = face_scale[kL];
  double scaleR = face_scale[kR];
  delta_depth[left]   -= scaleL * mass;
  delta_depth[right]  += scaleR * mass;
  double *restrict delta_n = is_x ? delta_x : delta_z;
  double *restrict delta_t = is_x ? delta_z : delta_x;
  delta_n[left]  -= scaleL * norm_l;
  delta_n[right] += scaleR * norm_r;
  delta_t[left]  -= scaleL * transverse;
  delta_t[right] += scaleR * transverse;
}

/* Lane k is face(left+k, right+k), including for Z-directed faces. */
static __attribute__((always_inline)) inline void face_pair(int32_t left, int32_t right, int32_t is_x) {
  f64x2 zero = splat2(0.0);
  f64x2 depthL = load2(depth + left), depthR = load2(depth + right);
  f64x2 bedL = load2(bed + left), bedR = load2(bed + right);
  f64x2 hL = max2(zero, depthL + load2(slope_eta + left));
  f64x2 hR = max2(zero, depthR - load2(slope_eta + right));
  f64x2 bed_max = max2(bedL, bedR);
  f64x2 a = max2(zero, hL + bedL - bed_max);
  f64x2 b = max2(zero, hR + bedR - bed_max);
  const double *restrict normal = is_x ? velocity_x : velocity_z;
  const double *restrict tangent = is_x ? velocity_z : velocity_x;
  f64x2 uL = choose2((v128_t)(a > DRY_DEPTH), load2(normal + left) + load2(slope_u + left), zero);
  f64x2 uR = choose2((v128_t)(b > DRY_DEPTH), load2(normal + right) - load2(slope_u + right), zero);
  f64x2 vL = choose2((v128_t)(a > DRY_DEPTH), load2(tangent + left) + load2(slope_v + left), zero);
  f64x2 vR = choose2((v128_t)(b > DRY_DEPTH), load2(tangent + right) - load2(slope_v + right), zero);
  f64x2 cL = sqrt2(GRAVITY * a), cR = sqrt2(GRAVITY * b);
  f64x2 sL = min2(zero, choose2((v128_t)(a <= DRY_DEPTH),
    uR - 2.0 * cR, min2(uL - cL, uR - cR)));
  f64x2 sR = max2(zero, choose2((v128_t)(b <= DRY_DEPTH),
    uL + 2.0 * cL, max2(uL + cL, uR + cR)));
  f64x2 inv = choose2((v128_t)(sR > sL), 1.0 / (sR - sL), zero);
  f64x2 mass = (sR * a * uL - sL * b * uR + sL * sR * (b - a)) * inv;
  f64x2 pressure_flux = (sR * (a * uL * uL + 0.5 * GRAVITY * a * a)
                       - sL * (b * uR * uR + 0.5 * GRAVITY * b * b)
                       + sL * sR * (b * uR - a * uL)) * inv;
  f64x2 transverse = (sR * a * uL * vL - sL * b * uR * vR
                     + sL * sR * (b * vR - a * vL)) * inv;
  f64x2 norm_l = pressure_flux + 0.5 * GRAVITY * (hL * hL - a * a - depthL * depthL);
  f64x2 norm_r = pressure_flux + 0.5 * GRAVITY * (hR * hR - b * b - depthR * depthR);
  int32_t kL = is_x ? left % N : left / N;
  int32_t kR = is_x ? right % N : right / N;
  f64x2 scaleL = is_x ? load2(face_scale + kL) : splat2(face_scale[kL]);
  f64x2 scaleR = is_x ? load2(face_scale + kR) : splat2(face_scale[kR]);
  double *restrict delta_n = is_x ? delta_x : delta_z;
  double *restrict delta_t = is_x ? delta_z : delta_x;
  /* Right adds BEFORE left subtracts, with a fresh left load. X pairs share
   * their middle cell: it must receive face 0's add before face 1's subtract.
   * The outer cells (and all Z lanes) are independent. Never merge these. */
  store2(delta_depth + right, load2(delta_depth + right) + scaleR * mass);
  store2(delta_depth + left, load2(delta_depth + left) - scaleL * mass);
  store2(delta_n + right, load2(delta_n + right) + scaleR * norm_r);
  store2(delta_n + left, load2(delta_n + left) - scaleL * norm_l);
  store2(delta_t + right, load2(delta_t + right) + scaleR * transverse);
  store2(delta_t + left, load2(delta_t + left) - scaleL * transverse);
}

/* -------- Transmissive boundary contributions. */

static void boundary_fluxes(double dt) {
  double scale_left  = dt / cell_widths[0];
  double scale_right = dt / cell_widths[N - 1];
  for (int32_t k = 0; k < N; k += 1) {
    {
      int32_t i = k * N;
      double q = momentum_x[i];
      delta_depth[i] += scale_left * q;
      delta_x[i]     += scale_left * q * velocity_x[i];
      delta_z[i]     += scale_left * q * velocity_z[i];
    }
    {
      int32_t i = k * N + (N - 1);
      double q = momentum_x[i];
      delta_depth[i] -= scale_right * q;
      delta_x[i]     -= scale_right * q * velocity_x[i];
      delta_z[i]     -= scale_right * q * velocity_z[i];
    }
    {
      int32_t i = k;
      double q = momentum_z[i];
      delta_depth[i] += scale_left * q;
      delta_x[i]     += scale_left * q * velocity_x[i];
      delta_z[i]     += scale_left * q * velocity_z[i];
    }
    {
      int32_t i = (N - 1) * N + k;
      double q = momentum_z[i];
      delta_depth[i] -= scale_right * q;
      delta_x[i]     -= scale_right * q * velocity_x[i];
      delta_z[i]     -= scale_right * q * velocity_z[i];
    }
  }
}

/* Reject nonfinite/negative state before applying roundoff-only clamping. */
static int32_t apply_deltas(void) {
  for (int32_t i = 0; i < NN; i += 1) {
    double h = depth[i] + delta_depth[i];
    int32_t finite = __builtin_isfinite(h);
    if (!finite || h < -1e-10) {
      last_failure_h = h;
      return i;
    }
    depth[i] = __builtin_wasm_max_f64(0.0, h);
    momentum_x[i]  = h > DRY_DEPTH ? momentum_x[i] + delta_x[i] : 0.0;
    momentum_z[i]  = h > DRY_DEPTH ? momentum_z[i] + delta_z[i] : 0.0;
  }
  return -1;
}

/* -------- One RK stage. Mirrors the JS step() source order exactly:
 * update velocities, X direction reconstruction then faces, Z direction
 * reconstruction then faces, transmissive boundaries, and finally
 * apply the deltas (with the same NaN / Inf / negative check). */

WASM_EXPORT(int32_t, compute_stage) (double dt) {
  update_velocities();
  for (int32_t i = 0; i < NN; i += 1) {
    delta_depth[i] = 0.0;
    delta_x[i]     = 0.0;
    delta_z[i]     = 0.0;
  }
  for (int32_t k = 0; k < N; k += 1) face_scale[k] = dt / cell_widths[k];
  reconstruct_states(1);
  for (int32_t z = 0; z < N; z += 1) {
    for (int32_t x = 0; x < N - 2; x += 2) {
      face_pair(z * N + x, z * N + x + 1, 1);
    }
    face(z * N + N - 2, z * N + N - 1, 1);
  }
  reconstruct_states(0);
  for (int32_t z = 0; z < N - 1; z += 1) {
    for (int32_t x = 0; x < N; x += 2) {
      face_pair(z * N + x, (z + 1) * N + x, 0);
    }
  }
  boundary_fluxes(dt);
  return apply_deltas();
}

/* Read once at construction to create zero-copy typed-array field views. */

WASM_EXPORT(uintptr_t, bed_address)        (void) { return (uintptr_t)bed; }
WASM_EXPORT(uintptr_t, depth_address)      (void) { return (uintptr_t)depth; }
WASM_EXPORT(uintptr_t, momentum_x_address) (void) { return (uintptr_t)momentum_x; }
WASM_EXPORT(uintptr_t, momentum_z_address) (void) { return (uintptr_t)momentum_z; }
WASM_EXPORT(uintptr_t, velocity_x_address) (void) { return (uintptr_t)velocity_x; }
WASM_EXPORT(uintptr_t, velocity_z_address) (void) { return (uintptr_t)velocity_z; }
WASM_EXPORT(uintptr_t, axis_address)       (void) { return (uintptr_t)axis; }
WASM_EXPORT(uintptr_t, cell_widths_address)(void) { return (uintptr_t)cell_widths; }
WASM_EXPORT(uintptr_t, foam_address)(void) { return (uintptr_t)foam; }
WASM_EXPORT(uintptr_t, wetness_address)(void) { return (uintptr_t)wetness; }
WASM_EXPORT(uintptr_t, foam_offset_x_address)(void) { return (uintptr_t)foam_offset_x; }
WASM_EXPORT(uintptr_t, foam_offset_z_address)(void) { return (uintptr_t)foam_offset_z; }
WASM_EXPORT(uintptr_t, shore_normal_x_address)(void) { return (uintptr_t)shore_normal_x; }
WASM_EXPORT(uintptr_t, shore_normal_z_address)(void) { return (uintptr_t)shore_normal_z; }
WASM_EXPORT(uintptr_t, shore_impulse_x_address)(void) { return (uintptr_t)shore_impulse_x; }
WASM_EXPORT(uintptr_t, shore_impulse_z_address)(void) { return (uintptr_t)shore_impulse_z; }
WASM_EXPORT(uintptr_t, foam_candidates_address)(void) { return (uintptr_t)foam_candidates; }
WASM_EXPORT(uintptr_t, foam_compression_address)(void) { return (uintptr_t)foam_compression; }
WASM_EXPORT(uintptr_t, foam_source_step_address)(void) { return (uintptr_t)foam_source_step; }

WASM_EXPORT(int32_t, grid_size)        (void) { return N; }
WASM_EXPORT(double,  failure_h)        (void) { return last_failure_h; }
