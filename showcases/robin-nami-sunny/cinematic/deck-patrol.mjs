// Deterministic, time-absolute patrol route shared by every character walking the Sunny lawn.
//
// The route is derived from the *loaded ship geometry* (world-space triangles of the
// supplied entity), never from hand-placed obstacle discs:
//   * walkable support  = upward triangles lying on the y=0 lawn plane; their welded
//                         boundary edges form the support polygon (inset by the radius);
//   * solid obstacles   = every triangle intersecting the agent slab (FLOOR, height),
//                         clipped to the slab and projected to XZ as a convex polygon
//                         (degenerate walls stay blocking: distance is edge based);
//   * stage exclusion   = analytic disc at the origin (Robin's skill stage; the loop encircles it).
// A conservative 0.2 m occupancy grid (inflated by radius + safety + cell half-diagonal)
// is searched with A* between the authored waypoints, strings are pulled with an exact
// swept-clearance test, and corners are rounded with clearance-validated fillets (or a
// sharp corner with an in-place turn dwell when no fillet fits). Sampling is a pure
// function of absolute seconds.

const CELL = 0.2;
const HALF_DIAGONAL = CELL * Math.SQRT2 / 2;
const SAFETY = 0.08;
const FLOOR = 0.04;            // surfaces at or below this height are walked on, not hit
const SUPPORT_Y = 0.002;       // lawn plane tolerance
const BUCKET = 0.5;
const WAYPOINT_BYPASS = 0.75;  // max distance a smoothed route may pass from an authored waypoint
const ACCESS_SEARCH = 1.2;     // max swept connection length for isClear accessibility
const ROBIN = Object.freeze({ x: 0, z: 0, radius: 1.1 });
const WAYPOINTS = Object.freeze([[2.2, 1.2], [3.5, 6], [-3.5, 6], [-2.4, -5.8], [2.4, -5.8]]);
const MARGIN_TIERS = Object.freeze([0.45, 0.25, 0.1, 0]);
const FILLET_MAX = 1.4;
const FILLET_MIN = 0.2;
const TURN_RATE = 2.4;         // rad/s for in-place turns at corners that cannot be rounded
const CHECK_STEP = 0.02;       // metres between dense verification samples
const TWO_PI = Math.PI * 2;

const wrapPi = (a) => a - TWO_PI * Math.round(a / TWO_PI);

function pointSegmentDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l = dx * dx + dz * dz;
  let t = l > 0 ? ((px - ax) * dx + (pz - az) * dz) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px;
  const z = az + t * dz - pz;
  return x * x + z * z;
}

const orient = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

function segmentSegmentDistSq(ax, az, bx, bz, cx, cz, dx, dz) {
  const o1 = orient(ax, az, bx, bz, cx, cz);
  const o2 = orient(ax, az, bx, bz, dx, dz);
  const o3 = orient(cx, cz, dx, dz, ax, az);
  const o4 = orient(cx, cz, dx, dz, bx, bz);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
  return Math.min(
    pointSegmentDistSq(ax, az, cx, cz, dx, dz),
    pointSegmentDistSq(bx, bz, cx, cz, dx, dz),
    pointSegmentDistSq(cx, cz, ax, az, bx, bz),
    pointSegmentDistSq(dx, dz, ax, az, bx, bz),
  );
}

function assertPositive(name, value, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= minimum) {
    throw new RangeError(`createSunnyPatrol: ${name} must be a finite number > ${minimum}; got ${value}`);
  }
}

// ---------------------------------------------------------------------------------
// Geometry extraction
// ---------------------------------------------------------------------------------

function collectMeshes(ship) {
  if (!ship || typeof ship.traverseVisible !== 'function' || typeof ship.updateWorldMatrix !== 'function') {
    throw new TypeError('createSunnyPatrol: ship must be the loaded Sunny THREE.Object3D');
  }
  ship.updateWorldMatrix(true, true);
  const meshes = [];
  ship.traverseVisible((object) => {
    if (!object.isMesh) return;
    if (object.isSkinnedMesh || object.isInstancedMesh) {
      throw new Error(`createSunnyPatrol: ${object.name || 'mesh'} is skinned/instanced; static geometry required`);
    }
    const position = object.geometry?.attributes?.position;
    if (!position || position.itemSize < 3) return;
    meshes.push(object);
  });
  return meshes;
}

