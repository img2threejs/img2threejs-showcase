// Coffee-house water windows: PixiJS 8.22 textured Mesh UV motion.
//
// Two disjoint water windows in the source artwork (the distant horizon
// strip at the back of the bay and a smaller reflective channel near
// the foreground) each render via a fixed-geometry MeshGeometry whose
// texture is the same source region a Sprite would draw. The mesh uses
// the native default TextureShader (GL/GPU compatible) — no custom
// shader, no custom GLSL. Only the UV attribute of the geometry is
// animated; positions and indices are immutable.
//
// Geometry layout: a regular COLS x ROWS grid of (COLS+1)*(ROWS+1)
// vertices covering the rectangle. UVs initially sample the framed
// region in 0..1 normalized space. Per-vertex edge strength is
// precomputed so the wave displacement smoothly fades to 0 at every
// rectangle edge, so the wave never crosses into a neighbouring
// region. Per-vertex phase (and its sin/cos) is precomputed; per-frame
// work is one shared sin/cos of omega*t plus 4 multiplies and a
// subtraction per vertex. No allocation in the per-frame path.
//
// Neutrality: the carrier is sin(omega*t + phi) - sin(phi); at t=0
// every displacement is exactly 0, so the original UV grid is
// preserved. The V-axis modulator uses cos(omega*t + psi) - cos(psi)
// for variety, also zero at t=0.
//
// Determinism: clock is an absolute seconds value supplied by the
// scene. setTime(0) returns to a known neutral shape. No random
// sources; all phases and trig components are baked into typed arrays.

import { Container, Mesh, MeshGeometry, Rectangle, Sprite, Texture } from 'pixi.js';

interface WaterParams {
  parent: Container;
  source: Texture;
  liveSource: Texture;
  liveFrameX: number;
  liveFrameY: number;
  frameX: number;
  frameY: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  gridCols: number;
  gridRows: number;
  /** Peak displacement in source pixels along U. */
  amplitudeU: number;
  /** Peak displacement in source pixels along V. */
  amplitudeV: number;
  /** Carrier angular frequency (radians per second). */
  omega: number;
  /** Per-vertex phase base along U (radians). */
  phaseScale: number;
}

