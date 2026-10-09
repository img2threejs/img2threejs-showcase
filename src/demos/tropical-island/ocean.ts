import * as THREE from 'three';
import { ShallowWater, WET_FILM_DEPTH, WET_DEPTH_WET } from './shallowWater';

/** Coast-sample radial count; matches the world's 16-sector shape. */
const COAST_COUNT = 16;

const TAU = Math.PI * 2;

/** Simulation grid axis length shared with ShallowWater. */
const SIM_SIZE = ShallowWater.size;

/** Outer simulation extent in world units — full pointer-clicking range. */
const SIM_EXTENT = 100;

/** Dense island simulation radius — the [-14, 14] inner span. */
const DENSE_RADIUS = 14;

/** PlaneGeometry vertex grid for the ocean mesh. */
const PLANE_SEG = 256;

/** PlaneGeometry world span. */
const PLANE_EXTENT = 200;

/** Sea level — bed elevations live relative to sea level (mesh.position.y = SEALEVEL). */
const SEALEVEL = 0.01;

/** Offshore water must clear the full meteor; the visible beach keeps its own bed. */
const DEEP_BED = -5;

/** Terrain silhouette match radius (q ≤ 1.18) — bathymetry == geometry near shore. */
const TERRAIN_MATCH_Q = 1.18;

/** Silhouette q where bed reaches DEEP_BED — smooth transition to far field. */
const DEEP_Q = 1.7;

/** PlaneGeometry fraction of half-extent that maps to the dense [-14, 14] span. */
const PLANE_DENSE_FRAC = 0.8;

/** Depth below which a water fragment is discarded. Shared with the wetness
 *  transfer function in shallowWater.ts so the visible-film floor and the
 *  dry-fragment boundary cannot drift apart. */
const DRY_DEPTH = WET_FILM_DEPTH;

/** Depth at which the water film reaches full coverage. Shared with the
 *  wetness transfer function so the alpha ramp and the wetness saturation
 *  threshold use the same depth endpoint. */
const COVERAGE_FULL_DEPTH = WET_DEPTH_WET;

/** Depth below which a fragment is treated as water for picking. */
const WATER_DEPTH = 0.005;

/** Reduced-motion feedback fade window. */
const FEEDBACK_FADE = 3.0;

export interface OceanShape {
  silhouetteAt: (theta: number) => number;
  /** Absolute height of the island/beach geometry at world (x, z). Main owns terrain equation. */
  heightAt: (x: number, z: number) => number;
}

export interface WaterUniforms extends Record<string, THREE.IUniform> {
  islandTime: THREE.IUniform<number>;
  islandDaylight: THREE.IUniform<number>;
  islandCoast: THREE.IUniform<Float32Array>;
  /** RGBA Float texture: (eta, foam, wetness, depth). */
  oceanState: THREE.IUniform<THREE.DataTexture>;
  /** RGBA Float texture: (u, v, transported foam material-offset X, Z). */
  oceanFlow: THREE.IUniform<THREE.DataTexture>;
  /** Float32 simulation-axis centers, shared with CPU. */
  oceanAxis: THREE.IUniform<Float32Array>;
  /** Reduced-motion local feedback: (x, z, alpha, radius). Opacity only; never height. */
  oceanLocal: THREE.IUniform<THREE.Vector4>;
}

export interface OceanPlane {
  mesh: THREE.Mesh;
  uniforms: WaterUniforms;
  tick: (elapsed: number, reducedMotion?: boolean) => void;
  sampleSurface: (x: number, z: number, target: THREE.Vector3) => void;
  /** Opacity-only acknowledgement for a dropped rock. Validates the
   *  coordinate lands on a wet cell and paints the same blue-feedback ring
   *  the shader uses; never mutates solver state. Invalid (off-domain /
   *  dry / non-finite) coordinates no-op so the rock layer can broadcast
   *  every click without guarding its own routing. */
  acknowledge: (x: number, z: number) => void;
  /** Re-upload the solver's packed surfaceData / flowData after main has
   *  finished a batch of body / parcel exchanges, so the GPU textures
   *  reflect the latest physics before the next tick(). */
  sync: () => void;
  isWater: (x: number, z: number) => boolean;
  dispose: () => void;
  readonly simulation: ShallowWater;
}

