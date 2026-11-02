import * as THREE from 'three';

// Pure room-graph, portal-visibility, streaming and eviction planning for the
// house phase. Data is glTF Y-up metres. No GPU, DOM or loader state is touched.

const DUPLICATE_PORTAL_TOLERANCE = 0.02;
const UNIT_TOLERANCE = 1e-3;
const TIERS = ['standard', 'high'];
export const MEMORY_NOTICE = 'Memory is limited: showing standard detail in every room.';

function check(condition, message) { if (!condition) throw new Error(message); }
function vec3(value, label) {
  check(Array.isArray(value) && value.length === 3 && value.every(Number.isFinite), `${label} must be three finite numbers.`);
  return new THREE.Vector3(value[0], value[1], value[2]);
}
function finiteNonNegative(value, label) { check(Number.isFinite(value) && value >= 0, `${label} must be a finite nonnegative number.`); }
function roomOf(graph, id, label) {
  const room = graph?.rooms?.get(id);
  check(room, `${label} names unknown room: ${String(id)}`);
  return room;
}
function byHopThenId(hops) {
  return (a, b) => (hops.get(a) ?? Infinity) - (hops.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0);
}

// Native/runtime boundary tolerance: an opening plane must lie within this distance of the
// facing boundary of each of the two cells it joins (no slab or gap bridging).
const BOUNDS_TOLERANCE = 0.02;
const GEOMETRY_TOLERANCE = 1e-3;

function makePortal(to, center, normal, width, height, interiorOf, derived, explicit = null, walkable = true) {
  let corners;
  if (explicit) corners = explicit.map(corner => corner.clone());
  else {
    const tangent = new THREE.Vector3(-normal.z, 0, normal.x);
    const up = new THREE.Vector3(0, 1, 0);
    corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) =>
      center.clone().addScaledVector(tangent, u * width / 2).addScaledVector(up, v * height / 2));
  }
  return {
    to, center, normal, width, height, derived, corners, walkable,
    explicit: explicit !== null,
    horizontal: explicit !== null && Math.abs(normal.y) > 0.5,
    box: new THREE.Box3().setFromPoints(corners),
    // Unit normal pointing into the room that owns this portal entry (horizontal for
    // ordinary doors, full 3D for explicit-corner openings).
    interiorNormal: interiorOf
  };
}

// The manifest does not pin which way `normal` faces, so the interior side is
// taken from the owning room's bounds centre instead of from the sign of `normal`.
// Ordinary doors use the XZ sign only; explicit openings use the full 3D offset.
function interiorNormalFor(room, center, normal, label, full = false) {
  const roomCenter = room.bounds.getCenter(new THREE.Vector3());
  const side = (roomCenter.x - center.x) * normal.x + (roomCenter.z - center.z) * normal.z
    + (full ? (roomCenter.y - center.y) * normal.y : 0);
  check(Math.abs(side) > 1e-9, `${label} lies in the plane through the room centre; its interior side is ambiguous.`);
  return side > 0 ? normal.clone() : normal.clone().negate();
}

// Validate and normalise an explicit rectangle. Native exporters always write center, normal,
// width and height next to corners, so all four are required and must agree with the corners.
// Returns the corners plus the derived centre, unit normal and edge lengths.
// Scope restriction: explicit rectangles must be axis-aligned (normal along X, Y or Z) because
// the spatial cells are axis-aligned boxes and only an axis-aligned plane can lie on both cells'
// boundaries. Arbitrarily oriented openings are not supported; the native validator must match.
function parseExplicitCorners(portal, label) {
  check(Array.isArray(portal.corners) && portal.corners.length === 4, `${label} corners must be exactly four [x, y, z] points.`);
  const p = portal.corners.map((corner, i) => vec3(corner, `${label} corners[${i}]`));
  const e1 = p[1].clone().sub(p[0]);
  const e3 = p[3].clone().sub(p[0]);
  const width = e1.length();
  const height = e3.length();
  check(width > GEOMETRY_TOLERANCE && height > GEOMETRY_TOLERANCE, `${label} corners are degenerate (zero-length edge).`);
  check(p[2].distanceTo(p[0].clone().add(e1).add(e3)) <= GEOMETRY_TOLERANCE,
    `${label} corners must be ordered around a planar parallelogram.`);
  check(Math.abs(e1.dot(e3)) / (width * height) <= GEOMETRY_TOLERANCE, `${label} corners must form a rectangle (perpendicular edges).`);
  const normal = e1.clone().cross(e3).normalize();
  const center = p[0].clone().add(p[1]).add(p[2]).add(p[3]).multiplyScalar(0.25);
  check(portal.center !== undefined, `${label} needs a center next to its corners.`);
  check(vec3(portal.center, `${label} center`).distanceTo(center) <= GEOMETRY_TOLERANCE, `${label} center must be the mean of its corners.`);
  check(portal.normal !== undefined, `${label} needs a normal next to its corners.`);
  const given = vec3(portal.normal, `${label} normal`);
  check(Math.abs(given.length() - 1) <= UNIT_TOLERANCE, `${label} normal must be a unit vector.`);
  check(given.clone().cross(normal).length() <= UNIT_TOLERANCE, `${label} normal must be perpendicular to its corner rectangle.`);
  for (const [name, value] of [['width', portal.width], ['height', portal.height]]) {
    check(Number.isFinite(value) && value > 0, `${label} ${name} must be positive.`);
  }
  // The pair is assigned as a whole: (width, height) is (|e1|, |e3|) or the swapped pair.
  const close = (a, b) => Math.abs(a - b) <= 5e-3;
  check((close(portal.width, width) && close(portal.height, height)) || (close(portal.width, height) && close(portal.height, width)),
    `${label} width and height disagree with its corner rectangle.`);
  const axis = ['x', 'y', 'z'].reduce((best, key) => Math.abs(normal[key]) > Math.abs(normal[best]) ? key : best, 'x');
  check(Math.abs(normal[axis]) >= 1 - UNIT_TOLERANCE, `${label} corner rectangle must be axis-aligned to lie on cell boundaries.`);
  return { corners: p, center, normal: normal.clone().multiplyScalar(Math.sign(normal[axis])), width, height, axis };
}

