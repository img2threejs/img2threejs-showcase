// Pure walk navigation over navigation.json (schemaVersion 2). Coordinates are
// glTF Y-up metres; polygons are [x, z]. The exporter already insets walkable
// polygons and dilates holes by the capsule radius, so the eye is a point in XZ:
// valid iff inside the union of the room's walkable polygons (boundary inclusive),
// not strictly inside any hole, and standing on a surface: a surface polygon that
// covers the point with capsule clearance under its ceiling. The walker keeps a
// current surface; its height is the plane at (x, z), so eye height is continuous
// except for explicit step hops (<= maxStepHeight) between overlapping surfaces
// and across portals. Surface choice never jumps between overlapping heights:
// candidates farther than maxStepHeight from the current height are not eligible.
import {
  EPS, finite, validatePolygon, polygonEdges, distanceToEdge, onBoundary, insideRing,
  compilePolicy, compileSurface, surfaceHeight, surfaceCeiling, surfaceClearance, surfaceUsable,
} from './interior-walk-surfaces.js';

const PROBE = 1e-6;
const MAX_SLIDES = 4;
const MAX_STEPS = 16;
const CONTOUR_EPS = 1e-6;

function compileRoom(room, policy, { orbitOnly }) {
  const id = room.id;
  if (typeof id !== 'string' || !id) throw new Error('navigation room id must be a non-empty string');
  if (!finite(room.floorY)) throw new Error(`room ${id}: floorY must be finite`);
  if (!Array.isArray(room.walkable) || (!orbitOnly && !room.walkable.length)) {
    throw new Error(`room ${id}: walkable must be a non-empty polygon list`);
  }
  if (!Array.isArray(room.holes)) throw new Error(`room ${id}: holes must be a polygon list`);
  if (!Array.isArray(room.surfaces) || (!orbitOnly && !room.surfaces.length)) {
    throw new Error(`room ${id}: surfaces must be a non-empty list`);
  }
  if (orbitOnly && !room.walkable.length !== !room.surfaces.length) {
    throw new Error(`room ${id}: walkable and surfaces must both be empty or both be non-empty`);
  }
  const walkable = room.walkable.map((polygon, i) => {
    validatePolygon(polygon, `room ${id} walkable[${i}]`);
    return { polygon, edges: polygonEdges(polygon) };
  });
  const holes = room.holes.map((polygon, i) => {
    validatePolygon(polygon, `room ${id} holes[${i}]`);
    return { polygon, edges: polygonEdges(polygon) };
  });
  const surfaces = [];
  const surfaceById = new Map();
  for (const source of room.surfaces) {
    const surface = compileSurface(source, id, policy);
    if (surfaceById.has(surface.id)) throw new Error(`room ${id}: duplicate surface id ${surface.id}`);
    surfaceById.set(surface.id, surface);
    surfaces.push(surface);
  }
  const edges = [];
  for (const ring of walkable) edges.push(...ring.edges);
  for (const ring of holes) edges.push(...ring.edges);
  for (const surface of surfaces) edges.push(...surface.edges);
  return { id, floorY: room.floorY, walkable, holes, surfaces, surfaceById, edges, portals: [], maxStep: policy.maxStepHeight };
}

// XZ validity only: walkable union minus hole interiors.
function pointValid(room, x, z) {
  let inside = false;
  for (const ring of room.walkable) {
    if (onBoundary(x, z, ring.edges) || insideRing(x, z, ring.polygon)) { inside = true; break; }
  }
  if (!inside) return false;
  for (const hole of room.holes) {
    if (insideRing(x, z, hole.polygon) && !onBoundary(x, z, hole.edges)) return false;
  }
  return true;
}

// The surface standing at (x, z). `pref` wins when eligible; with a reference height
// only surfaces within maxStep of it qualify (nearest wins), without one the lowest.
function resolveSurface(room, x, z, pref = null, refY = null) {
  if (!pointValid(room, x, z)) return null;
  let best = null, bestScore = Infinity;
  for (const s of room.surfaces) {
    if (!surfaceUsable(s, x, z)) continue;
    const h = surfaceHeight(s, x, z);
    if (refY !== null && Math.abs(h-refY) > room.maxStep+EPS) continue;
    if (s === pref) return s;
    const score = refY === null ? h : Math.abs(h-refY);
    if (score < bestScore) { best = s; bestScore = score; }
  }
  return best;
}