interface WaterState {
  container: Container;
  originalSprite: Sprite;
  mesh: Mesh<MeshGeometry>;
  framedTexture: Texture;
  liveTexture: Texture;
  aUV: Float32Array;
  originals: Float32Array;
  edges: Float32Array;
  /** Per-vertex precomputed sin/cos of the U-axis phase. */
  sinPhi: Float32Array;
  cosPhi: Float32Array;
  /** Per-vertex precomputed sin/cos of the V-axis phase. */
  sinPsi: Float32Array;
  cosPsi: Float32Array;
  amplitudeU: number;
  amplitudeV: number;
  strength: number;
  omega: number;
  srcWidth: number;
  srcHeight: number;
  /** Latest clock value applied (so toggling ambient mid-flight re-syncs). */
  lastSeconds: number;
  /** Was aUV uploaded yet? Skip the geometry.uvs setter when nothing changed. */
  dirty: boolean;
  disposed: boolean;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Per-vertex edge fade factor in [0, 1]. Zero on the outermost ring
 * of vertices, 1 once we are at least ~1.5 cells into the interior.
 * The wave displacement is multiplied by this factor so it smoothly
 * vanishes at the rectangle boundary. smoothstep(0, 1.5, dist) is
 * 0 at dist=0 (boundary) and 1 at dist>=1.5 (interior).
 */
function computeEdges(gridCols: number, gridRows: number): Float32Array {
  const count = (gridCols + 1) * (gridRows + 1);
  const edges = new Float32Array(count);
  for (let j = 0; j <= gridRows; j++) {
    const jDist = Math.min(j, gridRows - j);
    const ey = smoothstep(0, 1.5, jDist);
    for (let i = 0; i <= gridCols; i++) {
      const iDist = Math.min(i, gridCols - i);
      const ex = smoothstep(0, 1.5, iDist);
      edges[j * (gridCols + 1) + i] = Math.min(ex, ey);
    }
  }
  return edges;
}

interface BuiltGeometry {
  geometry: MeshGeometry;
  uvs: Float32Array;
  originals: Float32Array;
  edges: Float32Array;
  sinPhi: Float32Array;
  cosPhi: Float32Array;
  sinPsi: Float32Array;
  cosPsi: Float32Array;
}

function buildGeometry(
  width: number,
  height: number,
  gridCols: number,
  gridRows: number,
  phaseScale: number,
): BuiltGeometry {
  const verts = (gridCols + 1) * (gridRows + 1);
  const positions = new Float32Array(verts * 2);
  const uvs = new Float32Array(verts * 2);
  const originals = new Float32Array(verts * 2);
  const edges = computeEdges(gridCols, gridRows);
  const sinPhi = new Float32Array(verts);
  const cosPhi = new Float32Array(verts);
  const sinPsi = new Float32Array(verts);
  const cosPsi = new Float32Array(verts);
  for (let j = 0; j <= gridRows; j++) {
    for (let i = 0; i <= gridCols; i++) {
      const idx = j * (gridCols + 1) + i;
      const x = (i / gridCols) * width;
      const y = (j / gridRows) * height;
      positions[idx * 2] = x;
      positions[idx * 2 + 1] = y;
      const u = i / gridCols;
      const v = j / gridRows;
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
      originals[idx * 2] = u;
      originals[idx * 2 + 1] = v;
      // Spatial phase anchored to vertex coordinates. Deterministic
      // (no Math.random); identical inputs always yield identical
      // waves. Phi feeds the U carrier; Psi feeds the V modulator.
      const phi = phaseScale * (u * 2.1 + v * 1.3) + idx * 0.21;
      const psi = phaseScale * (u * 1.7 - v * 0.9) + idx * 0.17;
      sinPhi[idx] = Math.sin(phi);
      cosPhi[idx] = Math.cos(phi);
      sinPsi[idx] = Math.sin(psi);
      cosPsi[idx] = Math.cos(psi);
    }
  }
  const indices = new Uint32Array(gridCols * gridRows * 6);
  let k = 0;
  for (let j = 0; j < gridRows; j++) {
    for (let i = 0; i < gridCols; i++) {
      const a = j * (gridCols + 1) + i;
      const b = a + 1;
      const c = a + (gridCols + 1);
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const geometry = new MeshGeometry({ positions, uvs, indices });
  return { geometry, uvs, originals, edges, sinPhi, cosPhi, sinPsi, cosPsi };
}

function makeFramedTexture(source: Texture, fx: number, fy: number, fw: number, fh: number): Texture {
  return new Texture({
    source: source.source,
    frame: new Rectangle(fx, fy, fw, fh),
  });
}

function createWater(p: WaterParams): WaterState {
  const framedTexture = makeFramedTexture(p.source, p.frameX, p.frameY, p.width, p.height);
  const liveTexture = makeFramedTexture(p.liveSource, p.liveFrameX, p.liveFrameY, p.width, p.height);
  const originalSprite = new Sprite({ texture: framedTexture });
  originalSprite.x = p.originX;
  originalSprite.y = p.originY;
  p.parent.addChild(originalSprite);

  const { geometry, uvs, originals, edges, sinPhi, cosPhi, sinPsi, cosPsi } = buildGeometry(
    p.width, p.height, p.gridCols, p.gridRows, p.phaseScale,
  );
  const mesh = new Mesh({ texture: liveTexture, geometry });
  mesh.x = p.originX;
  mesh.y = p.originY;
  mesh.visible = false;
  p.parent.addChild(mesh);

  return {
    container: p.parent,
    originalSprite,
    mesh,
    framedTexture,
    liveTexture,
    aUV: uvs,
    originals,
    edges,
    sinPhi,
    cosPhi,
    sinPsi,
    cosPsi,
    amplitudeU: p.amplitudeU,
    amplitudeV: p.amplitudeV,
    strength: 1,
    omega: p.omega,
    srcWidth: p.width,
    srcHeight: p.height,
    lastSeconds: 0,
    dirty: false,
    disposed: false,
  };
}

function setAmbient(res: WaterState, ambient: boolean): void {
  if (res.disposed) return;
  res.originalSprite.visible = !ambient;
  res.mesh.visible = ambient;
  if (ambient) {
    // Re-sync the geometry to the latest known clock value when the
    // mesh becomes visible again, so paused-or-skipped frames do not
    // flash a stale neutral grid.
    applyTime(res, res.lastSeconds, true);
  }
}

function applyTime(res: WaterState, seconds: number, force: boolean): void {
  if (res.disposed || !res.mesh.visible) return;
  if (!force && seconds === res.lastSeconds && res.dirty) return;
  const t = seconds;
  const omega = res.omega;
  const sint = Math.sin(omega * t);
  const cost = Math.cos(omega * t);
  const aUV = res.aUV;
  const originals = res.originals;
  const edges = res.edges;
  const sinPhi = res.sinPhi;
  const cosPhi = res.cosPhi;
  const sinPsi = res.sinPsi;
  const cosPsi = res.cosPsi;
  const ampU = res.amplitudeU * res.strength;
  const ampV = res.amplitudeV * res.strength;
  const widthInv = 1 / res.srcWidth;
  const heightInv = 1 / res.srcHeight;
  const verts = sinPhi.length;
  // At t=0: sint=0, cost=1.
  //   dispU = ampU*edge*(0*cosPhi + (1-1)*sinPhi) = 0
  //   dispV = ampV*edge*(0*sinPsi - (1-1)*cosPsi) = 0
  // So every displacement is exactly 0; the geometry samples the
  // framed region bit-exactly.
  for (let idx = 0; idx < verts; idx++) {
    const edge = edges[idx]!;
    if (edge <= 0) {
      aUV[idx * 2] = originals[idx * 2]!;
      aUV[idx * 2 + 1] = originals[idx * 2 + 1]!;
      continue;
    }
    const u0 = originals[idx * 2]!;
    const v0 = originals[idx * 2 + 1]!;
    // sin(omega*t + phi) - sin(phi) = sint*cosPhi + (cost-1)*sinPhi
    const dispU = 0.5 * ampU * edge * (sint * cosPhi[idx]! + (cost - 1) * sinPhi[idx]!);
    // cos(omega*t + psi) - cos(psi) = cost*cosPsi - sint*sinPsi - cosPsi
    //   = (cost-1)*cosPsi - sint*sinPsi
    const dispV = 0.5 * ampV * edge * ((cost - 1) * cosPsi[idx]! - sint * sinPsi[idx]!);
    aUV[idx * 2] = u0 + dispU * widthInv;
    aUV[idx * 2 + 1] = v0 + dispV * heightInv;
  }
  res.mesh.geometry.uvs = aUV;
  res.lastSeconds = seconds;
  res.dirty = true;
}

function setTime(res: WaterState, seconds: number): void {
  if (res.disposed) return;
  const t = Math.max(0, seconds);
  // Always remember the latest clock so a later setAmbient(true)
  // re-syncs the geometry to the current value, even if the mesh
  // was hidden during intermediate setTime calls.
  if (!res.mesh.visible || res.strength === 0) {
    res.lastSeconds = t;
    return;
  }
  applyTime(res, t, false);
}

function disposeWater(res: WaterState): void {
  if (res.disposed) return;
  res.disposed = true;
  res.mesh.visible = false;
  res.originalSprite.visible = false;
  if (res.container.children.includes(res.mesh)) res.container.removeChild(res.mesh);
  if (res.container.children.includes(res.originalSprite)) res.container.removeChild(res.originalSprite);
  // Host must perform a renderer-first teardown before this runs.
  // geometry.destroy(true) releases the OWN buffer set; Mesh.destroy
  // alone does NOT release them. Texture wrapper is owned; the
  // borrowed atlas source is preserved (destroy(false)).
  res.mesh.geometry.destroy(true);
  res.framedTexture.destroy(false);
  res.liveTexture.destroy(false);
  res.mesh.destroy({ children: false, texture: false, textureSource: false });
  res.originalSprite.destroy({ children: false, texture: false, textureSource: false });
}

export interface WaterWindowHandle {
  /** The live Mesh for this window. Exposed so the host can drive the contract. */
  readonly mesh: Mesh<MeshGeometry>;
  setAmbient(enabled: boolean): void;
  setTime(seconds: number): void;
  setStrength(value: number): void;
  dispose(): void;
}

export function createWaterWindow(
  parent: Container,
  source: Texture,
  frameX: number,
  frameY: number,
  width: number,
  height: number,
  originX: number,
  originY: number,
  gridCols: number,
  gridRows: number,
  amplitudeU: number,
  amplitudeV: number,
  omega: number,
  phaseScale: number,
  liveSource: Texture,
  liveFrameX: number,
  liveFrameY: number,
): WaterWindowHandle {
  const res = createWater({
    parent,
    source,
    liveSource, liveFrameX, liveFrameY,
    frameX, frameY,
    width, height,
    originX, originY,
    gridCols, gridRows,
    amplitudeU, amplitudeV, omega, phaseScale,
  });
  return {
    mesh: res.mesh,
    setAmbient(enabled: boolean): void { setAmbient(res, enabled); },
    setTime(seconds: number): void { setTime(res, seconds); },
    setStrength(value: number): void {
      res.strength = value;
      if (value === 0) {
        res.aUV.set(res.originals);
        res.mesh.geometry.uvs = res.aUV;
        res.dirty = true;
      } else applyTime(res, res.lastSeconds, true);
    },
    dispose(): void { disposeWater(res); },
  };
}