// The rectangle must lie on the boundary between the two cells: its plane within
// BOUNDS_TOLERANCE of a face of each cell, the cells on opposite sides of it (they must not
// overlap across the opening) and every corner inside both boxes' extents on the other axes.
function checkOpeningBetween(owner, target, opening, label) {
  const { axis, corners } = opening;
  const plane = opening.center[axis];
  for (const room of [owner, target]) {
    const face = Math.min(Math.abs(plane - room.bounds.min[axis]), Math.abs(plane - room.bounds.max[axis]));
    check(face <= BOUNDS_TOLERANCE, `${label} lies off the boundary of room ${room.id} (${face.toFixed(3)} m from its nearest ${axis} face).`);
  }
  const side = room => room.bounds.getCenter(new THREE.Vector3())[axis] - plane;
  check(side(owner) * side(target) < 0,
    `${label} joins cells ${owner.id} and ${target.id} on the same side of the opening plane; that is not a boundary opening.`);
  for (const room of [owner, target]) {
    for (const corner of corners) {
      for (const other of ['x', 'y', 'z']) {
        if (other === axis) continue;
        check(corner[other] >= room.bounds.min[other] - BOUNDS_TOLERANCE && corner[other] <= room.bounds.max[other] + BOUNDS_TOLERANCE,
          `${label} extends outside the footprint of room ${room.id}.`);
      }
    }
  }
}

function sameCorners(a, b) {
  return a.every(corner => b.some(other => other.distanceTo(corner) <= DUPLICATE_PORTAL_TOLERANCE));
}

