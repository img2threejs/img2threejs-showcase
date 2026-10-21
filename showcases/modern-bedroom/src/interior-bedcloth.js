import * as THREE from 'three';
import { validateRoomBounds } from './interior-manifest.js';

// Interactive bed linen (duvet + throw). Position-based dynamics on a coarse
// particle grid; the authored high-resolution closed cloth volume is skinned
// onto the solver surface with per-vertex local frames, so every authored
// wrinkle, normal and tangent follows the cloth. Meshes are untouched until the
// user grabs them and the solver sleeps (zero CPU) once the fabric settles.
// All coordinates are Y-up world metres; the scene root must be identity.

const STEP = 1 / 60;
const MAX_FRAME_STEPS = 3;
// A frame that has already spent this long stepping drops the rest of its backlog (the cloth runs slower than real time for a moment)
// instead of stepping again: catching up with the clock is what turns one slow frame into a run of them.
const STEP_BUDGET_MS = 9;
const FOLLOW_BOUNDS_MARGIN = 0.35;
const TABLE = 8192;
const CC_CELL = 0.03;
const REACH_MAX = 0.02;
const FIXED_REACH = 0.002;
// Margin of a moving cloth's contact grid (built right before each pass from the positions it reads): covers the corrections of the pass.
const LIVE_HASH_MARGIN = 0.006;
// A particle pressed on the floor, a collider or the fixed duvet this substep counts this fraction of its mass in a cloth-on-cloth contact,
// so the layer above is pushed out of it instead of the supported layer being driven into its support.
const SUPPORT_W = 0.05;
// Per-particle triangle cache against a fixed surface: slots per particle, how far a particle may move before the list is rebuilt, and
// the extra reach the list is built with so that it still covers the contact range after that move.
const FC_SLOTS = 48, FC_PAD = 0.008, FC_DRIFT2 = (FC_PAD * 0.9) ** 2, FC_STALE = -1;
const STATIC_CELL = 0.2;
// Per-cloth solver parameters (the manifest may override any of them). Fabric stiffness is physical: N/m for stretch and shear, N m for
// bending rigidity. `compression` is the fraction of the tension stiffness that resists compression (fabric buckles, it does not push).
// `stretchDamping`/`bendDamping` are Rayleigh damping times (s); `damping` is velocity damping (1/s); `airDrag` the quadratic drag across
// the sheet (1/m); `gripForce` the strongest pull of the pinch (N) and `gripSpeed` the fastest the pinch target travels (m/s).
const DEFAULTS = {
  stretchStiffness: 1500, shearStiffness: 40, bendRigidity: 0.001, compression: 0.05, stretchDamping: 0.0004, bendDamping: 0.01, stretchIterations: 6,
  friction: 0.6, damping: 1.6, airDrag: 1.2, gripParticles: 3, gripForce: 30, gripSpeed: 12,
  sleepFraction: 0.03, selfCollision: true,
};
const AIR_TANGENT = 0.3;
const SKIN = 0.0012;
const SPEED_CAP = 8;
// After release, extra damping ramps up so a crumpled cloth always comes to rest (like air + fibre friction).
const SETTLE_DELAY = 0.8;
const SETTLE_RAMP = 5;
const SETTLE_MAX = 10;
// Whatever is still stirring this long after release (a heavy cloth draped over an edge, a crumpled heap) is brought to rest by fibre friction and air.
const SETTLE_HARD = 2.5;
const SETTLE_HARD_DAMP = 40;
const SETTLE_FREEZE = 4.5;
const STICK_HARD_SPEED2 = 0.15 * 0.15;
const CONTACT_DAMP = 0.999;
// Kinetic friction is this fraction of the static coefficient (the manifest `friction` is the static one).
const FRICTION_KINETIC = 0.85;
// Self-contact is what keeps a crumpled cloth buzzing, so once it has been free for a while and (almost) nothing moves it is switched off.
const CONTACT_PUSH = 0.008;
const STICK_AFTER = 0.8;
const TOUCH_MEMORY = 8;
const STICK_SPEED2 = 0.03 * 0.03;
// A cloth marked `fixed` is a STATIC surface: it is never picked, never simulated and never skinned,
// and its authored mid-surface is the collision surface for the other cloths.
// The margin added to the design standoff: it keeps the two fabrics from z-fighting at the contact.
const FIXED_CONTACT_MARGIN = 0.001;
// Target spacing of a fixed cloth's collision surface. The authored grid is far finer than a
// contact query can afford to test, so the surface keeps every stride-th authored vertex. The
// stride is chosen so the spacing is about this value.
const FIXED_SURFACE_SPACING = 0.016;
// A strided surface may not be pushed further out than this, or a deep authored dip would lift the
// resting cloth off the fabric.
const FIXED_SURFACE_MAX_PUSH = 0.012;
// Hash table of a fixed cloth's collision surface. It holds many more triangles than a simulated
// cloth's, so it needs its own (larger) table to keep the buckets short.
const FIXED_TABLE = 1 << 19;
// Hash cell of a fixed cloth's collision surface. Its triangles are larger, so a wider cell keeps the
// number of candidate triangles per query low.
const FIXED_HASH_CELL = 0.03;
const SELF_QUIET_AFTER = 1.2;
const SELF_QUIET_FRACTION = 0.08;
const MOVING_SPEED2 = 0.1 * 0.1;
const SLEEP_DELAY = 0.5;
const REST_WINDOW = 0.25;
const REST_MOVE2 = 0.004 * 0.004;
const clamp = THREE.MathUtils.clamp;
const scratch = new Float64Array(8);
const closest = new Float64Array(6);

function meshKey(mesh) { return mesh.userData?.physical_id ?? mesh.name; }

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') { if (glob[i + 1] === '*') { out += '.*'; i++; } else out += '[^.]*'; }
    else if (ch === '?') out += '[^.]';
    else out += ch.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function resolveMeshes(entries, patterns, label) {
  const found = [];
  const seen = new Set();
  for (const pattern of patterns) {
    const test = pattern.includes('*') || pattern.includes('?') ? globToRegExp(pattern) : null;
    let matched = 0;
    for (const entry of entries) {
      if (test ? !test.test(entry.key) : entry.key !== pattern) continue;
      matched++;
      if (!seen.has(entry.mesh)) { seen.add(entry.mesh); found.push(entry); }
    }
    if (!matched) throw new Error(`bedCloth ${label} "${pattern}" matches no mesh in the loaded model (meshes are matched by extras.physical_id, then node name).`);
  }
  return found;
}

// Which configured cloth (id) owns a mesh, by the same extras.physical_id / name rules the solver uses; null otherwise.
// Lets the renderer give each cloth its own material instances for lighting without touching the physics.
export function createBedClothOwnerLookup(config) {
  const owners = [];
  for (const spec of config?.cloths ?? []) {
    for (const pattern of [spec.surfaceMesh, ...(spec.followMeshes ?? [])]) {
      const test = pattern.includes('*') || pattern.includes('?') ? globToRegExp(pattern) : null;
      owners.push({ id: spec.id, surface: pattern === spec.surfaceMesh, matches: key => (test ? test.test(key) : key === pattern) });
    }
  }
  return mesh => {
    const key = meshKey(mesh);
    const owner = owners.find(candidate => candidate.matches(key));
    return owner ? { id: owner.id, surface: owner.surface } : null;
  };
}

function assertFloat(attribute, mesh, name, size) {
  if (!attribute || attribute.isInterleavedBufferAttribute || attribute.itemSize !== size || !(attribute.array instanceof Float32Array)) {
    throw new Error(`Bed cloth mesh ${mesh.name} needs a plain float ${name} attribute (item size ${size}).`);
  }
  return attribute.array;
}

// ---------------------------------------------------------------------------
// Catmull-Rom lattice that lifts the coarse solver grid to the authored grid.
function axisWeights(fineCells, coarseCells) {
  const idx = new Int32Array((fineCells + 1) * 4);
  const w = new Float32Array((fineCells + 1) * 4);
  // Two-tap (linear) lattice for the cheap channels (rotations, curvature).
  const lin = new Int32Array((fineCells + 1) * 2), linW = new Float32Array(fineCells + 1);
  for (let k = 0; k <= fineCells; k++) {
    const t = k * coarseCells / fineCells;
    const cell = Math.min(coarseCells - 1, Math.floor(t + 1e-9));
    const s = t - cell, s2 = s * s, s3 = s2 * s;
    idx[k * 4] = Math.max(cell - 1, 0);
    idx[k * 4 + 1] = cell;
    idx[k * 4 + 2] = Math.min(cell + 1, coarseCells);
    idx[k * 4 + 3] = Math.min(cell + 2, coarseCells);
    w[k * 4] = -0.5 * s3 + s2 - 0.5 * s;
    w[k * 4 + 1] = 1.5 * s3 - 2.5 * s2 + 1;
    w[k * 4 + 2] = -1.5 * s3 + 2 * s2 + 0.5 * s;
    w[k * 4 + 3] = 0.5 * s3 - 0.5 * s2;
    lin[k * 2] = cell; lin[k * 2 + 1] = Math.min(cell + 1, coarseCells); linW[k] = s;
  }
  return { idx, w, lin, linW };
}

function distinctCount(values, stride, offset, count, min, span) {
  const seen = new Set();
  for (let v = 0; v < count; v++) seen.add(Math.round((values[v * stride + offset] - min) / span * 1e5));
  // Merge float noise: sort and count gaps wider than 0.02 % of the extent.
  const sorted = Array.from(seen).sort((a, b) => a - b);
  let groups = 1;
  for (let k = 1; k < sorted.length; k++) if (sorted[k] - sorted[k - 1] > 20) groups++;
  return groups;
}

function recoverGrid(mesh, label) {
  const geometry = mesh.geometry;
  const position = assertFloat(geometry.getAttribute('position'), mesh, 'position', 3);
  const uv = assertFloat(geometry.getAttribute('uv'), mesh, 'UV0', 2);
  const count = position.length / 3;
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let v = 0; v < count; v++) {
    const u = uv[v * 2], t = uv[v * 2 + 1];
    if (!Number.isFinite(u) || !Number.isFinite(t)) throw new Error(`${label}: non-finite UV0.`);
    if (u < umin) umin = u; if (u > umax) umax = u;
    if (t < vmin) vmin = t; if (t > vmax) vmax = t;
  }
  const su = umax - umin, sv = vmax - vmin;
  if (!(su > 1e-9 && sv > 1e-9)) throw new Error(`${label}: UV0 has no extent; the cloth grid cannot be recovered.`);
  const nx = distinctCount(uv, 2, 0, count, umin, su) - 1, ny = distinctCount(uv, 2, 1, count, vmin, sv) - 1;
  if (nx < 4 || ny < 4) throw new Error(`${label}: recovered only a ${nx}x${ny} UV0 grid; cloth_volume UV0 must be one value per grid point.`);
  const cols = nx + 1, total = cols * (ny + 1);
  const gridIndex = new Int32Array(count);
  const layerA = new Float32Array(total * 3).fill(NaN);
  const layerB = new Float32Array(total * 3).fill(NaN);
  for (let v = 0; v < count; v++) {
    const fi = (uv[v * 2] - umin) / su * nx, fj = (uv[v * 2 + 1] - vmin) / sv * ny;
    const i = Math.round(fi), j = Math.round(fj);
    if (Math.abs(fi - i) > 0.05 || Math.abs(fj - j) > 0.05) throw new Error(`${label}: UV0 is not a regular ${nx}x${ny} lattice; re-export the cloth_volume authoring.`);
    const g = j * cols + i, g3 = g * 3, p = v * 3;
    gridIndex[v] = g;
    if (Number.isNaN(layerA[g3])) { layerA[g3] = position[p]; layerA[g3 + 1] = position[p + 1]; layerA[g3 + 2] = position[p + 2]; continue; }
    if (Math.abs(position[p] - layerA[g3]) + Math.abs(position[p + 1] - layerA[g3 + 1]) + Math.abs(position[p + 2] - layerA[g3 + 2]) < 3e-5) continue;
    if (Number.isNaN(layerB[g3])) { layerB[g3] = position[p]; layerB[g3 + 1] = position[p + 1]; layerB[g3 + 2] = position[p + 2]; continue; }
    if (Math.abs(position[p] - layerB[g3]) + Math.abs(position[p + 1] - layerB[g3 + 1]) + Math.abs(position[p + 2] - layerB[g3 + 2]) > 3e-5) throw new Error(`${label}: a grid point carries more than two surface layers.`);
  }
  const mid = new Float32Array(total * 3);
  for (let g = 0; g < total; g++) {
    const g3 = g * 3;
    if (Number.isNaN(layerA[g3])) throw new Error(`${label}: grid point ${g % cols},${Math.floor(g / cols)} has no vertex; the authored ${nx}x${ny} grid is incomplete.`);
    const two = !Number.isNaN(layerB[g3]);
    for (let d = 0; d < 3; d++) mid[g3 + d] = two ? (layerA[g3 + d] + layerB[g3 + d]) * 0.5 : layerA[g3 + d];
  }
  return { gridIndex, mid, nx, ny };
}

function sampleBilinear(mid, cols, rows, fi, fj, out) {
  const i = Math.min(cols - 2, Math.max(0, Math.floor(fi + 1e-9))), j = Math.min(rows - 2, Math.max(0, Math.floor(fj + 1e-9)));
  const a = fi - i, b = fj - j;
  const g00 = (j * cols + i) * 3, g10 = g00 + 3, g01 = g00 + cols * 3, g11 = g01 + 3;
  for (let d = 0; d < 3; d++) {
    out[d] = (1 - a) * (1 - b) * mid[g00 + d] + a * (1 - b) * mid[g10 + d] + (1 - a) * b * mid[g01 + d] + a * b * mid[g11 + d];
  }
}

// Orientation of every solver particle as a unit quaternion (columns of the rotation: tangent along u, tangent along v, normal).
// The normal is the area-weighted sum of the surrounding quad normals, so a tight fold (where one-sided tangent differences
// collapse or reverse) still has a well defined frame. A particle whose neighbourhood degenerates keeps its previous orientation.
function coarseOrientation(cloth, P) {
  const { cx, cy, pc, coarseQ: Q } = cloth;
  for (let b = 0; b <= cy; b++) for (let a = 0; a <= cx; a++) {
    const q = (b * pc + a) * 4;
    const l = (b * pc + Math.max(a - 1, 0)) * 3, r = (b * pc + Math.min(a + 1, cx)) * 3;
    let tx = P[r] - P[l], ty = P[r + 1] - P[l + 1], tz = P[r + 2] - P[l + 2];
    let nx = 0, ny = 0, nz = 0;
    for (let db = -1; db <= 0; db++) for (let da = -1; da <= 0; da++) {
      const a0 = a + da, b0 = b + db;
      if (a0 < 0 || b0 < 0 || a0 >= cx || b0 >= cy) continue;
      const p00 = (b0 * pc + a0) * 3, p10 = p00 + 3, p01 = p00 + pc * 3, p11 = p01 + 3;
      const dx1 = P[p11] - P[p00], dy1 = P[p11 + 1] - P[p00 + 1], dz1 = P[p11 + 2] - P[p00 + 2];
      const dx2 = P[p01] - P[p10], dy2 = P[p01 + 1] - P[p10 + 1], dz2 = P[p01 + 2] - P[p10 + 2];
      nx += dy1 * dz2 - dz1 * dy2; ny += dz1 * dx2 - dx1 * dz2; nz += dx1 * dy2 - dy1 * dx2;
    }
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const tn = tx * nx + ty * ny + tz * nz;
    tx -= tn * nx; ty -= tn * ny; tz -= tn * nz;
    const tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-12) continue;
    tx /= tl; ty /= tl; tz /= tl;
    const sx = ny * tz - nz * ty, sy = nz * tx - nx * tz, sz = nx * ty - ny * tx; // e2 = n x e1
    // Rotation matrix with columns (t, s, n) -> quaternion (x, y, z, w).
    const m00 = tx, m10 = ty, m20 = tz, m01 = sx, m11 = sy, m21 = sz, m02 = nx, m12 = ny, m22 = nz;
    const trace = m00 + m11 + m22;
    let qx, qy, qz, qw;
    if (trace > 0) { const k = 0.5 / Math.sqrt(trace + 1); qw = 0.25 / k; qx = (m21 - m12) * k; qy = (m02 - m20) * k; qz = (m10 - m01) * k; }
    else if (m00 > m11 && m00 > m22) { const k = 2 * Math.sqrt(1 + m00 - m11 - m22); qw = (m21 - m12) / k; qx = 0.25 * k; qy = (m01 + m10) / k; qz = (m02 + m20) / k; }
    else if (m11 > m22) { const k = 2 * Math.sqrt(1 + m11 - m00 - m22); qw = (m02 - m20) / k; qx = (m01 + m10) / k; qy = 0.25 * k; qz = (m12 + m21) / k; }
    else { const k = 2 * Math.sqrt(1 + m22 - m00 - m11); qw = (m10 - m01) / k; qx = (m02 + m20) / k; qy = (m12 + m21) / k; qz = 0.25 * k; }
    Q[q] = qx; Q[q + 1] = qy; Q[q + 2] = qz; Q[q + 3] = qw;
  }
  // Curvature of the solver surface: rotation between neighbouring particle frames per metre of cloth between them.
  const K = cloth.kappaCoarse;
  K.fill(0);
  const pair = (p, n) => {
    const q = p * 4, r = n * 4, dot = Math.abs(Q[q] * Q[r] + Q[q + 1] * Q[r + 1] + Q[q + 2] * Q[r + 2] + Q[q + 3] * Q[r + 3]);
    const angle = 2 * Math.acos(dot > 1 ? 1 : dot);
    const dx = P[p * 3] - P[n * 3], dy = P[p * 3 + 1] - P[n * 3 + 1], dz = P[p * 3 + 2] - P[n * 3 + 2];
    const k = Math.min(KAPPA_MAX, angle / Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.005));
    if (k > K[p]) K[p] = k;
    if (k > K[n]) K[n] = k;
  };
  for (let b = 0; b <= cy; b++) for (let a = 0; a <= cx; a++) {
    const p = b * pc + a;
    if (a < cx) pair(p, p + 1);
    if (b < cy) pair(p, p + pc);
  }
}

