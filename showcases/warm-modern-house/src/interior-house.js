// Pure house helpers shared by the viewer and its tests: `room/view` identities,
// current-room resolution, per-room residency attribution and memory-pressure
// planning. No DOM, GPU or loader state is touched here. Coordinates are glTF Y-up metres.
import { planEviction } from './interior-portals.js';
import { validateWalkNavigation } from './interior-walk.js';
import { distanceToEdge, insideRing, onBoundary, polygonEdges, surfaceCeiling, surfaceCovers, surfaceHeight,
  validatePolygon } from './interior-walk-surfaces.js';

const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TOLERANCE = 1e-6;

function check(condition, message) { if (!condition) throw new Error(message); }

export function formatViewId(room, view) {
  check(typeof room === 'string' && ROOM_ID.test(room), `Invalid room id: ${String(room)}`);
  check(typeof view === 'string' && view.length > 0, `Invalid view name for room ${room}.`);
  return `${room}/${view}`;
}

/** "living/source" -> { room: "living", view: "source" }. Room ids never contain "/". */
export function parseViewId(id) {
  check(typeof id === 'string', `View id must be a "room/view" string: ${String(id)}`);
  const slash = id.indexOf('/');
  check(slash > 0 && slash < id.length - 1, `View id must be "room/view": ${id}`);
  const room = id.slice(0, slash);
  check(ROOM_ID.test(room), `View id has an invalid room id: ${id}`);
  return { room, view: id.slice(slash + 1) };
}

/** Every named view of every room, in manifest order, keyed by `room/view`. */
export function viewCatalog(manifest) {
  const catalog = new Map();
  for (const room of manifest.house.rooms) {
    for (const [name, pose] of Object.entries(room.views)) {
      catalog.set(formatViewId(room.id, name), { id: formatViewId(room.id, name), room: room.id, name, pose });
    }
  }
  return catalog;
}

export function viewLabel(name, pose) {
  if (pose?.label) return pose.label;
  if (name === 'source') return 'Source view';
  // `src-l1-study` is a camera pose that matches a concept view; show it as "Concept · Study".
  const concept = /^src-(?:l\d+-)?(.+)$/.exec(name);
  const words = (concept ? concept[1] : name).replaceAll('-', ' ');
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return concept ? `Concept · ${label}` : label;
}

function boxContains(bounds, [x, y, z], tolerance = TOLERANCE) {
  return x >= bounds.min[0] - tolerance && x <= bounds.max[0] + tolerance
    && y >= bounds.min[1] - tolerance && y <= bounds.max[1] + tolerance
    && z >= bounds.min[2] - tolerance && z <= bounds.max[2] + tolerance;
}

function boxDistanceSquared(bounds, [x, y, z]) {
  const axis = (value, min, max) => value < min ? min - value : value > max ? value - max : 0;
  return axis(x, bounds.min[0], bounds.max[0]) ** 2 + axis(y, bounds.min[1], bounds.max[1]) ** 2
    + axis(z, bounds.min[2], bounds.max[2]) ** 2;
}

const HEIGHT_SLACK_BELOW = 0.05;
const HEIGHT_SLACK_ABOVE = 1e-3;

// navigation2 documents are compiled once by the walk module (the same validation, surface
// planes and ceilings the walker uses) and cached per document object.
const compiledNavigation = new WeakMap();
function compileNavigation(navigation) {
  check(navigation !== null && typeof navigation === 'object', 'navigation must be a navigation2 document.');
  let compiled = compiledNavigation.get(navigation);
  if (!compiled) {
    // Only a navigation declaring mode 'orbit-only' may hold rooms with neither walkable area nor surfaces.
    compiled = validateWalkNavigation(navigation, { orbitOnly: navigation.mode === 'orbit-only' });
    compiledNavigation.set(navigation, compiled);
  }
  return compiled;
}

function horizontalDistance(surface, x, z) {
  if (surfaceCovers(surface, x, z)) return 0;
  let best = Infinity;
  for (const edge of surface.edges) best = Math.min(best, distanceToEdge(x, z, edge));
  return best;
}

// How the eye relates to one room's surfaces: `exact` (eye-height error) when it stands inside
// a surface polygon and between its floor and ceiling at x,z; `compatibleDistance` is the
// horizontal gap to the nearest surface whose vertical range holds the eye; `cost` adds the
// horizontal and vertical gaps for the nearest-cell fallback.
function surfaceFit(navRoom, x, y, z, eyeHeight) {
  let exact = null;
  let compatibleDistance = null;
  let cost = Infinity;
  for (const surface of navRoom.surfaces) {
    const height = surfaceHeight(surface, x, z);
    const ceiling = surfaceCeiling(surface, x, z);
    const vertical = Math.max(0, height - HEIGHT_SLACK_BELOW - y, y - ceiling - HEIGHT_SLACK_ABOVE);
    const horizontal = horizontalDistance(surface, x, z);
    cost = Math.min(cost, horizontal + vertical);
    if (vertical > 0) continue;
    if (compatibleDistance === null || horizontal < compatibleDistance) compatibleDistance = horizontal;
    if (horizontal === 0) {
      const error = Math.abs(y - (height + eyeHeight));
      if (exact === null || error < exact) exact = error;
    }
  }
  return { exact, compatibleDistance, cost };
}

