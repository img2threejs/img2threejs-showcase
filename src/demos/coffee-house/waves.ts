// Coffee-house surface wave ribbons: PixiJS 8.22 Mesh<MeshGeometry> strips
// that draw bright pale-white travelling crests on top of the existing
// textured water surfaces and on two extra source-observed water
// rectangles that the host layer (water Container) does not currently
// texture.
//
// Each region owns a small set of curved serpentine ribbons. The
// geometry is built once per ribbon at construction time: a strip of
// N+1 segments (2*(N+1) vertices, 2*N triangles) whose center-line is
// a smooth sine-shifted path inside the region and whose perpendicular
// width tapers to zero at both ends. Per-vertex sin/cos of the
// travelling-wave phase are baked into typed arrays so per-frame work
// is one shared Math.sin / Math.cos of omega*t plus a handful of
// multiplies per vertex and per ribbon. No per-frame allocation.
//
// Animation:
//   1. The whole ribbon slides along the travel axis (horizontal for
//      the four regions here — the bay water reads as a left-to-right
//      swell). Position offset wraps inside a fixed span that is
//      larger than the ribbon length, so the leading edge is always
//      inside the region and the trailing edge always fades before
//      crossing the opposite border.
//   2. The ribbon's center-line is rolled by a low-amplitude vertical
//      sine so the crest shape undulates instead of being a rigid
//      bar; the roll uses a separate omega for variety.
//   3. The mesh's overall alpha is multiplied by a fade window
//      derived from the ribbon's travel offset so the wrap-around
//      point is invisible.
//   4. Width taper (vertex placement already at construction) gives
//      smooth geometric ends without any shader or alpha mask.
//
// Determinism: clock is an absolute seconds value supplied by the
// scene. setTime(0) returns to the authored baseline (sin(0)=0,
// cos(0)=1 → displacement 0 → visible crests at their starting
// positions, identical across reloads). No Math.random; every offset
// is derived from the loop index.
//
// Neutrality / mode: in original mode every ribbon is hidden (the
// host's existing Sprite of the source region already shows the
// unmodified pixels). In ambient mode ribbons layer on top of the
// textured water Meshes; the underlying source artwork is preserved
// by sampling Texture.WHITE for these ribbons and not destroying it.
//
// Boundaries: every vertex of every ribbon lives strictly inside its
// approved world-space rectangle; the ribbon's travel span and
// length are chosen so a crest never pokes across a region border at
// any phase of the animation.

import { Mesh, MeshGeometry, Texture } from 'pixi.js';
import type { Container } from 'pixi.js';

/* -------- approved source-observed water rectangles (WORLD) -------- */

