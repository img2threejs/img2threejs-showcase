// Geometry primitives and walkable-surface model for navigation schemaVersion 2.
// Coordinates are glTF Y-up metres; polygons are [x, z]. A surface is an inset XZ
// polygon carrying the plane y = a*x + b*z + c and the ceiling above it. Height and
// clearance are both affine in (x, z), so along any straight segment each is affine
// in the segment parameter: checking breakpoints and one interior sample is exact.
export const EPS = 1e-9;
// Tolerance on the clearance inequality so that sliding along a clearance contour
// (and floating-point noise on flat floors) never flips validity.
export const CLEAR_EPS = 1e-7;

export const finite = value => typeof value === 'number' && Number.isFinite(value);

export function validatePolygon(polygon, label) {
  if (!Array.isArray(polygon) || polygon.length < 3) throw new Error(`${label}: polygon needs at least 3 points`);
  for (const point of polygon) {
    if (!Array.isArray(point) || point.length !== 2 || !finite(point[0]) || !finite(point[1])) {
      throw new Error(`${label}: polygon point must be two finite numbers`);
    }
  }
}

export function polygonEdges(polygon) {
  const edges = [];
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i];
    const [bx, bz] = polygon[(i+1)%polygon.length];
    if (ax === bx && az === bz) continue;
    edges.push({ ax, az, bx, bz });
  }
  return edges;
}

export function distanceToEdge(x, z, e) {
  const ex = e.bx-e.ax, ez = e.bz-e.az;
  const u = Math.max(0, Math.min(1, ((x-e.ax)*ex+(z-e.az)*ez)/(ex*ex+ez*ez)));
  return Math.hypot(x-(e.ax+u*ex), z-(e.az+u*ez));
}

export function onBoundary(x, z, edges) {
  for (const e of edges) if (distanceToEdge(x, z, e) <= EPS) return true;
  return false;
}

export function insideRing(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length-1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < (xj-xi)*(z-zi)/(zj-zi)+xi) inside = !inside;
  }
  return inside;
}

function signedArea(polygon) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i], [bx, bz] = polygon[(i+1)%polygon.length];
    sum += ax*bz-bx*az;
  }
  return sum/2;
}

function orient(ax, az, bx, bz, cx, cz) {
  return (bx-ax)*(cz-az)-(bz-az)*(cx-ax);
}

function onSegment(ax, az, bx, bz, px, pz) {
  return Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(az, bz) <= pz && pz <= Math.max(az, bz);
}

function segmentsTouch(p, q, r, s) {
  const o1 = orient(...p, ...q, ...r), o2 = orient(...p, ...q, ...s);
  const o3 = orient(...r, ...s, ...p), o4 = orient(...r, ...s, ...q);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (o1 === 0 && onSegment(...p, ...q, ...r)) return true;
  if (o2 === 0 && onSegment(...p, ...q, ...s)) return true;
  if (o3 === 0 && onSegment(...r, ...s, ...p)) return true;
  if (o4 === 0 && onSegment(...r, ...s, ...q)) return true;
  return false;
}

// Non-degenerate, no repeated consecutive vertices, no edge touching a non-adjacent edge.
function validateSimple(polygon, label) {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i], b = polygon[(i+1)%n];
    if (a[0] === b[0] && a[1] === b[1]) throw new Error(`${label}: polygon has a repeated vertex`);
  }
  if (Math.abs(signedArea(polygon)) <= 1e-9) throw new Error(`${label}: polygon is degenerate (zero area)`);
  for (let i = 0; i < n; i++) {
    for (let j = i+1; j < n; j++) {
      if (j === i+1 || (i === 0 && j === n-1)) {
        // Adjacent edges may share only their common vertex: reject a fold-back.
        const shared = j === i+1 ? polygon[j] : polygon[0];
        const p = polygon[i], q = polygon[(i+1)%n], r = polygon[j], s = polygon[(j+1)%n];
        const other = j === i+1 ? [p, s] : [q, r];
        if (orient(...other[0], ...shared, ...other[1]) === 0
          && ((other[0][0]-shared[0])*(other[1][0]-shared[0])+(other[0][1]-shared[1])*(other[1][1]-shared[1])) > 0) {
          throw new Error(`${label}: polygon folds back on itself`);
        }
        continue;
      }
      if (segmentsTouch(polygon[i], polygon[(i+1)%n], polygon[j], polygon[(j+1)%n])) {
        throw new Error(`${label}: polygon is not simple (edges ${i} and ${j} touch)`);
      }
    }
  }
}