/** Common GLSL — vertex- and fragment-safe. No fwidth, no discard. */
const WATER_COMMON_GLSL = `
  #define OCEAN_TAU 6.28318530718
  uniform float islandTime;
  uniform float islandDaylight;
  uniform float islandCoast[16];
  uniform sampler2D oceanState;
  uniform sampler2D oceanFlow;
  uniform float oceanAxis[${SIM_SIZE}];
  uniform vec4 oceanLocal;

  /** Worley F1 (closest cell distance) and F2 (second-closest). F2 - F1 gives the
   *  actual Voronoi edge distance which is what we want for AA cell boundaries. */
  vec2 worleyF1F2(vec2 p, float jitter) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    for (int oy = -1; oy <= 1; oy += 1) {
      for (int ox = -1; ox <= 1; ox += 1) {
        vec2 n = vec2(float(ox), float(oy));
        vec2 jitterVec = vec2(
          fract(sin(dot(cell + n, vec2(127.1, 311.7))) * 43758.5453),
          fract(sin(dot(cell + n, vec2(269.5, 183.3))) * 43758.5453)
        ) - 0.5;
        vec2 diff = n + jitter * jitterVec - f;
        float d = dot(diff, diff);
        if (d < d1) { d2 = d1; d1 = d; }
        else if (d < d2) { d2 = d; }
      }
    }
    return vec2(sqrt(d1), sqrt(d2));
  }

  /** Binary-search the shared physical axis for (i0, fraction).
   *  The lower neighbour and its successor are clamped to the shared grid.
   *  Used by sampleState/sampleFlow to bilinearly sample the raw packed RGBA
   *  channels (eta, foam, wetness, depth) without disturbing the simulation
   *  consumer pipeline. */
  void oceanAxisCoord(float w, out float i0, out float f) {
    float lo = 0.0;
    float hi = ${SIM_SIZE - 1}.0;
    for (int iter = 0; iter < ${Math.ceil(Math.log2(SIM_SIZE))}; iter += 1) {
      float mid = floor((lo + hi) * 0.5);
      float v = oceanAxis[int(mid)];
      if (v < w) lo = mid + 1.0; else hi = mid;
    }
    i0 = clamp(lo - 1.0, 0.0, ${SIM_SIZE - 2}.0);
    float i1 = min(i0 + 1.0, ${SIM_SIZE - 1}.0);
    float a0 = oceanAxis[int(i0)];
    float a1 = oceanAxis[int(i1)];
    float axisDiff = max(a1 - a0, 1e-6);
    f = clamp((w - a0) / axisDiff, 0.0, 1.0);
  }

  /** Raw 4-tap bilinear read of the packed RGBA channel. Consumers must
   *  receive (eta, foam, wetness, depth) unchanged; the cubic surface path is
   *  isolated to solvedSurface so the wet/foam shader logic never reads
   *  gradients as foam. */
  void sampleFourTexels(sampler2D src, vec2 worldXZ,
                        out vec4 s00, out vec4 s10, out vec4 s01, out vec4 s11,
                        out float fx, out float fz, out float dxX, out float dxZ) {
    float i0, iz0;
    oceanAxisCoord(worldXZ.x, i0, fx);
    oceanAxisCoord(worldXZ.y, iz0, fz);
    float i1 = min(i0 + 1.0, ${SIM_SIZE - 1}.0);
    float j1 = min(iz0 + 1.0, ${SIM_SIZE - 1}.0);
    dxX = oceanAxis[int(i1)] - oceanAxis[int(i0)];
    dxZ = oceanAxis[int(j1)] - oceanAxis[int(iz0)];
    float u0 = (i0 + 0.5) / ${SIM_SIZE}.0;
    float v0 = (iz0 + 0.5) / ${SIM_SIZE}.0;
    float u1 = (i1 + 0.5) / ${SIM_SIZE}.0;
    float v1 = (j1 + 0.5) / ${SIM_SIZE}.0;
    s00 = texture2D(src, vec2(u0, v0));
    s10 = texture2D(src, vec2(u1, v0));
    s01 = texture2D(src, vec2(u0, v1));
    s11 = texture2D(src, vec2(u1, v1));
  }

  vec4 sampleState(vec2 worldXZ) {
    vec4 s00, s10, s01, s11;
    float fx, fz, dxX, dxZ;
    sampleFourTexels(oceanState, worldXZ, s00, s10, s01, s11, fx, fz, dxX, dxZ);
    return mix(mix(s00, s10, fx), mix(s01, s11, fx), fz);
  }

  vec4 sampleFlow(vec2 worldXZ) {
    vec4 s00, s10, s01, s11;
    float fx, fz, dxX, dxZ;
    sampleFourTexels(oceanFlow, worldXZ, s00, s10, s01, s11, fx, fz, dxX, dxZ);
    return mix(mix(s00, s10, fx), mix(s01, s11, fx), fz);
  }

  /** Linear-axis lookup with extrapolation past the ends so spacing joins
   *  (dense uniform centre ↔ outer geometric ring) stay C2 continuous.
   *  SolvedSurface is the ONLY place the cubic B-spline lives. */
  float axisAt(float k, float axis0, float axisN, float axisNminus1, float axis1) {
    if (k < 0.0) return axis0 + k * (axis1 - axis0);
    if (k >= ${SIM_SIZE}.0) return axisN + (k - ${SIM_SIZE - 1}.0) * (axisN - axisNminus1);
    return oceanAxis[int(k)];
  }

  /** Cubic B-spline weights for one axis. u = (clampedW - cV) / (dV - cV);
   *  physical knots a..f are strictly increasing. */
  void cubicAxisWeights(float w,
                        out float wA, out float wB, out float wC, out float wD,
                        out float dA, out float dB, out float dC, out float dD,
                        out float ix, out float iSelA, out float iSelB, out float iSelC, out float iSelD) {
    float axis0 = oceanAxis[0];
    float axisN = oceanAxis[${SIM_SIZE - 1}];
    float clampedW = clamp(w, axis0, axisN);
    float lo = 0.0;
    float hi = ${SIM_SIZE - 1}.0;
    for (int iter = 0; iter < ${Math.ceil(Math.log2(SIM_SIZE))}; iter += 1) {
      float mid = floor((lo + hi) * 0.5);
      float v = oceanAxis[int(mid)];
      if (v < clampedW) lo = mid + 1.0; else hi = mid;
    }
    ix = clamp(lo - 1.0, 0.0, ${SIM_SIZE - 2}.0);
    float aV = axisAt(ix - 2.0, axis0, axisN, oceanAxis[${SIM_SIZE - 2}], oceanAxis[1]);
    float bV = axisAt(ix - 1.0, axis0, axisN, oceanAxis[${SIM_SIZE - 2}], oceanAxis[1]);
    float cV = axisAt(ix, axis0, axisN, oceanAxis[${SIM_SIZE - 2}], oceanAxis[1]);
    float dV = axisAt(ix + 1.0, axis0, axisN, oceanAxis[${SIM_SIZE - 2}], oceanAxis[1]);
    float eV = axisAt(ix + 2.0, axis0, axisN, oceanAxis[${SIM_SIZE - 2}], oceanAxis[1]);
    float fV = axisAt(ix + 3.0, axis0, axisN, oceanAxis[${SIM_SIZE - 2}], oceanAxis[1]);
    float invDc = 1.0 / (dV - cV);
    float invDb = 1.0 / (dV - bV);
    float invEc = 1.0 / (eV - cV);
    float invDa = 1.0 / (dV - aV);
    float invEb = 1.0 / (eV - bV);
    float invFc = 1.0 / (fV - cV);
    float u = (clampedW - cV) * invDc;
    float AB = (dV - clampedW) * invDb * (1.0 - u);
    float BB = (clampedW - bV) * invDb * (1.0 - u) + (eV - clampedW) * invEc * u;
    float CB = (clampedW - cV) * invEc * u;
    wA = (dV - clampedW) * invDa * AB;
    wB = (clampedW - aV) * invDa * AB + (eV - clampedW) * invEb * BB;
    wC = (clampedW - bV) * invEb * BB + (fV - clampedW) * invFc * CB;
    wD = (clampedW - cV) * invFc * CB;
    dA = -3.0 * AB * invDa;
    dB = 3.0 * AB * invDa - 3.0 * BB * invEb;
    dC = 3.0 * BB * invEb - 3.0 * CB * invFc;
    dD = 3.0 * CB * invFc;
    iSelA = max(0.0, ix - 1.0);
    iSelB = ix;
    iSelC = min(${SIM_SIZE - 1}.0, ix + 1.0);
    iSelD = min(${SIM_SIZE - 1}.0, ix + 2.0);
  }

  /** Cubic B-spline reconstruction of the free surface height and analytic
   *  gradient. Uses 16 texels and the same six-knot weights as the CPU sample.
   *  Per-knot dry gate applies only to eta so dry cells cannot lift the
   *  rendered surface but still contribute nothing to gradient components.
   *  Returns (eta, dEta/dX, dEta/dZ). x/z outer clamps are independent so a
   *  sample outside the grid along x still keeps the z component. */
  vec3 solvedSurface(vec2 worldXZ) {
    float axis0 = oceanAxis[0];
    float axisN = oceanAxis[${SIM_SIZE - 1}];
    float wA, wB, wC, wD, dA, dB, dC, dD, ix, iSelA, iSelB, iSelC, iSelD;
    cubicAxisWeights(worldXZ.x, wA, wB, wC, wD, dA, dB, dC, dD, ix, iSelA, iSelB, iSelC, iSelD);
    float wAz, wBz, wCz, wDz, dAz, dBz, dCz, dDz, iz, jSelA, jSelB, jSelC, jSelD;
    cubicAxisWeights(worldXZ.y, wAz, wBz, wCz, wDz, dAz, dBz, dCz, dDz, iz, jSelA, jSelB, jSelC, jSelD);
    vec4 s[16];
    for (int j = 0; j < 4; j += 1) {
      float zRow = j == 0 ? jSelA : j == 1 ? jSelB : j == 2 ? jSelC : jSelD;
      for (int i = 0; i < 4; i += 1) {
        float xCol = i == 0 ? iSelA : i == 1 ? iSelB : i == 2 ? iSelC : iSelD;
        float u = (xCol + 0.5) / ${SIM_SIZE}.0;
        float v = (zRow + 0.5) / ${SIM_SIZE}.0;
        s[j * 4 + i] = texture2D(oceanState, vec2(u, v));
      }
    }
    vec4 eta = vec4(0.0);
    float gxAcc = 0.0, gzAcc = 0.0;
    float wRow0 = wA, wRow1 = wB, wRow2 = wC, wRow3 = wD;
    float dRow0 = dA, dRow1 = dB, dRow2 = dC, dRow3 = dD;
    float wCol0 = wAz, wCol1 = wBz, wCol2 = wCz, wCol3 = wDz;
    float dCol0 = dAz, dCol1 = dBz, dCol2 = dCz, dCol3 = dDz;
    for (int j = 0; j < 4; j += 1) {
      vec4 wetEta = vec4(0.0);
      float wetDu = 0.0;
      float wj = j == 0 ? wCol0 : j == 1 ? wCol1 : j == 2 ? wCol2 : wCol3;
      float dj = j == 0 ? dCol0 : j == 1 ? dCol1 : j == 2 ? dCol2 : dCol3;
      for (int i = 0; i < 4; i += 1) {
        vec4 samp = s[j * 4 + i];
        float gate = samp.w > 0.00001 ? 1.0 : 0.0;
        float wi = i == 0 ? wRow0 : i == 1 ? wRow1 : i == 2 ? wRow2 : wRow3;
        float di = i == 0 ? dRow0 : i == 1 ? dRow1 : i == 2 ? dRow2 : dRow3;
        wetEta += gate * wi * samp;
        wetDu += gate * di * samp.x;
      }
      eta += wj * wetEta;
      gxAcc += wj * wetDu;
      gzAcc += dj * wetEta.x;
    }
    float insideX = (worldXZ.x > axis0 && worldXZ.x < axisN) ? 1.0 : 0.0;
    float insideZ = (worldXZ.y > axis0 && worldXZ.y < axisN) ? 1.0 : 0.0;
    return vec3(eta.x, gxAcc * insideX, gzAcc * insideZ);
  }

  // Single shared advection period keeps the two-phase mapping bounded:
  // phase = fract(time / period) so velocity*totalTime cannot wrap or jump
  // as currents change. Subgrid slopes affect NORMAL only; the resolved
  // macrosurface (solvedSurface) is never displaced here so the CPU solver
  // and the GPU vertex displacement stay bit-identical.
  // Millimetre-scale wind texture changes the reflection, not the resolved
  // surface height. Incommensurate wavelengths avoid a regular crosshatch.
  vec2 rippleSlope(vec2 p0, vec2 p1, float blend, vec2 direction,
    float wavelength, float amplitude, float phaseOffset, float depth, float footprint) {
    // Remove a component before it reaches fewer than two pixels per cycle.
    float visibility = 1.0 - smoothstep(wavelength * 0.15, wavelength * 0.5, footprint);
    if (visibility < 0.001) return vec2(0.0);
    float k = 6.28318530718 / wavelength;
    float omega = sqrt((9.81 * k + 0.000074 * k * k * k) * tanh(k * depth));
    float phase = omega * islandTime + phaseOffset;
    float carrier = mix(sin(k * dot(p1, direction) - phase),
      sin(k * dot(p0, direction) - phase), blend);
    return -direction * (amplitude * k * visibility * carrier);
  }

  vec2 capillarySlope(vec2 worldXZ, vec2 velocity, float depth, float footprint) {
    float period = 2.0;
    // Bounded two-phase advection: phase1 is phase0 + 0.5 mod 1, so the two
    // halves sit on opposite sides of the same period and never accumulate
    // a velocity*totalTime phase warp.
    float phase0 = fract(islandTime / period);
    float phase1 = fract(phase0 + 0.5);
    vec2 p0 = worldXZ - velocity * (phase0 * period);
    vec2 p1 = worldXZ - velocity * (phase1 * period);
    // Complementary triangular weights hide each phase's coordinate reset.
    float w0 = 1.0 - abs(1.0 - 2.0 * phase0);
    vec2 slope = rippleSlope(p0, p1, w0, vec2(0.9208, 0.3899),
        0.43, 0.0014, 0.7, depth, footprint)
      + rippleSlope(p0, p1, w0, vec2(0.6823, 0.7311),
        0.317, 0.00095, 3.1, depth, footprint)
      + rippleSlope(p0, p1, w0, vec2(0.9930, 0.1181),
        0.197, 0.0007, 1.9, depth, footprint)
      + rippleSlope(p0, p1, w0, vec2(0.8253, -0.5646),
        0.127, 0.0004, 4.7, depth, footprint)
      + rippleSlope(p0, p1, w0, vec2(0.3754, 0.9268),
        0.083, 0.00024, 2.3, depth, footprint)
      + rippleSlope(p0, p1, w0, vec2(0.9759, -0.2182),
        0.057, 0.00013, 5.8, depth, footprint);
    return slope * smoothstep(0.0, 0.15, depth);
  }
`;