// Evaluates the smooth fine surface and its orthonormal local frames.
// frames layout per fine grid point: F(3) e1(3) e2(3) n(3).
// Positions are Catmull-Rom interpolated from the solver grid; orientations are the particle rotations relative to the authored
// pose, blended linearly (sign-aligned quaternions, renormalised). The authored pose therefore has identity frames.
function evaluateSurface(cloth, particles, frames, rest = false) {
  const { nx, ny, cx, wi, wj, tmp, tmpQ, tmpK, kFine, kappaCoarse, fine, coarseQ, coarseQ0, relQ } = cloth;
  const cols = nx + 1, pc = cx + 1;
  const wiIdx = wi.idx, wiW = wi.w, wjIdx = wj.idx, wjW = wj.w, wiLin = wi.lin, wiLinW = wi.linW, wjLin = wj.lin, wjLinW = wj.linW;
  coarseOrientation(cloth, particles);
  // Frames are the rotation of each particle relative to its authored pose (identity there). Vertex offsets are stored in world axes,
  // so a pose near the authored one moves every vertex by about the particle motion, however tightly the authored cloth is folded.
  for (let p = 0, n = cloth.N; p < n; p++) {
    const q = p * 4;
    if (rest) { relQ[q] = relQ[q + 1] = relQ[q + 2] = 0; relQ[q + 3] = 1; continue; }
    const ax = coarseQ[q], ay = coarseQ[q + 1], az = coarseQ[q + 2], aw = coarseQ[q + 3], bx = -coarseQ0[q], by = -coarseQ0[q + 1], bz = -coarseQ0[q + 2], bw = coarseQ0[q + 3];
    let x = aw * bx + ax * bw + ay * bz - az * by, y = aw * by - ax * bz + ay * bw + az * bx, z = aw * bz + ax * by - ay * bx + az * bw, w = aw * bw - ax * bx - ay * by - az * bz;
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    relQ[q] = x; relQ[q + 1] = y; relQ[q + 2] = z; relQ[q + 3] = w;
  }
  for (let b = 0; b <= cloth.cy; b++) {
    const row = b * pc, out = b * cols;
    for (let i = 0; i < cols; i++) {
      const k = i * 4;
      const a0 = (row + wiIdx[k]) * 3, a1 = (row + wiIdx[k + 1]) * 3, a2 = (row + wiIdx[k + 2]) * 3, a3 = (row + wiIdx[k + 3]) * 3;
      const w0 = wiW[k], w1 = wiW[k + 1], w2 = wiW[k + 2], w3 = wiW[k + 3];
      const o = (out + i) * 3;
      tmp[o] = w0 * particles[a0] + w1 * particles[a1] + w2 * particles[a2] + w3 * particles[a3];
      tmp[o + 1] = w0 * particles[a0 + 1] + w1 * particles[a1 + 1] + w2 * particles[a2 + 1] + w3 * particles[a3 + 1];
      tmp[o + 2] = w0 * particles[a0 + 2] + w1 * particles[a1 + 2] + w2 * particles[a2 + 2] + w3 * particles[a3 + 2];
      const pa = row + wiLin[i * 2], pb = row + wiLin[i * 2 + 1], s = wiLinW[i], qa = pa * 4, qb = pb * 4;
      const sg = relQ[qa] * relQ[qb] + relQ[qa + 1] * relQ[qb + 1] + relQ[qa + 2] * relQ[qb + 2] + relQ[qa + 3] * relQ[qb + 3] < 0 ? -s : s, t4 = (out + i) * 4;
      tmpQ[t4] = (1 - s) * relQ[qa] + sg * relQ[qb]; tmpQ[t4 + 1] = (1 - s) * relQ[qa + 1] + sg * relQ[qb + 1];
      tmpQ[t4 + 2] = (1 - s) * relQ[qa + 2] + sg * relQ[qb + 2]; tmpQ[t4 + 3] = (1 - s) * relQ[qa + 3] + sg * relQ[qb + 3];
      tmpK[out + i] = (1 - s) * kappaCoarse[pa] + s * kappaCoarse[pb];
    }
  }
  for (let j = 0; j <= ny; j++) {
    const k = j * 4;
    const r0 = wjIdx[k] * cols, r1 = wjIdx[k + 1] * cols, r2 = wjIdx[k + 2] * cols, r3 = wjIdx[k + 3] * cols;
    const w0 = wjW[k], w1 = wjW[k + 1], w2 = wjW[k + 2], w3 = wjW[k + 3];
    const ra = wjLin[j * 2] * cols, rb = wjLin[j * 2 + 1] * cols, s = wjLinW[j], is = 1 - s;
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 3;
      const a0 = (r0 + i) * 3, a1 = (r1 + i) * 3, a2 = (r2 + i) * 3, a3 = (r3 + i) * 3;
      const fx = w0 * tmp[a0] + w1 * tmp[a1] + w2 * tmp[a2] + w3 * tmp[a3];
      const fy = w0 * tmp[a0 + 1] + w1 * tmp[a1 + 1] + w2 * tmp[a2 + 1] + w3 * tmp[a3 + 1];
      const fz = w0 * tmp[a0 + 2] + w1 * tmp[a1 + 2] + w2 * tmp[a2 + 2] + w3 * tmp[a3 + 2];
      fine[o] = fx; fine[o + 1] = fy; fine[o + 2] = fz;
      const qa = (ra + i) * 4, qb = (rb + i) * 4;
      const sg = tmpQ[qa] * tmpQ[qb] + tmpQ[qa + 1] * tmpQ[qb + 1] + tmpQ[qa + 2] * tmpQ[qb + 2] + tmpQ[qa + 3] * tmpQ[qb + 3] < 0 ? -s : s;
      let x = is * tmpQ[qa] + sg * tmpQ[qb], y = is * tmpQ[qa + 1] + sg * tmpQ[qb + 1], z = is * tmpQ[qa + 2] + sg * tmpQ[qb + 2], w = is * tmpQ[qa + 3] + sg * tmpQ[qb + 3];
      const g = j * cols + i, f = g * 12;
      kFine[g] = is * tmpK[ra + i] + s * tmpK[rb + i];
      frames[f] = fx; frames[f + 1] = fy; frames[f + 2] = fz;
      const ql = Math.sqrt(x * x + y * y + z * z + w * w);
      if (ql < 1e-9) {
        // Degenerate blend: keep the previous frame so skinning stays finite.
        if (frames[f + 3] === 0 && frames[f + 4] === 0 && frames[f + 5] === 0) { frames[f + 3] = 1; frames[f + 7] = 1; frames[f + 11] = 1; }
        continue;
      }
      const iq = 1 / ql; x *= iq; y *= iq; z *= iq; w *= iq;
      const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
      // Columns of the rotation matrix: e1, e2, n.
      frames[f + 3] = 1 - 2 * (yy + zz); frames[f + 4] = 2 * (xy + wz); frames[f + 5] = 2 * (xz - wy);
      frames[f + 6] = 2 * (xy - wz); frames[f + 7] = 1 - 2 * (xx + zz); frames[f + 8] = 2 * (yz + wx);
      frames[f + 9] = 2 * (xz + wy); frames[f + 10] = 2 * (yz - wx); frames[f + 11] = 1 - 2 * (xx + yy);
    }
  }
}

function bindAttribute(source, gridIndex, frames, vertexCount, size) {
  // Local coordinates of a vector (position offset, normal or tangent xyz) in the rest frame.
  const out = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const o = gridIndex[v] * 12;
    const x = source[v * size], y = source[v * size + 1], z = source[v * size + 2];
    out[v * 3] = x * frames[o + 3] + y * frames[o + 4] + z * frames[o + 5];
    out[v * 3 + 1] = x * frames[o + 6] + y * frames[o + 7] + z * frames[o + 8];
    out[v * 3 + 2] = x * frames[o + 9] + y * frames[o + 10] + z * frames[o + 11];
  }
  return out;
}

function makeBinding(mesh, gridIndex, frames0, kind, rigidPieces = null) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const tangent = geometry.getAttribute('tangent');
  const count = position.count;
  const posArray = assertFloat(position, mesh, 'position', 3);
  const offsets = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const o = gridIndex[v] * 12;
    offsets[v * 3] = posArray[v * 3] - frames0[o];
    offsets[v * 3 + 1] = posArray[v * 3 + 1] - frames0[o + 1];
    offsets[v * 3 + 2] = posArray[v * 3 + 2] - frames0[o + 2];
  }
  const binding = {
    mesh, kind, count, gridIndex, position,
    posArray, normal: normal ? normal : null, tangent: tangent ? tangent : null,
    local: bindAttribute(offsets, gridIndex, frames0, count, 3),
    originalPosition: posArray.slice(),
    originalFrustumCulled: mesh.frustumCulled,
    originalBox: geometry.boundingBox?.clone() ?? null,
    originalSphere: geometry.boundingSphere?.clone() ?? null,
    rigid: null,
  };
  if (rigidPieces?.length) {
    // Rigid pieces keep their own shape; they hang from their root like pendulums.
    const pieces = rigidPieces.map(piece => {
      const verts = Int32Array.from(piece.vertices), local = binding.local;
      const pick = [];
      for (let axis = 0; axis < 3; axis++) {
        let lo = verts[0], hi = verts[0];
        for (const v of verts) { if (local[v * 3 + axis] < local[lo * 3 + axis]) lo = v; if (local[v * 3 + axis] > local[hi * 3 + axis]) hi = v; }
        pick.push(lo, hi);
      }
      let far = verts[0], farD = -1;
      for (const v of verts) { const d = local[v * 3] ** 2 + local[v * 3 + 1] ** 2 + local[v * 3 + 2] ** 2; if (d > farD) { farD = d; far = v; } }
      pick.push(far);
      // The strand's own shape: the root-to-tip chord and how far it bulges away from it. A drooping strand sags below the chord,
      // and the ground has to be measured against that. Both are fixed, because the piece is rigid.
      const fl = Math.hypot(local[far * 3], local[far * 3 + 1], local[far * 3 + 2]);
      const ux = fl > 1e-6 ? local[far * 3] / fl : 0, uy = fl > 1e-6 ? local[far * 3 + 1] / fl : -1, uz = fl > 1e-6 ? local[far * 3 + 2] / fl : 0;
      let sag = 0;
      for (const v of verts) {
        const dx = local[v * 3], dy = local[v * 3 + 1], dz = local[v * 3 + 2];
        const along = dx * ux + dy * uy + dz * uz;
        const perp = Math.hypot(dx - along * ux, dy - along * uy, dz - along * uz);
        if (perp > sag) sag = perp;
      }
      // The strand's own bearing, in the root's tangent plane. A tassel hangs along the hem, so this is the direction it keeps;
      // it is the fallback bearing for a strand that happens to stand exactly vertical.
      const al = Math.hypot(local[far * 3], local[far * 3 + 1]);
      // Clearance is checked on a spread of the strand, not only on its extremes.
      const stride = Math.max(1, Math.floor(verts.length / 16));
      for (let i = 0; i < verts.length; i += stride) pick.push(verts[i]);
      return { anchor: piece.anchor, tip: far, vertices: verts, samples: Int32Array.from(new Set(pick)), sag,
        azimX: al > 1e-4 ? local[far * 3] / al : 0, azimY: al > 1e-4 ? local[far * 3 + 1] / al : 0 };
    });
    binding.rigid = pieces;
  }
  if (normal) {
    assertFloat(normal, mesh, 'normal', 3);
    binding.localNormal = bindAttribute(normal.array, gridIndex, frames0, count, 3);
    binding.originalNormal = normal.array.slice();
  }
  if (tangent) {
    assertFloat(tangent, mesh, 'tangent', 4);
    binding.localTangent = bindAttribute(tangent.array, gridIndex, frames0, count, 4);
    binding.originalTangent = tangent.array.slice();
  }
  return binding;
}

// Welds exact-duplicate vertices (hard-edge / UV-seam splits) so cloth-surface connectivity is geometric, not index based.
function weldVertices(posArray, count) {
  const wid = new Int32Array(count);
  const seen = new Map();
  let wcount = 0;
  const q = 1 / 2e-4;
  for (let v = 0; v < count; v++) {
    const k = `${Math.round(posArray[v * 3] * q)},${Math.round(posArray[v * 3 + 1] * q)},${Math.round(posArray[v * 3 + 2] * q)}`;
    let w = seen.get(k);
    if (w === undefined) { w = wcount++; seen.set(k, w); }
    wid[v] = w;
  }
  return { wid, wcount };
}

// A follower mesh is bound to the solver grid by proximity, but proximity alone is ambiguous where the authored cloth is folded
// back onto itself within a centimetre: neighbouring vertices could pick grid points on opposite layers and be torn apart as soon as
// the cloth moves. So grid points are chosen by flood-filling the welded surface: every vertex takes the near-equal-distance
// candidate that is closest, in grid space, to the point its neighbour already chose. Small free-standing pieces (fringe strands) are
// bound rigidly to a single grid point so they cannot stretch at all.
const RIGID_FOLLOWER_DIAGONAL = 0.2;
const SKIN_OFFSET_PERCENTILE = 0.97;
const KAPPA_MAX = 300;
const SHRINK_BUDGET = 0.8;
const SHRINK_MIN = 0.25;
const PICK_SLACK = 0.008;
const PICK_ANGLE = 0.012;
function bindFollowerGrid(mesh, mid, cols, rows) {
  const geometry = mesh.geometry;
  const posArray = assertFloat(geometry.getAttribute('position'), mesh, 'position', 3);
  const count = posArray.length / 3;
  const cell = 0.04;
  const buckets = new Map();
  const total = cols * rows;
  const key = (x, y, z) => Math.imul(x, HASH_P1) ^ Math.imul(y, HASH_P2) ^ Math.imul(z, HASH_P3);
  for (let g = 0; g < total; g++) {
    const k = key(Math.floor(mid[g * 3] / cell), Math.floor(mid[g * 3 + 1] / cell), Math.floor(mid[g * 3 + 2] / cell));
    const list = buckets.get(k);
    if (list) list.push(g); else buckets.set(k, [g]);
  }
  const { wid, wcount } = weldVertices(posArray, count);
  const rep = new Int32Array(wcount).fill(-1);
  for (let v = 0; v < count; v++) if (rep[wid[v]] < 0) rep[wid[v]] = v;
  // Welded adjacency (CSR).
  const index = geometry.index?.array;
  const triCount = index ? index.length / 3 : count / 3;
  const corner = (t, k) => wid[index ? index[t * 3 + k] : t * 3 + k];
  const degree = new Int32Array(wcount + 1);
  for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) { const a = corner(t, k), b = corner(t, (k + 1) % 3); if (a !== b) { degree[a + 1]++; degree[b + 1]++; } }
  for (let w = 0; w < wcount; w++) degree[w + 1] += degree[w];
  const fill = degree.slice(0, wcount);
  const edges = new Int32Array(degree[wcount]);
  for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) { const a = corner(t, k), b = corner(t, (k + 1) % 3); if (a !== b) { edges[fill[a]++] = b; edges[fill[b]++] = a; } }

  const candidates = [];
  const search = (x, y, z, limit) => {
    // Nearest grid point; when limit is given, also every grid point within limit(bestDistance).
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1, bestD = Infinity;
    for (let ring = 0; ring < 48; ring++) {
      if (best >= 0 && (ring - 1) * cell > Math.sqrt(bestD)) break;
      for (let a = -ring; a <= ring; a++) for (let b = -ring; b <= ring; b++) {
        // Only the shell of this ring: the interior of the cube was visited by the smaller rings. Same visiting order as the full scan.
        const step = Math.max(Math.abs(a), Math.abs(b)) === ring ? 1 : 2 * ring;
        for (let c = -ring; c <= ring; c += step) {
          const list = buckets.get(key(cx + a, cy + b, cz + c));
          if (!list) continue;
          for (const g of list) {
            const dx = mid[g * 3] - x, dy = mid[g * 3 + 1] - y, dz = mid[g * 3 + 2] - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) { bestD = d; best = g; }
          }
        }
      }
    }
    if (best < 0) throw new Error(`Follower mesh ${mesh.name} has a vertex more than ${(48 * cell).toFixed(1)} m from its cloth.`);
    candidates.length = 0;
    if (limit) {
      const R = limit(Math.sqrt(bestD)), R2 = R * R, rings = Math.ceil(R / cell);
      for (let a = -rings; a <= rings; a++) for (let b = -rings; b <= rings; b++) for (let c = -rings; c <= rings; c++) {
        const list = buckets.get(key(cx + a, cy + b, cz + c));
        if (!list) continue;
        for (const g of list) {
          const dx = mid[g * 3] - x, dy = mid[g * 3 + 1] - y, dz = mid[g * 3 + 2] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d <= R2) candidates.push(g, d);
        }
      }
    }
    return { best, bestD };
  };

  const chosen = new Int32Array(wcount).fill(-1), nearD = new Float64Array(wcount), component = new Int32Array(wcount).fill(-1);
  const queue = new Int32Array(wcount);
  const comps = [];
  const slack = d => Math.max(d * 1.6, d + 0.012);
  for (let seed = 0; seed < wcount; seed++) {
    if (chosen[seed] >= 0) continue;
    const v0 = rep[seed] * 3;
    const s = search(posArray[v0], posArray[v0 + 1], posArray[v0 + 2], null);
    chosen[seed] = s.best; nearD[seed] = Math.sqrt(s.bestD); component[seed] = comps.length;
    const info = { members: [seed], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    comps.push(info);
    let head = 0, tail = 0;
    queue[tail++] = seed;
    while (head < tail) {
      const w = queue[head++];
      const gp = chosen[w], pi = gp % cols, pj = (gp - pi) / cols;
      for (let e = degree[w]; e < degree[w + 1]; e++) {
        const u = edges[e];
        if (chosen[u] >= 0) continue;
        const o = rep[u] * 3;
        const r = search(posArray[o], posArray[o + 1], posArray[o + 2], slack);
        let pick = r.best, pickCost = Infinity, pickD = Infinity;
        for (let k = 0; k < candidates.length; k += 2) {
          const g = candidates[k], gi = g % cols, gj = (g - gi) / cols;
          const cost = Math.max(Math.abs(gi - pi), Math.abs(gj - pj));
          if (cost < pickCost || (cost === pickCost && candidates[k + 1] < pickD)) { pickCost = cost; pickD = candidates[k + 1]; pick = g; }
        }
        chosen[u] = pick; nearD[u] = Math.sqrt(r.bestD); component[u] = component[w];
        info.members.push(u);
        queue[tail++] = u;
      }
    }
  }
  for (const info of comps) for (const w of info.members) {
    const o = rep[w] * 3;
    for (let d = 0; d < 3; d++) { if (posArray[o + d] < info.min[d]) info.min[d] = posArray[o + d]; if (posArray[o + d] > info.max[d]) info.max[d] = posArray[o + d]; }
  }
  const gridIndex = new Int32Array(count);
  const vertexComp = new Int32Array(count).fill(-1);
  const rigid = [];
  const rigidOf = new Int32Array(comps.length).fill(-1);
  comps.forEach((info, c) => {
    if (Math.hypot(info.max[0] - info.min[0], info.max[1] - info.min[1], info.max[2] - info.min[2]) > RIGID_FOLLOWER_DIAGONAL) return;
    let anchor = info.members[0];
    for (const w of info.members) if (nearD[w] < nearD[anchor]) anchor = w;
    rigidOf[c] = rigid.length;
    rigid.push({ anchor: chosen[anchor], vertices: [] });
  });
  for (let v = 0; v < count; v++) {
    const w = wid[v], r = rigidOf[component[w]];
    if (r >= 0) { gridIndex[v] = rigid[r].anchor; vertexComp[v] = r; rigid[r].vertices.push(v); } else gridIndex[v] = chosen[w];
  }
  return { gridIndex, rigid };
}

