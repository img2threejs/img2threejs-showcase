// SPDX-License-Identifier: Apache-2.0
// Bounded positional strain / bending for the worn garment. The pull field and the skin contact give
// each vertex a target on their own; neighbouring targets can disagree (the nearest skin point jumps
// across a crease; a pull can ask for more travel than the cloth between the pinned band and the grip
// can stretch), and nothing in those steps knows the vertices are joined by cloth. Over the WELDED
// surface (UV-seam twins are one vertex, so seams stay closed) this module
//   strainScale(): the largest fraction of a pull's displacement the cloth can follow without any edge
//     leaving its soft strain band, so travel is limited by the cloth, uniformly, not torn at a junction;
//   relax(): a few Gauss-Seidel sweeps over every stretch/compression edge and every pair of triangles
//     sharing an edge (fold limit), plus optional skin half-spaces, that settle what contact left.
// All state is typed arrays allocated once; nothing here allocates per call.
//
// The numbers are project-calibrated design limits for a lightweight stretch fabric on a 1-8 mm
// mesh, not measured material constants.
/**
 * stretchSoft / stretchMax: an edge may reach stretchSoft x its rest length freely; beyond it the
 *   allowed length saturates smoothly (tanh) toward stretchMax, which it never reaches.
 * compressSoft / compressMin: the same for shortening.
 * bendMin: the distance between the two vertices opposite a shared edge may fall to bendMin x its
 *   flat-unfolded value (times the rest value): cos(half the fold angle), so 0.8 = a 74 degree fold.
 * fieldStretch / fieldCompress: loose bound on the raw pull field (strainScale); relax() and the caller's
 *   retry loop do the real limiting. accept: the largest rendered edge ratio the caller will accept.
 * iterations: most relax() sweeps; it stops early once every RELATIVE edge/fold residual is within `tolerance`
 *   AND, independently, no vertex entered the skin by `floorTolerance` metres or more (an absolute length).
 * bendEvery: fold limits are evaluated on every bendEvery-th sweep (edges on every sweep).
 * overRelax: successive over-relaxation factor of each relax() correction.
 */
export const CLOTH_STRAIN = Object.freeze({ stretchSoft: 1.25, stretchMax: 1.32, compressSoft: 0.8, compressMin: 0.55, bendMin: 0.8, fieldStretch: 2.2, fieldCompress: 0.45,
  accept: 1.33, iterations: 16, bendEvery: 4, overRelax: 1.3, tolerance: 4e-3, floorTolerance: 1e-4 });

/**
 * @param graph surface graph from buildGraph (welded vertices, rest edge lengths)
 * @param weldFirst first vertex index of every weld id (the representative that carries the position)
 * @param indices triangle indices of the render mesh
 * @param rest rest positions of the render mesh (xyz per vertex)
 */