// Calls visit(ax,ay,az,bx,by,bz,cx,cy,cz) with world-space triangle vertices.
function forEachTriangle(mesh, scratch, visit) {
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  const e = mesh.matrixWorld.elements;
  const count = position.count;
  const world = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    world[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    world[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    world[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const index = geometry.index;
  const triangles = Math.floor((index ? index.count : count) / 3);
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const v = (index ? index.getX(t * 3 + k) : t * 3 + k) * 3;
      scratch[k * 3] = world[v];
      scratch[k * 3 + 1] = world[v + 1];
      scratch[k * 3 + 2] = world[v + 2];
    }
    visit(scratch);
  }
}

function extractSupport(meshes) {
  const scratch = new Float64Array(9);
  const triangles = [];
  for (const mesh of meshes) {
    forEachTriangle(mesh, scratch, (t) => {
      if (Math.abs(t[1]) > SUPPORT_Y || Math.abs(t[4]) > SUPPORT_Y || Math.abs(t[7]) > SUPPORT_Y) return;
      const up = (t[5] - t[2]) * (t[6] - t[0]) - (t[3] - t[0]) * (t[8] - t[2]);
      if (up > 1e-12) triangles.push(t[0], t[2], t[3], t[5], t[6], t[8]);
    });
  }
  if (triangles.length === 0) throw new Error('createSunnyPatrol: no walkable y=0 lawn triangles found in ship');
  // Welded edge usage: edges used by exactly one triangle bound the walkable region.
  const weld = (x, z) => `${Math.round(x * 1e5)},${Math.round(z * 1e5)}`;
  const edges = new Map();
  for (let i = 0; i < triangles.length; i += 6) {
    for (let k = 0; k < 3; k++) {
      const ax = triangles[i + k * 2];
      const az = triangles[i + k * 2 + 1];
      const bx = triangles[i + ((k + 1) % 3) * 2];
      const bz = triangles[i + ((k + 1) % 3) * 2 + 1];
      const ka = weld(ax, az);
      const kb = weld(bx, bz);
      if (ka === kb) continue;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const entry = edges.get(key);
      if (entry) entry.count++;
      else edges.set(key, { count: 1, ax, az, bx, bz });
    }
  }
  const boundary = [];
  for (const e of edges.values()) if (e.count === 1) boundary.push(e.ax, e.az, e.bx, e.bz);
  if (boundary.length < 12) throw new Error('createSunnyPatrol: lawn support has no closed boundary');
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < triangles.length; i += 2) {
    minX = Math.min(minX, triangles[i]);
    maxX = Math.max(maxX, triangles[i]);
    minZ = Math.min(minZ, triangles[i + 1]);
    maxZ = Math.max(maxZ, triangles[i + 1]);
  }
  return {
    triangleCount: triangles.length / 6,
    boundary: Float64Array.from(boundary),
    bounds: { minX, maxX, minZ, maxZ },
  };
}

// Sutherland-Hodgman against one horizontal plane; vertices are xyz triples.
function clipHorizontal(src, n, dst, level, keepAbove) {
  let out = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ay = src[i * 3 + 1];
    const by = src[j * 3 + 1];
    const da = keepAbove ? ay - level : level - ay;
    const db = keepAbove ? by - level : level - by;
    if (da >= 0) {
      dst[out * 3] = src[i * 3];
      dst[out * 3 + 1] = ay;
      dst[out * 3 + 2] = src[i * 3 + 2];
      out++;
    }
    if ((da >= 0) !== (db >= 0)) {
      const u = da / (da - db);
      dst[out * 3] = src[i * 3] + (src[j * 3] - src[i * 3]) * u;
      dst[out * 3 + 1] = level;
      dst[out * 3 + 2] = src[i * 3 + 2] + (src[j * 3 + 2] - src[i * 3 + 2]) * u;
      out++;
    }
  }
  return out;
}

function extractObstacles(meshes, bounds, height, reach) {
  const minX = bounds.minX - reach;
  const maxX = bounds.maxX + reach;
  const minZ = bounds.minZ - reach;
  const maxZ = bounds.maxZ + reach;
  const scratch = new Float64Array(9);
  const bufA = new Float64Array(8 * 3);
  const bufB = new Float64Array(8 * 3);
  const coords = [];
  const starts = [];
  const counts = [];
  const boxes = [];
  const areas = [];
  const sources = new Map();
  let scanned = 0;
  let inSlab = 0;
  for (const mesh of meshes) {
    let kept = 0;
    forEachTriangle(mesh, scratch, (t) => {
      scanned++;
      const ymin = Math.min(t[1], t[4], t[7]);
      const ymax = Math.max(t[1], t[4], t[7]);
      if (ymax <= FLOOR || ymin >= height) return;
      const xmin = Math.min(t[0], t[3], t[6]);
      const xmax = Math.max(t[0], t[3], t[6]);
      const zmin = Math.min(t[2], t[5], t[8]);
      const zmax = Math.max(t[2], t[5], t[8]);
      if (xmax < minX || xmin > maxX || zmax < minZ || zmin > maxZ) return;
      inSlab++;
      bufA.set(t, 0);
      const n1 = clipHorizontal(bufA, 3, bufB, FLOOR, true);
      if (n1 === 0) return;
      const n2 = clipHorizontal(bufB, n1, bufA, height, false);
      if (n2 === 0) return;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      let area2 = 0;
      starts.push(coords.length / 2);
      counts.push(n2);
      for (let i = 0; i < n2; i++) {
        const x = bufA[i * 3];
        const z = bufA[i * 3 + 2];
        const nx = bufA[((i + 1) % n2) * 3];
        const nz = bufA[((i + 1) % n2) * 3 + 2];
        coords.push(x, z);
        area2 += x * nz - nx * z;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      boxes.push(x0, x1, z0, z1);
      areas.push(Math.abs(area2) * 0.5);
      kept++;
    });
    if (kept) {
      const name = mesh.name || mesh.uuid;
      sources.set(name, (sources.get(name) ?? 0) + kept);
    }
  }
  const count = counts.length;
  // Fixed-bucket CSR index. A polygon is registered in every bucket its box overlaps.
  const cols = Math.max(1, Math.ceil((maxX - minX) / BUCKET) + 1);
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / BUCKET) + 1);
  const bucketCounts = new Uint32Array(cols * rows + 1);
  const bucketRange = (i) => [
    Math.max(0, Math.floor((boxes[i * 4] - minX) / BUCKET)),
    Math.min(cols - 1, Math.floor((boxes[i * 4 + 1] - minX) / BUCKET)),
    Math.max(0, Math.floor((boxes[i * 4 + 2] - minZ) / BUCKET)),
    Math.min(rows - 1, Math.floor((boxes[i * 4 + 3] - minZ) / BUCKET)),
  ];
  for (let i = 0; i < count; i++) {
    const [a, b, c, d] = bucketRange(i);
    for (let r = c; r <= d; r++) for (let q = a; q <= b; q++) bucketCounts[r * cols + q + 1]++;
  }
  for (let i = 1; i < bucketCounts.length; i++) bucketCounts[i] += bucketCounts[i - 1];
  const bucketItems = new Uint32Array(bucketCounts[bucketCounts.length - 1]);
  const cursor = bucketCounts.slice(0, -1);
  for (let i = 0; i < count; i++) {
    const [a, b, c, d] = bucketRange(i);
    for (let r = c; r <= d; r++) for (let q = a; q <= b; q++) bucketItems[cursor[r * cols + q]++] = i;
  }
  return {
    count,
    scanned,
    inSlab,
    coords: Float64Array.from(coords),
    starts: Uint32Array.from(starts),
    counts: Uint8Array.from(counts),
    boxes: Float64Array.from(boxes),
    solid: Uint8Array.from(areas, (a) => (a > 1e-10 ? 1 : 0)),
    bucket: { minX, minZ, cols, rows, offsets: bucketCounts, items: bucketItems },
    sources: [...sources].map(([mesh, polygons]) => ({ mesh, polygons })).sort((a, b) => b.polygons - a.polygons || (a.mesh < b.mesh ? -1 : 1)),
  };
}