// Parameters t in [0,1] where segment p + t*d meets any edge or leaves a surface's
// clearance, plus 0 and 1.
function breakpoints(room, px, pz, dx, dz) {
  const ts = [0, 1];
  const dl = Math.hypot(dx, dz);
  for (const e of room.edges) {
    const ex = e.bx-e.ax, ez = e.bz-e.az;
    const denom = dx*ez-dz*ex;
    if (Math.abs(denom) <= 1e-12*dl*Math.hypot(ex, ez)) {
      if (Math.abs((e.ax-px)*dz-(e.az-pz)*dx)/dl <= EPS) {
        for (const [x, z] of [[e.ax, e.az], [e.bx, e.bz]]) {
          const t = ((x-px)*dx+(z-pz)*dz)/(dl*dl);
          if (t > 0 && t < 1) ts.push(t);
        }
      }
      continue;
    }
    const t = ((e.ax-px)*ez-(e.az-pz)*ex)/denom;
    const u = ((e.ax-px)*dz-(e.az-pz)*dx)/denom;
    if (t >= 0 && t <= 1 && u >= -EPS && u <= 1+EPS) ts.push(t);
  }
  for (const s of room.surfaces) {
    const g = s.ka*dx+s.kb*dz;
    if (g === 0) continue;
    const t = -surfaceClearance(s, px, pz)/g;
    if (t > 0 && t < 1) ts.push(t);
  }
  return ts.sort((a, b) => a-b);
}

// Surface carrying the walker over one interval, or null. Staying put is preferred;
// otherwise hop to another surface whose height at the interval start is within maxStep.
function intervalSurface(room, cur, px, pz, dx, dz, t0, tm, last) {
  const mx = px+dx*tm, mz = pz+dz*tm, ex = px+dx, ez = pz+dz;
  if (!pointValid(room, mx, mz) || (last && !pointValid(room, ex, ez))) return null;
  const carries = s => surfaceUsable(s, mx, mz) && (!last || surfaceUsable(s, ex, ez));
  if (carries(cur)) return cur;
  const x0 = px+dx*t0, z0 = pz+dz*t0;
  const y0 = surfaceHeight(cur, x0, z0);
  let best = null, bestGap = Infinity;
  for (const s of room.surfaces) {
    if (s === cur || !carries(s)) continue;
    const gap = Math.abs(surfaceHeight(s, x0, z0)-y0);
    if (gap <= room.maxStep+EPS && gap < bestGap) { best = s; bestGap = gap; }
  }
  return best;
}

// Returns { t, tangent, surface, path } where t=1 means the whole segment is valid.
// path lists the surface carrying the walker from each t0 on.
function sweep(room, px, pz, dx, dz, start) {
  const ts = breakpoints(room, px, pz, dx, dz);
  const path = [{ t0: 0, surface: start }];
  let cur = start;
  for (let i = 0; i+1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i+1];
    if (t1-t0 < 1e-12) continue;
    const next = intervalSurface(room, cur, px, pz, dx, dz, t0, (t0+t1)/2, i+2 === ts.length);
    if (next) {
      if (next !== cur) path.push({ t0, surface: next });
      cur = next;
      continue;
    }
    const hx = px+dx*t0, hz = pz+dz*t0;
    if (!pointValid(room, hx, hz) || !surfaceUsable(cur, hx, hz)) return { t: 0, tangent: null, surface: start, path: [path[0]] };
    return { t: t0, tangent: blockingTangent(room, cur, hx, hz, dx, dz), surface: cur, path };
  }
  return { t: 1, tangent: null, surface: cur, path };
}

function pathSurface(path, t) {
  for (let i = path.length-1; i > 0; i--) if (path[i].t0 <= t) return path[i].surface;
  return path[0].surface;
}