/** Fragment-only GLSL — uses fwidth, discard, shoreline visualisation. */
const WATER_FRAGMENT_GLSL = `
  float shoreDistance(vec2 p) {
    vec2 e = p / vec2(1.0, 0.85);
    float theta = atan(e.y, e.x);
    float a = mod(theta + OCEAN_TAU, OCEAN_TAU) * (16.0 / OCEAN_TAU);
    float iFloat = floor(a);
    float i = mod(iFloat, 16.0);
    float f = fract(a);
    f = f * f * (3.0 - 2.0 * f);
    float r0 = islandCoast[int(i)];
    float r1 = islandCoast[int(mod(i + 1.0, 16.0))];
    return length(e) - mix(r0, r1, f);
  }


  /** Low-density foam leaves bubble lace; dense breaking foam fills the cells.
   *  Material coordinates are advected by the same current as the foam tracer. */
  float foamMicrostructure(vec2 materialXZ, float tracer) {
    if (tracer < 0.01) return 0.0;
    vec2 warp = materialXZ;
    vec2 f12Core = worleyF1F2(warp * 6.5, 1.0);
    vec2 f12Mid = worleyF1F2(warp * 15.0 + vec2(13.0, -21.0), 0.85);
    vec2 f12Fine = worleyF1F2(warp * 35.0 - vec2(7.0, 17.0), 0.75);
    float edgeDistCore = max(f12Core.y - f12Core.x, 0.0);
    float edgeDistMid = max(f12Mid.y - f12Mid.x, 0.0);
    float edgeDistFine = max(f12Fine.y - f12Fine.x, 0.0);
    float aaCore = fwidth(edgeDistCore) * 1.8 + 0.04;
    float aaMid = fwidth(edgeDistMid) * 1.8 + 0.04;
    float aaFine = fwidth(edgeDistFine) * 1.8 + 0.04;
    float coreEdge = 1.0 - smoothstep(0.0, aaCore + 0.06, edgeDistCore);
    float midEdge = 1.0 - smoothstep(0.0, aaMid + 0.09, edgeDistMid);
    float fineEdge = 1.0 - smoothstep(0.0, aaFine + 0.07, edgeDistFine);
    float footprint = max(length(dFdx(materialXZ)), length(dFdy(materialXZ)));
    fineEdge = mix(fineEdge, 0.26, smoothstep(0.3, 0.9, footprint * 35.0));
    float edges = midEdge * 0.65 + coreEdge * 0.35;
    float lacy = pow(clamp(coreEdge, 0.0, 1.0), 2.0) * 0.55
      + pow(clamp(midEdge, 0.0, 1.0), 2.0) * 0.35
      + pow(clamp(fineEdge, 0.0, 1.0), 1.4) * 0.18;
    float lace = clamp(edges + lacy, 0.0, 1.0);
    float dense = 0.4 + 0.6 * fineEdge;
    return mix(lace, dense, smoothstep(0.15, 0.65, tracer));
  }
`;