// ---------------------------------------------------------------------------------
// Collision queries
// ---------------------------------------------------------------------------------

function createCollision(support, obstacles, clearanceCap) {
  const boundary = support.boundary;
  const edgeCount = boundary.length / 4;
  const { coords, starts, counts, boxes, solid, bucket } = obstacles;
  const bucketStamp = new Uint32Array(bucket.cols * bucket.rows);
  const polyStamp = new Uint32Array(Math.max(1, obstacles.count));
  let epoch = 0;

  function insideSupport(x, z) {
    let inside = false;
    for (let i = 0; i < edgeCount; i++) {
      const z1 = boundary[i * 4 + 1];
      const z2 = boundary[i * 4 + 3];
      if ((z1 > z) === (z2 > z)) continue;
      const x1 = boundary[i * 4];
      const x2 = boundary[i * 4 + 2];
      if (x1 + ((z - z1) * (x2 - x1)) / (z2 - z1) > x) inside = !inside;
    }
    return inside;
  }

  function boundaryDistSq(x, z) {
    let best = Infinity;
    for (let i = 0; i < edgeCount; i++) {
      const d = pointSegmentDistSq(x, z, boundary[i * 4], boundary[i * 4 + 1], boundary[i * 4 + 2], boundary[i * 4 + 3]);
      if (d < best) best = d;
    }
    return best;
  }

  function boundarySegmentDistSq(ax, az, bx, bz) {
    let best = Infinity;
    for (let i = 0; i < edgeCount; i++) {
      const d = segmentSegmentDistSq(ax, az, bx, bz, boundary[i * 4], boundary[i * 4 + 1], boundary[i * 4 + 2], boundary[i * 4 + 3]);
      if (d < best) best = d;
    }
    return best;
  }

  function polygonContains(i, x, z) {
    if (!solid[i]) return false;
    const s = starts[i] * 2;
    const n = counts[i];
    let pos = false;
    let neg = false;
    for (let k = 0; k < n; k++) {
      const ax = coords[s + k * 2];
      const az = coords[s + k * 2 + 1];
      const bx = coords[s + ((k + 1) % n) * 2];
      const bz = coords[s + ((k + 1) % n) * 2 + 1];
      const c = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      if (c > 0) pos = true;
      else if (c < 0) neg = true;
      if (pos && neg) return false;
    }
    return true;
  }

  function polygonPointDistSq(i, x, z) {
    if (polygonContains(i, x, z)) return 0;
    const s = starts[i] * 2;
    const n = counts[i];
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const d = pointSegmentDistSq(x, z, coords[s + k * 2], coords[s + k * 2 + 1], coords[s + j * 2], coords[s + j * 2 + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  function polygonSegmentDistSq(i, ax, az, bx, bz) {
    if (polygonContains(i, ax, az)) return 0;
    const s = starts[i] * 2;
    const n = counts[i];
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const d = segmentSegmentDistSq(ax, az, bx, bz, coords[s + k * 2], coords[s + k * 2 + 1], coords[s + j * 2], coords[s + j * 2 + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  // Exact distance to the nearest obstacle polygon, saturated at cap.
  function obstacleDistance(x, z, cap) {
    if (obstacles.count === 0) return cap;
    let best = cap * cap;
    const c0 = Math.max(0, Math.floor((x - cap - bucket.minX) / BUCKET));
    const c1 = Math.min(bucket.cols - 1, Math.floor((x + cap - bucket.minX) / BUCKET));
    const r0 = Math.max(0, Math.floor((z - cap - bucket.minZ) / BUCKET));
    const r1 = Math.min(bucket.rows - 1, Math.floor((z + cap - bucket.minZ) / BUCKET));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const b = r * bucket.cols + c;
        for (let q = bucket.offsets[b]; q < bucket.offsets[b + 1]; q++) {
          const i = bucket.items[q];
          const dx = Math.max(boxes[i * 4] - x, 0, x - boxes[i * 4 + 1]);
          const dz = Math.max(boxes[i * 4 + 2] - z, 0, z - boxes[i * 4 + 3]);
          if (dx * dx + dz * dz >= best) continue;
          const d = polygonPointDistSq(i, x, z);
          if (d < best) best = d;
        }
      }
    }
    return Math.sqrt(best);
  }

  // True when any obstacle polygon lies strictly closer than `need` to the segment.
  function obstacleNearSegment(ax, az, bx, bz, need) {
    if (obstacles.count === 0) return false;
    const needSq = need * need;
    const length = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(length / (BUCKET / 2)));
    const ext = need + BUCKET / 2;
    epoch++;
    for (let s = 0; s <= steps; s++) {
      const px = ax + ((bx - ax) * s) / steps;
      const pz = az + ((bz - az) * s) / steps;
      const c0 = Math.max(0, Math.floor((px - ext - bucket.minX) / BUCKET));
      const c1 = Math.min(bucket.cols - 1, Math.floor((px + ext - bucket.minX) / BUCKET));
      const r0 = Math.max(0, Math.floor((pz - ext - bucket.minZ) / BUCKET));
      const r1 = Math.min(bucket.rows - 1, Math.floor((pz + ext - bucket.minZ) / BUCKET));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const b = r * bucket.cols + c;
          if (bucketStamp[b] === epoch) continue;
          bucketStamp[b] = epoch;
          for (let q = bucket.offsets[b]; q < bucket.offsets[b + 1]; q++) {
            const i = bucket.items[q];
            if (polyStamp[i] === epoch) continue;
            polyStamp[i] = epoch;
            if (
              boxes[i * 4 + 1] + need < Math.min(ax, bx) || boxes[i * 4] - need > Math.max(ax, bx)
              || boxes[i * 4 + 3] + need < Math.min(az, bz) || boxes[i * 4 + 2] - need > Math.max(az, bz)
            ) continue;
            if (polygonSegmentDistSq(i, ax, az, bx, bz) < needSq) return true;
          }
        }
      }
    }
    return false;
  }

  // Signed clearance of a point: >0 inside support and that far from every blocker
  // (saturated at cap, except the Robin term which is exact), <0 outside the lawn.
  function clearanceAt(x, z, cap = clearanceCap, withStage = true) {
    const limit = Math.min(cap, clearanceCap);
    if (!insideSupport(x, z)) return -Math.max(Math.sqrt(boundaryDistSq(x, z)), 1e-9);
    const stage = withStage ? Math.hypot(x - ROBIN.x, z - ROBIN.z) - ROBIN.radius : Infinity;
    let value = Math.min(limit, Math.sqrt(boundaryDistSq(x, z)), stage);
    if (value > 0) value = Math.min(value, obstacleDistance(x, z, value));
    return value;
  }

  // Whole segment keeps at least `need` from the lawn edge, Robin and all solids.
  function segmentFree(ax, az, bx, bz, need) {
    if (!insideSupport(ax, az) || !insideSupport(bx, bz)) return false;
    if (boundarySegmentDistSq(ax, az, bx, bz) < need * need) return false;
    const robin = ROBIN.radius + need;
    if (pointSegmentDistSq(ROBIN.x, ROBIN.z, ax, az, bx, bz) < robin * robin) return false;
    return !obstacleNearSegment(ax, az, bx, bz, need);
  }

  return { clearanceAt, segmentFree, insideSupport };
}

// ---------------------------------------------------------------------------------
// Occupancy grid + A*
// ---------------------------------------------------------------------------------

function createGrid(bounds, collision, clearanceCap) {
  const ix0 = Math.floor(bounds.minX / CELL);
  const ix1 = Math.ceil(bounds.maxX / CELL);
  const iz0 = Math.floor(bounds.minZ / CELL);
  const iz1 = Math.ceil(bounds.maxZ / CELL);
  const cols = ix1 - ix0 + 1;
  const rows = iz1 - iz0 + 1;
  const clearance = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) clearance[r * cols + c] = collision.clearanceAt((ix0 + c) * CELL, (iz0 + r) * CELL, clearanceCap);
  }
  return {
    cols, rows, ix0, iz0, clearance,
    centerX: (i) => (ix0 + (i % cols)) * CELL,
    centerZ: (i) => (iz0 + Math.floor(i / cols)) * CELL,
  };
}