// ---------------------------------------------------------------------------
function buildCloth(spec, entries, followEntries, config, room) {
  const label = `Cloth ${spec.id}`;
  const surface = entries;
  const recovered = recoverGrid(surface.mesh, `${label} (${surface.key})`);
  const { gridIndex, mid, nx, ny } = recovered;
  const cols = nx + 1, rows = ny + 1, total = cols * rows;
  // Physical extent along each grid axis (mid-row / mid-column polyline length) sizes the solver grid.
  const polyline = (count, at) => { let s = 0; for (let k = 1; k < count; k++) { const a = at(k - 1) * 3, b = at(k) * 3; s += Math.hypot(mid[a] - mid[b], mid[a + 1] - mid[b + 1], mid[a + 2] - mid[b + 2]); } return s; };
  const lengthU = polyline(cols, k => (ny >> 1) * cols + k), lengthV = polyline(rows, k => k * cols + (nx >> 1));
  const spacing = spec.simSpacing ?? 0.03;
  const [cx, cy] = spec.simGrid ? [Math.min(spec.simGrid[0], nx), Math.min(spec.simGrid[1], ny)]
    : [clamp(Math.round(lengthU / spacing), 4, nx), clamp(Math.round(lengthV / spacing), 4, ny)];
  const advisory = spec.grid && (spec.grid[0] !== nx || spec.grid[1] !== ny) ? `manifest grid ${spec.grid.join('x')} differs from geometry ${nx}x${ny}; geometry used` : null;
  const pc = cx + 1, N = pc * (cy + 1);
  const params = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (spec[key] !== undefined) params[key] = spec[key];
  const cloth = {
    advisory, id: spec.id, spec, params, nx, ny, cx, cy, pc, N, thickness: spec.thickness, massPerM2: spec.massPerM2,
    wi: axisWeights(nx, cx), wj: axisWeights(ny, cy),
    tmp: new Float32Array((cy + 1) * cols * 3), tmpQ: new Float32Array((cy + 1) * cols * 4), coarseQ: new Float32Array(N * 4), coarseQ0: new Float32Array(N * 4), relQ: new Float32Array(N * 4), kappaCoarse: new Float32Array(N), tmpK: new Float32Array((cy + 1) * cols), kFine: new Float32Array(total), kappaRest: new Float32Array(total), offMax: new Float32Array(total), shrink: new Float32Array(total).fill(1), fine: new Float32Array(total * 3),
    frames: new Float32Array(total * 12), frames0: new Float32Array(total * 12),
    rest: new Float64Array(N * 3), X: new Float64Array(N * 3), P: new Float64Array(N * 3), V: new Float64Array(N * 3),
    W: new Float64Array(N), normals: new Float64Array(N * 3), radius: new Float64Array(N), CN: new Float64Array(N * 3), CF: new Uint8Array(N), SC: new Uint8Array(N), touch: new Uint8Array(N), meanSpeed: 0, movingFraction: 1, driftFraction: 1, free: 0, window: 0, snap: new Float64Array(N * 3),
    bindings: [], awake: false, quiet: 0, maxSpeed: 0, dirty: false, boundsMin: new Float64Array(3), boundsMax: new Float64Array(3),
    awakeFrames: 0, wakeReason: null,
  };
  // Coarse rest particles sample the authored mid-surface.
  const out = new Float64Array(3);
  for (let b = 0; b <= cy; b++) for (let a = 0; a <= cx; a++) {
    sampleBilinear(mid, cols, rows, a * nx / cx, b * ny / cy, out);
    cloth.rest.set(out, (b * pc + a) * 3);
  }
  cloth.X.set(cloth.rest); cloth.P.set(cloth.rest);
  for (let p = 0; p < N; p++) cloth.coarseQ[p * 4 + 3] = 1;
  evaluateSurface(cloth, cloth.rest, cloth.frames0, true);
  cloth.coarseQ0.set(cloth.coarseQ);
  cloth.kappaRest.set(cloth.kFine);
  cloth.frames.set(cloth.frames0);
  cloth.bindings.push(makeBinding(surface.mesh, gridIndex, cloth.frames0, 'surface'));
  {
    // How far the visible skin stands off the solver surface (authored loft, wrinkle relief). Another cloth resting on this one
    // is held at least this far away, or the lower cloth's wrinkles would cut through it.
    const first = cloth.bindings[0], local = first.local, normals = first.originalNormal, n = first.count, mags = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      const o = v * 3;
      mags[v] = normals ? Math.abs(local[o] * normals[o] + local[o + 1] * normals[o + 1] + local[o + 2] * normals[o + 2]) : Math.hypot(local[o], local[o + 1], local[o + 2]);
    }
    mags.sort();
    cloth.skinOffset = Math.max(spec.thickness * 0.5, mags[Math.min(n - 1, Math.floor(n * SKIN_OFFSET_PERCENTILE))]);
  }
  for (const follower of followEntries) {
    const { gridIndex: index, rigid } = bindFollowerGrid(follower.mesh, mid, cols, rows);
    cloth.bindings.push(makeBinding(follower.mesh, index, cloth.frames0, 'follower', rigid));
  }
  for (const binding of cloth.bindings) {
    if (binding.rigid) continue;
    const { local, gridIndex: gi, count } = binding;
    for (let v = 0; v < count; v++) {
      const m = Math.hypot(local[v * 3], local[v * 3 + 1], local[v * 3 + 2]);
      if (m > cloth.offMax[gi[v]]) cloth.offMax[gi[v]] = m;
    }
  }
  // Masses from rest cell areas.
  const area = new Float64Array(N);
  const rest = cloth.rest;
  for (let b = 0; b < cy; b++) for (let a = 0; a < cx; a++) {
    const p00 = (b * pc + a) * 3, p10 = p00 + 3, p01 = p00 + pc * 3;
    const ux = rest[p10] - rest[p00], uy = rest[p10 + 1] - rest[p00 + 1], uz = rest[p10 + 2] - rest[p00 + 2];
    const vx = rest[p01] - rest[p00], vy = rest[p01 + 1] - rest[p00 + 1], vz = rest[p01 + 2] - rest[p00 + 2];
    const cell = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 0.25;
    area[b * pc + a] += cell; area[b * pc + a + 1] += cell; area[(b + 1) * pc + a] += cell; area[(b + 1) * pc + a + 1] += cell;
  }
  let totalArea = 0;
  for (let p = 0; p < N; p++) { totalArea += area[p]; cloth.W[p] = 1 / Math.max(1e-6, area[p] * spec.massPerM2); }
  cloth.Wc = Float64Array.from(cloth.W);
  cloth.area = totalArea;
  cloth.mass = totalArea * spec.massPerM2;
  // Constraints.
  const stretch = [], shear = [], bend = [];
  const dist = (a, b) => Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
  for (let b = 0; b <= cy; b++) for (let a = 0; a <= cx; a++) {
    const p = b * pc + a;
    if (a < cx) stretch.push(p, p + 1, dist(p, p + 1));
    if (b < cy) stretch.push(p, p + pc, dist(p, p + pc));
    if (a < cx && b < cy) { shear.push(p, p + pc + 1, dist(p, p + pc + 1)); shear.push(p + 1, p + pc, dist(p + 1, p + pc)); }
    // Bending: three consecutive particles along a grid line (the middle one is the hinge).
    if (a + 2 <= cx) bend.push(p, p + 1, p + 2);
    if (b + 2 <= cy) bend.push(p, p + pc, p + 2 * pc);
  }
  const pack = list => {
    const n = list.length / 3, ids = new Int32Array(n * 2), len = new Float64Array(n);
    for (let c = 0; c < n; c++) { ids[c * 2] = list[c * 3]; ids[c * 2 + 1] = list[c * 3 + 1]; len[c] = list[c * 3 + 2]; }
    return { n, ids, len };
  };
  cloth.stretch = pack(stretch); cloth.shear = pack(shear); cloth.bend = { n: bend.length / 3, ids: Int32Array.from(bend) };
  cloth.stretch.lam = new Float64Array(cloth.stretch.n); cloth.shear.lam = new Float64Array(cloth.shear.n);
  // Mean solver spacing (the first constraint can sit in a pinched authored corner, which once made the duvet grip a single particle).
  { let sum = 0; for (let c = 0; c < cloth.stretch.n; c++) sum += cloth.stretch.len[c]; cloth.spacing = sum / Math.max(1, cloth.stretch.n) || 0.03; }
  // Physical compliances (m/N). A square-grid edge carries the fabric's stiffness per metre of width unchanged. Bending: the curvature
  // constraint |a + b - 2m| ~ L * fold angle, so its stiffness is rigidity / L^2. Compression is a small fraction of tension.
  cloth.alphaStretch = 1 / params.stretchStiffness; cloth.alphaStretchCompress = cloth.alphaStretch / params.compression;
  cloth.alphaShear = 1 / params.shearStiffness; cloth.alphaShearCompress = cloth.alphaShear / params.compression;
  cloth.alphaBend = cloth.spacing * cloth.spacing / params.bendRigidity;
  // Triangles (two per solver cell) for picking and cloth-cloth contact.
  cloth.triCount = cx * cy * 2;
  cloth.tris = new Int32Array(cloth.triCount * 3);
  cloth.triCell = new Int16Array(cloth.triCount * 2);
  let t = 0;
  for (let b = 0; b < cy; b++) for (let a = 0; a < cx; a++) {
    const p = b * pc + a;
    cloth.tris.set([p, p + 1, p + pc], t * 3); cloth.triCell[t * 2] = a; cloth.triCell[t * 2 + 1] = b; t++;
    cloth.tris.set([p + 1, p + pc + 1, p + pc], t * 3); cloth.triCell[t * 2] = a; cloth.triCell[t * 2 + 1] = b; t++;
  }
  cloth.hash = { start: new Int32Array(TABLE + 1), cursor: new Int32Array(TABLE), items: new Int32Array(cloth.triCount * 8), valid: false };
  cloth.radius.fill(spec.thickness * 0.5 + SKIN);
  cloth.pi = new Int16Array(N); cloth.pj = new Int16Array(N);
  for (let p = 0; p < N; p++) { cloth.pj[p] = Math.floor(p / pc); cloth.pi[p] = p - cloth.pj[p] * pc; }
  cloth.grip = null;
  cloth.simVertices = cloth.bindings.reduce((sum, binding) => sum + binding.count, 0);
  cloth.boundsMin.fill(Infinity); cloth.boundsMax.fill(-Infinity);
  return cloth;
}

// ---------------------------------------------------------------------------
// A fixed cloth is a STATIC surface.
//
// `fixed: true` means the cloth is authored in place and stays there: it is never picked, never
// simulated and never skinned, so its mesh stays exactly as exported and it costs nothing per frame.
// Its authored mid-surface triangles are the collision surface for the other cloths.
//
// The contact standoff is derived from the two fabrics' thicknesses: the other cloth's particles are
// held (its own thickness + the fixed cloth's half thickness) above the fixed cloth's mid-surface, so
// the other fabric's visible underside rests on the fixed fabric's visible top instead of sinking
// into it. The margin is a hair, not the authored loft: a fixed cloth must not hold the other cloth
// in the air.
function buildFixedCloth(spec, entry) {
  const label = `Cloth ${spec.id}`;
  const { mid, nx, ny } = recoverGrid(entry.mesh, `${label} (${entry.key})`);
  const params = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (spec[key] !== undefined) params[key] = spec[key];

  const cols = nx + 1, rows = ny + 1;
  // The collision surface keeps every stride-th authored mid-surface vertex. The authored grid is
  // far finer than a contact query can afford to test (the duvet's authored grid alone is 114 688
  // triangles), so the surface is strided down to a spacing a contact query can afford.
  //
  // A strided surface can cut below the fabric the user sees, so every retained vertex is pushed
  // OUT along the authored normal by the deepest dip of the authored surface it stands for. The
  // collision surface then lies on or above the visible fabric everywhere: the resting cloth never
  // sinks into it.
  const polyline = (count, at) => { let s = 0; for (let k = 1; k < count; k++) { const a = at(k - 1) * 3, b = at(k) * 3; s += Math.hypot(mid[a] - mid[b], mid[a + 1] - mid[b + 1], mid[a + 2] - mid[b + 2]); } return s; };
  const lengthU = polyline(cols, k => (ny >> 1) * cols + k), lengthV = polyline(rows, k => k * cols + (nx >> 1));
  const authoredSpacing = (lengthU / nx + lengthV / ny) * 0.5;
  const stride = Math.max(1, Math.round(FIXED_SURFACE_SPACING / Math.max(1e-4, authoredSpacing)));
  const sx = Math.ceil(nx / stride), sy = Math.ceil(ny / stride);
  const scols = sx + 1, srows = sy + 1, sTotal = scols * srows;
  const surface = new Float32Array(sTotal * 3);
  const normals = new Float32Array(sTotal * 3);
  // The authored grid point each retained vertex stands for.
  const srcI = new Int32Array(scols), srcJ = new Int32Array(srows);
  for (let a = 0; a <= sx; a++) srcI[a] = Math.min(nx, a * stride);
  for (let b = 0; b <= sy; b++) srcJ[b] = Math.min(ny, b * stride);
  for (let b = 0; b <= sy; b++) {
    const j = srcJ[b];
    for (let a = 0; a <= sx; a++) {
      const i = srcI[a];
      const o = (b * scols + a) * 3, g = (j * cols + i) * 3;
      surface[o] = mid[g]; surface[o + 1] = mid[g + 1]; surface[o + 2] = mid[g + 2];
      const il = Math.max(0, i - 1), ir = Math.min(nx, i + 1), jl = Math.max(0, j - 1), jr = Math.min(ny, j + 1);
      const ux = mid[(j * cols + ir) * 3] - mid[(j * cols + il) * 3];
      const uy = mid[(j * cols + ir) * 3 + 1] - mid[(j * cols + il) * 3 + 1];
      const uz = mid[(j * cols + ir) * 3 + 2] - mid[(j * cols + il) * 3 + 2];
      const vx = mid[(jr * cols + i) * 3] - mid[(jl * cols + i) * 3];
      const vy = mid[(jr * cols + i) * 3 + 1] - mid[(jl * cols + i) * 3 + 1];
      const vz = mid[(jr * cols + i) * 3 + 2] - mid[(jl * cols + i) * 3 + 2];
      let nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
      const nl = Math.hypot(nxv, nyv, nzv);
      if (nl > 1e-12) { nxv /= nl; nyv /= nl; nzv /= nl; } else { nxv = 0; nyv = 1; nzv = 0; }
      normals[o] = nxv; normals[o + 1] = nyv; normals[o + 2] = nzv;
    }
  }
  // Push every retained vertex out of the authored surface it stands for, so the collision surface
  // never cuts below the visible fabric.
  for (let b = 0; b <= sy; b++) {
    const j = srcJ[b];
    for (let a = 0; a <= sx; a++) {
      const i = srcI[a];
      const o = (b * scols + a) * 3, nxv = normals[o], nyv = normals[o + 1], nzv = normals[o + 2];
      let dip = 0;
      const jEnd = Math.min(ny, j + stride), iEnd = Math.min(nx, i + stride);
      for (let jj = j; jj <= jEnd; jj++) for (let ii = i; ii <= iEnd; ii++) {
        const g = (jj * cols + ii) * 3;
        const d = (mid[g] - surface[o]) * nxv + (mid[g + 1] - surface[o + 1]) * nyv + (mid[g + 2] - surface[o + 2]) * nzv;
        if (-d > dip) dip = -d;
      }
      const push = Math.min(dip, FIXED_SURFACE_MAX_PUSH);
      surface[o] += nxv * push; surface[o + 1] += nyv * push; surface[o + 2] += nzv * push;
    }
  }

  const pc = scols, N = sTotal;
  const cloth = {
    fixed: true, id: spec.id, spec, params, nx: sx, ny: sy, cx: sx, cy: sy, pc, N,
    thickness: spec.thickness, massPerM2: spec.massPerM2,
    rest: Float64Array.from(surface), X: Float64Array.from(surface), P: Float64Array.from(surface),
    W: new Float64Array(N), normals: Float64Array.from(normals), radius: new Float64Array(N),
    CN: new Float64Array(N * 3), CF: new Uint8Array(N), touch: new Uint8Array(N),
    meanSpeed: 0, movingFraction: 1, driftFraction: 1, free: 0, window: 0, snap: new Float64Array(N * 3),
    bindings: [], awake: false, quiet: 0, maxSpeed: 0, dirty: false, lastDisp: 0, prevMax: 0,
    boundsMin: new Float64Array(3), boundsMax: new Float64Array(3), awakeFrames: 0, wakeReason: null, grip: null,
    authoredGrid: [nx, ny], surfaceStride: stride,
  };
  // The collision surface: two triangles per cell.
  cloth.triCount = sx * sy * 2;
  cloth.tris = new Int32Array(cloth.triCount * 3);
  cloth.triCell = new Int16Array(cloth.triCount * 2);
  let t = 0;
  for (let b = 0; b < sy; b++) for (let a = 0; a < sx; a++) {
    const p = b * pc + a;
    cloth.tris.set([p, p + 1, p + pc], t * 3); cloth.triCell[t * 2] = a; cloth.triCell[t * 2 + 1] = b; t++;
    cloth.tris.set([p + 1, p + pc + 1, p + pc], t * 3); cloth.triCell[t * 2] = a; cloth.triCell[t * 2 + 1] = b; t++;
  }
  // The surface never moves, so its broad-phase grid is built once and stays valid.
  cloth.hash = { start: new Int32Array(FIXED_TABLE + 1), cursor: new Int32Array(FIXED_TABLE), items: new Int32Array(cloth.triCount * 2), valid: false };
  cloth.hashCell = FIXED_HASH_CELL; cloth.hashTable = FIXED_TABLE;
  // The visible skin of a fixed cloth stands off its mid-surface by half its authored thickness.
  cloth.skinOffset = spec.thickness * 0.5;
  // Mass from the surface area: only the mass ORDER matters (the lighter cloth is the one that is
  // pushed out of the other), and the fixed cloth has to be the heavier one.
  const area = new Float64Array(N);
  const rest = cloth.rest;
  for (let b = 0; b < sy; b++) for (let a = 0; a < sx; a++) {
    const p00 = (b * pc + a) * 3, p10 = p00 + 3, p01 = p00 + pc * 3;
    const ux = rest[p10] - rest[p00], uy = rest[p10 + 1] - rest[p00 + 1], uz = rest[p10 + 2] - rest[p00 + 2];
    const vx = rest[p01] - rest[p00], vy = rest[p01 + 1] - rest[p00 + 1], vz = rest[p01 + 2] - rest[p00 + 2];
    const cell = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 0.25;
    area[b * pc + a] += cell; area[b * pc + a + 1] += cell; area[(b + 1) * pc + a] += cell; area[(b + 1) * pc + a + 1] += cell;
  }
  let totalArea = 0;
  for (let p = 0; p < N; p++) { totalArea += area[p]; cloth.W[p] = 1 / Math.max(1e-6, area[p] * spec.massPerM2); }
  cloth.area = totalArea;
  cloth.mass = totalArea * spec.massPerM2;
  cloth.simVertices = entry.mesh.geometry.getAttribute('position').count;
  return cloth;
}