function buildWaterSky(): THREE.CubeTexture {
  const size = 64;
  const horizon = [194, 224, 235], zenith = [82, 148, 196], below = [36, 89, 112];
  const faces = Array.from({ length: 6 }, (_, face) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const u = (x + 0.5) / size * 2 - 1, v = (y + 0.5) / size * 2 - 1;
        const skyY = (face === 2 ? 1 : face === 3 ? -1 : -v) / Math.sqrt(1 + u * u + v * v);
        const target = skyY >= 0 ? zenith : below;
        const blend = Math.pow(Math.abs(skyY), 0.65);
        const i = (y * size + x) * 4;
        for (let c = 0; c < 3; c += 1) image.data[i + c] = horizon[c]! + (target[c]! - horizon[c]!) * blend;
        image.data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return canvas;
  });
  const sky = new THREE.CubeTexture(faces);
  sky.colorSpace = THREE.SRGBColorSpace;
  sky.needsUpdate = true;
  return sky;
}

/** Map world (x, z) to a bed elevation matching the ShallowWater contract.
 *  Bed is terrain height minus sea level: positive = dry land, negative = submerged.
 *  Within the silhouette ellipse q ≤ TERRAIN_MATCH_Q the bathymetry mirrors the
 *  visible beach; beyond that, it tapers smoothly to DEEP_BED by q = DEEP_Q. */
