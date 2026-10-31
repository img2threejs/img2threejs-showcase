// SPDX-License-Identifier: Apache-2.0
// Distance along the garment surface. Every part of the garment (cups, both ribbons, the neck
// loop, the under band) is one connected mesh, so how far a pull reaches must be measured
// ALONG that mesh, through the neck loop to the other ribbon, not through the air. One smooth
// kernel over that distance gives every vertex a weight; adjacent vertices then differ by at
// most (kernel slope x edge length), which is what keeps the garment in one piece.

/**
 * Surface graph over welded vertices. `weldIds[i]` is the dense weld id of vertex i (vertices
 * sharing a position, e.g. across UV seams, share an id); edge length is the rest distance.
 */
export function buildGraph(weldIds, weldCount, rest, indices) {
  const first = new Int32Array(weldCount).fill(-1);
  for (let i = 0; i < weldIds.length; i++) if (first[weldIds[i]] < 0) first[weldIds[i]] = i;
  const seen = new Set(), pairs = [];
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = weldIds[indices[t + k]], b = weldIds[indices[t + (k + 1) % 3]];
      if (a === b) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * weldCount + hi;
      if (seen.has(key)) continue;
      seen.add(key); pairs.push(lo, hi);
    }
  }
  const start = new Uint32Array(weldCount + 1);
  for (let k = 0; k < pairs.length; k++) start[pairs[k] + 1]++;
  for (let v = 0; v < weldCount; v++) start[v + 1] += start[v];
  const fill = start.slice(0, weldCount), neighbor = new Uint32Array(pairs.length), length = new Float32Array(pairs.length);
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k], b = pairs[k + 1], i = first[a], j = first[b];
    const d = Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2]);
    neighbor[fill[a]] = b; length[fill[a]++] = d;
    neighbor[fill[b]] = a; length[fill[b]++] = d;
  }
  return { count: weldCount, weldIds, start, neighbor, length };
}

/** Shortest surface distance from `sources` ([{ weld, distance }]) to every weld id (Infinity if unreachable). */
export function geodesic(graph, sources, out = new Float32Array(graph.count)) {
  out.fill(Infinity);
  const heapV = [], heapD = [];
  const push = (v, d) => {
    let i = heapV.length; heapV.push(v); heapD.push(d);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapD[parent] <= d) break;
      heapV[i] = heapV[parent]; heapD[i] = heapD[parent]; i = parent;
    }
    heapV[i] = v; heapD[i] = d;
  };
  const pop = () => {
    const v = heapV[0], d = heapD[0], lastV = heapV.pop(), lastD = heapD.pop();
    const n = heapV.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && heapD[child + 1] < heapD[child]) child++;
        if (heapD[child] >= lastD) break;
        heapV[i] = heapV[child]; heapD[i] = heapD[child]; i = child;
      }
      heapV[i] = lastV; heapD[i] = lastD;
    }
    return [v, d];
  };
  // Distances are stored as float32, so queue the rounded value or the stale-entry check below
  // would discard nearly every entry.
  for (const { weld, distance } of sources) {
    const d0 = Math.fround(distance);
    if (d0 < out[weld]) { out[weld] = d0; push(weld, d0); }
  }
  while (heapV.length) {
    const [v, d] = pop();
    if (d > out[v]) continue;
    for (let e = graph.start[v]; e < graph.start[v + 1]; e++) {
      const w = graph.neighbor[e], nd = Math.fround(d + graph.length[e]);
      if (nd < out[w]) { out[w] = nd; push(w, nd); }
    }
  }
  return out;
}

/**
 * Per-vertex distance from a grab. Sources are the grabbed face's vertices, each at its straight
 * distance from `center`. A vertex the surface cannot reach (a part not connected to the grab)
 * falls back to its straight distance from `center`, so a loose piece still follows.
 */
export function distanceField(graph, rest, vertices, center, out) {
  const sources = vertices.map((i) => ({ weld: graph.weldIds[i], distance: Math.hypot(rest[i * 3] - center.x, rest[i * 3 + 1] - center.y, rest[i * 3 + 2] - center.z) }));
  const geo = geodesic(graph, sources);
  for (let i = 0; i < out.length; i++) {
    const d = geo[graph.weldIds[i]];
    out[i] = Number.isFinite(d) ? d : Math.hypot(rest[i * 3] - center.x, rest[i * 3 + 1] - center.y, rest[i * 3 + 2] - center.z);
  }
  return out;
}

const smoothstep = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** Kernel over distance: 1 inside `plateau`, smooth fall (zero slope at both ends) to 0 at `reach`. */
export function falloff(distance, plateau, reach) {
  return 1 - smoothstep((distance - plateau) / Math.max(reach - plateau, 1e-9));
}

/** Steepest possible change of `falloff` per metre: the bound on weight difference between neighbours. */
export function falloffSlope(plateau, reach) {
  return 1.5 / Math.max(reach - plateau, 1e-9);
}