function labelComponents(grid, free) {
  const { cols, rows } = grid;
  const label = new Int32Array(cols * rows).fill(-1);
  const sizes = [];
  const stack = [];
  for (let start = 0; start < free.length; start++) {
    if (!free[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      size++;
      const c = i % cols;
      const r = (i - c) / cols;
      if (c > 0 && free[i - 1] && label[i - 1] < 0) { label[i - 1] = id; stack.push(i - 1); }
      if (c < cols - 1 && free[i + 1] && label[i + 1] < 0) { label[i + 1] = id; stack.push(i + 1); }
      if (r > 0 && free[i - cols] && label[i - cols] < 0) { label[i - cols] = id; stack.push(i - cols); }
      if (r < rows - 1 && free[i + cols] && label[i + cols] < 0) { label[i + cols] = id; stack.push(i + cols); }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

class MinHeap {
  constructor() { this.keys = []; this.values = []; }
  get size() { return this.keys.length; }
  less(a, b) { return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.values[a] < this.values[b]); }
  swap(a, b) {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
  }
  push(key, value) {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop() {
    const value = this.values[0];
    const lastKey = this.keys.pop();
    const lastValue = this.values.pop();
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.less(l, m)) m = l;
        if (r < this.keys.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return value;
  }
}

const NEIGHBOURS = Object.freeze([
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
]);

function astar(grid, free, start, goal) {
  const { cols, rows } = grid;
  const total = cols * rows;
  const g = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const gx = goal % cols;
  const gr = (goal - gx) / cols;
  const heuristic = (i) => {
    const dx = Math.abs((i % cols) - gx);
    const dz = Math.abs(Math.floor(i / cols) - gr);
    return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
  };
  const open = new MinHeap();
  g[start] = 0;
  open.push(heuristic(start), start);
  while (open.size) {
    const i = open.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === goal) {
      const path = [];
      for (let n = goal; n >= 0; n = parent[n]) path.push(n);
      return path.reverse();
    }
    const c = i % cols;
    const r = (i - c) / cols;
    for (const [dc, dr, cost] of NEIGHBOURS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const n = nr * cols + nc;
      if (!free[n] || closed[n]) continue;
      // No corner cutting: both orthogonal side cells of a diagonal move must be free.
      if (dc !== 0 && dr !== 0 && (!free[r * cols + nc] || !free[nr * cols + c])) continue;
      const candidate = g[i] + cost;
      if (candidate < g[n]) {
        g[n] = candidate;
        parent[n] = i;
        open.push(candidate + heuristic(n), n);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------------

function pullString(points, need, collision) {
  const out = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1 && !collision.segmentFree(points[i][0], points[i][1], points[j][0], points[j][1], need)) j--;
    out.push(points[j]);
    i = j;
  }
  return out;
}

function planTier(margin, grid, planning, collision) {
  const threshold = planning + HALF_DIAGONAL + margin;
  const free = new Uint8Array(grid.clearance.length);
  let freeCells = 0;
  for (let i = 0; i < free.length; i++) {
    if (grid.clearance[i] >= threshold) { free[i] = 1; freeCells++; }
  }
  const diagnostics = { margin, freeCells, ok: false };
  if (freeCells === 0) return { diagnostics: { ...diagnostics, reason: 'no free cells' } };
  const { label, sizes } = labelComponents(grid, free);
  let main = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
  diagnostics.components = sizes.length;
  diagnostics.mainComponentCells = sizes[main];
  // Snap each requested waypoint to the nearest free cell of the main component.
  const snapped = WAYPOINTS.map(([wx, wz]) => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < label.length; i++) {
      if (label[i] !== main) continue;
      const d = (grid.centerX(i) - wx) ** 2 + (grid.centerZ(i) - wz) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { cell: best, moved: Math.sqrt(bestD) };
  });
  const legs = [];
  for (let k = 0; k < snapped.length; k++) {
    const a = snapped[k].cell;
    const b = snapped[(k + 1) % snapped.length].cell;
    if (a === b) { legs.push([a]); continue; }
    const path = astar(grid, free, a, b);
    if (!path) return { diagnostics: { ...diagnostics, reason: `no A* path for leg ${k}` } };
    legs.push(path);
  }
  // String-pull each leg with the exact swept test at planning radius + comfort margin.
  const need = planning + margin;
  const vertices = [];
  for (const leg of legs) {
    const pts = leg.map((i) => [grid.centerX(i), grid.centerZ(i)]);
    const pulled = pullString(pts, need, collision);
    for (let i = vertices.length ? 1 : 0; i < pulled.length; i++) vertices.push(pulled[i]);
  }
  vertices.pop(); // closing duplicate of the first waypoint
  // Waypoints are visit regions, not mandatory corners: bypass a vertex when its neighbours
  // see each other with the same swept clearance and the chord still passes close by.
  for (let i = 0; i < vertices.length && vertices.length > 3;) {
    const p = vertices[(i + vertices.length - 1) % vertices.length];
    const q = vertices[i];
    const nx = vertices[(i + 1) % vertices.length];
    if (Math.sqrt(pointSegmentDistSq(q[0], q[1], p[0], p[1], nx[0], nx[1])) <= WAYPOINT_BYPASS
      && collision.segmentFree(p[0], p[1], nx[0], nx[1], need)) {
      vertices.splice(i, 1);
      i = Math.max(0, i - 1);
    } else i++;
  }
  // Drop repeated and collinear vertices so every remaining vertex is a real turn.
  let changed = true;
  while (changed && vertices.length > 3) {
    changed = false;
    for (let i = 0; i < vertices.length; i++) {
      const p = vertices[(i + vertices.length - 1) % vertices.length];
      const q = vertices[i];
      const n = vertices[(i + 1) % vertices.length];
      const ax = q[0] - p[0];
      const az = q[1] - p[1];
      const bx = n[0] - q[0];
      const bz = n[1] - q[1];
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la < 1e-9 || lb < 1e-9 || Math.abs(ax * bz - az * bx) / (la * lb) < 1e-6 && ax * bx + az * bz > 0) {
        vertices.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (vertices.length < 3) return { diagnostics: { ...diagnostics, reason: 'degenerate loop' } };
  return {
    diagnostics: { ...diagnostics, ok: true },
    free,
    snapped: snapped.map((s) => ({ x: grid.centerX(s.cell), z: grid.centerZ(s.cell), moved: s.moved })),
    vertices,
  };
}

function loopWinding(vertices) {
  let sum = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const ax = a[0] - ROBIN.x;
    const az = a[1] - ROBIN.z;
    const bx = b[0] - ROBIN.x;
    const bz = b[1] - ROBIN.z;
    sum += Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
  }
  return sum / TWO_PI;
}

// Rounded corners (clearance-validated) or sharp corners with an in-place turn.
function buildPieces(vertices, planning, speed, collision) {
  const n = vertices.length;
  const dirs = [];
  const lens = [];
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lens.push(l);
    dirs.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l]);
  }
  const corners = [];
  for (let i = 0; i < n; i++) {
    const din = dirs[(i + n - 1) % n];
    const dout = dirs[i];
    const P = vertices[i];
    const cos = Math.max(-1, Math.min(1, din[0] * dout[0] + din[1] * dout[1]));
    const theta = Math.acos(cos);
    const maxTangent = 0.5 * Math.min(lens[(i + n - 1) % n], lens[i]);
    let corner = null;
    if (theta < Math.PI - 0.05) { // only a near-reversal is turned in place
      let rho = Math.min(FILLET_MAX, maxTangent / Math.tan(theta / 2));
      for (; rho >= FILLET_MIN; rho *= 0.75) {
        const t = rho * Math.tan(theta / 2);
        const ex = P[0] - din[0] * t;
        const ez = P[1] - din[1] * t;
        const perpX = dout[0] - din[0] * cos;
        const perpZ = dout[1] - din[1] * cos;
        const pl = Math.hypot(perpX, perpZ);
        const cx = ex + (perpX / pl) * rho;
        const cz = ez + (perpZ / pl) * rho;
        const phi0 = Math.atan2(ez - cz, ex - cx);
        const sigma = (-Math.sin(phi0)) * din[0] + Math.cos(phi0) * din[1] > 0 ? 1 : -1;
        const arcLength = rho * theta;
        const samples = Math.ceil(arcLength / CHECK_STEP);
        let clear = true;
        for (let s = 0; s <= samples && clear; s++) {
          const phi = phi0 + (sigma * theta * s) / samples;
          // 1-Lipschitz clearance: half a step of slack covers the gaps between samples.
          clear = collision.clearanceAt(cx + rho * Math.cos(phi), cz + rho * Math.sin(phi), planning + 0.1) >= planning + CHECK_STEP / 2;
        }
        if (!clear) continue;
        const exitX = P[0] + dout[0] * t;
        const exitZ = P[1] + dout[1] * t;
        const endPhi = phi0 + sigma * theta;
        if (Math.hypot(cx + rho * Math.cos(endPhi) - exitX, cz + rho * Math.sin(endPhi) - exitZ) > 1e-6) {
          throw new Error('createSunnyPatrol: internal fillet construction mismatch');
        }
        corner = { kind: 'arc', entry: [ex, ez], exit: [exitX, exitZ], cx, cz, rho, phi0, sigma, theta, tangent: t };
        break;
      }
    }
    if (!corner && theta > 1e-9) corner = { kind: 'turn', entry: [P[0], P[1]], exit: [P[0], P[1]], theta, from: din, to: dout };
    if (!corner) corner = { kind: 'none', entry: [P[0], P[1]], exit: [P[0], P[1]] };
    corners.push(corner);
  }
  const pieces = [];
  const pushLine = (from, to) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length < 1e-9) return;
    const ux = (to[0] - from[0]) / length;
    const uz = (to[1] - from[1]) / length;
    pieces.push({ kind: 'line', length, duration: length / speed, x0: from[0], z0: from[1], ux, uz, yaw: Math.atan2(ux, uz) });
  };
  const pushCorner = (c) => {
    if (c.kind === 'arc') {
      const length = c.rho * c.theta;
      pieces.push({ kind: 'arc', length, duration: length / speed, cx: c.cx, cz: c.cz, rho: c.rho, phi0: c.phi0, sigma: c.sigma, theta: c.theta, x0: c.entry[0], z0: c.entry[1] });
    } else if (c.kind === 'turn') {
      const yaw0 = Math.atan2(c.from[0], c.from[1]);
      const yaw1 = Math.atan2(c.to[0], c.to[1]);
      const dyaw = wrapPi(yaw1 - yaw0);
      pieces.push({ kind: 'turn', length: 0, duration: Math.abs(dyaw) / TURN_RATE, x0: c.entry[0], z0: c.entry[1], yaw0, dyaw });
    }
  };
  for (let i = 0; i < n; i++) {
    pushLine(corners[i].exit, corners[(i + 1) % n].entry);
    pushCorner(corners[(i + 1) % n]);
  }
  let time = 0;
  let distance = 0;
  for (const p of pieces) {
    p.t0 = time;
    p.s0 = distance;
    time += p.duration;
    distance += p.length;
  }
  return { pieces, duration: time, length: distance, corners };
}

