import { validateWalkNavigation } from './interior-walk.js';
import { buildRoomGraph } from './interior-portals.js';

const MIGRATION = 'Migrate the project to img2interior 0.4.0: interior_project.py migrate --workspace W --to 0.4; then draft (after reported builder edits), bake (all pairs), probe, export and encode.';
const CLASSES = new Set(['architecture', 'furniture', 'fixture', 'appliance', 'textile', 'decor', 'plant', 'exterior']);
const BAKE_CLASSES = new Set(['architecture', 'furniture', 'textiles', 'details', 'garden']);
const SOURCE_KINDS = new Set(['photo', 'render', 'synthetic-design-reference', 'floorplan']);

function check(condition, message) { if (!condition) throw new Error(message); }
function text(value, label) { check(typeof value === 'string' && value.trim(), `${label} must be nonempty text.`); return value; }
function object(value, label) { check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`); return value; }
function array(value, label, nonempty = false) { check(Array.isArray(value) && (!nonempty || value.length), `${label} must be an array${nonempty ? ' with entries' : ''}.`); return value; }
function positive(value, label) { check(Number.isFinite(value) && value > 0, `${label} must be positive.`); }
function nonnegative(value, label) { check(Number.isFinite(value) && value >= 0, `${label} must be nonnegative.`); }
function identities(value, label) {
  const result = new Map();
  for (const row of array(value, label, true)) {
    object(row, label);
    check(typeof row.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(row.id), `${label} has invalid id.`);
    check(!result.has(row.id), `${label} has duplicate id: ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}