function blockingTangent(room, cur, hx, hz, dx, dz) {
  const dl = Math.hypot(dx, dz);
  const refY = surfaceHeight(cur, hx, hz);
  for (const e of room.edges) {
    if (distanceToEdge(hx, hz, e) > 1e-7) continue;
    const ex = e.bx-e.ax, ez = e.bz-e.az;
    const el = Math.hypot(ex, ez);
    const tx = ex/el, tz = ez/el;
    if (Math.abs(dx*tz-dz*tx)/dl < 1e-9) continue;
    const nx = -tz, nz = tx;
    const s = Math.sign(dx*nx+dz*nz);
    if (!resolveSurface(room, hx+s*nx*PROBE, hz+s*nz*PROBE, cur, refY)) return [tx, tz];
  }
  // Headroom contour: clearance shrinks along the push; slide along the contour.
  const gradient = Math.hypot(cur.ka, cur.kb);
  if (cur.ka*dx+cur.kb*dz < 0 && gradient > 0 && Math.abs(surfaceClearance(cur, hx, hz)) <= CONTOUR_EPS) {
    return [-cur.kb/gradient, cur.ka/gradient];
  }
  return null;
}

// Earliest strict crossing of a portal segment by p + t*d, t in (0,1].
function portalCrossing(room, px, pz, dx, dz) {
  let best = null;
  for (const portal of room.portals) {
    const [[ax, az], [bx, bz]] = portal.segment;
    const ex = bx-ax, ez = bz-az;
    const el = Math.hypot(ex, ez);
    const sp = ((px-ax)*ez-(pz-az)*ex)/el;
    const sq = ((px+dx-ax)*ez-(pz+dz-az)*ex)/el;
    // A room's own side of the doorway is where its walkable extent lies; points
    // on the line count as home, so standing in the doorway still crosses.
    if (!(portal.home*sp >= -EPS && portal.home*sq < -EPS)) continue;
    const t = Math.abs(sp) <= EPS ? 0 : sp/(sp-sq);
    const hx = px+dx*t, hz = pz+dz*t;
    const u = ((hx-ax)*ex+(hz-az)*ez)/(el*el);
    if (u < 0 || u > 1) continue;
    if (!best || t < best.t) best = { t, portal, tangent: [ex/el, ez/el] };
  }
  return best;
}

// +1/-1: the side of the portal line holding the room's farthest walkable vertex.
function homeSide(room, segment, label) {
  const [[ax, az], [bx, bz]] = segment;
  const ex = bx-ax, ez = bz-az, el = Math.hypot(ex, ez);
  let best = 0;
  for (const ring of room.walkable) {
    for (const [x, z] of ring.polygon) {
      const side = ((x-ax)*ez-(z-az)*ex)/el;
      if (Math.abs(side) > Math.abs(best)) best = side;
    }
  }
  if (!best) throw new Error(`${label}: room ${room.id} has no walkable extent off the portal line`);
  return Math.sign(best);
}