function describePiece(p) {
  const out = { kind: p.kind, startTime: p.t0, duration: p.duration, startDistance: p.s0, length: p.length, start: [p.x0, p.z0] };
  if (p.kind === 'arc') Object.assign(out, { radius: p.rho, angle: p.theta, center: [p.cx, p.cz], direction: p.sigma > 0 ? 'cw-from-above' : 'ccw-from-above' });
  if (p.kind === 'turn') out.angle = p.dyaw;
  return out;
}

// ---------------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------------

/**
 * Build the patrol from the loaded Sunny entity (metres, Y-up, bow +Z, no transform).
 * Returns { sample(seconds, out), snapshot(), isClear(x, z) }.
 *  - sample: absolute, deterministic and allocation-free when `out` is supplied. Throws
 *    RangeError for non-finite or negative seconds. Fills out.{x,y,z,yaw,distance,moving};
 *    yaw = atan2(tangentX, tangentZ) for a model whose forward is +Z; distance is the
 *    monotonic distance walked since t=0; moving is false during an in-place corner turn.
 *  - isClear: accessible-lawn test. True only if the full circular footprint of `radius` at
 *    (x,z) lies on the lawn, touches no ship surface in the (floor, height) slab nor
 *    Robin's exclusion disc, AND a straight radius-clear segment (<= ACCESS_SEARCH) joins it
 *    to the walkable component the route lives in. Points enclosed by solids (cabin interior),
 *    disconnected pockets, and points beyond that reach are conservatively rejected.
 *  - snapshot: copy-safe diagnostics of the extracted geometry, grid and realized route.
 */