function buildBedElevation(shape: OceanShape): (x: number, z: number) => number {
  return (x: number, z: number): number => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return DEEP_BED;
    const ex = x;
    const ez = z / 0.85;
    const theta = Math.atan2(ez, ex);
    const radius = shape.silhouetteAt(theta);
    const q = Math.hypot(ex, ez) / Math.max(radius, 1e-3);
    const terrain = shape.heightAt(x, z);
    const bed = terrain - SEALEVEL;
    if (q <= TERRAIN_MATCH_Q) {
      return bed;
    }
    if (q >= DEEP_Q) {
      return Math.min(bed, DEEP_BED);
    }
    const t = (q - TERRAIN_MATCH_Q) / (DEEP_Q - TERRAIN_MATCH_Q);
    const mix = t * t * (3 - 2 * t);
    return bed * (1 - mix) + DEEP_BED * mix;
  };
}

/** Map a PlaneGeometry raw vertex coord into the same [-SIM_EXTENT, +SIM_EXTENT]
 *  world span the simulation owns, with PLANE_DENSE_FRAC of the half-extent
 *  mapped to [-DENSE_RADIUS, +DENSE_RADIUS] and the outer span stretching to
 *  ±SIM_EXTENT (geometric expansion for coarse far-field resolution). */
function remapPlaneAxis(raw: number): number {
  const halfExtent = PLANE_EXTENT / 2;
  const norm = raw / halfExtent;
  if (Math.abs(norm) <= PLANE_DENSE_FRAC) {
    return (norm * DENSE_RADIUS) / PLANE_DENSE_FRAC;
  }
  const sign = norm < 0 ? -1 : 1;
  const u = (Math.abs(norm) - PLANE_DENSE_FRAC) / (1 - PLANE_DENSE_FRAC);
  return sign * (DENSE_RADIUS + (SIM_EXTENT - DENSE_RADIUS) * u);
}