export function vector3(value) { return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite); }
export function validateRoomBounds(bounds, label = 'roomBounds', minimumExtent = 0.5) {
  // Orbit controls need their existing half-metre safety envelope; schema boxes
  // (including probe boxes) only require positive extent and pass zero explicitly.
  check(vector3(bounds?.min) && vector3(bounds?.max) && bounds.min.every((v, i) => v + minimumExtent < bounds.max[i]), `${label} needs Y-up min/max extents greater than ${minimumExtent} m.`);
}
// Box projection is degenerate on a wall, so a probe must sit strictly inside its parallax box.
function strictlyInside(position, bounds) { return position.every((v, i) => v > bounds.min[i] && v < bounds.max[i]); }
function assetPath(value, field, extension) {
  check(typeof value === 'string' && value.startsWith('/assets/'), `${field} requires a local /assets/ URL.`);
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new Error(`Invalid asset URL: ${field}`); }
  check(decoded.startsWith('/assets/') && !/[\\?#\s\x00-\x1f\x7f%]/.test(decoded)
    && decoded.split('/').slice(1).every(part => part && part !== '.' && part !== '..'), `${field} must stay inside /assets/ without traversal or ambiguous encoding.`);
  if (extension) check(decoded.endsWith(extension), `${field} must use ${extension}.`);
}
function pose(value, label, requireFov = true) {
  check(vector3(value?.position) && vector3(value?.target), `${label} needs position and target vectors.`);
  check(value.position.some((v, i) => v !== value.target[i]), `${label} position equals its target.`);
  if (requireFov || value.fov !== undefined) check(Number.isFinite(value.fov) && value.fov > 0 && value.fov < 180, `${label} has invalid FOV.`);
}
function validateVariants(value) {
  const groups = new Set();
  for (const entry of array(value, 'variants')) {
    object(entry, 'variant group');
    const group = text(entry.group, 'variant group');
    check(!groups.has(group), `Duplicate finish group: ${group}`);
    groups.add(group);
    const options = identities(entry.options, `variants.${group}`);
    for (const option of options.values()) {
      text(option.label, 'variant label');
      check(typeof option.color === 'string' && /^#[\da-f]{6}$/i.test(option.color), 'Variant color must be hex RGB.');
      if (option.roughness !== undefined) check(Number.isFinite(option.roughness) && option.roughness >= 0 && option.roughness <= 1, 'Variant roughness must be in [0,1].');
    }
    if (options.size > 1) check(!entry.options[0].color.slice(1).match(/../g).includes('00'), 'Base finish must have nonzero RGB channels for relative recoloring.');
  }
  return groups;
}

export function validateManifest(manifest) {
  check(manifest?.schemaVersion === 3, `Manifest schema 3 required. ${MIGRATION}`);
  const obsolete = ['sourceImage', 'sourceImageSize', 'sourceKind', 'model', 'portableModel', 'blender',
    'environment', 'camera', 'views', 'roomBounds', 'lightmaps', 'finishTarget', 'backgroundIntensity', 'toneMapping', 'exposure'].filter(key => Object.hasOwn(manifest, key));
  check(!obsolete.length, `Removed manifest fields: ${obsolete.join(', ')}. ${MIGRATION}`);
  text(manifest.title, 'title');
  const lighting = object(manifest.lighting, 'lighting');
  check(lighting.model === 'ambient-bake+shadowed-sun-v2', 'lighting.model must be ambient-bake+shadowed-sun-v2; full-sun bakes are not runtime ambient atlases.');
  check(lighting.lightmapEncoding === 'rgbm-webp-m2', 'lighting.lightmapEncoding must be rgbm-webp-m2.');
  positive(lighting.exposure, 'lighting.exposure');
  check(Object.hasOwn(lighting, 'sun'), 'Declare lighting.sun: null when there is no authored sun.');
  if (lighting.sun !== null) {
    const sun = object(lighting.sun, 'sun');
    pose(sun, 'sun', false);
    check(vector3(sun.color) && sun.color.every(v => v >= 0), 'Sun color must be nonnegative.');
    nonnegative(sun.intensity, 'sun intensity');
    check(Number.isInteger(sun.shadowMapSize) && sun.shadowMapSize >= 512 && sun.shadowMapSize <= 4096, 'sun shadowMapSize must be 512..4096.');
  }
  const quality = object(manifest.quality, 'quality');
  check(Array.isArray(quality.tiers) && quality.tiers.length === 2 && quality.tiers[0] === 'standard' && quality.tiers[1] === 'high', 'quality.tiers must be standard, high.');
  const adaptive = object(quality.adaptive, 'quality.adaptive');
  check(Number.isFinite(adaptive.minScale) && adaptive.minScale >= .5 && adaptive.minScale <= 1, 'minScale must be in [.5,1].');
  check(Number.isFinite(adaptive.step) && adaptive.step > 0 && adaptive.step <= .5, 'adaptive step must be in (0,.5].');
  const accumulation = object(quality.accumulation, 'quality.accumulation');
  check(Number.isFinite(accumulation.restMs) && accumulation.restMs >= 150, 'restMs must be at least 150.');
  check(Number.isInteger(accumulation.samples) && accumulation.samples >= 16, 'accumulation samples must be at least 16.');
  const house = object(manifest.house, 'house');
  const levels = identities(house.levels, 'levels');
  for (const level of levels.values()) check(Number.isFinite(level.floorY), 'level.floorY must be finite.');
  const rooms = identities(house.rooms, 'rooms');
  const atlasIds = new Set();
  for (const [id, room] of rooms) {
    text(room.label, `room ${id}.label`);
    check(levels.has(room.level), `Room ${id} names unknown level.`);
    validateRoomBounds(room.bounds, `room ${id}.bounds`, 0);
    if (room.floorY !== undefined) {
      check(Number.isFinite(room.floorY), `Room ${id} floorY must be finite.`);
      check(Math.abs(room.floorY - room.bounds.min[1]) < 1e-6, `Room ${id} floorY differs from its bounds.`);
    }
    assetPath(room.geometry, `room ${id}.geometry`, '.glb');
    for (const atlas of array(room.lightmaps, `room ${id}.lightmaps`, true)) {
      object(atlas, 'lightmap');
      check(typeof atlas.id === 'string' && atlas.id.startsWith(`${id}/`) && BAKE_CLASSES.has(atlas.id.slice(id.length + 1)), `Invalid room/class atlas identity: ${atlas.id}`);
      check(!atlasIds.has(atlas.id), `Duplicate atlas id: ${atlas.id}`);
      atlasIds.add(atlas.id);
      assetPath(atlas.url, `lightmap ${atlas.id}`, '.webp');
      positive(atlas.intensity, 'lightmap intensity');
      check(Number.isInteger(atlas.range) && atlas.range > 0, 'Lightmap range must be a positive integer.');
    }
    const probe = object(room.probe, `room ${id}.probe`);
    assetPath(probe.url, `probe ${id}`, '.hdr');
    validateRoomBounds(probe.box, `probe ${id}.box`, 0);
    check(vector3(probe.position) && strictlyInside(probe.position, probe.box), `Probe ${id} position must be strictly inside its box.`);
    for (const portal of array(room.portals, `room ${id}.portals`)) {
      check(rooms.has(portal?.to) && portal.to !== id, `Portal in ${id} targets unknown or same room.`);
      check(vector3(portal.center) && vector3(portal.normal) && Math.abs(portal.normal.reduce((n, v) => n + v*v, 0) - 1) < 1e-4, `Portal in ${id} needs center and unit normal.`);
      positive(portal.width, 'portal width'); positive(portal.height, 'portal height');
    }
    const views = object(room.views, `room ${id}.views`);
    check(Object.hasOwn(views, 'source'), `Room ${id} needs a source view.`);
    for (const [name, camera] of Object.entries(views)) { text(name, 'view name'); pose(camera, `${id}.views.${name}`); }
  }
  buildRoomGraph(manifest.house.rooms);
  for (const [id, source] of identities(manifest.sources, 'sources')) {
    assetPath(source.url, `source ${id}`);
    check(Array.isArray(source.size) && source.size.length === 2 && source.size.every(v => Number.isInteger(v) && v > 0), 'source size needs positive integer dimensions.');
    check(rooms.has(source.room), `Source ${id} names unknown room.`);
    check(SOURCE_KINDS.has(source.kind), `Source ${id} has invalid kind.`);
  }
  for (const [id, texture] of Object.entries(object(manifest.textures, 'textures'))) {
    text(id, 'textureId'); object(texture, `texture ${id}`);
    check(['color', 'orm', 'normal'].includes(texture.role), `Invalid texture role: ${id}`);
    for (const tier of ['standard', 'high']) assetPath(texture[tier], `texture ${id}.${tier}`, '.ktx2');
  }
  const covered = new Set();
  for (const [id, path] of identities(manifest.paths, 'paths')) {
    positive(path.speed, `path ${id}.speed`);
    for (const room of array(path.rooms, `path ${id}.rooms`, true)) {
      check(rooms.has(room), `Path ${id} names unknown room: ${room}`); covered.add(room);
    }
    for (const key of array(path.keys, `path ${id}.keys`, true)) {
      pose(key, `path ${id}`, false); nonnegative(key.stopMs ?? 0, `path ${id}.stopMs`);
    }
  }
  check(covered.size === rooms.size, `paths must cover every room; missing: ${[...rooms.keys()].filter(id => !covered.has(id)).join(', ')}`);
  validateVariants(manifest.variants);
  for (const field of ['objects', 'navigation', 'budget']) assetPath(manifest[field], field);
  object(manifest.products, 'products');
  assetPath(manifest.products.portable, 'products.portable', '.glb');
  assetPath(manifest.products.native, 'products.native', '.blend');
  if (manifest.background != null) {
    object(manifest.background, 'background');
    assetPath(manifest.background.url, 'background', '.hdr');
    nonnegative(manifest.background.intensity, 'background intensity');
  }
  text(manifest.portability, 'portability'); text(manifest.sourceLimit, 'sourceLimit');
  return manifest;
}

function polygon(points, label) {
  check(Array.isArray(points) && points.length >= 3 && points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)), `${label} needs at least three XZ vertices.`);
  check(new Set(points.map(p => p.join(','))).size === points.length, `${label} has repeated vertices.`);
  const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i+1)%points.length];
    area += a[0]*b[1]-a[1]*b[0];
    for (let j = i+2; j < points.length; j++) {
      if (i === 0 && j === points.length-1) continue;
      const c = points[j], d = points[(j+1)%points.length];
      const on = (p, u, v) => Math.abs(cross(u,v,p)) < 1e-10 && p.every((n,k) => n >= Math.min(u[k],v[k]) && n <= Math.max(u[k],v[k]));
      check(!(cross(a,b,c)*cross(a,b,d) < 0 && cross(c,d,a)*cross(c,d,b) < 0) && !on(a,c,d) && !on(b,c,d) && !on(c,a,b) && !on(d,a,b), `${label} self-intersects.`);
    }
  }
  check(Math.abs(area) > 1e-8, `${label} has zero area.`);
}

