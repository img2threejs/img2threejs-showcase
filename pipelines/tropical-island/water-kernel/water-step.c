/* Strict float64 SSP-RK2 step helpers; preserve the JS expression and
 * traversal order of ShallowWater#advance / ShallowWater#step. All scratch
 * lives in static linear memory; no heap, no callbacks, no fast-math. */

#include "water-fields.h"

static const double GRAVITY = 9.81;
static const double DRY_DEPTH = 1e-5;

/* SSP-RK2 snapshot: depth, momentum_x, momentum_z at the start of step().
 * Required for the Unext = (U0 + U2) / 2 blend; lives in native memory. */

static double saved_depth[NN];
static double saved_momentum_x[NN];
static double saved_momentum_z[NN];

/* Include the wet/dry rarefaction fan; native max preserves NaN semantics. */

WASM_EXPORT(double, cfl_signal) (void) {
    double signalX = 0.0;
    double signalZ = 0.0;
    for (int32_t i = 0; i < NN; i += 1) {
        double h = depth[i];
        double u = h > DRY_DEPTH ? momentum_x[i] / h : 0.0;
        double v = h > DRY_DEPTH ? momentum_z[i] / h : 0.0;
        double c = __builtin_sqrt(GRAVITY * h);
        signalX = __builtin_wasm_max_f64(signalX, __builtin_fabs(u) + 2.0 * c);
        signalZ = __builtin_wasm_max_f64(signalZ, __builtin_fabs(v) + 2.0 * c);
    }
    return signalX + signalZ;
}

/* Snapshot depth / momentum_x / momentum_z exactly once per step.
 * Fixed-size static arrays, no per-step allocation, no heap. */

WASM_EXPORT(void, snapshot_state) (void) {
    for (int32_t i = 0; i < NN; i += 1) {
        saved_depth[i] = depth[i];
        saved_momentum_x[i] = momentum_x[i];
        saved_momentum_z[i] = momentum_z[i];
    }
}

/* Exact step269-282 blend and soil-infiltration loop. Assigns each field
 * .5 * (saved + current); when bed > 0 and depth > 0, depth drops to
 * max(0, h - infiltration), momenta scale by retained, and the absorbed
 * volume accumulates (h - next) * cell_widths[i%N] * cell_widths[i/N] in
 * the same per-cell order. Returns the running absorbed total so the host
 * can assign it back to ShallowWater#absorbedVolume without altering the
 * summation order. */

WASM_EXPORT(double, blend_state) (double infiltration, double absorbed) {
    for (int32_t i = 0; i < NN; i += 1) {
        depth[i] = 0.5 * (saved_depth[i] + depth[i]);
        momentum_x[i] = 0.5 * (saved_momentum_x[i] + momentum_x[i]);
        momentum_z[i] = 0.5 * (saved_momentum_z[i] + momentum_z[i]);
        if (bed[i] > 0.0 && depth[i] > 0.0) {
            double h = depth[i];
            double next = __builtin_wasm_max_f64(0.0, h - infiltration);
            double retained = next / h;
            absorbed += (h - next) * cell_widths[i % N] * cell_widths[i / N];
            depth[i] = next;
            momentum_x[i] *= retained;
            momentum_z[i] *= retained;
        }
    }
    return absorbed;
}