export function buildOceanPlane(shape: OceanShape): OceanPlane {
  const coast = new Float32Array(COAST_COUNT);
  for (let i = 0; i < COAST_COUNT; i += 1) coast[i] = shape.silhouetteAt(i / COAST_COUNT * TAU);

  const geometry = new THREE.PlaneGeometry(PLANE_EXTENT, PLANE_EXTENT, PLANE_SEG, PLANE_SEG);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i += 1) {
    positions.setXYZ(i, remapPlaneAxis(positions.getX(i)), 0, remapPlaneAxis(positions.getZ(i)));
  }
  geometry.computeBoundingBox();
  geometry.boundingBox!.min.y = -0.95;
  geometry.boundingBox!.max.y = 0.95;
  geometry.computeBoundingSphere();
  geometry.boundingSphere!.radius = Math.hypot(SIM_EXTENT, SIM_EXTENT, 0.95);
  positions.needsUpdate = false;

  // ShallowWater drives all ambient incident waves via the localized offshore strip
  // when constructed with `{ambient: true}`; no analytic swells live in the shader.
  const simulation = new ShallowWater(buildBedElevation(shape), { ambient: true });

  const oceanStateTexture = new THREE.DataTexture(
    simulation.surfaceData, SIM_SIZE, SIM_SIZE, THREE.RGBAFormat, THREE.FloatType,
  );
  oceanStateTexture.minFilter = THREE.NearestFilter;
  oceanStateTexture.magFilter = THREE.NearestFilter;
  oceanStateTexture.wrapS = THREE.ClampToEdgeWrapping;
  oceanStateTexture.wrapT = THREE.ClampToEdgeWrapping;
  oceanStateTexture.generateMipmaps = false;
  oceanStateTexture.needsUpdate = true;

  const oceanFlowTexture = new THREE.DataTexture(
    simulation.flowData, SIM_SIZE, SIM_SIZE, THREE.RGBAFormat, THREE.FloatType,
  );
  oceanFlowTexture.minFilter = THREE.NearestFilter;
  oceanFlowTexture.magFilter = THREE.NearestFilter;
  oceanFlowTexture.wrapS = THREE.ClampToEdgeWrapping;
  oceanFlowTexture.wrapT = THREE.ClampToEdgeWrapping;
  oceanFlowTexture.generateMipmaps = false;
  oceanFlowTexture.needsUpdate = true;

  const uniforms: WaterUniforms = {
    islandTime: { value: 0 },
    islandDaylight: { value: 1 },
    islandCoast: { value: coast },
    oceanState: { value: oceanStateTexture },
    oceanFlow: { value: oceanFlowTexture },
    oceanAxis: { value: simulation.axis },
    oceanLocal: { value: new THREE.Vector4(0, 0, 0, 0) },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.10, metalness: 0, ior: 1.333,
    specularIntensity: 1, envMapIntensity: 0.85,
    envMap: buildWaterSky(),
    transparent: true, depthWrite: false,
  });
  material.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = WATER_COMMON_GLSL + '\nvarying vec2 islandXZ;\n'
      + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
      #include <beginnormal_vertex>
      vec3 vSurface = solvedSurface(position.xz);
      objectNormal = normalize(vec3(-vSurface.y, 1.0, -vSurface.z));
    `);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      islandXZ = position.xz;
      transformed.y += vSurface.x;
    `);
    shader.fragmentShader = WATER_COMMON_GLSL + WATER_FRAGMENT_GLSL
      + '\nvarying vec2 islandXZ;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec4 simState = sampleState(islandXZ);
      float depth = simState.w;
      float foamField = simState.y;
      // Dry-fragment discard: only the simulation's resolved depth decides wet vs dry.
      if (depth < ${DRY_DEPTH.toFixed(4)}) discard;
      // Film coverage: alpha approaches 0 continuously as depth retreats
      // toward the dry-fragment boundary. Above COVERAGE_FULL_DEPTH the sheet
      // is fully opaque; deep water keeps the original color/mass unchanged.
      float coverage = smoothstep(${DRY_DEPTH.toFixed(4)},
        ${COVERAGE_FULL_DEPTH.toFixed(4)}, depth);
      float distanceToShore = shoreDistance(islandXZ);
      float shelf = 1.0 - smoothstep(0.0, 2.6, distanceToShore);
      // Smoothly depth-driven turquoise absorption: deeper water pulls toward
      // a dimmer blue, shallow shelf keeps a clean teal. No hard step.
      float depthAbsorb = clamp((max(0.05, depth) - 0.05) / 1.2, 0.0, 1.0);
      vec3 deep = vec3(0.012, 0.075, 0.16);
      vec3 mid = vec3(0.022, 0.18, 0.26);
      vec3 shallow = vec3(0.030, 0.34, 0.30);
      vec3 absorption = mix(shallow, mid, smoothstep(0.0, 0.5, depthAbsorb));
      absorption = mix(absorption, deep, smoothstep(0.55, 1.0, depthAbsorb));
      // Subtle, broad low-amplitude caustics. Replaces the previous harsh
      // sin^12 patches with a footprint-friendly worley curl that only tints
      // shallow shelf water.
      float caustic = worleyF1F2(islandXZ * 0.85 + vec2(islandTime * 0.07, -islandTime * 0.05), 0.6).x;
      caustic = pow(1.0 - clamp(caustic, 0.0, 1.0), 2.6);
      diffuseColor.rgb *= absorption;
      diffuseColor.rgb += vec3(0.018, 0.05, 0.04) * caustic * shelf * clamp(islandDaylight, 0.0, 1.0);
      // Foam births ONLY from simulation foam tracer; AA-aware microstructure + flow warp.
      vec4 flowState = sampleFlow(islandXZ);
      float microPattern = foamMicrostructure(islandXZ + flowState.zw, foamField);
      float foamVis = clamp(foamField * microPattern, 0.0, 1.0);
      vec3 foamColor = vec3(0.92, 0.97, 0.95) * (0.22 + 0.78 * clamp(islandDaylight, 0.0, 1.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, foamColor, foamVis);
      // Reduced-motion / dropped-rock blue tint. Splash is its own effect,
      // NEVER white foam at the impact point.
      float feedback = oceanLocal.z * exp(-pow((length(islandXZ - oceanLocal.xy) - oceanLocal.w) * 4.0, 2.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.7, 0.85, 1.15), feedback);
      // Apply the same film coverage to the shoreline foam ring alpha so foam
      // also dissolves into the dry fragment rather than popping at the edge.
      diffuseColor.a = mix(mix(0.96, 0.7, shelf), 0.97, foamVis) * coverage;
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
      #include <roughnessmap_fragment>
      // Deeper water is slightly glossier; foam patches read matte.
      float depthGloss = clamp((max(0.05, depth) - 0.05) / 1.5, 0.0, 1.0);
      roughnessFactor = mix(0.13, 0.085, depthGloss);
      roughnessFactor = mix(roughnessFactor, 0.65, foamVis);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
      #include <normal_fragment_maps>
      // Fragment normal uses the same cubic solvedSurface gradient as the
      // vertex displacement, plus shading-only multi-wavelet capillary
      // normals that flow with the local current. Macrosurface eta is NEVER
      // displaced here — solvedSurface.yz carries the resolved wave slope,
      // capillarySlope adds tiny high-frequency texture for specular glint.
      vec3 surf = solvedSurface(islandXZ);
      // Reuse the flow lookup already done above: oceanFlow.xy is the
      // resolved horizontal velocity; .zw are the foam material offsets.
      // sampleFlow/islandXZ are stable within this fragment block.
      vec2 capSlope = capillarySlope(islandXZ, flowState.xy, depth,
        max(length(dFdx(islandXZ)), length(dFdy(islandXZ))));
      vec2 slope = surf.yz + capSlope;
      normal = normalize(mat3(viewMatrix) * vec3(-slope.x, 1.0, -slope.y));
    `);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
       // Night-consistent water: daylight drives both diffuse and specular
       // energy so the same scene reads correctly after dusk without an extra
       // offscreen pass. A small blue-tinted ambient lift keeps the surface
       // visible (low moon) while specular falls to a dim cool reflection.
       float oceanDay = clamp(islandDaylight, 0.0, 1.0);
       float night = 1.0 - oceanDay;
       reflectedLight.indirectDiffuse *= mix(0.42, 1.0, oceanDay);
       reflectedLight.indirectDiffuse += night * vec3(0.012, 0.022, 0.034);
       reflectedLight.indirectSpecular *= mix(vec3(0.10, 0.20, 0.42), vec3(1.0), oceanDay);`,
    );
  };
  material.customProgramCacheKey = () => 'tropical-island-liquid-water-v15-coverage-fade';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Ocean';
  mesh.receiveShadow = true;
  mesh.position.y = SEALEVEL;
  mesh.renderOrder = 1;

  let previousElapsed: number | undefined;
  let lastReduced = false;
  let feedbackRemaining = 0, feedbackAlpha = 0;
  let disposed = false;

  const uploadState = (): void => {
    simulation.pack();
    oceanStateTexture.needsUpdate = true;
    oceanFlowTexture.needsUpdate = true;
  };

  const tick = (elapsed: number, reducedMotion = false): void => {
    if (disposed || !Number.isFinite(elapsed)) return;
    const dt = previousElapsed === undefined || elapsed < previousElapsed ? 0 : elapsed - previousElapsed;
    previousElapsed = elapsed;
    // Preference transitions resynchronise the clock without catching up the
    // frozen physical field. Feedback alone may fade under reduced motion.
    if (!reducedMotion && !lastReduced && dt > 0) {
      // Bound work at the render boundary, not inside the numerical solver.
      // Shader compilation or a slow frame must not create an ever-growing
      // catch-up loop. Water, falling rocks and body loads share this clock.
      const simulatedDt = Math.min(dt, 0.05);
      simulation.advance(simulatedDt);
      uploadState();
      uniforms.islandTime.value += simulatedDt;
    }
    lastReduced = reducedMotion;
    feedbackRemaining = Math.max(0, feedbackRemaining - dt);
    uniforms.oceanLocal.value.z = feedbackAlpha * (feedbackRemaining / FEEDBACK_FADE) ** 2;
  };

  const sampleSurface = (x: number, z: number, target: THREE.Vector3): void => {
    if (disposed) {
      target.set(0, 0, 0);
      return;
    }
    simulation.sample(x, z, target);
  };

  const acknowledge = (x: number, z: number): void => {
    if (disposed) return;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (!isWater(x, z)) return;
    // Opacity-only blue acknowledgement. Solver state is never mutated here;
    // the rock layer owns the actual body / parcel exchanges and calls sync()
    // once its batch is complete so the GPU textures reflect the result.
    feedbackAlpha = 0.32;
    feedbackRemaining = FEEDBACK_FADE;
    uniforms.oceanLocal.value.set(x, z, feedbackAlpha, 0.6);
  };

  const sync = (): void => {
    if (disposed) return;
    uploadState();
  };

  const isWater = (x: number, z: number): boolean => {
    if (disposed) return false;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (Math.abs(x) >= SIM_EXTENT || Math.abs(z) >= SIM_EXTENT) return false;
    const depth = simulation.sampleChannel(simulation.surfaceData, x, z, 3);
    return depth > WATER_DEPTH;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    oceanStateTexture.dispose();
    oceanFlowTexture.dispose();
  };

  return {
    mesh,
    uniforms,
    tick,
    sampleSurface,
    acknowledge,
    sync,
    isWater,
    dispose,
    simulation,
  };
}