export function buildRoomGraph(rooms) {
  check(Array.isArray(rooms) && rooms.length > 0, 'rooms must be a nonempty array.');
  const parsed = new Map();
  for (const row of rooms) {
    check(row !== null && typeof row === 'object', 'room must be an object.');
    check(typeof row.id === 'string' && row.id, 'room needs a nonempty string id.');
    check(!parsed.has(row.id), `duplicate room id: ${row.id}`);
    const min = vec3(row.bounds?.min, `room ${row.id} bounds.min`);
    const max = vec3(row.bounds?.max, `room ${row.id} bounds.max`);
    check(min.x < max.x && min.y < max.y && min.z < max.z, `room ${row.id} bounds need min < max on every axis.`);
    check(row.portals === undefined || Array.isArray(row.portals), `room ${row.id} portals must be an array.`);
    parsed.set(row.id, { id: row.id, bounds: new THREE.Box3(min, max), declared: row.portals ?? [], portals: [] });
  }

  const declared = new Map();
  for (const room of parsed.values()) {
    declared.set(room.id, room.declared.map((portal, index) => {
      const label = `room ${room.id} portal ${index}`;
      check(portal !== null && typeof portal === 'object', `${label} must be an object.`);
      check(typeof portal.to === 'string' && portal.to, `${label} needs a target room id.`);
      check(portal.to !== room.id, `${label} targets its own room.`);
      check(parsed.has(portal.to), `${label} targets unknown room: ${portal.to}`);
      check(portal.walkable === undefined || typeof portal.walkable === 'boolean', `${label} walkable must be a boolean.`);
      const walkable = portal.walkable ?? true;
      if (portal.corners !== undefined) {
        const opening = parseExplicitCorners(portal, label);
        checkOpeningBetween(room, parsed.get(portal.to), opening, label);
        return { label, to: portal.to, center: opening.center, normal: opening.normal, width: opening.width,
          height: opening.height, corners: opening.corners, walkable };
      }
      const center = vec3(portal.center, `${label} center`);
      const normal = vec3(portal.normal, `${label} normal`);
      check(Number.isFinite(portal.width) && portal.width > 0, `${label} width must be positive.`);
      check(Number.isFinite(portal.height) && portal.height > 0, `${label} height must be positive.`);
      check(Math.abs(normal.y) <= UNIT_TOLERANCE && Math.abs(normal.length() - 1) <= UNIT_TOLERANCE,
        `${label} normal must be a unit horizontal vector.`);
      normal.normalize();
      return { label, to: portal.to, center, normal, width: portal.width, height: portal.height, corners: null, walkable };
    }));
  }

  for (const room of parsed.values()) {
    for (const portal of declared.get(room.id)) {
      room.portals.push(makePortal(portal.to, portal.center, portal.normal, portal.width, portal.height,
        interiorNormalFor(room, portal.center, portal.normal, portal.label, portal.corners !== null),
        false, portal.corners, portal.walkable));
    }
  }
  // Derive the reverse portal only when the target has no matching one within 2 cm.
  // A declared reverse must describe the same opening: same geometry kind, corners, walkability.
  for (const room of parsed.values()) {
    for (const portal of declared.get(room.id)) {
      const target = parsed.get(portal.to);
      let present = false;
      for (const other of declared.get(target.id)) {
        if (other.to !== room.id || other.center.distanceTo(portal.center) > DUPLICATE_PORTAL_TOLERANCE) continue;
        check((other.corners !== null) === (portal.corners !== null) && other.walkable === portal.walkable
          && (portal.corners === null || sameCorners(portal.corners, other.corners)),
          `${portal.label} and ${other.label} disagree: reciprocal openings must share corners and walkability.`);
        present = true;
      }
      if (present) continue;
      const normal = portal.normal.clone().negate();
      target.portals.push(makePortal(room.id, portal.center, normal, portal.width, portal.height,
        interiorNormalFor(target, portal.center, normal, `${portal.label} (derived reverse in room ${target.id})`, portal.corners !== null),
        true, portal.corners, portal.walkable));
    }
  }

  const graphRooms = new Map();
  for (const room of parsed.values()) graphRooms.set(room.id, { id: room.id, bounds: room.bounds, portals: room.portals });
  return {
    rooms: graphRooms,
    hops(fromId) {
      roomOf({ rooms: graphRooms }, fromId, 'hops origin');
      const result = new Map([[fromId, 0]]);
      const queue = [fromId];
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        for (const portal of graphRooms.get(id).portals) {
          if (result.has(portal.to)) continue;
          result.set(portal.to, result.get(id) + 1);
          queue.push(portal.to);
        }
      }
      return result;
    }
  };
}

function cameraFrustum(camera) {
  check(camera?.isCamera, 'visibleRooms needs a THREE camera.');
  const local = new THREE.Matrix4().compose(camera.position, camera.quaternion, camera.scale);
  const world = camera.parent ? camera.parent.matrixWorld.clone().multiply(local) : local;
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, world.clone().invert()));
  return { frustum, position: new THREE.Vector3().setFromMatrixPosition(world) };
}

// Exact convex polygon vs convex frustum: clip the rectangle by each plane in turn.
function polygonIntersectsFrustum(corners, planes) {
  let polygon = corners;
  for (const plane of planes) {
    const next = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const da = plane.distanceToPoint(a);
      const db = plane.distanceToPoint(b);
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) next.push(a.clone().lerp(b, da / (da - db)));
    }
    if (next.length === 0) return false;
    polygon = next;
  }
  return true;
}

/**
 * Rooms drawn from `current`: a neighbour is added when a portal of an already
 * visible room (1) intersects the frustum and (2) is approached from its
 * interior side: dot(camera - portal.center, portal.interiorNormal) > 0, where
 * interiorNormal points into the room owning that portal entry. A camera on or
 * behind the plane (dot <= 0) never sees through it. Visible hops <= depth.
 */
export function visibleRooms({ graph, current, camera, depth = 3, overview = false }) {
  roomOf(graph, current, 'current');
  check(Number.isInteger(depth) && depth >= 0, 'depth must be a nonnegative integer.');
  const { frustum, position } = cameraFrustum(camera);
  if (overview) {
    const rooms = [...graph.rooms.values()].filter(room => frustum.intersectsBox(room.bounds)).map(room => room.id);
    return { rooms, hops: new Map(rooms.map(id => [id, 0])), via: new Map() };
  }
  const hops = new Map([[current, 0]]);
  const via = new Map();
  const order = [current];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (hops.get(id) >= depth) continue;
    const room = graph.rooms.get(id);
    room.portals.forEach((portal, portalIndex) => {
      if (hops.has(portal.to)) return;
      if (position.clone().sub(portal.center).dot(portal.interiorNormal) <= 0) return;
      if (!polygonIntersectsFrustum(portal.corners, frustum.planes)) return;
      hops.set(portal.to, hops.get(id) + 1);
      via.set(portal.to, { from: id, portalIndex });
      order.push(portal.to);
    });
  }
  return { rooms: order, hops, via };
}