export function createClothConstraints(graph, weldFirst, indices, rest) {
  const { stretchSoft, stretchMax, compressSoft, compressMin, bendMin, fieldStretch, fieldCompress } = CLOTH_STRAIN;
  let edgeCount = 0;
  for (let w = 0; w < graph.count; w++) for (let e = graph.start[w]; e < graph.start[w + 1]; e++) if (graph.neighbor[e] > w) edgeCount++;
  const ea = new Int32Array(edgeCount), eb = new Int32Array(edgeCount), eLen = new Float32Array(edgeCount), eHi2 = new Float32Array(edgeCount), eLo2 = new Float32Array(edgeCount);
  for (let w = 0, k = 0; w < graph.count; w++) for (let e = graph.start[w]; e < graph.start[w + 1]; e++) {
    if (graph.neighbor[e] <= w) continue;
    ea[k] = weldFirst[w] * 3; eb[k] = weldFirst[graph.neighbor[e]] * 3; eLen[k] = graph.length[e];
    eHi2[k] = (stretchSoft * eLen[k]) ** 2; eLo2[k] = (compressSoft * eLen[k]) ** 2; k++;
  }

  // Bend pairs: for every welded edge shared by exactly two triangles, the hinge (a, b) and the opposite vertices (c, d).
  const key = (u, v) => Math.min(u, v) * graph.count + Math.max(u, v);
  const shared = new Map(), weld = graph.weldIds;
  for (let t = 0; t < indices.length; t += 3) for (let j = 0; j < 3; j++) {
    const u = weld[indices[t + j]], v = weld[indices[t + (j + 1) % 3]], opposite = weld[indices[t + (j + 2) % 3]];
    if (u === v || u === opposite || v === opposite) continue;
    const k = key(u, v), item = shared.get(k);
    if (item) item.push(opposite); else shared.set(k, [u, v, opposite]);
  }
  const pairs = [...shared.values()].filter((item) => item.length === 4 && item[2] !== item[3]);
  const bendCount = pairs.length;
  const ba = new Int32Array(bendCount), bb = new Int32Array(bendCount), bc = new Int32Array(bendCount), bd = new Int32Array(bendCount), bRatio = new Float32Array(bendCount);
  const pair = new Float64Array(2);
  /** Flat-unfolded distance between c and d about the hinge a-b (pair[0]) and their actual distance (pair[1]). */
  function unfold(p, a, b, c, d) {
    let hx = p[b] - p[a], hy = p[b + 1] - p[a + 1], hz = p[b + 2] - p[a + 2];
    const hl = Math.sqrt(hx * hx + hy * hy + hz * hz); if (hl < 1e-12) return false;
    hx /= hl; hy /= hl; hz /= hl;
    const cx = p[c] - p[a], cy = p[c + 1] - p[a + 1], cz = p[c + 2] - p[a + 2], dx = p[d] - p[a], dy = p[d + 1] - p[a + 1], dz = p[d + 2] - p[a + 2];
    const s1 = cx * hx + cy * hy + cz * hz, s2 = dx * hx + dy * hy + dz * hz;
    const c1 = cx - s1 * hx, c2 = cy - s1 * hy, c3 = cz - s1 * hz, d1 = dx - s2 * hx, d2 = dy - s2 * hy, d3 = dz - s2 * hz;
    const h = Math.sqrt(c1 * c1 + c2 * c2 + c3 * c3) + Math.sqrt(d1 * d1 + d2 * d2 + d3 * d3);
    pair[0] = Math.sqrt((s1 - s2) * (s1 - s2) + h * h);
    pair[1] = Math.sqrt((cx - dx) * (cx - dx) + (cy - dy) * (cy - dy) + (cz - dz) * (cz - dz));
    return true;
  }
  for (let k = 0; k < bendCount; k++) {
    const [u, v, c, d] = pairs[k];
    ba[k] = weldFirst[u] * 3; bb[k] = weldFirst[v] * 3; bc[k] = weldFirst[c] * 3; bd[k] = weldFirst[d] * 3;
    bRatio[k] = unfold(rest, ba[k], bb[k], bc[k], bd[k]) && pair[0] > 1e-9 ? Math.min(1, pair[1] / pair[0]) : 0;
  }
  const stretchBand = stretchMax - stretchSoft, compressBand = compressSoft - compressMin;

  /** Allowed length ratio for a measured ratio: identity inside the soft band, saturating outside it. */
  function allowed(r) {
    if (r > stretchSoft) return stretchSoft + stretchBand * Math.tanh((r - stretchSoft) / stretchBand);
    if (r < compressSoft) return compressSoft - compressBand * Math.tanh((compressSoft - r) / compressBand);
    return r;
  }

  /**
   * Largest scale s in [0, 1] such that moving every vertex by s x `displacement` (xyz per render
   * vertex, weld representatives only), on top of `applied` (a displacement already committed, or
   * null), keeps every edge inside [fieldCompress, fieldStretch] x its rest length. Exact per edge:
   * |E + s D|^2 is a quadratic in s. 1 when the whole displacement is feasible.
   */
  function strainScale(displacement, applied = null) {
    let scale = 1;
    const hi = fieldStretch * fieldStretch, lo = fieldCompress * fieldCompress;
    for (let e = 0; e < edgeCount; e++) {
      const a = ea[e], b = eb[e];
      const dx = displacement[b] - displacement[a], dy = displacement[b + 1] - displacement[a + 1], dz = displacement[b + 2] - displacement[a + 2];
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < 1e-18) continue;
      let ex = rest[b] - rest[a], ey = rest[b + 1] - rest[a + 1], ez = rest[b + 2] - rest[a + 2];
      if (applied) { ex += applied[b] - applied[a]; ey += applied[b + 1] - applied[a + 1]; ez += applied[b + 2] - applied[a + 2]; }
      const ed = ex * dx + ey * dy + ez * dz, l2 = eLen[e] * eLen[e], base2 = ex * ex + ey * ey + ez * ez;
      // |E + sD|^2 = base2 + 2 s ed + s^2 dd. Stretch limit: the positive root of ... = hi l2.
      const room = hi * l2 - base2;
      const stretchRoot = room > 0 ? (-ed + Math.sqrt(ed * ed + dd * room)) / dd : 0;
      if (stretchRoot < scale) scale = stretchRoot;
      // Compression limit: the first positive root of ... = lo l2, when the edge is shortening.
      if (ed < 0) {
        const disc = ed * ed - dd * (base2 - lo * l2);
        if (disc >= 0) { const compressRoot = (-ed - Math.sqrt(disc)) / dd; if (compressRoot < scale) scale = Math.max(0, compressRoot); }
      }
    }
    return scale;
  }

  /**
   * Settles `positions` (xyz per render vertex; only weld representatives are read or written) with
   * Gauss-Seidel sweeps and returns the largest remaining RELATIVE edge/fold residual (violation over
   * the edge/fold length; skin penetration is metres and converges on `floorTolerance` separately). `weight[v]` is the inverse mass
   * of vertex v (0 = held, below 1 = a support that may give a little). Constraints whose vertices are
   * all unmoved (`moved`) are skipped; a vertex they move is flagged. `options.leash` bounds how far
   * the low-weight supports may slip: entry k holds vertex `index[k]`, which may not end up further than
   * `max` metres from `origin[index[k]..]`. `options.floor` keeps vertices out of the skin while they
   * settle: entry k holds vertex `index[k]` (offset into positions), the skin's outward normal
   * `normal[3k..]` and the clearance `slack[k]` (metres, above the allowed floor) the vertex had at
   * `base[3k..]`; the vertex may not move against the normal by more than that.
   */
  function relax(p, weight, moved, { leash = null, floor = null, iterations = CLOTH_STRAIN.iterations } = {}) {
    const over = CLOTH_STRAIN.overRelax, floorTolerance = CLOTH_STRAIN.floorTolerance;
    let worst = 0, floorWorst = 0;
    for (let it = 0; it < iterations; it++) {
      const forward = (it & 1) === 0;
      worst = 0; floorWorst = 0;
      for (let n = 0; n < edgeCount; n++) {
        const e = forward ? n : edgeCount - 1 - n, a = ea[e], b = eb[e], wa = weight[a / 3], wb = weight[b / 3], wsum = wa + wb;
        if (wsum === 0 || (moved[a / 3] === 0 && moved[b / 3] === 0)) continue;
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2], len2 = dx * dx + dy * dy + dz * dz, rest0 = eLen[e];
        // Inside the soft band (compared squared, no sqrt) there is nothing to do.
        if (len2 <= eHi2[e] && len2 >= eLo2[e]) continue;
        const length = Math.sqrt(len2), ratio = length / rest0;
        if (length < 1e-12) continue;
        const excess = length - allowed(ratio) * rest0, relative = Math.abs(excess) / rest0;
        if (relative > worst) worst = relative;
        const k = excess * over / length / wsum;
        p[a] += dx * k * wa; p[a + 1] += dy * k * wa; p[a + 2] += dz * k * wa;
        p[b] -= dx * k * wb; p[b + 1] -= dy * k * wb; p[b + 2] -= dz * k * wb;
        moved[a / 3] = 1; moved[b / 3] = 1;
      }
      // Fold limits are the weaker, costlier constraint: every `bendEvery`-th sweep is enough.
      if (it % CLOTH_STRAIN.bendEvery === 0) for (let n = 0; n < bendCount; n++) {
        const e = forward ? n : bendCount - 1 - n, c = bc[e], d = bd[e], wc = weight[c / 3], wd = weight[d / 3], wsum = wc + wd;
        if (wsum === 0 || bRatio[e] === 0) continue;
        if (moved[c / 3] === 0 && moved[d / 3] === 0 && moved[ba[e] / 3] === 0 && moved[bb[e] / 3] === 0) continue;
        if (!unfold(p, ba[e], bb[e], c, d)) continue;
        const deficit = bendMin * bRatio[e] * pair[0] - pair[1];
        if (deficit <= 0) continue;
        const dx = p[c] - p[d], dy = p[c + 1] - p[d + 1], dz = p[c + 2] - p[d + 2], length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (length < 1e-12) continue;
        if (deficit / pair[0] > worst) worst = deficit / pair[0];
        const k = deficit * over / length / wsum;
        p[c] += dx * k * wc; p[c + 1] += dy * k * wc; p[c + 2] += dz * k * wc;
        p[d] -= dx * k * wd; p[d + 1] -= dy * k * wd; p[d + 2] -= dz * k * wd;
        moved[c / 3] = 1; moved[d / 3] = 1;
      }
      if (leash) for (let k = 0; k < leash.count; k++) {
        const v = leash.index[k], dx = p[v] - leash.origin[v], dy = p[v + 1] - leash.origin[v + 1], dz = p[v + 2] - leash.origin[v + 2], len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len <= leash.max) continue;
        const s = leash.max / len;
        p[v] = leash.origin[v] + dx * s; p[v + 1] = leash.origin[v + 1] + dy * s; p[v + 2] = leash.origin[v + 2] + dz * s;
      }
      if (floor) for (let k = 0; k < floor.count; k++) {
        const v = floor.index[k];
        if (weight[v / 3] === 0) continue;
        const k3 = k * 3, nx = floor.normal[k3], ny = floor.normal[k3 + 1], nz = floor.normal[k3 + 2];
        const room = (p[v] - floor.base[k3]) * nx + (p[v + 1] - floor.base[k3 + 1]) * ny + (p[v + 2] - floor.base[k3 + 2]) * nz + floor.slack[k];
        if (room >= 0) continue;
        if (-room > floorWorst) floorWorst = -room;
        p[v] -= nx * room; p[v + 1] -= ny * room; p[v + 2] -= nz * room;
        moved[v / 3] = 1;
      }
      if (worst < CLOTH_STRAIN.tolerance && floorWorst < floorTolerance) break;
    }
    return worst;
  }

  const range = new Float64Array(2);
  /** Largest and smallest edge length / rest length over the welded surface: range[0] = max, range[1] = min. */
  function strain(p) {
    let hiR = 0, loR = Infinity;
    for (let e = 0; e < edgeCount; e++) {
      const a = ea[e], b = eb[e], dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2], r = Math.sqrt(dx * dx + dy * dy + dz * dz) / eLen[e];
      if (r > hiR) hiR = r;
      if (r < loR) loR = r;
    }
    range[0] = hiR; range[1] = loR;
    return range;
  }
  return { strainScale, relax, strain, allowed, edges: edgeCount, bends: bendCount };
}