export function buildFoamRing(shape: OceanShape, uniforms: WaterUniforms): THREE.Mesh {
  // Foam band: -1.0 (deep beach, accommodates strong run-up) to +2.2 (open water).
  const segments = 256, rows = 22;
  const positions = new Float32Array((segments + 1) * (rows + 1) * 3);
  const indices = new Uint16Array(segments * rows * 6);
  for (let a = 0; a <= segments; a += 1) {
    const theta = a / segments * TAU;
    const edge = shape.silhouetteAt(theta);
    for (let r = 0; r <= rows; r += 1) {
      const radius = edge - 1.0 + r / rows * 3.2;
      const i = a * (rows + 1) + r;
      positions.set([Math.cos(theta) * radius, 0.019, Math.sin(theta) * radius * 0.85], i * 3);
      if (a === segments || r === rows) continue;
      const j = i + rows + 1;
      indices.set([i, j, i + 1, i + 1, j, j + 1], (a * rows + r) * 6);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.boundingBox!.min.y = -0.95;
  geometry.boundingBox!.max.y = 0.95;
  geometry.computeBoundingSphere();
  geometry.boundingSphere!.radius = Math.hypot(geometry.boundingSphere!.radius, 0.95);
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: WATER_COMMON_GLSL + `
      varying vec2 foamXZ;
      void main() {
        foamXZ = position.xz;
        vec3 surface = solvedSurface(position.xz);
        vec3 transformed = position;
        transformed.y += surface.x;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
      }
    `,
    fragmentShader: WATER_COMMON_GLSL + WATER_FRAGMENT_GLSL + `
      varying vec2 foamXZ;
      void main() {
        vec4 simState = sampleState(foamXZ);
        float depth = simState.w;
        float foamField = simState.y;
        if (depth < ${DRY_DEPTH.toFixed(4)}) discard;
        // Same coverage ramp as the ocean surface so the foam ring's trailing
        // edge dissolves into the dry fragment rather than popping.
        float coverage = smoothstep(${DRY_DEPTH.toFixed(4)},
          ${COVERAGE_FULL_DEPTH.toFixed(4)}, depth);
        vec4 flowState = sampleFlow(foamXZ);
        float microPattern = foamMicrostructure(foamXZ + flowState.zw, foamField);
        float microFoam = clamp(foamField * microPattern, 0.0, 1.0);
        // Foam births ONLY from simulation foam tracer; opacity grows with foam.
        float alpha = clamp(microFoam * 0.92, 0.0, 0.95) * coverage;
        float dayFoam = clamp(islandDaylight, 0.0, 1.0);
        vec3 foamColor = vec3(0.92, 0.97, 0.95) * (0.22 + 0.78 * dayFoam);
        // Same feedback / night handling as the ocean surface so the foam
        // ring never disagrees about time-of-day or impact acknowledgement.
        float feedback = oceanLocal.z * exp(-pow((length(foamXZ - oceanLocal.xy) - oceanLocal.w) * 4.0, 2.0));
        foamColor = mix(foamColor, foamColor * vec3(0.7, 0.85, 1.15), feedback);
        gl_FragColor = vec4(foamColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  material.customProgramCacheKey = () => 'tropical-island-shoreline-foam-v11-coverage-fade';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Shoreline foam ring';
  mesh.renderOrder = 2;
  // The CPU ring is an enclosure, not a hit on the shader's transparent foam.
  mesh.userData.isPointerTransparent = true;
  return mesh;
}

/**
 * Patch an existing beach material's compiled shader with a wetness darkening +
 * smoother-specular term driven by `oceanState.wetness`. The shared uniforms
 * reference the simulation state textures. Wetness only affects low-elevation
 * sand (beachLocalY < 0.3); grass/pebble vertices are untouched.
 *
 * Two wetness stages share the same source but recover on different curves:
 *  - sheen (thin glossy film) tracks wetness^1 with an early ramp-off so the
 *    highlight is lost before the sand visibly dries;
 *  - darkening tracks wetness^0.6 so damp sand keeps its tinted body long
 *    after the sheen is gone, then fades back to the original color/roughness.
 * A position-only worley breakup adds natural spatial variation without
 * introducing time-random sparkle or an extra texture lookup.
 */
export function installWetBeach(mesh: THREE.Mesh, uniforms: WaterUniforms): void {
  const material = mesh.material;
  if (Array.isArray(material)) return;
  if (material.userData.wetBeachInstalled === true) return;
  material.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = WATER_COMMON_GLSL + '\nvarying vec2 beachWorldXZ;\nvarying float beachLocalY;\n'
      + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      beachWorldXZ = position.xz;
      beachLocalY = position.y;
    `);
    shader.fragmentShader = WATER_COMMON_GLSL + '\nvarying vec2 beachWorldXZ;\nvarying float beachLocalY;\n'
      + shader.fragmentShader;
    // Read beachState once before color_fragment; reuse across stages via globals.
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      `void main() {
       vec4 beachState = sampleState(beachWorldXZ);
       float beachWet = clamp(beachState.z, 0.0, 1.0);
       float sandMask = 1.0 - smoothstep(0.15, 0.3, beachLocalY);
       // Sheen reads at full wetness but its highlight is lost early as the
       // film thins. Darkening holds longer so the sand looks damp after the
       // gloss is gone. Both are position-only breakup (no time noise) so the
       // breakup stays stable while the cell wetness animates.
       float breakup = clamp(mix(0.85, 1.0, worleyF1F2(beachWorldXZ * 4.5, 0.7).x),
         0.85, 1.0);
       float sheen = beachWet * breakup;
       float damp = pow(beachWet, 0.6);`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       vec3 beachWetnessTerm = mix(vec3(1.0), vec3(0.55), damp);
       diffuseColor.rgb *= mix(vec3(1.0), beachWetnessTerm, sandMask);`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       // Thin glossy sheen: low roughness only while the film is fresh.
       float sheenRough = mix(roughnessFactor, 0.18, sheen * 0.9);
       float sandRough = mix(roughnessFactor, 0.32, damp * 0.5);
       // Blend the sheen on top of the damp base so the highlight evaporates
       // first while the damp darkening remains.
       roughnessFactor = mix(roughnessFactor,
         mix(sandRough, sheenRough, sheen), sandMask);`,
    );
  };
  material.customProgramCacheKey = () => 'tropical-island-beach-wet-v12-sheen-damp';
  material.needsUpdate = true;
  material.userData.wetBeachInstalled = true;
}