export function validateReferences(manifest, { registry, navigation, roomTextureIds } = {}) {
  validateManifest(manifest);
  const rooms = new Map(manifest.house.rooms.map(room => [room.id, room]));
  const finishGroups = new Set(manifest.variants.map(group => group.group));
  if (registry !== undefined) {
    check(registry?.schemaVersion === 1, 'Object registry schema 1 required.');
    const ids = new Set(), usedGroups = new Set();
    for (const entry of array(registry.objects, 'registry.objects', true)) {
      object(entry, 'registry object');
      check(typeof entry.objectId === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.objectId), 'Registry objectId must be a stable slug.');
      check(!ids.has(entry.objectId), `Duplicate objectId: ${entry.objectId}`); ids.add(entry.objectId);
      check(rooms.has(entry.room), `Object ${entry.objectId} names unknown room: ${entry.room}`);
      check(CLASSES.has(entry.class), `Object ${entry.objectId} has unknown class.`);
      text(entry.label, 'object label'); text(entry.component, 'object component');
      // Flat physical surfaces may have zero extent on one axis.
      check(vector3(entry.bounds?.min) && vector3(entry.bounds?.max) && entry.bounds.min.every((v,i) => v <= entry.bounds.max[i]), `Object ${entry.objectId} has invalid bounds.`);
      for (const material of array(entry.materials, 'object materials')) text(material, 'material name');
      const capabilities = array(entry.capabilities, 'object capabilities');
      check(new Set(capabilities).size === capabilities.length && capabilities.every(v => ['select','inspect','hide','show','isolate','finish'].includes(v)), `Object ${entry.objectId} has unsupported capabilities.`);
      if (entry.finishGroup !== undefined) {
        check(finishGroups.has(entry.finishGroup), `Object ${entry.objectId} names unknown finish group: ${entry.finishGroup}`);
        usedGroups.add(entry.finishGroup);
      }
    }
    for (const group of finishGroups) check(usedGroups.has(group), `Finish group ${group} has no registry objects.`);
  }
  if (navigation !== undefined) {
    check(navigation?.schemaVersion === 2, 'Navigation schema 2 required; regenerate navigation with the current exporter.');
    validateWalkNavigation(navigation, { orbitOnly: navigation.mode === 'orbit-only' });
    positive(navigation.eyeHeight, 'navigation.eyeHeight'); positive(navigation.capsuleRadius, 'navigation.capsuleRadius');
    text(navigation.limit, 'navigation.limit');
    check(navigation.mode === undefined || navigation.mode === 'orbit-only' || navigation.mode === 'walk', 'Unknown navigation mode.');
    const navRooms = identities(navigation.rooms, 'navigation.rooms');
    check(navRooms.size === rooms.size && [...navRooms.keys()].every(id => rooms.has(id)), 'Navigation rooms must match manifest rooms.');
    for (const [id, room] of navRooms) {
      check(Number.isFinite(room.floorY), `Navigation room ${id} floorY must be finite.`);
      const level = manifest.house.levels.find(value => value.id === rooms.get(id).level);
      const expectedFloor = rooms.get(id).floorY ?? level.floorY;
      check(Math.abs(room.floorY-expectedFloor) < 1e-6, `Navigation room ${id} floorY differs from its room.`);
      for (const field of ['walkable', 'holes']) {
        const polygons = array(room[field], `navigation ${id}.${field}`, field === 'walkable' && navigation.mode !== 'orbit-only');
        for (const points of polygons) polygon(points, `navigation ${id}.${field}`);
      }
    }
    for (const portal of array(navigation.portals, 'navigation.portals')) {
      check(rooms.has(portal?.a) && rooms.has(portal?.b) && portal.a !== portal.b, 'Navigation portal names unknown or same rooms.');
      check(rooms.get(portal.a).portals.some(p => p.to === portal.b && p.walkable !== false) || rooms.get(portal.b).portals.some(p => p.to === portal.a && p.walkable !== false), 'Navigation portal has no walkable manifest portal.');
      check(Array.isArray(portal.segment) && portal.segment.length === 2 && portal.segment.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) && portal.segment[0].some((v,i) => v !== portal.segment[1][i]), 'Navigation portal needs a nonzero XZ segment.');
    }
  }
  if (roomTextureIds !== undefined) {
    for (const [room, ids] of Object.entries(object(roomTextureIds, 'roomTextureIds'))) {
      check(rooms.has(room), `Texture references name unknown room: ${room}`);
      check(Array.isArray(ids) || ids instanceof Set, `Room ${room} textureIds must be an array or Set.`);
      for (const id of ids) check(typeof id === 'string' && Object.hasOwn(manifest.textures, id), `Room ${room} references unknown textureId: ${id}`);
    }
  }
  return manifest;
}

export function sourceLabel(manifest) {
  return manifest.sources?.[0]?.kind === 'synthetic-design-reference' ? 'Synthetic design reference' : 'Source reference image';
}
export function usesPolyHavenAPI(manifest) {
  return manifest.resourceCredit?.provider === 'Poly Haven' && manifest.resourceCredit?.apiDerived === true;
}