// Validates and compiles a nav2 document without needing a start room/position.
// Returns { navigation, rooms: Map, policy }; throws on any structural, numeric,
// slope, headroom or portal error. `orbitOnly` tolerates rooms with neither
// walkable area nor surfaces (orbit-only scenes) but keeps every other constraint.
export function validateWalkNavigation(navigation, { orbitOnly = false } = {}) {
  if (!navigation || navigation.schemaVersion !== 2) throw new Error('navigation.schemaVersion must be 2');
  if (!finite(navigation.eyeHeight) || navigation.eyeHeight <= 0) throw new Error('navigation.eyeHeight must be a positive finite number');
  if (!finite(navigation.capsuleRadius) || navigation.capsuleRadius <= 0) throw new Error('navigation.capsuleRadius must be a positive finite number');
  if (typeof navigation.limit !== 'string' || !navigation.limit) throw new Error('navigation.limit must be a non-empty string');
  if (!Array.isArray(navigation.rooms) || !navigation.rooms.length) throw new Error('navigation.rooms must be a non-empty list');
  const policy = compilePolicy(navigation);
  const rooms = new Map();
  for (const source of navigation.rooms) {
    const compiled = compileRoom(source ?? {}, policy, { orbitOnly });
    if (rooms.has(compiled.id)) throw new Error(`duplicate navigation room id ${compiled.id}`);
    rooms.set(compiled.id, compiled);
  }
  for (const [index, portal] of (navigation.portals ?? []).entries()) {
    const label = `portal[${index}] ${portal?.a}->${portal?.b}`;
    if (!rooms.has(portal?.a)) throw new Error(`${label}: unknown room ${portal?.a}`);
    if (!rooms.has(portal.b)) throw new Error(`${label}: unknown room ${portal.b}`);
    if (portal.a === portal.b) throw new Error(`${label}: portal joins room ${portal.a} to itself`);
    const seg = portal.segment;
    if (!Array.isArray(seg) || seg.length !== 2 || !seg.every(p => Array.isArray(p) && p.length === 2 && p.every(finite))) {
      throw new Error(`${label}: segment must be two finite [x,z] points`);
    }
    if (seg[0][0] === seg[1][0] && seg[0][1] === seg[1][1]) throw new Error(`${label}: segment has zero length`);
    const a = rooms.get(portal.a), b = rooms.get(portal.b);
    if (orbitOnly && (!a.walkable.length || !b.walkable.length)) continue;
    a.portals.push({ other: portal.b, segment: seg, home: homeSide(a, seg, label) });
    b.portals.push({ other: portal.a, segment: seg, home: homeSide(b, seg, label) });
  }
  return { navigation, rooms, policy };
}

// Pure surface lookup for other modules: the surface standing at (x, z) in a room of a
// compiled navigation (from validateWalkNavigation), nearest to `y` (ground height,
// metres) within maxStepHeight when given, else the lowest. Returns
// { surface, y, ceilingY } or null. Never throws for unwalkable points.
export function walkSurfaceAt(compiled, roomId, x, z, y = null) {
  const room = compiled.rooms.get(roomId);
  if (!room || !finite(x) || !finite(z) || (y !== null && !finite(y))) return null;
  const s = resolveSurface(room, x, z, null, y);
  return s ? { surface: s.id, y: surfaceHeight(s, x, z), ceilingY: surfaceCeiling(s, x, z) } : null;
}