// Validates and returns the walk policy shared by every room.
export function compilePolicy(navigation) {
  const { eyeHeight, capsuleHeight, maxStepHeight, maxSlopeDegrees } = navigation;
  if (!finite(capsuleHeight) || capsuleHeight <= 0) throw new Error('navigation.capsuleHeight must be a positive finite number');
  if (capsuleHeight < eyeHeight) throw new Error('navigation.capsuleHeight must not be below eyeHeight');
  if (!finite(maxStepHeight) || maxStepHeight < 0) throw new Error('navigation.maxStepHeight must be a non-negative finite number');
  if (!finite(maxSlopeDegrees) || maxSlopeDegrees <= 0 || maxSlopeDegrees >= 90) {
    throw new Error('navigation.maxSlopeDegrees must be finite in (0, 90)');
  }
  return { capsuleHeight, maxStepHeight, maxSlopeDegrees };
}

export function compileSurface(source, roomId, policy) {
  const id = source?.id;
  const label = `room ${roomId} surface ${id}`;
  if (typeof id !== 'string' || !id) throw new Error(`room ${roomId}: surface id must be a non-empty string`);
  validatePolygon(source.polygon, label);
  validateSimple(source.polygon, label);
  const plane = source.plane;
  if (!Array.isArray(plane) || plane.length !== 3 || !plane.every(finite)) {
    throw new Error(`${label}: plane must be three finite numbers [a, b, c]`);
  }
  const hasY = source.ceilingY !== undefined, hasPlane = source.ceilingPlane !== undefined;
  if (hasY === hasPlane) throw new Error(`${label}: exactly one of ceilingY or ceilingPlane is required`);
  let ceiling;
  if (hasY) {
    if (!finite(source.ceilingY)) throw new Error(`${label}: ceilingY must be finite`);
    ceiling = [0, 0, source.ceilingY];
  } else {
    ceiling = source.ceilingPlane;
    if (!Array.isArray(ceiling) || ceiling.length !== 3 || !ceiling.every(finite)) {
      throw new Error(`${label}: ceilingPlane must be three finite numbers [a, b, c]`);
    }
  }
  const [a, b, c] = plane;
  const slope = Math.atan(Math.hypot(a, b))*180/Math.PI;
  if (slope > policy.maxSlopeDegrees+1e-9) {
    throw new Error(`${label}: slope ${slope.toFixed(2)} degrees exceeds maxSlopeDegrees ${policy.maxSlopeDegrees}`);
  }
  // Clearance k(x, z) = ceiling - floor - capsuleHeight is affine; usable iff k >= -CLEAR_EPS.
  const ka = ceiling[0]-a, kb = ceiling[1]-b, kc = ceiling[2]-c-policy.capsuleHeight;
  // Affine, so the best clearance over the polygon is at a vertex.
  const best = Math.max(...source.polygon.map(([x, z]) => ka*x+kb*z+kc));
  if (best < -CLEAR_EPS) throw new Error(`${label}: no point has capsule clearance under its ceiling`);
  return { id, polygon: source.polygon, edges: polygonEdges(source.polygon), a, b, c, ceiling, ka, kb, kc };
}

export const surfaceHeight = (s, x, z) => s.a*x+s.b*z+s.c;
export const surfaceCeiling = (s, x, z) => s.ceiling[0]*x+s.ceiling[1]*z+s.ceiling[2];
// Metres of headroom left above the capsule top (negative: does not fit).
export const surfaceClearance = (s, x, z) => s.ka*x+s.kb*z+s.kc;

export function surfaceCovers(s, x, z) {
  return onBoundary(x, z, s.edges) || insideRing(x, z, s.polygon);
}

// Inside the surface polygon with the capsule fitting under the ceiling.
export function surfaceUsable(s, x, z) {
  return surfaceClearance(s, x, z) >= -CLEAR_EPS && surfaceCovers(s, x, z);
}