// Four disjoint world-space rectangles. The first two are the
// existing textured water windows (mesh surfaces inside the water
// Container); the third and fourth are open-bay and near-island water
// patches that the environment Mesh already paints but the existing
// water layer does not currently cover.
interface RegionSpec {
  /** World-space rectangle. Vertices never escape this box. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const REGIONS: ReadonlyArray<RegionSpec> = [
  { x: 938, y: 480, w: 416, h: 28  }, // horizon
  { x: 942, y: 538, w: 148, h: 68  }, // channel
  { x: 974, y: 510, w: 178, h: 26  }, // openbay
  { x: 1246, y: 714, w: 160, h: 50 }, // near-island_water
];

/* -------- per-region authoring -------------------------------------- */

interface RibbonSpec {
  /** Centerline y offset from region top, in source pixels. */
  readonly centerY: number;
  /** Ribbon length in source pixels (along travel axis). */
  readonly length: number;
  /** Peak perpendicular thickness in source pixels. */
  readonly thickness: number;
  /** Travel speed in source pixels per second. */
  readonly speed: number;
  /** Starting travel offset (0..1 of travel span). */
  readonly phaseOffset: number;
  /** Roll amplitude in source pixels (perpendicular). */
  readonly rollAmplitude: number;
  /** Per-vertex spatial roll wavelength (radians per vertex cycle). */
  readonly rollFrequency: number;
  /** Peak alpha (after region fade & envelope). */
  readonly peakAlpha: number;
}

interface RegionAuthoring {
  readonly spec: RegionSpec;
  /** Travel direction in world space (+1 or -1 along x). */
  readonly direction: 1 | -1;
  /** Ribbons authored for this region. */
  readonly ribbons: ReadonlyArray<RibbonSpec>;
}

const PI2 = Math.PI * 2;

// Horizon strip — long, distant, low perspective. Thin and pale so it
// reads as a sliver of warm reflection.
const HORIZON: RegionAuthoring = {
  spec: REGIONS[0]!,
  direction: 1,
  ribbons: [
    { centerY:  7, length: 78, thickness: 0.8, speed:  18, phaseOffset: 0.00, rollAmplitude: 0.4, rollFrequency: 5.1, peakAlpha: 0.22 },
    { centerY: 11, length: 64, thickness: 0.9, speed:  22, phaseOffset: 0.18, rollAmplitude: 0.5, rollFrequency: 4.6, peakAlpha: 0.26 },
    { centerY: 17, length: 56, thickness: 0.7, speed:  16, phaseOffset: 0.41, rollAmplitude: 0.3, rollFrequency: 5.7, peakAlpha: 0.20 },
    { centerY: 22, length: 72, thickness: 0.8, speed:  20, phaseOffset: 0.62, rollAmplitude: 0.4, rollFrequency: 5.3, peakAlpha: 0.24 },
    { centerY: 15, length: 50, thickness: 1.0, speed:  26, phaseOffset: 0.27, rollAmplitude: 0.6, rollFrequency: 4.3, peakAlpha: 0.30 },
    { centerY:  9, length: 44, thickness: 1.1, speed:  30, phaseOffset: 0.74, rollAmplitude: 0.5, rollFrequency: 4.8, peakAlpha: 0.34 },
  ],
};

// Channel — narrow midground. Fewer ribbons, faster, slightly
// thicker to match the closer perspective.
const CHANNEL: RegionAuthoring = {
  spec: REGIONS[1]!,
  direction: 1,
  ribbons: [
    { centerY: 14, length: 46, thickness: 1.3, speed:  24, phaseOffset: 0.00, rollAmplitude: 0.7, rollFrequency: 4.9, peakAlpha: 0.30 },
    { centerY: 26, length: 38, thickness: 1.5, speed:  28, phaseOffset: 0.21, rollAmplitude: 0.8, rollFrequency: 4.5, peakAlpha: 0.34 },
    { centerY: 40, length: 50, thickness: 1.2, speed:  22, phaseOffset: 0.45, rollAmplitude: 0.6, rollFrequency: 5.1, peakAlpha: 0.28 },
    { centerY: 54, length: 42, thickness: 1.4, speed:  26, phaseOffset: 0.68, rollAmplitude: 0.7, rollFrequency: 4.7, peakAlpha: 0.32 },
    { centerY: 20, length: 36, thickness: 1.6, speed:  32, phaseOffset: 0.83, rollAmplitude: 0.9, rollFrequency: 4.2, peakAlpha: 0.38 },
  ],
};

// Open bay — small rectangle just below horizon. Mid alpha, faster,
// thickness in the 1.2-2.4 nearer-perspective bracket.
const OPENBAY: RegionAuthoring = {
  spec: REGIONS[2]!,
  direction: 1,
  ribbons: [
    { centerY:  6, length: 56, thickness: 1.3, speed:  22, phaseOffset: 0.00, rollAmplitude: 0.6, rollFrequency: 5.0, peakAlpha: 0.26 },
    { centerY: 11, length: 48, thickness: 1.4, speed:  26, phaseOffset: 0.17, rollAmplitude: 0.7, rollFrequency: 4.6, peakAlpha: 0.30 },
    { centerY: 17, length: 60, thickness: 1.2, speed:  20, phaseOffset: 0.38, rollAmplitude: 0.5, rollFrequency: 5.3, peakAlpha: 0.24 },
    { centerY: 21, length: 42, thickness: 1.6, speed:  30, phaseOffset: 0.61, rollAmplitude: 0.8, rollFrequency: 4.4, peakAlpha: 0.34 },
    { centerY:  9, length: 36, thickness: 1.8, speed:  34, phaseOffset: 0.79, rollAmplitude: 0.9, rollFrequency: 4.1, peakAlpha: 0.38 },
    { centerY: 19, length: 50, thickness: 1.2, speed:  18, phaseOffset: 0.52, rollAmplitude: 0.5, rollFrequency: 5.6, peakAlpha: 0.22 },
  ],
};

// Near-island water — closest foreground, strongest perspective.
// Ribbons visibly larger; still kept well inside the rectangle.
const NEAR_ISLAND: RegionAuthoring = {
  spec: REGIONS[3]!,
  direction: 1,
  ribbons: [
    { centerY:  8, length: 60, thickness: 1.7, speed:  20, phaseOffset: 0.00, rollAmplitude: 1.0, rollFrequency: 4.5, peakAlpha: 0.32 },
    { centerY: 16, length: 52, thickness: 1.9, speed:  24, phaseOffset: 0.16, rollAmplitude: 1.1, rollFrequency: 4.2, peakAlpha: 0.36 },
    { centerY: 26, length: 70, thickness: 1.6, speed:  18, phaseOffset: 0.35, rollAmplitude: 0.9, rollFrequency: 4.7, peakAlpha: 0.28 },
    { centerY: 35, length: 48, thickness: 2.2, speed:  26, phaseOffset: 0.54, rollAmplitude: 1.2, rollFrequency: 4.0, peakAlpha: 0.38 },
    { centerY: 43, length: 56, thickness: 1.8, speed:  22, phaseOffset: 0.72, rollAmplitude: 1.0, rollFrequency: 4.4, peakAlpha: 0.30 },
    { centerY: 12, length: 40, thickness: 2.4, speed:  28, phaseOffset: 0.85, rollAmplitude: 1.3, rollFrequency: 3.9, peakAlpha: 0.42 },
  ],
};

const REGION_AUTHORING: ReadonlyArray<RegionAuthoring> = [
  HORIZON, CHANNEL, OPENBAY, NEAR_ISLAND,
];

// Per-region base roll omega (radians per second). Different per
// region so ribbons on different regions do not roll in lockstep.
const ROLL_OMEGA_PER_REGION: ReadonlyArray<number> = [
  0.55 * PI2, 0.41 * PI2, 0.73 * PI2, 0.62 * PI2,
];

// Segments per ribbon. 24 → 50 vertices / 48 triangles — plenty of
// resolution for a smooth curved strip without overhead.
const RIBBON_SEGMENTS = 24;

interface BuiltRibbon {
  readonly mesh: Mesh<MeshGeometry>;
  readonly geometry: MeshGeometry;
  readonly ribbon: RibbonSpec;
  readonly direction: 1 | -1;
  readonly worldX: number;
  readonly worldY: number;
  readonly rollOmegaR: number;
  readonly travelOmega: number;
  /** Maximum travel span in source pixels (= region.w - ribbon.length). */
  readonly travelSpan: number;
  /** Precomputed per-vertex centerline parameter 0..1 (length axis). */
  readonly tAlong: Float32Array;
  /** Precomputed per-vertex offset from center (perpendicular). */
  readonly perpOffset: Float32Array;
  /** Precomputed per-vertex sin/cos of the spatial roll phase. */
  readonly rollSin: Float32Array;
  readonly rollCos: Float32Array;
  /** Working typed-array of vertex positions (length = verts*2). */
  readonly positions: Float32Array;
}

/* -------- helpers ---------------------------------------------------- */

/**
 * Build one ribbon's geometry.
 *
 * Layout (per ribbon, RIBBON_SEGMENTS+1 segments):
 *   two parallel rails of (RIBBON_SEGMENTS+1) vertices; each pair is
 *   the two endpoints of a perpendicular to the centreline. Indices
 *   join every consecutive quad into 2 triangles.
 *
 *   The centreline starts at (0, 0) and runs to (length, 0) before
 *   per-frame offsets. Width is shaped by sin(π·t) so the ribbon
 *   tapers smoothly to zero at both ends — no hard bars.
 */
function buildRibbonMesh(
  ribbon: RibbonSpec,
  direction: 1 | -1,
  worldX: number,
  worldY: number,
  rollOmegaR: number,
  travelOmega: number,
  travelSpan: number,
  whiteTexture: Texture,
): BuiltRibbon {
  const seg = RIBBON_SEGMENTS;
  const verts = (seg + 1) * 2;
  const positions = new Float32Array(verts * 2);
  const uvs = new Float32Array(verts * 2);
  const tAlong = new Float32Array(verts);
  const perpOffset = new Float32Array(verts);
  const rollSin = new Float32Array(verts);
  const rollCos = new Float32Array(verts);

  const length = ribbon.length;
  const peakHalfWidth = ribbon.thickness * 0.5;

  for (let i = 0; i <= seg; i++) {
    const tParam = i / seg; // 0..1 along ribbon length.
    const baseX = tParam * length;
    // sin(π·t) is 0 at the ends and 1 in the middle — a clean
    // bell-curve taper that yields smooth geometric ends.
    const halfWidth = peakHalfWidth * Math.sin(tParam * Math.PI);
    const upper = i * 2;
    const lower = upper + 1;
    positions[upper * 2] = baseX;
    positions[upper * 2 + 1] = halfWidth;
    positions[lower * 2] = baseX;
    positions[lower * 2 + 1] = -halfWidth;
    uvs[upper * 2] = tParam;
    uvs[upper * 2 + 1] = 0;
    uvs[lower * 2] = tParam;
    uvs[lower * 2 + 1] = 1;
    tAlong[upper] = tParam;
    tAlong[lower] = tParam;
    perpOffset[upper] = halfWidth;
    perpOffset[lower] = -halfWidth;
    // Roll phase: spatial sine, anchored to the ribbon's tParam. The
    // time component is applied per-frame via a shared Math.sin / Math.cos.
    const phi = tParam * ribbon.rollFrequency * PI2;
    rollSin[upper] = Math.sin(phi);
    rollSin[lower] = Math.sin(phi);
    rollCos[upper] = Math.cos(phi);
    rollCos[lower] = Math.cos(phi);
  }

  const indices = new Uint32Array(seg * 6);
  let k = 0;
  for (let i = 0; i < seg; i++) {
    const a = i * 2;       // upper left
    const b = a + 1;       // lower left
    const c = a + 2;       // upper right
    const d = a + 3;       // lower right
    indices[k++] = a;
    indices[k++] = b;
    indices[k++] = c;
    indices[k++] = b;
    indices[k++] = d;
    indices[k++] = c;
  }

  const geometry = new MeshGeometry({ positions, uvs, indices });

  const mesh = new Mesh({ texture: whiteTexture, geometry });
  mesh.eventMode = 'none';
  mesh.visible = false;
  mesh.tint = 0xffe2b0; // warm pale-gold reflection tint
  mesh.blendMode = 'screen'; // additive bright crests on top of water

  return {
    mesh,
    geometry,
    ribbon,
    direction,
    worldX,
    worldY,
    rollOmegaR,
    travelOmega,
    travelSpan,
    tAlong,
    perpOffset,
    rollSin,
    rollCos,
    positions,
  };
}

/* -------- state ------------------------------------------------------ */

interface SurfaceWavesState {
  readonly ribbons: BuiltRibbon[];
  readonly meshes: Mesh<MeshGeometry>[];
  /**
   * Latest clock value supplied by the host. Used by setAmbient(true)
   * to re-sync to the current value, and by setTime to drive
   * applyTime. Independent from `appliedSeconds` so subsequent setTime
   * calls with the same value still apply when ambient just turned on.
   */
  rememberedSeconds: number;
  /** Clock value most recently uploaded to the GPU buffers. */
  appliedSeconds: number;
  ambient: boolean;
  strength: number;
  disposed: boolean;
}

export interface SurfaceWaves {
  readonly meshes: readonly Mesh<MeshGeometry>[];
  setAmbient(enabled: boolean): void;
  setTime(seconds: number): void;
  setStrength(value: number): void;
  dispose(): void;
}

/**
 * Create the surface-wave ribbon system and attach it to `parent`.
 * Caller is expected to add this mesh inside the scene's water
 * Container (so the ribbons render on top of the existing textured
 * water Meshes in ambient mode and are hidden in original mode).
 *
 * The borrowed `Texture.WHITE` is sampled; it is NOT destroyed by
 * `dispose()`.
 */
export function createSurfaceWaves(parent: Container): SurfaceWaves {
  const whiteTexture = Texture.WHITE;

  const ribbons: BuiltRibbon[] = [];
  const meshes: Mesh<MeshGeometry>[] = [];

  for (let r = 0; r < REGION_AUTHORING.length; r++) {
    const authoring = REGION_AUTHORING[r]!;
    const rollOmegaR = ROLL_OMEGA_PER_REGION[r % ROLL_OMEGA_PER_REGION.length]!;
    for (let i = 0; i < authoring.ribbons.length; i++) {
      const ribbon = authoring.ribbons[i]!;
      // travelSpan = region.w - ribbon.length is the maximum pixel
      // distance the ribbon can travel while keeping both endpoints
      // inside the region. omega = 2π * speed / travelSpan so one full
      // wrap cycle equals `travelSpan / speed` seconds.
      const travelSpan = authoring.spec.w - ribbon.length;
      const travelOmega = (PI2 * ribbon.speed) / travelSpan;
      const built = buildRibbonMesh(
        ribbon,
        authoring.direction,
        authoring.spec.x,
        authoring.spec.y + ribbon.centerY,
        rollOmegaR,
        travelOmega,
        travelSpan,
        whiteTexture,
      );
      parent.addChild(built.mesh);
      ribbons.push(built);
      meshes.push(built.mesh);
    }
  }

  const state: SurfaceWavesState = {
    ribbons,
    meshes,
    rememberedSeconds: 0,
    appliedSeconds: -1,
    ambient: false,
    strength: 1,
    disposed: false,
  };

  // Hide everything until the host turns ambient mode on.
  for (const m of meshes) m.visible = false;

  return {
    meshes,
    setAmbient(enabled: boolean): void { setAmbient(state, enabled); },
    setTime(seconds: number): void { setTime(state, seconds); },
    setStrength(value: number): void {
      state.strength = value;
      if (value === 0) { for (const mesh of state.meshes) mesh.alpha = 0; }
      else applyTime(state, state.rememberedSeconds, true);
    },
    dispose(): void { disposeWaves(state); },
  };
}

/* -------- per-frame / event handlers --------------------------------- */

function setAmbient(state: SurfaceWavesState, enabled: boolean): void {
  if (state.disposed) return;
  state.ambient = enabled;
  for (const m of state.meshes) m.visible = enabled;
  if (enabled) applyTime(state, state.rememberedSeconds, true);
}

function applyTime(state: SurfaceWavesState, seconds: number, force: boolean): void {
  if (state.disposed || !state.ambient) return;
  if (!force && seconds === state.appliedSeconds) return;
  const t = seconds;
  const ribbons = state.ribbons;
  for (let i = 0; i < ribbons.length; i++) {
    applyRibbon(ribbons[i]!, t, state.strength);
  }
  state.appliedSeconds = seconds;
}

function applyRibbon(r: BuiltRibbon, t: number, strength: number): void {
  const ribbon = r.ribbon;
  const sint = Math.sin(r.rollOmegaR * t);
  const cost = Math.cos(r.rollOmegaR * t);

  // Travel fraction. omega·t grows monotonically; the mod-1 wrap yields
  // a 0..1 fraction that monotonically sweeps across the region's
  // travel span and wraps invisibly. Adding phaseOffset shifts each
  // ribbon's wrap point in time so multiple ribbons are out of phase.
  const offsetPhase = ribbon.phaseOffset * PI2;
  const rawPhase = r.travelOmega * t + offsetPhase;
  const cycles = rawPhase / PI2;
  const travelFraction = cycles - Math.floor(cycles); // ∈ [0, 1)
  // Alpha envelope: 0 at the wrap extremes (travelFraction ∈ {0, 1}),
  // 1 at travelFraction = 0.5. Uses sin(π·frac) so the wrap is
  // invisible without resorting to a custom shader.
  const alphaEnv = Math.sin(travelFraction * Math.PI);
  // Pixel offset along the travel axis (positive toward the region's
  // far edge so the ribbon's leftmost x sweeps from region.x to
  // region.x + travelSpan).
  const travelOffset = travelFraction * r.travelSpan;

  const positions = r.positions;
  const verts = r.tAlong.length;
  const direction = r.direction;
  const worldY = r.worldY;
  const worldX = r.worldX;
  const rollFactor = ribbon.rollAmplitude;
  const length = ribbon.length;

  for (let i = 0; i < verts; i++) {
    const tParam = r.tAlong[i]!;
    const perp = r.perpOffset[i]!;
    const sPR = r.rollSin[i]!;
    const cPR = r.rollCos[i]!;
    // Roll shape across the ribbon. sin(rollOmega*t + phi) - sin(phi)
    // = sint*cPR + (cost-1)*sPR. At t=0 every roll is 0.
    const roll = sint * cPR + (cost - 1) * sPR;
    positions[i * 2] = worldX + direction * (tParam * length + travelOffset);
    positions[i * 2 + 1] = worldY + perp + rollFactor * roll;
  }
  r.mesh.geometry.positions = positions;
  r.mesh.alpha = Math.min(1, ribbon.peakAlpha * alphaEnv * strength);
}

function setTime(state: SurfaceWavesState, seconds: number): void {
  if (state.disposed) return;
  const t = Math.max(0, seconds);
  // Remember the latest clock first so a later setAmbient(true) can
  // re-sync to the current value, even if intermediate setTime calls
  // happened while ambient was off.
  state.rememberedSeconds = t;
  if (!state.ambient || state.strength === 0) return;
  applyTime(state, t, false);
}

function disposeWaves(state: SurfaceWavesState): void {
  if (state.disposed) return;
  state.disposed = true;
  for (const r of state.ribbons) {
    r.mesh.visible = false;
    if (r.mesh.parent) r.mesh.parent.removeChild(r.mesh);
    // We own the geometry buffer set; borrowed Texture.WHITE survives.
    r.geometry.destroy(true);
    r.mesh.destroy({ children: false, texture: false, textureSource: false });
  }
  state.ribbons.length = 0;
  state.meshes.length = 0;
}