// ---------------------------------------------------------------------------
// Static colliders: world AABBs, optionally with a rounding radius (pillows).
function buildColliders(entries, soft, floorY) {
  const list = [];
  const add = (entry, round) => {
    const geometry = entry.mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const min = box.min.toArray(), max = box.max.toArray();
    let rr = 0;
    if (round) {
      const half = Math.min(...max.map((v, i) => (v - min[i]) * 0.5));
      rr = half * 0.9;
    }
    list.push({ name: entry.key, min, max, round: rr,
      inner: [min[0] + rr, min[1] + rr, min[2] + rr, max[0] - rr, max[1] - rr, max[2] - rr] });
  };
  for (const entry of entries) add(entry, false);
  for (const entry of soft) add(entry, true);
  const C = list.length;
  const inner = new Float64Array(C * 6), roundArr = new Float64Array(C), outer = new Float64Array(C * 6);
  list.forEach((c, i) => { inner.set(c.inner, i * 6); roundArr[i] = c.round; outer.set([...c.min, ...c.max], i * 6); });
  return { list, count: C, inner, round: roundArr, outer, floorY, grid: null };
}

function buildColliderGrid(colliders, room, pad) {
  const min = room.min, size = [room.max[0] - room.min[0], room.max[1] - room.min[1], room.max[2] - room.min[2]];
  const dims = size.map(s => Math.max(1, Math.ceil(s / STATIC_CELL)));
  const cells = dims[0] * dims[1] * dims[2];
  const counts = new Int32Array(cells + 1);
  const range = (c, axis) => {
    const lo = Math.floor((colliders.outer[c * 6 + axis] - pad - min[axis]) / STATIC_CELL), hi = Math.floor((colliders.outer[c * 6 + 3 + axis] + pad - min[axis]) / STATIC_CELL);
    return [clamp(lo, 0, dims[axis] - 1), clamp(hi, 0, dims[axis] - 1)];
  };
  const visit = fn => {
    for (let c = 0; c < colliders.count; c++) {
      const [x0, x1] = range(c, 0), [y0, y1] = range(c, 1), [z0, z1] = range(c, 2);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) fn((x * dims[1] + y) * dims[2] + z, c);
    }
  };
  visit(cell => { counts[cell + 1]++; });
  for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
  const items = new Int32Array(counts[cells]);
  const fill = counts.slice(0, cells);
  visit((cell, c) => { items[fill[cell]++] = c; });
  colliders.grid = { min, dims, start: counts, items };
}

// Signed distance to collider c (negative inside); normal in scratch[1..3].
function colliderDistance(colliders, c, px, py, pz) {
  const o = c * 6, inner = colliders.inner, rr = colliders.round[c];
  const qx = Math.min(Math.max(px, inner[o]), inner[o + 3]);
  const qy = Math.min(Math.max(py, inner[o + 1]), inner[o + 4]);
  const qz = Math.min(Math.max(pz, inner[o + 2]), inner[o + 5]);
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > 1e-18) {
    const d = Math.sqrt(d2);
    scratch[1] = dx / d; scratch[2] = dy / d; scratch[3] = dz / d;
    return d - rr;
  }
  // Inside the (shrunk) box: leave through the nearest face.
  let best = Infinity, axis = 0, sign = 1;
  const lx = px - inner[o], ly = py - inner[o + 1], lz = pz - inner[o + 2], hx = inner[o + 3] - px, hy = inner[o + 4] - py, hz = inner[o + 5] - pz;
  if (lx < best) { best = lx; axis = 0; sign = -1; }
  if (hx < best) { best = hx; axis = 0; sign = 1; }
  if (ly < best) { best = ly; axis = 1; sign = -1; }
  if (hy < best) { best = hy; axis = 1; sign = 1; }
  if (lz < best) { best = lz; axis = 2; sign = -1; }
  if (hz < best) { best = hz; axis = 2; sign = 1; }
  scratch[1] = scratch[2] = scratch[3] = 0;
  scratch[1 + axis] = sign;
  return -best - rr;
}

function rayBox(origin, dir, outer, c, pad) {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = origin[a], d = dir[a], lo = outer[c * 6 + a] - pad, hi = outer[c * 6 + 3 + a] + pad;
    if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) return Infinity; continue; }
    let ta = (lo - o) / d, tb = (hi - o) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

// Closest point on triangle (Ericson); writes x,y,z,u,v,w into `closest`.
function closestOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const out = closest;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; out[3] = 1; out[4] = 0; out[5] = 0; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; out[3] = 0; out[4] = 1; out[5] = 0; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; out[3] = 1 - v; out[4] = v; out[5] = 0; return;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; out[3] = 0; out[4] = 0; out[5] = 1; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; out[3] = 1 - w; out[4] = 0; out[5] = w; return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = bx + w * (cx - bx); out[1] = by + w * (cy - by); out[2] = bz + w * (cz - bz); out[3] = 0; out[4] = 1 - w; out[5] = w; return;
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
  out[3] = 1 - v - w; out[4] = v; out[5] = w;
}

// Hash of a grid cell. The three classic spatial-hash primes are mixed with integer multiplies and masked to the power-of-two table: this
// is bit for bit the same bucket as ((x * p1) ^ (y * p2) ^ (z * p3)) >>> 0) % table, without the double-precision products and the float
// modulo (which dominated the whole simulation step).
const HASH_P1 = 73856093, HASH_P2 = 19349663, HASH_P3 = 83492791;
function cellHash(x, y, z, mask) {
  return (Math.imul(x, HASH_P1) ^ Math.imul(y, HASH_P2) ^ Math.imul(z, HASH_P3)) & mask;
}

// Bins a cloth's triangles into a uniform grid. A fixed cloth uses a wider cell and a larger table:
// its authored surface has far more triangles than a simulated one, and the bucket size decides how
// many candidate triangles every contact query has to test. Triangles are binned in ascending index
// order, so every bucket lists them ascending; the table size must be a power of two.
function buildTriangleHash(cloth, positions, inflate, cellSize = CC_CELL, tableSize = TABLE) {
  const { tris, triCount, hash } = cloth;
  if (hash.start.length !== tableSize + 1) {
    hash.start = new Int32Array(tableSize + 1);
    hash.cursor = new Int32Array(tableSize);
  }
  if (!hash.box || hash.box.length < triCount * 6) hash.box = new Int32Array(triCount * 6);
  const start = hash.start, cursor = hash.cursor, box = hash.box, mask = tableSize - 1;
  const inv = 1 / cellSize;
  hash.inv = inv; hash.inflate = inflate; hash.cell = cellSize; hash.table = tableSize; hash.mask = mask;
  start.fill(0);
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ax = positions[a], bx = positions[b], cx = positions[c];
    const ay = positions[a + 1], by = positions[b + 1], cy = positions[c + 1];
    const az = positions[a + 2], bz = positions[b + 2], cz = positions[c + 2];
    const x0 = Math.floor((Math.min(ax, bx, cx) - inflate) * inv), x1 = Math.floor((Math.max(ax, bx, cx) + inflate) * inv);
    const y0 = Math.floor((Math.min(ay, by, cy) - inflate) * inv), y1 = Math.floor((Math.max(ay, by, cy) + inflate) * inv);
    const z0 = Math.floor((Math.min(az, bz, cz) - inflate) * inv), z1 = Math.floor((Math.max(az, bz, cz) + inflate) * inv);
    box[t * 6] = x0; box[t * 6 + 1] = x1; box[t * 6 + 2] = y0; box[t * 6 + 3] = y1; box[t * 6 + 4] = z0; box[t * 6 + 5] = z1;
    for (let x = x0; x <= x1; x++) {
      const hx = Math.imul(x, HASH_P1);
      for (let y = y0; y <= y1; y++) {
        const hxy = hx ^ Math.imul(y, HASH_P2);
        for (let z = z0; z <= z1; z++) start[((hxy ^ Math.imul(z, HASH_P3)) & mask) + 1]++;
      }
    }
  }
  for (let i = 0; i < tableSize; i++) start[i + 1] += start[i];
  if (start[tableSize] > hash.items.length) hash.items = new Int32Array(start[tableSize] * 2);
  for (let i = 0; i < tableSize; i++) cursor[i] = start[i];
  const items = hash.items;
  for (let t = 0; t < triCount; t++) {
    const x0 = box[t * 6], x1 = box[t * 6 + 1], y0 = box[t * 6 + 2], y1 = box[t * 6 + 3], z0 = box[t * 6 + 4], z1 = box[t * 6 + 5];
    for (let x = x0; x <= x1; x++) {
      const hx = Math.imul(x, HASH_P1);
      for (let y = y0; y <= y1; y++) {
        const hxy = hx ^ Math.imul(y, HASH_P2);
        for (let z = z0; z <= z1; z++) items[cursor[(hxy ^ Math.imul(z, HASH_P3)) & mask]++] = t;
      }
    }
  }
  hash.valid = true;
}

// ---------------------------------------------------------------------------
function computeNormals(cloth) {
  const { X, normals, pc, cx, cy } = cloth;
  for (let b = 0; b <= cy; b++) {
    const bd = Math.max(b - 1, 0), bu = Math.min(b + 1, cy);
    for (let a = 0; a <= cx; a++) {
      const al = Math.max(a - 1, 0), ar = Math.min(a + 1, cx);
      const l = (b * pc + al) * 3, r = (b * pc + ar) * 3, d = (bd * pc + a) * 3, u = (bu * pc + a) * 3, o = (b * pc + a) * 3;
      const ux = X[r] - X[l], uy = X[r + 1] - X[l + 1], uz = X[r + 2] - X[l + 2];
      const vx = X[u] - X[d], vy = X[u + 1] - X[d + 1], vz = X[u + 2] - X[d + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals[o] = nx / len; normals[o + 1] = ny / len; normals[o + 2] = nz / len;
    }
  }
}

// XPBD distance constraints. `at`/`ac` are the tension / compression compliances divided by h^2 (fabric stretches a little under load
// but buckles almost freely), `g` = damping time / h: a Rayleigh term on the relative velocity along the edge, so stretch waves die out
// instead of ringing like rubber. One Gauss-Seidel pass per substep; the sweep direction alternates.
function solveDistance(set, P, X, W, at, ac, g, reverse) {
  const n = set.n, ids = set.ids, len = set.len, lam = set.lam, g1 = 1 + g;
  for (let q = 0; q < n; q++) {
    const c = reverse ? n - 1 - q : q;
    const pa = ids[c * 2], pb = ids[c * 2 + 1], a = pa * 3, b = pb * 3;
    const pax = P[a], pay = P[a + 1], paz = P[a + 2], pbx = P[b], pby = P[b + 1], pbz = P[b + 2];
    const dx = pax - pbx, dy = pay - pby, dz = paz - pbz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1e-18) continue;
    const d = Math.sqrt(d2), wa = W[pa], wb = W[pb], inv = 1 / d;
    const C = d - len[c];
    const nx = dx * inv, ny = dy * inv, nz = dz * inv;
    const rel = nx * ((pax - X[a]) - (pbx - X[b])) + ny * ((pay - X[a + 1]) - (pby - X[b + 1])) + nz * ((paz - X[a + 2]) - (pbz - X[b + 2]));
    const alpha = C < 0 ? ac : at;
    const dl = -(C + alpha * lam[c] + g * rel) / (g1 * (wa + wb) + alpha);
    lam[c] += dl;
    const sa = wa * dl, sb = wb * dl;
    P[a] = pax + sa * nx; P[a + 1] = pay + sa * ny; P[a + 2] = paz + sa * nz;
    P[b] = pbx - sb * nx; P[b + 1] = pby - sb * ny; P[b + 2] = pbz - sb * nz;
  }
}

// Isometric-style bending of a limp sheet: for every three consecutive particles a-m-b along a grid line the constraint is the
// discrete curvature |a + b - 2m| (zero for a flat run, proportional to the fold angle), with a compliance derived from the
// bending rigidity (N m). It is linear in the fold angle, so soft folds stay soft and tight folds are resisted proportionally.
function solveBend(set, P, X, W, at, g, reverse) {
  const n = set.n, ids = set.ids, g1 = 1 + g;
  for (let q = 0; q < n; q++) {
    const c = reverse ? n - 1 - q : q;
    const pa = ids[c * 3], pm = ids[c * 3 + 1], pb = ids[c * 3 + 2], a = pa * 3, m = pm * 3, b = pb * 3;
    const pax = P[a], pay = P[a + 1], paz = P[a + 2], pmx = P[m], pmy = P[m + 1], pmz = P[m + 2], pbx = P[b], pby = P[b + 1], pbz = P[b + 2];
    const vx = pax + pbx - 2 * pmx, vy = pay + pby - 2 * pmy, vz = paz + pbz - 2 * pmz;
    const l2 = vx * vx + vy * vy + vz * vz;
    if (l2 < 1e-18) continue;
    const l = Math.sqrt(l2), inv = 1 / l, wa = W[pa], wm = W[pm], wb = W[pb];
    const nx = vx * inv, ny = vy * inv, nz = vz * inv;
    const rel = nx * ((pax - X[a]) + (pbx - X[b]) - 2 * (pmx - X[m])) + ny * ((pay - X[a + 1]) + (pby - X[b + 1]) - 2 * (pmy - X[m + 1])) + nz * ((paz - X[a + 2]) + (pbz - X[b + 2]) - 2 * (pmz - X[m + 2]));
    const dl = -(l + g * rel) / (g1 * (wa + wb + 4 * wm) + at);
    const sa = wa * dl, sm = 2 * wm * dl, sb = wb * dl;
    P[a] = pax + sa * nx; P[a + 1] = pay + sa * ny; P[a + 2] = paz + sa * nz;
    P[b] = pbx + sb * nx; P[b + 1] = pby + sb * ny; P[b + 2] = pbz + sb * nz;
    P[m] = pmx - sm * nx; P[m + 1] = pmy - sm * ny; P[m + 2] = pmz - sm * nz;
  }
}