export function createSunnyPatrol(ship, { radius = 0.65, height = 2, speed = 0.7 } = {}) {
  assertPositive('radius', radius);
  assertPositive('height', height, FLOOR);
  assertPositive('speed', speed);
  const planning = radius + SAFETY;
  const clearanceCap = planning + HALF_DIAGONAL + MARGIN_TIERS[0] + 0.3;

  const meshes = collectMeshes(ship);
  const support = extractSupport(meshes);
  const obstacles = extractObstacles(meshes, support.bounds, height, clearanceCap + 0.2);
  const collision = createCollision(support, obstacles, clearanceCap);
  const grid = createGrid(support.bounds, collision, clearanceCap);

  // Plan every comfort tier; keep the roundest (fewest sharp corners, widest margin).
  const tierReports = [];
  let chosen = null;
  for (const margin of MARGIN_TIERS) {
    const plan = planTier(margin, grid, planning, collision);
    const report = { ...plan.diagnostics };
    tierReports.push(report);
    if (!plan.diagnostics.ok) continue;
    const winding = loopWinding(plan.vertices);
    report.windingTurns = winding;
    if (Math.abs(winding) < 0.5) { report.ok = false; report.reason = 'loop does not enclose Robin'; continue; }
    const built = buildPieces(plan.vertices, planning, speed, collision);
    report.sharpCorners = built.corners.filter((c) => c.kind === 'turn').length;
    report.length = built.length;
    report.duration = built.duration;
    if (!chosen || report.sharpCorners < chosen.report.sharpCorners) chosen = { plan, built, report, margin, winding };
    if (report.sharpCorners === 0) break;
  }
  if (!chosen) {
    throw new Error(`createSunnyPatrol: no collision-free patrol loop exists; tiers=${JSON.stringify(tierReports)}`);
  }
  chosen.report.chosen = true;
  const { pieces, duration, length, corners } = chosen.built;
  if (!(duration > 0) || !(length > 0)) throw new Error('createSunnyPatrol: realized route is empty');
  const starts = Float64Array.from(pieces, (p) => p.t0);

  function sampleInto(seconds, out) {
    const loops = Math.floor(seconds / duration);
    let tau = seconds - loops * duration;
    if (tau >= duration) tau = 0;
    if (tau < 0) tau = 0;
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= tau) lo = mid;
      else hi = mid - 1;
    }
    const p = pieces[lo];
    const u = tau - p.t0;
    let progress = p.duration > 0 ? Math.min(1, Math.max(0, u / p.duration)) : 0;
    out.y = 0;
    out.moving = true;
    out.turning = false;
    if (p.kind === 'line') {
      const s = progress * p.length;
      out.x = p.x0 + p.ux * s;
      out.z = p.z0 + p.uz * s;
      out.yaw = p.yaw;
      out.distance = loops * length + p.s0 + s;
    } else if (p.kind === 'arc') {
      const s = progress * p.length;
      const phi = p.phi0 + (p.sigma * s) / p.rho;
      const sin = Math.sin(phi);
      const cos = Math.cos(phi);
      out.x = p.cx + p.rho * cos;
      out.z = p.cz + p.rho * sin;
      out.yaw = Math.atan2(-p.sigma * sin, p.sigma * cos);
      out.distance = loops * length + p.s0 + s;
    } else {
      out.x = p.x0;
      out.z = p.z0;
      out.yaw = wrapPi(p.yaw0 + p.dyaw * progress);
      out.distance = loops * length + p.s0;
      out.moving = false;
      out.turning = true;
    }
    return out;
  }

  // Accessible-lawn semantics for isClear. Distance to *surfaces* cannot tell that a point
  // lies inside a closed or hollow solid (e.g. the cabin interior overlapping the lawn
  // ellipse), so a clear point must additionally be joined by a straight, radius-clear
  // swept segment to a free node of the walkable component that contains the route. Free
  // nodes use the widest planning inflation (radius + safety + cell half-diagonal); the
  // component is fixed by the route's own first vertex, never by a nearest-label guess.
  const accessFree = new Uint8Array(grid.clearance.length);
  let accessFreeCells = 0;
  for (let i = 0; i < accessFree.length; i++) {
    if (grid.clearance[i] >= planning + HALF_DIAGONAL) { accessFree[i] = 1; accessFreeCells++; }
  }
  const access = labelComponents(grid, accessFree);
  const routeStart = chosen.plan.vertices[0];
  const routeCell = (Math.round(routeStart[1] / CELL) - grid.iz0) * grid.cols + (Math.round(routeStart[0] / CELL) - grid.ix0);
  if (!accessFree[routeCell]) throw new Error('createSunnyPatrol: route start is not a free accessibility node');
  const accessLabel = access.label[routeCell];
  const accessReach = Math.ceil(ACCESS_SEARCH / CELL) + 1;
  const accessOffsets = [];
  for (let dr = -accessReach; dr <= accessReach; dr++) {
    for (let dc = -accessReach; dc <= accessReach; dc++) accessOffsets.push([dc, dr, Math.hypot(dc, dr) * CELL]);
  }
  accessOffsets.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  const accessDc = Int16Array.from(accessOffsets, (o) => o[0]);
  const accessDr = Int16Array.from(accessOffsets, (o) => o[1]);

  function accessibleClear(x, z) {
    if (collision.clearanceAt(x, z, radius + 0.01) < radius) return false;
    const bc = Math.round(x / CELL) - grid.ix0;
    const br = Math.round(z / CELL) - grid.iz0;
    for (let k = 0; k < accessDc.length; k++) {
      const c = bc + accessDc[k];
      const r = br + accessDr[k];
      if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) continue;
      const i = r * grid.cols + c;
      if (access.label[i] !== accessLabel) continue;
      const nx = (grid.ix0 + c) * CELL;
      const nz = (grid.iz0 + r) * CELL;
      if (Math.hypot(nx - x, nz - z) > ACCESS_SEARCH) continue;
      if (collision.segmentFree(x, z, nx, nz, radius)) return true;
    }
    return false;
  }

  // Verify the realized loop through the public sampler, including the wrap seam.
  const verify = { samples: 0, minClearance: Infinity, maxStep: 0, maxYawStep: 0, seamGap: 0, inaccessible: 0 };
  {
    const a = {};
    const b = {};
    const dt = CHECK_STEP / speed;
    const steps = Math.ceil(duration / dt);
    sampleInto(0, a);
    for (let s = 0; s <= steps + 1; s++) {
      sampleInto(Math.min(s * dt, duration), b);
      const c = collision.clearanceAt(b.x, b.z, planning + 0.5);
      verify.minClearance = Math.min(verify.minClearance, c);
      if (!accessibleClear(b.x, b.z)) verify.inaccessible++;
      if (s > 0) {
        verify.maxStep = Math.max(verify.maxStep, Math.hypot(b.x - a.x, b.z - a.z));
        verify.maxYawStep = Math.max(verify.maxYawStep, Math.abs(wrapPi(b.yaw - a.yaw)));
      }
      verify.samples++;
      a.x = b.x; a.z = b.z; a.yaw = b.yaw;
    }
    const first = sampleInto(0, {});
    const last = sampleInto(duration - 1e-9, {});
    verify.seamGap = Math.hypot(first.x - last.x, first.z - last.z);
    verify.seamYawGap = Math.abs(wrapPi(first.yaw - last.yaw));
  }
  // 1-Lipschitz clearance sampled every CHECK_STEP: true minimum >= sampled - step/2.
  const clearanceLowerBound = verify.minClearance - CHECK_STEP / 2;
  if (clearanceLowerBound < radius) {
    throw new Error(`createSunnyPatrol: realized route clearance ${clearanceLowerBound.toFixed(4)} m is below radius ${radius} m`);
  }
  if (verify.inaccessible > 0) {
    throw new Error(`createSunnyPatrol: ${verify.inaccessible} realized route samples failed the accessible-lawn isClear test`);
  }
  if (verify.maxStep > CHECK_STEP * 1.001 + 1e-9 || verify.seamGap > 1e-6) {
    throw new Error(`createSunnyPatrol: realized route is discontinuous (step ${verify.maxStep}, seam ${verify.seamGap})`);
  }

  const turnDwell = pieces.filter((p) => p.kind === 'turn').reduce((sum, p) => sum + p.duration, 0);
  const routeVertices = chosen.plan.vertices.map(([x, z]) => [x, z]);
  const controlPoints = [];
  for (const p of pieces) controlPoints.push([p.x0, p.z0]);
  const snapshotData = {
    radius, height, speed,
    length,
    duration,
    safety: SAFETY,
    planningRadius: planning,
    floorTolerance: FLOOR,
    robinExclusion: { x: ROBIN.x, z: ROBIN.z, radius: ROBIN.radius },
    support: {
      y: 0,
      triangles: support.triangleCount,
      boundaryEdges: support.boundary.length / 4,
      bounds: { ...support.bounds },
    },
    obstacles: {
      meshesScanned: meshes.length,
      trianglesScanned: obstacles.scanned,
      trianglesNearLawnInSlab: obstacles.inSlab,
      polygons: obstacles.count,
      bucket: BUCKET,
      sources: obstacles.sources.map((s) => ({ ...s })),
    },
    grid: {
      cell: CELL,
      halfDiagonal: HALF_DIAGONAL,
      cols: grid.cols,
      rows: grid.rows,
      origin: [grid.ix0 * CELL, grid.iz0 * CELL],
      cells: grid.clearance.length,
      chosenMargin: chosen.margin,
      freeCells: chosen.report.freeCells,
      components: chosen.report.components,
      mainComponentCells: chosen.report.mainComponentCells,
      access: {
        margin: 0,
        searchRadius: ACCESS_SEARCH,
        freeCells: accessFreeCells,
        components: access.sizes.length,
        routeComponentCells: access.sizes[accessLabel],
        sourceCell: [grid.ix0 * CELL + (routeCell % grid.cols) * CELL, grid.iz0 * CELL + Math.floor(routeCell / grid.cols) * CELL],
      },
      tiers: tierReports.map((t) => ({ ...t })),
    },
    waypoints: {
      requested: WAYPOINTS.map(([x, z]) => [x, z]),
      realized: chosen.plan.snapped.map((s) => [s.x, s.z]),
      moved: chosen.plan.snapped.map((s) => s.moved),
    },
    route: {
      vertices: routeVertices,
      controlPoints,
      pieces: pieces.map(describePiece),
      length,
      duration,
      speed,
      turnDwellSeconds: turnDwell,
      filletCount: corners.filter((c) => c.kind === 'arc').length,
      sharpCornerCount: corners.filter((c) => c.kind === 'turn').length,
      windingTurnsAroundRobin: chosen.winding,
      verification: {
        checkStep: CHECK_STEP,
        samples: verify.samples,
        sampledMinClearance: verify.minClearance,
        minClearanceLowerBound: clearanceLowerBound,
        requiredClearance: radius,
        maxPositionStep: verify.maxStep,
        maxYawStep: verify.maxYawStep,
        seamPositionGap: verify.seamGap,
        seamYawGap: verify.seamYawGap,
      },
    },
  };

  return {
    sample(seconds, out) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError(`sample: seconds must be a finite number >= 0; got ${seconds}`);
      }
      if (out === undefined) out = {};
      else if (out === null || typeof out !== 'object') throw new TypeError('sample: out must be a plain object');
      return sampleInto(seconds, out);
    },
    snapshot() {
      return structuredClone(snapshotData);
    },
    isClear(x, z) {
      if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return false;
      return accessibleClear(x, z);
    },
    // Distance to the lawn edge or any solid (saturates near 1.7 m; negative off the lawn).
    // Ignores the reserved skill-stage disc, so cameras may sit on the stage itself.
    surfaceClearance(x, z) {
      if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return -Infinity;
      return collision.clearanceAt(x, z, clearanceCap, false);
    },
  };
}