function checkTiers(graph, tiers) {
  if (tiers === undefined) return new Map();
  check(tiers instanceof Map, 'tiers must be a Map of room id to Set of tiers.');
  for (const [room, set] of tiers) {
    roomOf(graph, room, 'tiers');
    check(set instanceof Set && [...set].every(tier => TIERS.includes(tier)), `tiers for room ${room} must be a Set of standard|high.`);
  }
  return tiers;
}

export function streamingPlan({ graph, current, tiers }) {
  roomOf(graph, current, 'current');
  const resident = checkTiers(graph, tiers);
  const hops = graph.hops(current);
  const requests = [];
  const add = (room, tier, priority) => {
    if (!resident.get(room)?.has(tier)) requests.push({ room, tier, priority });
  };
  add(current, 'standard', 'P0');
  add(current, 'high', 'P1');
  const others = [...graph.rooms.keys()].filter(id => id !== current).sort(byHopThenId(hops));
  const neighbours = others.filter(id => hops.get(id) === 1);
  // P2 loads every neighbour's standard tier before any neighbour's high tier.
  for (const tier of TIERS) for (const room of neighbours) add(room, tier, 'P2');
  for (const room of others) if (hops.get(room) !== 1) add(room, 'standard', 'P3');
  return requests;
}

export function diffStreamingPlan(previous, next) {
  check(Array.isArray(previous) && Array.isArray(next), 'diffStreamingPlan needs two request arrays.');
  const key = request => `${request.room}\u0000${request.tier}`;
  const before = new Map(previous.map(request => [key(request), request]));
  const after = new Map(next.map(request => [key(request), request]));
  return {
    abort: previous.filter(request => !after.has(key(request))),
    start: next.filter(request => !before.has(key(request))),
    reprioritize: next.filter(request => before.has(key(request)) && before.get(key(request)).priority !== request.priority)
  };
}

export function planEviction({ graph, current, rooms, globalTier, budgetBytes }) {
  roomOf(graph, current, 'current');
  check(TIERS.includes(globalTier), 'globalTier must be standard or high.');
  finiteNonNegative(budgetBytes, 'budgetBytes');
  check(Array.isArray(rooms), 'rooms must be an array.');
  const hops = graph.hops(current);
  const state = new Map();
  for (const row of rooms) {
    check(row !== null && typeof row === 'object', 'eviction room must be an object.');
    roomOf(graph, row.id, 'eviction rooms');
    check(!state.has(row.id), `duplicate eviction room: ${row.id}`);
    finiteNonNegative(row.standardBytes, `room ${row.id} standardBytes`);
    finiteNonNegative(row.highBytes, `room ${row.id} highBytes`);
    check(typeof row.highResident === 'boolean', `room ${row.id} highResident must be boolean.`);
    check(!(globalTier === 'standard' && row.highResident), `room ${row.id} holds high tier although globalTier is standard.`);
    state.set(row.id, { id: row.id, standard: row.standardBytes, high: row.highResident ? row.highBytes : 0, holdsHigh: row.highResident });
  }
  const total = () => [...state.values()].reduce((sum, room) => sum + room.standard + room.high, 0);
  const steps = [];
  let resident = total();
  const run = (step, kind, predicate) => {
    if (resident <= budgetBytes) return;
    const chosen = [...state.values()].filter(room => room.holdsHigh && room.high > 0 && predicate(room))
      .sort((a, b) => (hops.get(b.id) ?? Infinity) - (hops.get(a.id) ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const freed = chosen.reduce((sum, room) => sum + room.high, 0);
    for (const room of chosen) { room.holdsHigh = false; room.high = 0; }
    if (freed === 0) return;
    resident -= freed;
    steps.push({ step, kind, rooms: chosen.map(room => room.id), freedBytes: freed, residentBytesAfter: resident });
  };
  const far = room => (hops.get(room.id) ?? Infinity) > 2;
  run(1, 'evict-high-far', far);
  run(2, 'evict-high-neighbours', room => room.id !== current);
  run(3, 'global-standard', () => true);
  const switched = steps.some(step => step.step === 3);
  return { steps, residentBytesAfter: resident, withinBudget: resident <= budgetBytes, notice: switched ? MEMORY_NOTICE : null };
}