export function createBedClothSystem({ root, config, roomBounds }) {
  validateRoomBounds(roomBounds);
  root.updateWorldMatrix(true, true);
  const identity = new THREE.Matrix4();
  const geometryUsers = new Map();
  const entries = [];
  root.traverse(node => {
    if (!node.isMesh) return;
    entries.push({ mesh: node, key: meshKey(node) });
    geometryUsers.set(node.geometry, (geometryUsers.get(node.geometry) ?? 0) + 1);
  });
  const assertStatic = (entry, deforming) => {
    if (!entry.mesh.matrixWorld.elements.every((value, i) => Math.abs(value - identity.elements[i]) < 1e-8)) {
      throw new Error(`Bed cloth mesh ${entry.key} has a non-identity world transform. Apply transforms in the authoring scene and re-export Y-up scene coordinates.`);
    }
    if (deforming && geometryUsers.get(entry.mesh.geometry) !== 1) throw new Error(`Bed cloth mesh ${entry.key} shares geometry with another mesh; make deforming geometry single-user before export.`);
  };
  const margin = 0.045;
  const room = { min: roomBounds.min, max: roomBounds.max };
  const gravity = config.gravity;
  const substeps = config.substeps ?? 8;
  const ccEvery = config.contactInterval ?? 2;
  const maxStep = config.maxStep ?? 0.012;
  const floorY = config.floorY;

  const cloths = [];
  const claimed = new Set();
  for (const spec of config.cloths) {
    const surfaces = resolveMeshes(entries, [spec.surfaceMesh], `${spec.id}.surfaceMesh`);
    if (surfaces.length !== 1) throw new Error(`Cloth ${spec.id}: surfaceMesh ${spec.surfaceMesh} must resolve to exactly one single-material mesh (found ${surfaces.length}).`);
    const followers = spec.followMeshes?.length ? resolveMeshes(entries, spec.followMeshes, `${spec.id}.followMeshes`) : [];
    for (const entry of [...surfaces, ...followers]) {
      if (claimed.has(entry.mesh)) throw new Error(`Mesh ${entry.key} is claimed by more than one bed cloth.`);
      claimed.add(entry.mesh);
      // A fixed cloth is never deformed, so its mesh may share geometry with another mesh.
      assertStatic(entry, !spec.fixed);
    }
    const cloth = spec.fixed ? buildFixedCloth(spec, surfaces[0]) : buildCloth(spec, surfaces[0], followers, config, room);
    cloth.index = cloths.length;
    cloths.push(cloth);
  }
  const colliderEntries = resolveMeshes(entries, config.colliderMeshes, 'colliderMeshes').filter(entry => !claimed.has(entry.mesh));
  const softEntries = resolveMeshes(entries, config.softColliderMeshes ?? [], 'softColliderMeshes').filter(entry => !claimed.has(entry.mesh));
  for (const entry of [...colliderEntries, ...softEntries]) assertStatic(entry, false);
  const colliders = buildColliders(colliderEntries, softEntries, floorY);
  const C = colliders.count;
  const maxRadius = Math.max(...cloths.map(c => c.thickness * 0.5 + SKIN)) + maxStep * 2;
  buildColliderGrid(colliders, room, maxRadius + 0.03);

  // Initial clearance: authored contacts are respected, never "fixed" by a pop.
  for (const cloth of cloths) {
    cloth.ign = new Uint8Array(cloth.N * C);
    cloth.cc = cloths.map(() => ({ ign: new Uint8Array(cloth.N), rad: new Float64Array(cloth.N), side: new Int8Array(cloth.N) }));
    cloth.baseRadius = cloth.thickness * 0.5 + SKIN;
    for (let p = 0; p < cloth.N; p++) {
      const o = p * 3, px = cloth.rest[o], py = cloth.rest[o + 1], pz = cloth.rest[o + 2];
      let r = cloth.baseRadius, dmin = Infinity;
      for (let c = 0; c < C; c++) {
        const d0 = colliderDistance(colliders, c, px, py, pz);
        if (d0 >= cloth.baseRadius) { if (d0 < dmin) dmin = d0; continue; }
        if (d0 <= 0.001) cloth.ign[p * C + c] = 1; else r = Math.min(r, Math.max(0.0005, d0 * 0.85));
      }
      const df = py - floorY;
      if (df < cloth.baseRadius) r = Math.min(r, Math.max(0.0005, df * 0.85)); else if (df < dmin) dmin = df;
      // Authored loft: a filled duvet rests thicker than its two-layer skin, so keep its authored standoff (up to spec.loft).
      if (cloth.spec.loft > 0 && r === cloth.baseRadius && dmin < Infinity) r = Math.max(r, Math.min(dmin * 0.97, cloth.spec.loft));
      cloth.radius[p] = r;
    }
  }
  // Contact radius between two cloths. A fixed cloth is a STATIC surface, so the other cloth's
  // particles are held at the design standoff above its mid-surface: the fixed cloth's half thickness
  // (its visible top) plus the other cloth's own thickness (its visible underside to its visible
  // top), plus a small margin for the skinning error of the visible mesh. The two fabrics therefore
  // touch instead of the lower one sinking into the upper one.
  for (const S of cloths) for (const T of cloths) {
    const pair = S.cc[T.index];
    if (S === T) { pair.rad.fill((S.thickness + T.thickness) * 0.5 + SKIN); if (!S.fixed) T.hashRad = Math.max(T.hashRad ?? 0, pair.rad[0]); continue; }
    const standOff = T.fixed
      ? S.thickness + T.thickness * 0.5 + FIXED_CONTACT_MARGIN
      : S.skinOffset + T.skinOffset + SKIN;
    pair.rad.fill(standOff);
    if (!S.fixed && !T.fixed) T.hashRad = Math.max(T.hashRad ?? 0, standOff);
    // A fixed cloth's broad-phase grid must be built with a margin that covers the widest contact
    // radius it is tested against (its surface never moves and particles are tested where they are).
    if (T.fixed) T.hashMargin = Math.max(T.hashMargin ?? 0, standOff + 0.004 + FIXED_REACH);
  }
  for (const T of cloths) buildTriangleHash(T, T.rest, T.fixed ? (T.hashMargin ?? 0.02) : 0.02, T.hashCell ?? CC_CELL, T.hashTable ?? TABLE);
  for (const S of cloths) for (const T of cloths) {
    // A fixed cloth is not simulated: it neither collides nor is collided against.
    if (S.fixed) continue;
    const pair = S.cc[T.index];
    contactPass(S, T, pair, null, 'init');
  }
  for (const cloth of cloths) { cloth.ign0 = cloth.ign.slice(); cloth.cc0 = cloth.cc.map(pair => ({ ign: pair.ign.slice(), rad: pair.rad.slice(), side: pair.side.slice() })); cloth.radius0 = cloth.radius.slice(); }

  let gripCloth = null;
  let reachExtra = 0;
  const stats = { frames: 0, repaired: 0 };

  function wake(cloth) {
    // A fixed cloth is a static surface: it is never woken.
    if (cloth.fixed) return;
    if (!cloth.awake) { cloth.awake = true; cloth.quiet = 0; cloth.free = 0; cloth.window = 0; cloth.movingFraction = 1; cloth.driftFraction = 1; cloth.snap.set(cloth.X); cloth.touch.fill(0); cloth.awakeFrames = 0; cloth.dirty = true; cloth.hash.valid = false; cloth.prevMax = 1; }
    cloth.quiet = 0;
  }

  function sleep(cloth) {
    cloth.awake = false;
    cloth.V.fill(0);
    cloth.P.set(cloth.X);
    cloth.maxSpeed = 0;
    cloth.hash.valid = false;
    cloth.dirty = true;
  }

  // One particle-vs-triangle contact pass. mode: 'init' records authored clearance,
  // measure object collects penetration only, otherwise it resolves.
  function contactPass(S, T, pair, measure, mode) {
    const SP = S.P, TP = T.P, SX = S.X, TX = T.X, SW = S.W, TW = T.W;
    const hash = T.hash, start = hash.start, items = hash.items, tris = T.tris, triCell = T.triCell;
    const self = S === T, inv = hash.inv, tAwake = T.awake && mode !== 'init';
    const mu = Math.min(S.params.friction, T.params.friction);
    // A fixed cloth is a static surface: its triangles never move, so it is never pushed and never pushed against.
    const tFixed = !!T.fixed, sFixed = !!S.fixed;
    let contacts = 0;
    // A fixed cloth's surface never moves and the particle is tested at its current position, so no extra reach is needed for it.
    const extra = mode === 'run' && !measure && !tFixed ? reachExtra : 0;
    const boundsCull = mode === 'run' && !measure && S !== T, blo = T.boundsMin, bhi = T.boundsMax, bm = 0.05 + 2 * extra;
    // Against a fixed surface a particle's candidate triangles are cached while it stays put (see below).
    let fc = null;
    if (tFixed && !self && mode === 'run' && !measure) {
      fc = (S.fixedCache ??= [])[T.index] ??= { items: new Int32Array(S.N * FC_SLOTS), count: new Int16Array(S.N).fill(FC_STALE), pos: new Float64Array(S.N * 3) };
    }
    for (let p = 0; p < S.N; p++) {
      const o = p * 3;
      if (mode !== 'init' && !measure && SW[p] === 0) continue;
      const px = mode === 'init' ? S.rest[o] : SP[o], py = mode === 'init' ? S.rest[o + 1] : SP[o + 1], pz = mode === 'init' ? S.rest[o + 2] : SP[o + 2];
      const rad = pair.rad[p];
      if (boundsCull && (px < blo[0] - bm || px > bhi[0] + bm || py < blo[1] - bm || py > bhi[1] + bm || pz < blo[2] - bm || pz > bhi[2] + bm)) continue;
      // (the hash is queried with the particle's own cell: the triangles were binned with the whole contact margin)
      const flagged = pair.ign[p] === 1;
      let near = false;
      let nearest = Infinity, nearSgn = 1;
      const pi = S.pi[p], pj = S.pj[p];
      {
      // Candidate triangles: the hash bucket of the particle's cell, or - against a fixed surface - a short list of the triangles that
      // were within reach when the particle last moved FC_PAD or more, which stays valid while it has not moved further than that.
      let src = items, k0 = 0, k1 = 0;
      if (fc) {
        const o3 = p * 3, ddx = px - fc.pos[o3], ddy = py - fc.pos[o3 + 1], ddz = pz - fc.pos[o3 + 2];
        if (fc.count[p] === FC_STALE || ddx * ddx + ddy * ddy + ddz * ddz > FC_DRIFT2) {
          const bucket = cellHash(Math.floor(px * inv), Math.floor(py * inv), Math.floor(pz * inv), hash.mask), limB = rad + 0.004 + FC_PAD, base = p * FC_SLOTS;
          let n = 0;
          for (let k = start[bucket], end = start[bucket + 1]; k < end; k++) {
            const t = items[k], ia = tris[t * 3] * 3, ib = tris[t * 3 + 1] * 3, ic = tris[t * 3 + 2] * 3;
            const ax = TP[ia], bx = TP[ib], cx = TP[ic];
            let lo = ax < bx ? ax : bx, hi = ax < bx ? bx : ax;
            if (cx < lo) lo = cx; else if (cx > hi) hi = cx;
            if (px < lo - limB || px > hi + limB) continue;
            const ay = TP[ia + 1], by = TP[ib + 1], cy = TP[ic + 1];
            lo = ay < by ? ay : by; hi = ay < by ? by : ay;
            if (cy < lo) lo = cy; else if (cy > hi) hi = cy;
            if (py < lo - limB || py > hi + limB) continue;
            const az = TP[ia + 2], bz = TP[ib + 2], cz = TP[ic + 2];
            lo = az < bz ? az : bz; hi = az < bz ? bz : az;
            if (cz < lo) lo = cz; else if (cz > hi) hi = cz;
            if (pz < lo - limB || pz > hi + limB) continue;
            closestOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
            const ex = px - closest[0], ey = py - closest[1], ez = pz - closest[2];
            if (ex * ex + ey * ey + ez * ez > limB * limB) continue;
            if (n < FC_SLOTS) fc.items[base + n] = t;
            n++;
          }
          fc.pos[o3] = px; fc.pos[o3 + 1] = py; fc.pos[o3 + 2] = pz;
          // More candidates than slots (a sharp crease): do not cache, scan the bucket this time and try again next pass.
          fc.count[p] = n > FC_SLOTS ? FC_STALE : n;
        }
        if (fc.count[p] >= 0) { src = fc.items; k0 = p * FC_SLOTS; k1 = k0 + fc.count[p]; }
        else { const bucket = cellHash(Math.floor(px * inv), Math.floor(py * inv), Math.floor(pz * inv), hash.mask); k0 = start[bucket]; k1 = start[bucket + 1]; }
      } else {
        const bucket = cellHash(Math.floor(px * inv), Math.floor(py * inv), Math.floor(pz * inv), hash.mask);
        k0 = start[bucket]; k1 = start[bucket + 1];
      }
      for (let k = k0; k < k1; k++) {
        const t = src[k];
        if (self && Math.abs(pi - triCell[t * 2]) <= 3 && Math.abs(pj - triCell[t * 2 + 1]) <= 3) continue;
        const ia = tris[t * 3] * 3, ib = tris[t * 3 + 1] * 3, ic = tris[t * 3 + 2] * 3;
        const tpos = mode === 'init' ? T.rest : TP;
        const lim = rad + 0.004 + extra;
        const ax = tpos[ia], bx = tpos[ib], cx = tpos[ic];
        let lo = ax < bx ? ax : bx, hi = ax < bx ? bx : ax;
        if (cx < lo) lo = cx; else if (cx > hi) hi = cx;
        if (px < lo - lim || px > hi + lim) continue;
        const ay = tpos[ia + 1], by = tpos[ib + 1], cy = tpos[ic + 1];
        lo = ay < by ? ay : by; hi = ay < by ? by : ay;
        if (cy < lo) lo = cy; else if (cy > hi) hi = cy;
        if (py < lo - lim || py > hi + lim) continue;
        const az = tpos[ia + 2], bz = tpos[ib + 2], cz = tpos[ic + 2];
        lo = az < bz ? az : bz; hi = az < bz ? bz : az;
        if (cz < lo) lo = cz; else if (cz > hi) hi = cz;
        if (pz < lo - lim || pz > hi + lim) continue;
        closestOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
        let dx = px - closest[0], dy = py - closest[1], dz = pz - closest[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (mode === 'init') {
          if (d2 < nearest) {
            nearest = d2;
            const abx = tpos[ib] - tpos[ia], aby = tpos[ib + 1] - tpos[ia + 1], abz = tpos[ib + 2] - tpos[ia + 2];
            const acx = tpos[ic] - tpos[ia], acy = tpos[ic + 1] - tpos[ia + 1], acz = tpos[ic + 2] - tpos[ia + 2];
            nearSgn = dx * (aby * acz - abz * acy) + dy * (abz * acx - abx * acz) + dz * (abx * acy - aby * acx) >= 0 ? 1 : -1;
          }
          continue;
        }
        if (d2 >= (rad + 0.004) * (rad + 0.004)) continue;
        near = true;
        let wrongSide = false, snx = 0, sny = 0, snz = 0;
        if (!self && !measure) {
          // Contact is one-sided: a particle remembers which face of the other cloth it came from and is
          // pushed back to it, so taut cloth over a tight edge cannot be driven through a thin layer.
          const abx = tpos[ib] - tpos[ia], aby = tpos[ib + 1] - tpos[ia + 1], abz = tpos[ib + 2] - tpos[ia + 2];
          const acx = tpos[ic] - tpos[ia], acy = tpos[ic + 1] - tpos[ia + 1], acz = tpos[ic + 2] - tpos[ia + 2];
          snx = aby * acz - abz * acy; sny = abz * acx - abx * acz; snz = abx * acy - aby * acx;
          const sl = Math.hypot(snx, sny, snz) || 1; snx /= sl; sny /= sl; snz /= sl;
          const sgn = dx * snx + dy * sny + dz * snz >= 0 ? 1 : -1;
          let side = pair.side[p];
          if (side === 0 || (side !== sgn && d2 > 4 * rad * rad)) { pair.side[p] = side = sgn; }
          wrongSide = side !== sgn;
          if (wrongSide) { snx *= side; sny *= side; snz *= side; }
        }
        if (flagged) continue;
        if (d2 >= rad * rad && !wrongSide) continue;
        const dist = Math.sqrt(d2);
        if (measure) { const pen = rad - dist; if (pen > measure.intrusion) measure.intrusion = pen; measure.contacts++; if (measure.list) measure.list.push(p, t); continue; }
        const u = closest[3], v = closest[4], w = closest[5];
        let nxv, nyv, nzv;
        if (wrongSide) { nxv = snx; nyv = sny; nzv = snz; }
        else if (dist > 1e-9) { nxv = dx / dist; nyv = dy / dist; nzv = dz / dist; }
        else {
          const abx = tpos[ib] - tpos[ia], aby = tpos[ib + 1] - tpos[ia + 1], abz = tpos[ib + 2] - tpos[ia + 2];
          const acx = tpos[ic] - tpos[ia], acy = tpos[ic + 1] - tpos[ia + 1], acz = tpos[ic + 2] - tpos[ia + 2];
          nxv = aby * acz - abz * acy; nyv = abz * acx - abx * acz; nzv = abx * acy - aby * acx;
          const l = Math.hypot(nxv, nyv, nzv) || 1; nxv /= l; nyv /= l; nzv /= l;
          if (nxv * (SX[o] - TX[ia]) + nyv * (SX[o + 1] - TX[ia + 1]) + nzv * (SX[o + 2] - TX[ia + 2]) < 0) { nxv = -nxv; nyv = -nyv; nzv = -nzv; }
        }
        // Cloth-on-cloth corrections are limited per pass: a particle found deep inside or behind another layer is eased out over a few
        // passes, not thrown out (near a convex edge two triangles can disagree about the right side, and unbounded pushes become a buzz).
        const pen = Math.min(CONTACT_PUSH, wrongSide ? rad - (dx * nxv + dy * nyv + dz * nzv) : rad - dist);
        // A particle (or triangle corner) that is pressed on the floor, a collider or the duvet this substep is heavy, so the contact
        // pushes the unsupported layer out. When both layers are supported (a heap flattened on the floor) the upper one is the mover.
        const TSC = T.SC, pSC = S.SC[p] === 1, tSC = !!TSC && (TSC[ia / 3] | TSC[ib / 3] | TSC[ic / 3]) === 1, pUp = nyv >= 0;
        const fp = pSC && !(tSC && pUp) ? SUPPORT_W : 1, ft = tSC && !(pSC && !pUp) ? SUPPORT_W : 1;
        const wp = SW[p] * fp;
        const wa = tAwake ? TW[ia / 3] * (TSC && TSC[ia / 3] ? ft : 1) : 0, wb = tAwake ? TW[ib / 3] * (TSC && TSC[ib / 3] ? ft : 1) : 0, wc = tAwake ? TW[ic / 3] * (TSC && TSC[ic / 3] ? ft : 1) : 0;
        const wsum = wp + u * u * wa + v * v * wb + w * w * wc;
        if (wsum === 0) continue;
        contacts++;
        const sp = pen * wp / wsum;
        SP[o] += nxv * sp; SP[o + 1] += nyv * sp; SP[o + 2] += nzv * sp;
        S.CF[p] = 1; S.CN[o] += nxv * sp; S.CN[o + 1] += nyv * sp; S.CN[o + 2] += nzv * sp;
        if (tFixed) S.SC[p] = 1;
        if (tAwake) {
          // The triangle's corners are pushed the other way. Like the particle's own push this is a position correction, not momentum:
          // it is recorded as a contact push too, so that finalize() strips it from the velocity (otherwise every cloth-cloth contact
          // pumps energy into the pile and it buzzes instead of coming to rest).
          const f = pen / wsum, fa = f * u * wa, fb = f * v * wb, fc = f * w * wc;
          const ja = ia, jb = ib, jc = ic;
          TP[ja] -= nxv * fa; TP[ja + 1] -= nyv * fa; TP[ja + 2] -= nzv * fa;
          TP[jb] -= nxv * fb; TP[jb + 1] -= nyv * fb; TP[jb + 2] -= nzv * fb;
          TP[jc] -= nxv * fc; TP[jc + 1] -= nyv * fc; TP[jc + 2] -= nzv * fc;
          const TF = T.CF, TN = T.CN;
          if (fa !== 0) { TF[ja / 3] = 1; TN[ja] -= nxv * fa; TN[ja + 1] -= nyv * fa; TN[ja + 2] -= nzv * fa; }
          if (fb !== 0) { TF[jb / 3] = 1; TN[jb] -= nxv * fb; TN[jb + 1] -= nyv * fb; TN[jb + 2] -= nzv * fb; }
          if (fc !== 0) { TF[jc / 3] = 1; TN[jc] -= nxv * fc; TN[jc + 1] -= nyv * fc; TN[jc + 2] -= nzv * fc; }
        }
        // Coulomb friction on the relative tangential displacement.
        let rx = SP[o] - SX[o], ry = SP[o + 1] - SX[o + 1], rz = SP[o + 2] - SX[o + 2];
        rx -= u * (TP[ia] - TX[ia]) + v * (TP[ib] - TX[ib]) + w * (TP[ic] - TX[ic]);
        ry -= u * (TP[ia + 1] - TX[ia + 1]) + v * (TP[ib + 1] - TX[ib + 1]) + w * (TP[ic + 1] - TX[ic + 1]);
        rz -= u * (TP[ia + 2] - TX[ia + 2]) + v * (TP[ib + 2] - TX[ib + 2]) + w * (TP[ic + 2] - TX[ic + 2]);
        const rn = rx * nxv + ry * nyv + rz * nzv;
        rx -= rn * nxv; ry -= rn * nyv; rz -= rn * nzv;
        const rl = Math.hypot(rx, ry, rz);
        if (rl > 1e-12) {
          // Static friction holds the contact while the relative slip this substep is within mu_s * (normal correction); once it
          // slips, the kinetic coefficient (a little lower) applies.
          const cap = mu * pen, fr = rl <= cap ? 1 : FRICTION_KINETIC * cap / rl;
          const sx = rx * fr, sy = ry * fr, sz = rz * fr, sf = wp / wsum;
          SP[o] -= sx * sf; SP[o + 1] -= sy * sf; SP[o + 2] -= sz * sf;
          if (tAwake) {
            const g = 1 / wsum;
            TP[ia] += sx * g * u * wa; TP[ia + 1] += sy * g * u * wa; TP[ia + 2] += sz * g * u * wa;
            TP[ib] += sx * g * v * wb; TP[ib + 1] += sy * g * v * wb; TP[ib + 2] += sz * g * v * wb;
            TP[ic] += sx * g * w * wc; TP[ic + 1] += sy * g * w * wc; TP[ic + 2] += sz * g * w * wc;
          }
        }
      }
      }
      if (mode === 'init') {
        const d0 = Math.sqrt(nearest);
        if (!self && d0 < 3 * rad) pair.side[p] = nearSgn;
        if (d0 < rad) { if (d0 <= 0.001) pair.ign[p] = 1; else pair.rad[p] = Math.max(0.0005, d0 * 0.85); }
      } else if (flagged && !near && !measure) pair.ign[p] = 0;
    }
    return contacts;
  }

  function collideStatic(cloth, measure) {
    const P = cloth.P, X = cloth.X, W = cloth.W, radius = cloth.radius, ign = cloth.ign;
    const grid = colliders.grid, start = grid.start, items = grid.items, dims = grid.dims, gmin = grid.min;
    const mu = cloth.params.friction;
    const minX = room.min[0] + margin, maxX = room.max[0] - margin, minY = Math.max(room.min[1], floorY), maxY = room.max[1] - margin, minZ = room.min[2] + margin, maxZ = room.max[2] - margin;
    for (let p = 0; p < cloth.N; p++) {
      if (W[p] === 0 && !measure) continue;
      const o = p * 3;
      let px = P[o], py = P[o + 1], pz = P[o + 2];
      const r = radius[p];
      // Floor.
      if (py < floorY + r) {
        const pen = floorY + r - py;
        if (measure) { if (floorY - py > measure.penetration) measure.penetration = floorY - py; if (pen > measure.intrusion) measure.intrusion = pen; measure.contacts++; }
        else {
          py = floorY + r;
          cloth.CF[p] = 1; cloth.SC[p] = 1; cloth.CN[o + 1] += pen;
          const dx = px - X[o], dz = pz - X[o + 2], tl = Math.hypot(dx, dz);
          if (tl > 1e-12) { const f = Math.min(1, mu * pen / tl); px -= dx * f; pz -= dz * f; }
        }
      }
      if (!measure) {
        const gx = clamp(Math.floor((px - gmin[0]) / STATIC_CELL), 0, dims[0] - 1);
        const gy = clamp(Math.floor((py - gmin[1]) / STATIC_CELL), 0, dims[1] - 1);
        const gz = clamp(Math.floor((pz - gmin[2]) / STATIC_CELL), 0, dims[2] - 1);
        const cell = (gx * dims[1] + gy) * dims[2] + gz;
        for (let k = start[cell], end = start[cell + 1]; k < end; k++) {
          const c = items[k];
          const d = colliderDistance(colliders, c, px, py, pz);
          const slot = p * C + c;
          if (ign[slot] === 1) { if (d > r + 0.004) ign[slot] = 0; continue; }
          if (d >= r) continue;
          const pen = r - d, nxv = scratch[1], nyv = scratch[2], nzv = scratch[3];
          px += nxv * pen; py += nyv * pen; pz += nzv * pen;
          cloth.CF[p] = 1; cloth.SC[p] = 1; cloth.CN[o] += nxv * pen; cloth.CN[o + 1] += nyv * pen; cloth.CN[o + 2] += nzv * pen;
          const dx = px - X[o], dy = py - X[o + 1], dz = pz - X[o + 2];
          const dn = dx * nxv + dy * nyv + dz * nzv;
          const tx = dx - dn * nxv, ty = dy - dn * nyv, tz = dz - dn * nzv, tl = Math.hypot(tx, ty, tz);
          if (tl > 1e-12) { const f = Math.min(1, mu * pen / tl); px -= tx * f; py -= ty * f; pz -= tz * f; }
        }
        if (px < minX) px = minX; else if (px > maxX) px = maxX;
        if (py > maxY) py = maxY; else if (py < minY) py = minY;
        if (pz < minZ) pz = minZ; else if (pz > maxZ) pz = maxZ;
        P[o] = px; P[o + 1] = py; P[o + 2] = pz;
      } else {
        for (let c = 0; c < C; c++) {
          if (ign[p * C + c] === 1) continue;
          const d = colliderDistance(colliders, c, px, py, pz);
          if (d >= r) continue;
          if (-d > measure.penetration) measure.penetration = -d;
          if (r - d > measure.intrusion) measure.intrusion = r - d;
          measure.contacts++;
        }
      }
    }
  }

  // Semi-implicit Euler on velocities. Damping is exponential in time (frame-rate independent). Air resistance acts on the velocity
  // relative to still air: quadratic across the sheet (a flat sheet reaches a terminal speed of sqrt(g / airDrag)), light along it.
  function integrate(cloth, h) {
    const { X, P, V, W, normals, params } = cloth;
    const hard = cloth.free > SETTLE_HARD;
    const damp = Math.exp(-(params.damping + Math.min(SETTLE_MAX, SETTLE_RAMP * Math.max(0, cloth.free - SETTLE_DELAY)) + (hard ? SETTLE_HARD_DAMP : 0)) * h), dragN = params.airDrag * h, dragT = 1 / (1 + AIR_TANGENT * h), g = gravity * h, limit = maxStep * maxStep;
    const stick = cloth.free > STICK_AFTER, stickSpeed2 = hard ? STICK_HARD_SPEED2 : STICK_SPEED2;
    for (let p = 0, n = cloth.N; p < n; p++) {
      const o = p * 3;
      if (W[p] === 0) { P[o] = X[o]; P[o + 1] = X[o + 1]; P[o + 2] = X[o + 2]; continue; }
      let vx = V[o] * damp, vy = V[o + 1] * damp, vz = V[o + 2] * damp;
      // Stiction: a released cloth that is down to a crawl stops there (fibre friction), instead of creeping for seconds.
      if (stick && cloth.touch[p] > 0 && vx * vx + vy * vy + vz * vz < stickSpeed2) { vx = vy = vz = 0; }
      vy -= g;
      const nxv = normals[o], nyv = normals[o + 1], nzv = normals[o + 2];
      const vn = vx * nxv + vy * nyv + vz * nzv;
      const kn = 1 / (1 + dragN * Math.abs(vn));
      const vnNew = vn * kn, tx = vx - nxv * vn, ty = vy - nyv * vn, tz = vz - nzv * vn;
      vx = tx * dragT + nxv * vnNew; vy = ty * dragT + nyv * vnNew; vz = tz * dragT + nzv * vnNew;
      V[o] = vx; V[o + 1] = vy; V[o + 2] = vz;
      let dx = vx * h, dy = vy * h, dz = vz * h;
      const l2 = dx * dx + dy * dy + dz * dz;
      if (l2 > limit) { const s = maxStep / Math.sqrt(l2); dx *= s; dy *= s; dz *= s; }
      P[o] = X[o] + dx; P[o + 1] = X[o + 1] + dy; P[o + 2] = X[o + 2] + dz;
    }
  }

  // XPBD substep (compliances are physical, m/N for edges, so the result does not depend on the substep count).
  function constrain(cloth, substep, h) {
    const { X, P, Wc, params, stretch, shear, bend } = cloth;
    const h2 = h * h, g = params.stretchDamping / h;
    stretch.lam.fill(0); shear.lam.fill(0);
    solveBend(bend, P, X, Wc, cloth.alphaBend / h2, params.bendDamping / h, (substep & 1) === 1);
    solveDistance(shear, P, X, Wc, cloth.alphaShear / h2, cloth.alphaShearCompress / h2, g, (substep & 1) === 1);
    // Edges are what a hanging cloth leans on, and a chain of many light particles needs several sweeps before a pull at one end reaches
    // the other: the stretch sweeps go last, alternating direction, and accumulate the multiplier so that the compliance stays physical.
    for (let it = 0; it < params.stretchIterations; it++) solveDistance(stretch, P, X, Wc, cloth.alphaStretch / h2, cloth.alphaStretchCompress / h2, g, ((substep + it) & 1) === 1);
  }

  // The pinched particles are pulled onto the pointer target, but only as hard as a hand could: the position correction is capped by
  // the force it implies (m * dx / h^2 <= gripForce / count), so a pinch stuck behind a collider drags rather than teleports.
  // Pointer events arrive at the display rate, so the target covers each jump in equal strides over the frame's remaining substeps
  // (it has caught up when the frame ends, and the pinch moves at an even speed instead of a burst), capped by the hand speed.
  function applyGrip(cloth, h, left) {
    const grip = cloth.grip;
    if (!grip) return;
    const target = grip.target, desired = grip.desired;
    let dx = (desired[0] - target[0]) / left, dy = (desired[1] - target[1]) / left, dz = (desired[2] - target[2]) / left;
    const dl = Math.hypot(dx, dy, dz), move = cloth.params.gripSpeed * h;
    if (dl > move) { const s = move / dl; dx *= s; dy *= s; dz *= s; }
    target[0] += dx; target[1] += dy; target[2] += dz;
    const P = cloth.P, W = cloth.W, reach = cloth.params.gripForce / grip.count * h * h;
    for (let k = 0; k < grip.count; k++) {
      const id = grip.ids[k], p = id * 3;
      let cx = target[0] + grip.offsets[k * 3] - P[p], cy = target[1] + grip.offsets[k * 3 + 1] - P[p + 1], cz = target[2] + grip.offsets[k * 3 + 2] - P[p + 2];
      const cap = reach * W[id], l2 = cx * cx + cy * cy + cz * cz;
      if (l2 > cap * cap) { const s = cap / Math.sqrt(l2); cx *= s; cy *= s; cz *= s; }
      P[p] += cx; P[p + 1] += cy; P[p + 2] += cz;
    }
  }

  function finalize(cloth, h) {
    const { X, P, V, CN, CF } = cloth;
    const inv = 1 / h;
    let topDisp = 0, topSpeed = 0, sum = 0, moving = 0;
    const dispCap2 = 4 * maxStep * maxStep, speedCap2 = SPEED_CAP * SPEED_CAP;
    for (let i = 0, n = cloth.N * 3; i < n; i += 3) {
      let dx = P[i] - X[i], dy = P[i + 1] - X[i + 1], dz = P[i + 2] - X[i + 2];
      if (!(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz))) { P[i] = X[i]; P[i + 1] = X[i + 1]; P[i + 2] = X[i + 2]; dx = dy = dz = 0; stats.repaired++; }
      const dl2 = dx * dx + dy * dy + dz * dz;
      if (dl2 > dispCap2) { const s = Math.sqrt(dispCap2 / dl2); dx *= s; dy *= s; dz *= s; P[i] = X[i] + dx; P[i + 1] = X[i + 1] + dy; P[i + 2] = X[i + 2] + dz; }
      let vx = dx * inv, vy = dy * inv, vz = dz * inv;
      const flag = i / 3;
      if (CF[flag] === 1) {
        // Contact pushes are position corrections, not momentum: strip them from the velocity,
        // then remove any remaining motion into the contact (inelastic, no bounce).
        const ox = CN[i], oy = CN[i + 1], oz = CN[i + 2];
        vx -= ox * inv; vy -= oy * inv; vz -= oz * inv;
        const dl = Math.hypot(ox, oy, oz);
        if (dl > 1e-12) {
          const nx = ox / dl, ny = oy / dl, nz = oz / dl, vn = vx * nx + vy * ny + vz * nz;
          if (vn < 0) { vx -= nx * vn; vy -= ny * vn; vz -= nz * vn; }
        }
        vx *= CONTACT_DAMP; vy *= CONTACT_DAMP; vz *= CONTACT_DAMP;
        CF[flag] = 0; CN[i] = CN[i + 1] = CN[i + 2] = 0;
        cloth.touch[flag] = TOUCH_MEMORY;
      } else if (cloth.touch[flag] > 0) cloth.touch[flag]--;
      const vs2 = vx * vx + vy * vy + vz * vz;
      if (vs2 > speedCap2) { const s = SPEED_CAP / Math.sqrt(vs2); vx *= s; vy *= s; vz *= s; }
      V[i] = vx; V[i + 1] = vy; V[i + 2] = vz;
      X[i] = P[i]; X[i + 1] = P[i + 1]; X[i + 2] = P[i + 2];
      const d2 = dx * dx + dy * dy + dz * dz, s2 = vx * vx + vy * vy + vz * vz;
      sum += Math.sqrt(s2);
      if (s2 > MOVING_SPEED2) moving++;
      if (d2 > topDisp) topDisp = d2;
      if (s2 > topSpeed) topSpeed = s2;
    }
    topSpeed = Math.sqrt(topSpeed);
    cloth.meanSpeed = Math.max(cloth.meanSpeed, sum / cloth.N);
    cloth.movingFraction = Math.max(cloth.movingFraction, moving / cloth.N);
    if (topSpeed > cloth.maxSpeed) cloth.maxSpeed = topSpeed;
    cloth.lastDisp = Math.sqrt(topDisp);
  }

  function prepareHashes() {
    let radius = 0;
    for (const cloth of cloths) if (cloth.baseRadius > radius) radius = cloth.baseRadius;
    // A fixed cloth's surface never moves, so its hash is built once and stays valid. Its margin only has to cover the contact radius
    // plus the distance a particle travels in one substep. A sleeping cloth's hash is built once as well (when it is asleep it is only
    // read by a moving cloth resting on it). The hashes of moving cloths are built right before each contact pass (buildLiveHashes).
    for (const T of cloths) {
      const pad = T.hashMargin ?? (radius + 0.004 + REACH_MAX);
      if (T.fixed) { if (!T.hash.valid) buildTriangleHash(T, T.X, pad, T.hashCell, T.hashTable); continue; }
      if (!T.awake) { if (!T.hash.valid) buildTriangleHash(T, T.X, pad, T.hashCell ?? CC_CELL, T.hashTable ?? TABLE); continue; }
      T.hash.valid = false;
    }
  }

  // The grid of a moving cloth is binned from the positions the contact pass is about to read (P), with a margin that only has to cover
  // the corrections of the pass itself. A wide margin (the old once-per-frame grid had to cover a frame of motion) made every bucket
  // hold hundreds of triangles in a crumpled pile; rebuilding is far cheaper than testing those. A grid is only built when some contact
  // pass reads it (its own self-contact, or another moving cloth resting on it).
  function buildLiveHashes() {
    for (const T of cloths) {
      if (T.fixed || !T.awake) continue;
      let needed = T.params.selfCollision && (!!T.grip || !(T.prevMax < 0.3 || (T.free > SELF_QUIET_AFTER && T.driftFraction < SELF_QUIET_FRACTION)));
      if (!needed) for (const S of cloths) if (S !== T && S.awake && !S.fixed) { needed = true; break; }
      if (needed) buildTriangleHash(T, T.P, T.hashRad + 0.004 + LIVE_HASH_MARGIN, T.hashCell ?? CC_CELL, T.hashTable ?? TABLE);
      else T.hash.valid = false;
    }
  }

  // `only`: 0 = every pair, 1 = only against fixed (static) cloths, 2 = only against simulated cloths (and itself).
  function collideCloths(doSelf, only = 0) {
    for (const S of cloths) {
      // A fixed cloth is not simulated: it never collides and is never pushed.
      if (!S.awake || S.fixed) continue;
      for (const T of cloths) {
        if (only === 1 ? !T.fixed : only === 2 && T.fixed) continue;
        if (T === S && (!doSelf || !S.params.selfCollision || (!S.grip && (S.prevMax < 0.3 || (S.free > SELF_QUIET_AFTER && S.driftFraction < SELF_QUIET_FRACTION))))) continue;
        if (T !== S) {
          // The lighter cloth's particles collide against the heavier cloth's triangles; the heavier cloth
          // only tests against a lighter one that is asleep (to wake it).
          if (S.mass > T.mass && T.awake) continue;
          // Broad phase on world bounds from the frame start.
          let apart = false;
          for (let d = 0; d < 3; d++) if (S.boundsMin[d] - 0.15 > T.boundsMax[d] || T.boundsMin[d] - 0.15 > S.boundsMax[d]) apart = true;
          if (apart) continue;
        }
        const touched = contactPass(S, T, S.cc[T.index], null, 'run');
        // A fixed cloth is never woken: it is a static surface.
        if (!T.fixed && !T.awake && touched > 0 && S.mass > T.mass && S.maxSpeed > 0.05) wake(T);
      }
    }
  }

  function updateBounds(cloth) {
    const X = cloth.X, lo = cloth.boundsMin, hi = cloth.boundsMax;
    lo[0] = lo[1] = lo[2] = Infinity; hi[0] = hi[1] = hi[2] = -Infinity;
    for (let i = 0, n = cloth.N * 3; i < n; i += 3) {
      for (let d = 0; d < 3; d++) { const v = X[i + d]; if (v < lo[d]) lo[d] = v; if (v > hi[d]) hi[d] = v; }
    }
  }
  for (const cloth of cloths) updateBounds(cloth);

  const live = [];
  function stepFrame() {
    stats.frames++;
    const h = STEP / substeps;
    live.length = 0;
    for (const cloth of cloths) if (cloth.awake) live.push(cloth);
    if (!live.length) return;
    for (const cloth of live) { computeNormals(cloth); updateBounds(cloth); cloth.maxSpeed = 0; cloth.meanSpeed = 0; }
    prepareHashes(h);
    for (let s = 0; s < substeps; s++) {
      for (const cloth of live) { integrate(cloth, h); applyGrip(cloth, h, substeps - s); constrain(cloth, s, h); }
      for (const cloth of live) { cloth.SC.fill(0); collideStatic(cloth, null); }
      // A fixed fabric (the duvet) is solved every substep: a falling cloth moves millimetres per substep and would otherwise sink deep
      // into it between passes. Cloth-on-cloth contacts (and self-contact) are the expensive ones and run every `ccEvery` substeps.
      collideCloths(false, 1);
      if (s % ccEvery === 0) {
        // Self-contact runs every other cloth-contact pass; cross-contacts between moving cloths (none in the shipped scene) every pass.
        const doSelf = s % (ccEvery * 2) === 0;
        if (doSelf || live.length > 1) {
          buildLiveHashes();
          reachExtra = LIVE_HASH_MARGIN * 0.5;
          collideCloths(doSelf, 2);
        }
      }
      for (const cloth of live) finalize(cloth, h);
    }
    for (const cloth of cloths) {
      if (!cloth.awake) continue;
      cloth.dirty = true;
      cloth.awakeFrames++;
      cloth.free = cloth.grip ? 0 : cloth.free + STEP;
      cloth.prevMax = cloth.maxSpeed;
      // Rest is judged on net displacement over a window, not instantaneous speed: contact/constraint
      // chatter that cancels out inside a substep is invisible and must not keep the solver awake.
      cloth.window += STEP;
      if (cloth.grip) { cloth.quiet = 0; cloth.window = 0; cloth.snap.set(cloth.X); }
      else if (cloth.free > SETTLE_FREEZE) { updateBounds(cloth); sleep(cloth); }
      else if (cloth.window >= REST_WINDOW) {
        let far = 0;
        const X = cloth.X, snap = cloth.snap;
        for (let i = 0, n = cloth.N * 3; i < n; i += 3) {
          const dx = X[i] - snap[i], dy = X[i + 1] - snap[i + 1], dz = X[i + 2] - snap[i + 2];
          if (dx * dx + dy * dy + dz * dz > REST_MOVE2) far++;
        }
        cloth.movingFraction = far / cloth.N;
        cloth.driftFraction = cloth.movingFraction;
        cloth.quiet = cloth.movingFraction < cloth.params.sleepFraction ? cloth.quiet + cloth.window : 0;
        cloth.window = 0; snap.set(X);
        if (cloth.quiet >= SLEEP_DELAY) { updateBounds(cloth); sleep(cloth); }
      }
    }
  }

  // Low static props (rug) lift the ground that free fringe has to clear.
  const lowProps = colliders.list.filter(c => c.max[1] < 0.08);
  const RIGID_CLEARANCE = 0.002, GROUND_BAND = 0.1, GROUND_EPS = 0.0008;
  const lowCount = lowProps.length, lowBox = new Float64Array(lowCount * 5);
  lowProps.forEach((c, i) => { lowBox[i * 5] = c.min[0]; lowBox[i * 5 + 1] = c.max[0]; lowBox[i * 5 + 2] = c.min[2]; lowBox[i * 5 + 3] = c.max[2]; lowBox[i * 5 + 4] = c.max[1]; });
  function groundAt(x, z) {
    let ground = floorY;
    for (let i = 0, o = 0; i < lowCount; i++, o += 5) if (x >= lowBox[o] && x <= lowBox[o + 1] && z >= lowBox[o + 2] && z <= lowBox[o + 3] && lowBox[o + 4] > ground) ground = lowBox[o + 4];
    return ground;
  }

  // Rotates a rigid piece about the horizontal axis k=(kx,0,kz) through its root.
  function rotatePiece(binding, piece, rx, ry, rz, kx, kz, angle) {
    const pos = binding.posArray, nrm = binding.normal?.array, tan = binding.tangent?.array;
    const c = Math.cos(angle), sn = Math.sin(angle);
    for (const v of piece.vertices) {
      const o = v * 3;
      const lx = pos[o] - rx, ly = pos[o + 1] - ry, lz = pos[o + 2] - rz, kd = (kx * lx + kz * lz) * (1 - c);
      pos[o] = rx + lx * c - kz * ly * sn + kx * kd;
      pos[o + 1] = ry + ly * c + (kz * lx - kx * lz) * sn;
      pos[o + 2] = rz + lz * c + kx * ly * sn + kz * kd;
      if (nrm) {
        const nx = nrm[o], ny = nrm[o + 1], nz = nrm[o + 2], nd = (kx * nx + kz * nz) * (1 - c);
        nrm[o] = nx * c - kz * ny * sn + kx * nd; nrm[o + 1] = ny * c + (kz * nx - kx * nz) * sn; nrm[o + 2] = nz * c + kx * ny * sn + kz * nd;
      }
      if (tan) {
        const w = v * 4, tx = tan[w], ty = tan[w + 1], tz = tan[w + 2], td = (kx * tx + kz * tz) * (1 - c);
        tan[w] = tx * c - kz * ty * sn + kx * td; tan[w + 1] = ty * c + (kz * tx - kx * tz) * sn; tan[w + 2] = tz * c + kx * ty * sn + kz * td;
      }
    }
  }

  // Rigid pieces (fringe strands) hang from their root like pendulums.
  //
  // A pendulum swings in a vertical plane: its bearing (the horizontal direction it points) is fixed, and only its elevation
  // changes. The swing plane is therefore spanned by the strand's CURRENT bearing and the world up axis, and the rotation axis is
  // the normal of that plane. Rotating about that axis lowers the strand without ever turning it sideways, so a strand can no
  // longer walk around the hem as it settles - which is what turned the fringe into splayed spikes.
  //
  // The elevation is set by two rules, both evaluated against the strand's CURRENT geometry, never against a remembered
  // orientation (that ratchet is what let a clump climb into a spike over successive frames):
  //   - gravity pulls the strand down: hanging in the air, it points straight down,
  //   - the ground limits how steep it may hang: with its root h above the ground and the strand L long, the tip reaches the floor
  //     at asin(h / L) - the "ladder" angle. A strand whose root lies on the floor therefore rests ON it, and one whose root is a
  //     few centimetres up lies almost flat. A strand can never be left sticking out sideways.
  function settleRigid(binding, frames) {
    const pos = binding.posArray;
    for (const piece of binding.rigid) {
      const ro = piece.anchor * 12, rx = frames[ro], ry = frames[ro + 1], rz = frames[ro + 2];
      const tip = piece.tip * 3;
      const dx = pos[tip] - rx, dy = pos[tip + 1] - ry, dz = pos[tip + 2] - rz;
      const reach = Math.hypot(dx, dy, dz);
      if (reach <= 1e-4) continue;
      const elevation = Math.asin(clamp(dy / reach, -1, 1));
      // The strand's bearing, and the normal of its swing plane. A pendulum swings in the vertical plane spanned by its bearing
      // and the world up axis, so the rotation axis is that plane's normal: (bearing x up) = (-bz, 0, bx). Rotating about it changes
      // the elevation only, and the bearing is preserved exactly, so the strand keeps pointing where the hem points.
      const hl = Math.hypot(dx, dz);
      let bx, bz;
      if (hl > 1e-3) { bx = dx / hl; bz = dz / hl; }
      else {
        // The strand stands exactly vertical, so it has no bearing of its own yet. It falls over along the hem: the direction it was
        // authored with, carried into the root's current frame, is the direction it keeps.
        const o = piece.anchor * 12;
        const fx = piece.azimX * frames[o + 3] + piece.azimY * frames[o + 6];
        const fz = piece.azimX * frames[o + 5] + piece.azimY * frames[o + 8];
        const fl2 = Math.hypot(fx, fz);
        if (fl2 > 1e-3) { bx = fx / fl2; bz = fz / fl2; } else { bx = 1; bz = 0; }
      }
      let kx = -bz, kz = bx;
      // The steepest angle at which the strand still clears the ground: the tip reaches the floor at asin(h / L). The strand's own
      // sag is added to L, because a drooping strand dips below the straight line between its root and its tip.
      const ground = groundAt(rx, rz);
      const h = ry - ground - RIGID_CLEARANCE;
      const ladder = -Math.asin(clamp(h / (reach + piece.sag), 0, 1));
      // The strand takes the steepest downward orientation that still clears the ground: hanging in the air it points straight down,
      // and with its root near the floor it lies flat on it. The correction is applied in both directions, so a strand can neither
      // sink into the floor nor be left standing on end.
      if (Math.abs(ladder - elevation) > 1e-4) rotatePiece(binding, piece, rx, ry, rz, kx, kz, ladder - elevation);
      // The strand's own sag can still dip under the ground: lift the whole piece (not single vertices, which would squash it).
      let worst = 0;
      for (const v of piece.samples) {
        const clearance = pos[v * 3 + 1] - groundAt(pos[v * 3], pos[v * 3 + 2]) - RIGID_CLEARANCE;
        if (clearance < worst) worst = clearance;
      }
      if (worst < 0) for (const v of piece.vertices) pos[v * 3 + 1] -= worst;
    }
  }

  // Authored offsets from the smooth surface (wrinkle relief, thickness) turn inside out where the cloth bends more sharply than the
  // offset is long (offset x curvature > 1). Offsets are scaled down just enough to stay valid; the authored pose is exempt.
  function updateShrink(cloth) {
    const { kFine, kappaRest, offMax, shrink } = cloth;
    for (let g = 0, n = shrink.length; g < n; g++) {
      const off = offMax[g], k = kFine[g];
      if (off <= 0 || k < 1e-6) { shrink[g] = 1; continue; }
      const allowed = Math.max(SHRINK_BUDGET / off, kappaRest[g]) / k;
      shrink[g] = allowed >= 1 ? 1 : allowed < SHRINK_MIN ? SHRINK_MIN : allowed;
    }
  }

  function skinCloth(cloth) {
    evaluateSurface(cloth, cloth.X, cloth.frames);
    updateShrink(cloth);
    const shrink = cloth.shrink;
    updateBounds(cloth);
    const frames = cloth.frames, lo = cloth.boundsMin, hi = cloth.boundsMax;
    for (const binding of cloth.bindings) {
      const { count, gridIndex, local, localNormal, localTangent, posArray } = binding;
      const relax = !binding.rigid;
      const normalOut = localNormal ? binding.normal.array : null, tangentOut = localTangent ? binding.tangent.array : null;
      if (relax) {
        for (let v = 0; v < count; v++) {
          const gi = gridIndex[v], o = gi * 12, l = v * 3, sg = shrink[gi];
          const fx = frames[o], fy = frames[o + 1], fz = frames[o + 2];
          const e1x = frames[o + 3], e1y = frames[o + 4], e1z = frames[o + 5], e2x = frames[o + 6], e2y = frames[o + 7], e2z = frames[o + 8], nx = frames[o + 9], ny = frames[o + 10], nz = frames[o + 11];
          const a = local[l] * sg, b = local[l + 1] * sg, c = local[l + 2] * sg;
          const px = fx + a * e1x + b * e2x + c * nx;
          let y = fy + a * e1y + b * e2y + c * ny;
          const pz = fz + a * e1z + b * e2z + c * nz;
          // Authored relief never pokes through the floor or the rug: vertices are lifted onto the ground.
          if (y < GROUND_BAND) { const ground = groundAt(Math.fround(px), Math.fround(pz)) + GROUND_EPS; if (y < ground) y = ground; }
          posArray[l] = px; posArray[l + 1] = y; posArray[l + 2] = pz;
          if (normalOut) {
            const u = localNormal[l], w = localNormal[l + 1], t = localNormal[l + 2];
            normalOut[l] = u * e1x + w * e2x + t * nx; normalOut[l + 1] = u * e1y + w * e2y + t * ny; normalOut[l + 2] = u * e1z + w * e2z + t * nz;
          }
          if (tangentOut) {
            const u = localTangent[l], w = localTangent[l + 1], t = localTangent[l + 2], k = v * 4;
            tangentOut[k] = u * e1x + w * e2x + t * nx; tangentOut[k + 1] = u * e1y + w * e2y + t * ny; tangentOut[k + 2] = u * e1z + w * e2z + t * nz;
          }
        }
      } else {
        for (let v = 0; v < count; v++) {
          const gi = gridIndex[v], o = gi * 12, l = v * 3;
          const fx = frames[o], fy = frames[o + 1], fz = frames[o + 2];
          const e1x = frames[o + 3], e1y = frames[o + 4], e1z = frames[o + 5], e2x = frames[o + 6], e2y = frames[o + 7], e2z = frames[o + 8], nx = frames[o + 9], ny = frames[o + 10], nz = frames[o + 11];
          const a = local[l], b = local[l + 1], c = local[l + 2];
          posArray[l] = fx + a * e1x + b * e2x + c * nx;
          posArray[l + 1] = fy + a * e1y + b * e2y + c * ny;
          posArray[l + 2] = fz + a * e1z + b * e2z + c * nz;
          if (normalOut) {
            const u = localNormal[l], w = localNormal[l + 1], t = localNormal[l + 2];
            normalOut[l] = u * e1x + w * e2x + t * nx; normalOut[l + 1] = u * e1y + w * e2y + t * ny; normalOut[l + 2] = u * e1z + w * e2z + t * nz;
          }
          if (tangentOut) {
            const u = localTangent[l], w = localTangent[l + 1], t = localTangent[l + 2], k = v * 4;
            tangentOut[k] = u * e1x + w * e2x + t * nx; tangentOut[k + 1] = u * e1y + w * e2y + t * ny; tangentOut[k + 2] = u * e1z + w * e2z + t * nz;
          }
        }
      }
      binding.position.needsUpdate = true;
      if (normalOut) binding.normal.needsUpdate = true;
      if (tangentOut) binding.tangent.needsUpdate = true;
      if (binding.rigid) {
        settleRigid(binding, frames);
        for (let v = 0; v < count; v++) {
          const o = v * 3 + 1;
          if (posArray[o] >= GROUND_BAND) continue;
          const ground = groundAt(posArray[o - 1], posArray[o + 1]) + GROUND_EPS;
          if (posArray[o] < ground) posArray[o] = ground;
        }
      }
      const geometry = binding.mesh.geometry;
      const pad = FOLLOW_BOUNDS_MARGIN;
      if (!geometry.boundingBox) geometry.boundingBox = new THREE.Box3();
      geometry.boundingBox.min.set(lo[0] - pad, lo[1] - pad, lo[2] - pad);
      geometry.boundingBox.max.set(hi[0] + pad, hi[1] + pad, hi[2] + pad);
      if (!geometry.boundingSphere) geometry.boundingSphere = new THREE.Sphere();
      geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
    }
    cloth.dirty = false;
  }

  function skinAwake() {
    // A fixed cloth is never skinned: its mesh stays exactly as authored.
    for (const cloth of cloths) if (cloth.dirty && !cloth.fixed) skinCloth(cloth);
  }

  // Ray picking on the solver surface (double-sided), occluded by static colliders.
  const tmpOrigin = [0, 0, 0], tmpDir = [0, 0, 0];
  function pick(ray) {
    tmpOrigin[0] = ray.origin.x; tmpOrigin[1] = ray.origin.y; tmpOrigin[2] = ray.origin.z;
    tmpDir[0] = ray.direction.x; tmpDir[1] = ray.direction.y; tmpDir[2] = ray.direction.z;
    const ox = tmpOrigin[0], oy = tmpOrigin[1], oz = tmpOrigin[2], dx = tmpDir[0], dy = tmpDir[1], dz = tmpDir[2];
    let best = null;
    for (const cloth of cloths) {
      // A fixed cloth is not pickable: a click on it must orbit the camera, not grab it.
      if (cloth.fixed) continue;
      const X = cloth.X, tris = cloth.tris;
      for (let t = 0; t < cloth.triCount; t++) {
        const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
        const e1x = X[b] - X[a], e1y = X[b + 1] - X[a + 1], e1z = X[b + 2] - X[a + 2];
        const e2x = X[c] - X[a], e2y = X[c + 1] - X[a + 1], e2z = X[c + 2] - X[a + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-14) continue;
        const inv = 1 / det;
        const tx = ox - X[a], ty = oy - X[a + 1], tz = oz - X[a + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist <= 0 || (best && dist >= best.distance)) continue;
        best = { cloth, tri: t, distance: dist, bary: [1 - u - v, u, v] };
      }
    }
    if (!best) {
      // Near miss: a thin or edge-on stretch of cloth (hem, a hanging side seen at a grazing angle) is still grabbable within a few pixels.
      let bestT = Infinity;
      for (const cloth of cloths) {
        if (cloth.fixed) continue;
        const Xc = cloth.X;
        for (let q = 0; q < cloth.N; q++) {
          const o = q * 3, rx = Xc[o] - ox, ry = Xc[o + 1] - oy, rz = Xc[o + 2] - oz, t = rx * dx + ry * dy + rz * dz;
          if (t <= 0 || t >= bestT) continue;
          const px = rx - t * dx, py = ry - t * dy, pz = rz - t * dz, tol = PICK_SLACK + t * PICK_ANGLE;
          if (px * px + py * py + pz * pz > tol * tol) continue;
          const a = Math.min(cloth.pi[q], cloth.cx - 1), b = Math.min(cloth.pj[q], cloth.cy - 1);
          for (let half = 0; half < 2; half++) {
            const tri = (b * cloth.cx + a) * 2 + half;
            for (let k = 0; k < 3; k++) {
              if (cloth.tris[tri * 3 + k] !== q) continue;
              bestT = t;
              const bary = [0, 0, 0]; bary[k] = 1;
              best = { cloth, tri, distance: t, bary, near: true };
            }
          }
        }
      }
    }
    if (!best) return null;
    const X = best.cloth.X, tris = best.cloth.tris;
    best.point = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) best.point[d] += best.bary[k] * X[tris[best.tri * 3 + k] * 3 + d];
    const outer = colliders.outer;
    for (let c = 0; c < C; c++) {
      const t = rayBox(tmpOrigin, tmpDir, outer, c, 0);
      if (!(t > 1e-6 && t < best.distance - 0.03)) continue;
      // A cloth point that lies inside the collider's bounds (authored overlap) is not occluded by it.
      const o = c * 6, p = best.point;
      const inside = p[0] > outer[o] - 0.02 && p[0] < outer[o + 3] + 0.02 && p[1] > outer[o + 1] - 0.02 && p[1] < outer[o + 4] + 0.02 && p[2] > outer[o + 2] - 0.02 && p[2] < outer[o + 5] + 0.02;
      if (!inside) return null;
    }
    return best;
  }

  // A pinch: the 1-3 solver particles nearest to the grabbed point follow the pointer (keeping their offsets to it), and the rest of
  // the cloth hangs and swings from them through its own constraints. Nothing else is attached.
  function beginGrip(hit, desired) {
    endGrip();
    const cloth = hit.cloth, X = cloth.X;
    // A fixed cloth is never grabbable.
    if (cloth.fixed) return null;
    const near = [];
    for (let k = 0; k < 3; k++) near.push(cloth.tris[hit.tri * 3 + k]);
    // The triangle's own corners are the candidates; the nearest corner is always pinched.
    const dist2 = p => (X[p * 3] - hit.point[0]) ** 2 + (X[p * 3 + 1] - hit.point[1]) ** 2 + (X[p * 3 + 2] - hit.point[2]) ** 2;
    near.sort((a, b) => dist2(a) - dist2(b));
    const want = clamp(Math.round(cloth.params.gripParticles), 1, 3);
    const ids = [], offsets = [];
    for (let k = 0; k < near.length && ids.length < want; k++) {
      // Particles further than about one cell from the grab point are not part of the pinch.
      if (k > 0 && Math.sqrt(dist2(near[k])) > 1.1 * cloth.spacing) continue;
      const p = near[k], o = p * 3;
      ids.push(p); offsets.push(X[o] - hit.point[0], X[o + 1] - hit.point[1], X[o + 2] - hit.point[2]);
    }
    // The pinched particles are infinitely heavy for the constraints (the hand carries them), so the cloth is held by them instead of
    // wasting its corrections on particles that the pointer puts back.
    for (const id of ids) cloth.Wc[id] = 0;
    cloth.grip = { count: ids.length, ids: Int32Array.from(ids), offsets: Float64Array.from(offsets),
      target: Float64Array.from(hit.point), desired: Float64Array.from(desired ?? hit.point) };
    gripCloth = cloth;
    wake(cloth);
    return cloth.grip;
  }

  function setGripTarget(point) {
    if (!gripCloth?.grip) return;
    const d = gripCloth.grip.desired;
    d[0] = clamp(point[0], room.min[0] + margin, room.max[0] - margin);
    d[1] = clamp(point[1], Math.max(room.min[1], floorY) + 0.01, room.max[1] - margin);
    d[2] = clamp(point[2], room.min[2] + margin, room.max[2] - margin);
    wake(gripCloth);
  }

  function endGrip() {
    if (!gripCloth) return;
    const cloth = gripCloth;
    gripCloth = null;
    cloth.grip = null;
    cloth.Wc.set(cloth.W);
    cloth.quiet = 0;
  }

  function reset() {
    endGrip();
    for (const cloth of cloths) {
      cloth.X.set(cloth.rest); cloth.P.set(cloth.rest); if (cloth.V) cloth.V.fill(0);
      cloth.awake = false; cloth.quiet = 0; cloth.maxSpeed = 0; cloth.dirty = false; cloth.hash.valid = false; cloth.lastDisp = 0;
      // A fixed cloth has no solver state: its mesh was never touched, so there is nothing to restore.
      if (cloth.fixed) continue;
      cloth.frames.set(cloth.frames0);
      cloth.coarseQ.set(cloth.coarseQ0);
      cloth.ign.set(cloth.ign0);
      cloth.cc.forEach((pair, i) => { pair.ign.set(cloth.cc0[i].ign); pair.rad.set(cloth.cc0[i].rad); pair.side.set(cloth.cc0[i].side); });
      cloth.radius.set(cloth.radius0);
      for (const binding of cloth.bindings) {
        binding.posArray.set(binding.originalPosition); binding.position.needsUpdate = true;
        if (binding.normal) { binding.normal.array.set(binding.originalNormal); binding.normal.needsUpdate = true; }
        if (binding.tangent) { binding.tangent.array.set(binding.originalTangent); binding.tangent.needsUpdate = true; }
        const geometry = binding.mesh.geometry;
        geometry.boundingBox = binding.originalBox?.clone() ?? null;
        geometry.boundingSphere = binding.originalSphere?.clone() ?? null;
      }
      updateBounds(cloth);
    }
  }

  function restDeviation() {
    let max = 0;
    for (const cloth of cloths) for (const binding of cloth.bindings) {
      const a = binding.posArray, b = binding.originalPosition;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; }
      if (binding.normal) { const n = binding.normal.array, m = binding.originalNormal; for (let i = 0; i < n.length; i++) { const d = Math.abs(n[i] - m[i]); if (d > max) max = d; } }
    }
    return max;
  }

  function measure(detail = false) {
    const result = { particles: 0, minY: Infinity, staticPenetration: 0, staticIntrusion: 0, staticContacts: 0, crossPenetration: 0, crossContacts: 0, selfContacts: 0, selfIntrusion: 0 };
    for (const cloth of cloths) {
      // A fixed cloth is never simulated, so it cannot penetrate anything.
      if (cloth.fixed) { result.particles += cloth.N; continue; }
      const m = { penetration: 0, intrusion: 0, contacts: 0 };
      collideStatic(cloth, m);
      result.staticPenetration = Math.max(result.staticPenetration, m.penetration);
      result.staticIntrusion = Math.max(result.staticIntrusion, m.intrusion);
      result.staticContacts += m.contacts;
      result.particles += cloth.N;
      for (let i = 1; i < cloth.X.length; i += 3) if (cloth.X[i] < result.minY) result.minY = cloth.X[i];
    }
    for (const S of cloths) for (const T of cloths) {
      // A fixed cloth neither collides nor is collided against: it is a static surface.
      if (S.fixed) continue;
      const m = { intrusion: 0, contacts: 0, list: detail ? [] : null };
      // A fixed cloth's surface never moves, so its broad-phase grid is reused as it is.
      if (!T.fixed) buildTriangleHash(T, T.X, S.baseRadius + T.baseRadius + 0.01, T.hashCell ?? CC_CELL, T.hashTable ?? TABLE);
      const saveP = S.P, saveTP = T.P;
      S.P = S.X; T.P = T.X;
      contactPass(S, T, S.cc[T.index], m, 'run');
      S.P = saveP; T.P = saveTP;
      if (S === T) { result.selfIntrusion = Math.max(result.selfIntrusion, m.intrusion); result.selfContacts += m.contacts; }
      else { result.crossPenetration = Math.max(result.crossPenetration, m.intrusion); result.crossContacts += m.contacts; }
      (result.pairs ??= []).push({ particlesOf: S.id, against: T.id, intrusion: m.intrusion, contacts: m.contacts });
      if (detail) (result.lists ??= []).push({ s: S.id, t: T.id, list: m.list });
      if (!T.fixed) T.hash.valid = false;
    }
    return result;
  }
  return {
    cloths, colliders, room, stats, substeps,
    get anyAwake() { return cloths.some(cloth => cloth.awake); },
    get gripped() { return gripCloth; },
    stepFrame, skinAwake, skinCloth, pick, beginGrip, setGripTarget, endGrip, reset, wake, measure, restDeviation,
  };
}