/**
 * The room whose bounds contain `position` (the eye). A point on a shared wall keeps `previous`
 * when it still contains it (no flapping at a doorway); otherwise the first containing room in
 * manifest order wins. A point outside every room keeps `previous`, or falls back to the
 * nearest room box when there is none.
 *
 * Optional `navigation` (a navigation2 document, validated by the walk module and cached) resolves
 * stacked rooms and stair cells by actual geometry instead of boxes. Per room with surfaces:
 *  1. exact: bounds contain the eye, it is inside a surface polygon (boundary inclusive), and its
 *     height lies between the surface height a*x+b*z+c and the ceiling at the same x,z (`ceilingY`
 *     or sloped `ceilingPlane`). Exact matches beat any other box, even `previous`; among them
 *     `previous` wins (stable on shared boundaries), else the surface closest to eye height.
 *  2. else (eye outside every polygon, e.g. in the wall inset): rooms whose box contains the eye and
 *     whose surface vertical range holds it; `previous` when it is one of them, else the nearest
 *     polygon horizontally. A wrong-floor box never wins here.
 *  3. else the room with the smallest horizontal+vertical gap to any surface (`previous` on ties).
 * Rooms with no surfaces (orbit-only scenes) are not candidates; a navigation with none at all
 * falls back to the box rules above.
 */
export function resolveCurrentRoom({ rooms, position, previous = null, navigation = null }) {
  check(Array.isArray(rooms) && rooms.length > 0, 'resolveCurrentRoom needs rooms.');
  check(Array.isArray(position) && position.length === 3 && position.every(Number.isFinite), 'position must be three finite numbers.');
  if (navigation !== null) {
    const compiled = compileNavigation(navigation);
    const [x, y, z] = position;
    const entries = [];
    for (const room of rooms) {
      const navRoom = compiled.rooms.get(room.id);
      if (!navRoom?.surfaces.length) continue;
      entries.push({ id: room.id, box: boxContains(room.bounds, position), ...surfaceFit(navRoom, x, y, z, navigation.eyeHeight) });
    }
    if (entries.length) {
      const exact = entries.filter(entry => entry.box && entry.exact !== null);
      if (exact.length) {
        if (previous !== null && exact.some(entry => entry.id === previous)) return previous;
        return exact.reduce((best, entry) => entry.exact < best.exact ? entry : best).id;
      }
      const compatible = entries.filter(entry => entry.box && entry.compatibleDistance !== null);
      if (compatible.length) {
        if (previous !== null && compatible.some(entry => entry.id === previous)) return previous;
        return compatible.reduce((best, entry) => entry.compatibleDistance < best.compatibleDistance ? entry : best).id;
      }
      const nearest = entries.reduce((best, entry) => entry.cost < best.cost - 1e-9 ? entry : best);
      const tied = entries.filter(entry => Math.abs(entry.cost - nearest.cost) <= 1e-9);
      return tied.some(entry => entry.id === previous) ? previous : nearest.id;
    }
  }
  const containing = rooms.filter(room => boxContains(room.bounds, position));
  if (previous !== null && containing.some(room => room.id === previous)) return previous;
  if (containing.length) return containing[0].id;
  if (previous !== null && rooms.some(room => room.id === previous)) return previous;
  let best = rooms[0];
  for (const room of rooms) if (boxDistanceSquared(room.bounds, position) < boxDistanceSquared(best.bounds, position)) best = room;
  return best.id;
}

/**
 * Split each resource's bytes evenly among the rooms that use it, so shared textures are not
 * counted twice and the rows sum to the true resident bytes. `resources` are
 * `{ bytes, tier: 'standard'|'high', rooms: [roomId] }`. A room is high-resident when
 * it is listed in `highRooms` and the global tier is not standard.
 */
export function attributeRoomBytes({ roomIds, resources, highRooms = new Set(), globalTier = 'high' }) {
  const rows = new Map(roomIds.map(id => [id, { id, standardBytes: 0, highBytes: 0,
    highResident: globalTier !== 'standard' && highRooms.has(id) }]));
  for (const resource of resources) {
    check(Number.isFinite(resource.bytes) && resource.bytes >= 0, 'Resource bytes must be nonnegative.');
    check(resource.tier === 'standard' || resource.tier === 'high', `Unknown resource tier: ${resource.tier}`);
    const owners = resource.rooms.filter(id => rows.has(id));
    if (!owners.length) continue;
    const share = resource.bytes / owners.length;
    for (const id of owners) rows.get(id)[resource.tier === 'high' ? 'highBytes' : 'standardBytes'] += share;
  }
  return [...rows.values()];
}