export function createWalkNavigation({ navigation, room, position, yaw = 0, surface = null, y = null } = {}) {
  const compiled = validateWalkNavigation(navigation);
  const { rooms } = compiled;
  if (!rooms.has(room)) throw new Error(`unknown navigation room ${room}`);
  if (!Array.isArray(position) || position.length !== 2 || !position.every(finite)) {
    throw new Error(`room ${room}: start position must be [x, z] finite numbers`);
  }
  if (!finite(yaw)) throw new Error('yaw must be finite');

  // Surface for a placement: explicit id, else nearest to a ground-height hint, else lowest.
  function place(roomId, x, z, surfaceId, hint) {
    const target = rooms.get(roomId);
    if (hint !== null && !finite(hint)) throw new Error(`room ${roomId}: y hint must be finite`);
    let found;
    if (surfaceId !== null) {
      const s = target.surfaceById.get(surfaceId);
      if (!s) throw new Error(`room ${roomId}: unknown surface ${surfaceId}`);
      found = pointValid(target, x, z) && surfaceUsable(s, x, z) ? s : null;
    } else {
      found = resolveSurface(target, x, z, null, hint);
    }
    if (!found) throw new Error(`room ${roomId}: point [${x}, ${z}] is not walkable`);
    return found;
  }

  const start = place(room, position[0], position[1], surface, y);
  const state = { room, x: position[0], z: position[1], surface: start.id, yaw, blockedLast: false };

  function move(dx, dz) {
    if (!finite(dx) || !finite(dz)) throw new Error('move displacement must be finite');
    const startRoom = state.room, startX = state.x, startZ = state.z, startSurface = state.surface;
    let current = rooms.get(state.room);
    let surf = current.surfaceById.get(state.surface);
    let x = state.x, z = state.z, rx = dx, rz = dz;
    let blocked = false, crossed = false, slides = 0;
    for (let step = 0; step < MAX_STEPS && (rx !== 0 || rz !== 0); step++) {
      const reach = sweep(current, x, z, rx, rz, surf);
      const portal = portalCrossing(current, x, z, rx, rz);
      let t = reach.t, tangent = reach.tangent, tSurf = reach.surface;
      // Rooms may meet exactly at the doorway line: tolerate rounding between the
      // sweep's edge parameter and the portal's own crossing parameter.
      if (portal && portal.t <= reach.t+1e-9) {
        const target = rooms.get(portal.portal.other);
        const hx = x+rx*portal.t, hz = z+rz*portal.t;
        const from = pathSurface(reach.path, portal.t);
        // The destination must offer a surface within maxStep of the height we leave
        // from, with capsule clearance; otherwise the portal is a wall at this height.
        const landing = resolveSurface(target, hx, hz, null, surfaceHeight(from, hx, hz));
        if (landing) {
          x = hx; z = hz;
          rx *= 1-portal.t; rz *= 1-portal.t;
          current = target;
          surf = landing;
          crossed = true;
          continue;
        }
        const back = Math.max(0, portal.t-PROBE/Math.hypot(rx, rz));
        const bx = x+rx*back, bz = z+rz*back;
        const stay = resolveSurface(current, bx, bz, pathSurface(reach.path, back), surfaceHeight(pathSurface(reach.path, back), bx, bz));
        t = stay ? back : 0;
        tSurf = stay ?? surf;
        tangent = portal.tangent;
      } else if (t === 1) {
        x += rx; z += rz;
        surf = reach.surface;
        rx = rz = 0;
        break;
      }
      blocked = true;
      x += rx*t; z += rz*t;
      surf = tSurf;
      if (!tangent || ++slides >= MAX_SLIDES) break;
      const rest = 1-t;
      const along = (rx*tangent[0]+rz*tangent[1])*rest;
      rx = tangent[0]*along; rz = tangent[1]*along;
    }
    if (rx !== 0 || rz !== 0) blocked = true;
    if (!resolveSurface(current, x, z, surf, surfaceHeight(surf, x, z))) {
      current = rooms.get(startRoom); x = startX; z = startZ;
      surf = current.surfaceById.get(startSurface);
      blocked = true; crossed = false;
    }
    state.room = current.id; state.x = x; state.z = z; state.surface = surf.id; state.blockedLast = blocked;
    return { x, z, y: surfaceHeight(surf, x, z), room: state.room, surface: surf.id, blocked, crossed };
  }

  // Placement, not motion: callers choose the surface (id) or a ground-height hint.
  function teleport(roomId, x, z, options = {}) {
    const target = rooms.get(roomId);
    if (!target) throw new Error(`unknown navigation room ${roomId}`);
    if (!finite(x) || !finite(z)) throw new Error(`room ${roomId}: teleport point must be finite`);
    const found = place(roomId, x, z, options?.surface ?? null, options?.y ?? null);
    state.room = roomId; state.x = x; state.z = z; state.surface = found.id; state.blockedLast = false;
  }

  function setYaw(radians) {
    if (!finite(radians)) throw new Error('yaw must be finite');
    state.yaw = radians;
  }

  const currentSurface = () => rooms.get(state.room).surfaceById.get(state.surface);
  const groundY = () => surfaceHeight(currentSurface(), state.x, state.z);

  return {
    move,
    teleport,
    setYaw,
    get yaw() { return state.yaw; },
    get room() { return state.room; },
    get x() { return state.x; },
    get z() { return state.z; },
    get surface() { return state.surface; },
    get groundY() { return groundY(); },
    forward(distance) { return move(-Math.sin(state.yaw)*distance, -Math.cos(state.yaw)*distance); },
    strafe(distance) { return move(Math.cos(state.yaw)*distance, -Math.sin(state.yaw)*distance); },
    snapshot() {
      const ground = groundY();
      return {
        room: state.room,
        surface: state.surface,
        position: [state.x, ground+navigation.eyeHeight, state.z],
        yaw: state.yaw,
        eyeHeight: navigation.eyeHeight,
        capsuleRadius: navigation.capsuleRadius,
        blockedLast: state.blockedLast,
        limit: navigation.limit,
      };
    },
  };
}