// ---------------------------------------------------------------------------
function percentile(values, count, fraction) {
  if (!count) return null;
  const sorted = Array.from(values.subarray(0, count)).sort((a, b) => a - b);
  return sorted[Math.min(count - 1, Math.floor(fraction * count))];
}

export function createBedCloth({ root, camera, canvas, controls, roomBounds, config, onChange = () => {}, isInteractive = () => true }) {
  const system = createBedClothSystem({ root, config, roomBounds });
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  const clock = win.performance;
  const originalCursor = canvas.style.cursor;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const plane = new THREE.Plane();
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();
  const target = [0, 0, 0];
  const blocked = new Set();
  const timings = { sim: new Float32Array(900), skin: new Float32Array(900), count: 0, cursor: 0 };
  let enabled = true, disposed = false, inView = true, paused = true, accumulator = 0, grip = null, geometryVersion = 0;

  function available() { return !disposed && enabled && !doc.hidden && inView && isInteractive(); }
  function suppress(event) { event.preventDefault(); event.stopImmediatePropagation(); }

  function setRay(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    camera.updateWorldMatrix(true, false);
    raycaster.setFromCamera(pointer, camera);
    return true;
  }

  function cancelGrip() {
    if (!grip) return;
    const old = grip;
    grip = null;
    system.endGrip();
    win.removeEventListener('wheel', suppress, true);
    controls.enabled = old.controlsEnabled && enabled && isInteractive();
    canvas.style.cursor = originalCursor;
    if (canvas.hasPointerCapture(old.pointerId)) canvas.releasePointerCapture(old.pointerId);
    onChange();
  }

  function pointerDown(event) {
    if (grip && event.pointerId !== grip.pointerId) {
      // A second pointer arrived while one was gripping: the drag is over, and both pointers are
      // quarantined so their own moves and up do not fight the camera.
      blocked.add(event.pointerId);
      blocked.add(grip.pointerId);
      cancelGrip();
      suppress(event);
      return;
    }
    // A quarantined pointer may have lost its "up". A new press of that same pointer proves the
    // old press is over, so the quarantine is stale: it must not keep the cloth ungrabbable for
    // the rest of the session (a lost pointerup used to wedge every later grab).
    blocked.delete(event.pointerId);
    if (event.target !== canvas || !available() || event.button !== 0 || event.isPrimary === false) return;
    // A second press of the same pointer without a release in between (lost pointerup): end the old grab first, so the
    // camera controls it disabled are restored instead of being remembered as "off".
    if (grip) cancelGrip();
    if (!setRay(event)) return;
    const hit = system.pick(raycaster.ray);
    if (!hit) return;
    camera.getWorldDirection(normal);
    plane.setFromNormalAndCoplanarPoint(normal, point.fromArray(hit.point));
    grip = { pointerId: event.pointerId, controlsEnabled: controls.enabled, plane: plane.clone(), cloth: hit.cloth.id, start: hit.point };
    controls.enabled = false;
    suppress(event);
    try { canvas.setPointerCapture(event.pointerId); } catch { cancelGrip(); return; }
    win.addEventListener('wheel', suppress, eventOptions);
    canvas.style.cursor = 'grabbing';
    system.beginGrip(hit, hit.point);
    paused = true;
    onChange();
  }

  function pointerMove(event) {
    if (blocked.has(event.pointerId)) { suppress(event); return; }
    if (!grip) {
      if (event.target === canvas && event.pointerType !== 'touch' && !event.buttons && available() && setRay(event) && system.pick(raycaster.ray)) canvas.style.cursor = 'grab';
      return;
    }
    if (event.pointerId !== grip.pointerId) return;
    suppress(event);
    if (!available()) { cancelGrip(); return; }
    if (!setRay(event) || !raycaster.ray.intersectPlane(grip.plane, point)) return;
    target[0] = point.x; target[1] = point.y; target[2] = point.z;
    system.setGripTarget(target);
    onChange();
  }

  function pointerEnd(event) {
    if (blocked.delete(event.pointerId)) { suppress(event); return; }
    if (grip?.pointerId !== event.pointerId) return;
    // Releasing another mouse button (chord) does not end the grab.
    if (event.type === 'pointerup' && event.pointerType === 'mouse' && event.button !== 0) return;
    suppress(event);
    cancelGrip();
  }

  function interrupt() {
    cancelGrip();
    blocked.clear();
    accumulator = 0;
    paused = true;
    canvas.style.cursor = originalCursor;
  }

  function visibilityChanged() { interrupt(); if (available() && system.anyAwake) onChange(); }
  function pointerLeave() { if (!grip) canvas.style.cursor = originalCursor; }
  function lostCapture(event) { if (grip?.pointerId === event.pointerId) cancelGrip(); }
  const eventOptions = { capture: true, passive: false };
  win.addEventListener('pointerdown', pointerDown, eventOptions);
  win.addEventListener('pointermove', pointerMove, eventOptions);
  win.addEventListener('pointerup', pointerEnd, eventOptions);
  win.addEventListener('pointercancel', pointerEnd, eventOptions);
  win.addEventListener('blur', interrupt);
  doc.addEventListener('visibilitychange', visibilityChanged);
  canvas.addEventListener('lostpointercapture', lostCapture);
  canvas.addEventListener('pointerleave', pointerLeave);
  const observer = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    visibilityChanged();
  }) : null;
  observer?.observe(canvas);

  const probeUV = [[0.5, 0], [0.5, 0.5], [0.5, 1], [0, 0.5], [1, 0.5], [0, 0], [1, 1], [0, 1], [1, 0]];
  function probes(cloth, rect) {
    return probeUV.map(([u, v]) => {
      const a = Math.round(u * cloth.cx), b = Math.round(v * cloth.cy), o = (b * cloth.pc + a) * 3;
      point.set(cloth.X[o], cloth.X[o + 1], cloth.X[o + 2]);
      const world = point.toArray();
      point.project(camera);
      return { uv: [u, v], world, canvas: [(point.x + 1) * rect.width / 2, (1 - point.y) * rect.height / 2], inFrustum: Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1 };
    });
  }

  return {
    get count() { return system.cloths.length; },
    get grabbing() { return !!grip; },
    get awake() { return system.anyAwake; },
    // Counts the updates that rewrote the cloth meshes: the shadow map only has to follow when it changes.
    get geometryVersion() { return geometryVersion; },
    // Read-only, for the renderer's lighting compensation: mean particle displacement from the authored rest pose, per cloth.
    lightingState() {
      return system.cloths.map(cloth => {
        // A fixed cloth never moves, so it never leaves its baked lighting.
        if (cloth.fixed) return { id: cloth.id, awake: false, displacement: 0, fixed: true };
        let sum = 0;
        for (let i = 0, n = cloth.N * 3; i < n; i += 3) sum += Math.hypot(cloth.X[i] - cloth.rest[i], cloth.X[i + 1] - cloth.rest[i + 1], cloth.X[i + 2] - cloth.rest[i + 2]);
        return { id: cloth.id, awake: cloth.awake, displacement: sum / cloth.N };
      });
    },
    update(deltaSeconds) {
      if (grip && !canvas.hasPointerCapture(grip.pointerId)) cancelGrip();
      if (!available()) { if (!paused || grip) interrupt(); return false; }
      if (!system.anyAwake) return false;
      if (paused) { paused = false; accumulator = 0; deltaSeconds = 0; }
      accumulator += clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, STEP * MAX_FRAME_STEPS);
      let steps = 0;
      const t0 = clock.now();
      while (accumulator >= STEP && steps < MAX_FRAME_STEPS) {
        accumulator -= STEP; system.stepFrame(); steps++;
        if (accumulator >= STEP && clock.now() - t0 > STEP_BUDGET_MS) { accumulator = 0; break; }
      }
      if (steps === MAX_FRAME_STEPS) accumulator = 0;
      if (steps) {
        const t1 = clock.now();
        system.skinAwake();
        geometryVersion++;
        const t2 = clock.now();
        timings.sim[timings.cursor] = (t1 - t0) / steps;
        timings.skin[timings.cursor] = t2 - t1;
        timings.cursor = (timings.cursor + 1) % timings.sim.length;
        timings.count = Math.min(timings.count + 1, timings.sim.length);
      }
      return system.anyAwake;
    },
    setEnabled(value) {
      if (disposed || enabled === !!value) return;
      enabled = !!value;
      if (!enabled) interrupt(); else if (system.anyAwake) onChange();
    },
    reset() {
      if (disposed) return;
      interrupt();
      system.reset();
      onChange();
    },
    snapshot() {
      const rect = canvas.getBoundingClientRect();
      camera.updateWorldMatrix(true, false);
      const measured = system.measure();
      const stat = buffer => ({
        samples: timings.count, p50: percentile(buffer, timings.count, 0.5), p95: percentile(buffer, timings.count, 0.95),
        max: timings.count ? Math.max(...buffer.subarray(0, timings.count)) : null,
      });
      return {
        enabled, grabbing: !!grip, awake: system.anyAwake, substeps: system.substeps, stepFrames: system.stats.frames, repairedParticles: system.stats.repaired,
        restDeviation: system.restDeviation(), contacts: measured,
        timing: { simMsPerFrameStep: stat(timings.sim), skinMsPerFrame: stat(timings.skin) },
        colliders: system.colliders.list.map(c => ({ name: c.name, min: c.min, max: c.max, round: c.round })),
        cloths: system.cloths.map(cloth => ({
          id: cloth.id, awake: cloth.awake, awakeFrames: cloth.awakeFrames, quiet: cloth.quiet, maxSpeed: cloth.maxSpeed, fixed: !!cloth.fixed,
          particles: cloth.N, simGrid: [cloth.cx, cloth.cy], grid: [cloth.nx, cloth.ny], vertices: cloth.simVertices, mass: cloth.mass, area: cloth.area,
          bounds: { min: Array.from(cloth.boundsMin), max: Array.from(cloth.boundsMax) },
          grip: cloth.grip ? { count: cloth.grip.count, target: Array.from(cloth.grip.target), desired: Array.from(cloth.grip.desired) } : null,
          probes: probes(cloth, rect),
        })),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      interrupt();
      observer?.disconnect();
      win.removeEventListener('pointerdown', pointerDown, true);
      win.removeEventListener('pointermove', pointerMove, true);
      win.removeEventListener('pointerup', pointerEnd, true);
      win.removeEventListener('pointercancel', pointerEnd, true);
      win.removeEventListener('blur', interrupt);
      doc.removeEventListener('visibilitychange', visibilityChanged);
      canvas.removeEventListener('lostpointercapture', lostCapture);
      canvas.removeEventListener('pointerleave', pointerLeave);
      // Geometry belongs to the caller: restore the authored pose, never dispose shared assets.
      system.reset();
      blocked.clear();
    },
  };
}