/**
 * The memory-pressure decision. The budget covers everything the GPU holds, but only the
 * per-room texture tiers can be evicted, so `fixedBytes` (render targets, canvas, batches...)
 * is subtracted before planning. Returns planEviction()'s result.
 */
export function planRoomPressure({ graph, current, rows, globalTier, budgetBytes, fixedBytes = 0 }) {
  check(Number.isFinite(fixedBytes) && fixedBytes >= 0, 'fixedBytes must be nonnegative.');
  return planEviction({ graph, current, rooms: rows, globalTier, budgetBytes: Math.max(0, budgetBytes - fixedBytes) });
}

/** `?memoryBudget=<bytes>` overrides the tier budget so memory-pressure scenarios are deterministic. */
export function memoryBudgetOverride(search = globalThis.location?.search ?? '') {
  const value = new URLSearchParams(search).get('memoryBudget');
  if (value === null) return null;
  check(/^[1-9]\d{0,15}$/.test(value), 'memoryBudget must be a positive integer number of bytes.');
  return Number(value);
}

/** The budget that applies to the current global tier, from runtime-budget.json metrics. */
export function tierBudget(budget, globalTier, override = null) {
  if (override !== null) return override;
  const metrics = budget?.metrics;
  const value = globalTier === 'standard' ? metrics?.standardGpuBytes : metrics?.highGpuBytes;
  check(Number.isFinite(value) && value > 0, `runtime-budget.json needs a positive ${globalTier === 'standard' ? 'standardGpuBytes' : 'highGpuBytes'} metric.`);
  return value;
}

/**
 * Search outward from `preferred` for a point `attempt(x, z)` accepts (it returns truthy on
 * success). Used to place the walking eye on a walkable spot without reading polygon internals.
 * Optional `surfaces` (navigation2 surfaces or bare XZ polygons) restrict candidates to points
 * inside at least one surface polygon, so sloped or narrow stair cells are searched without
 * spending `limit` on points that cannot hold a surface; `attempt` still has the final word.
 */
export function findWalkablePoint({ attempt, preferred, bounds, step = 0.25, limit = 400, surfaces = null }) {
  check(typeof attempt === 'function', 'attempt must be a function.');
  check(Array.isArray(preferred) && preferred.length === 2 && preferred.every(Number.isFinite), 'preferred must be [x, z].');
  let rings2d = null;
  if (surfaces !== null) {
    check(Array.isArray(surfaces), 'surfaces must be an array.');
    rings2d = surfaces.map((surface, index) => {
      const polygon = Array.isArray(surface) ? surface : surface?.polygon;
      validatePolygon(polygon, `surface ${index}`);
      return { polygon, edges: polygonEdges(polygon) };
    });
  }
  const usable = (x, z) => rings2d === null || rings2d.some(ring => onBoundary(x, z, ring.edges) || insideRing(x, z, ring.polygon));
  const candidates = usable(...preferred) ? [preferred] : [];
  const minX = bounds.min[0], maxX = bounds.max[0], minZ = bounds.min[2], maxZ = bounds.max[2];
  // Preserve a valid doorway bridge first; centre fallback search on the room, not a distant exterior eye.
  const px = Math.max(minX, Math.min(maxX, preferred[0]));
  const pz = Math.max(minZ, Math.min(maxZ, preferred[1]));
  if ((px !== preferred[0] || pz !== preferred[1]) && usable(px, pz)) candidates.push([px, pz]);
  const rings = Math.ceil(Math.max(maxX - minX, maxZ - minZ) / step);
  for (let ring = 1; ring <= rings; ring++) {
    const ordered = [];
    for (let ix = -ring; ix <= ring; ix++) for (let iz = -ring; iz <= ring; iz++) {
      if (Math.max(Math.abs(ix), Math.abs(iz)) !== ring) continue;
      const x = px + ix * step, z = pz + iz * step;
      if (x < minX || x > maxX || z < minZ || z > maxZ || !usable(x, z)) continue;
      ordered.push([x, z]);
    }
    ordered.sort((a, b) => Math.hypot(a[0] - px, a[1] - pz) - Math.hypot(b[0] - px, b[1] - pz));
    candidates.push(...ordered);
    if (candidates.length >= limit) break;
  }
  for (const [x, z] of candidates.slice(0, limit)) if (attempt(x, z)) return [x, z];
  return null;
}
