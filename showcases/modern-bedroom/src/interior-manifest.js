export function vector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

export function validateRoomBounds(bounds) {
  if (!vector3(bounds?.min) || !vector3(bounds?.max)
      || bounds.min.some((value, i) => value + 0.5 >= bounds.max[i])) {
    throw new Error('roomBounds must contain Y-up min/max vectors with more than 0.5 m on every axis.');
  }
}

// Per-cloth knobs src/interior-bedcloth.js reads (DEFAULTS there): [min, max, integer?]. Stiffness is physical (N/m for stretch and shear,
// N m for bending rigidity); `compression` is the fraction of the tension stiffness that resists compression; `stretchDamping` and
// `bendDamping` are Rayleigh damping times (s); `damping` is velocity damping (1/s); `airDrag` the quadratic sheet drag (1/m);
// `gripForce` the strongest pinch pull (N); `gripSpeed` the fastest pinch target speed (m/s); `gripParticles` how many particles a pinch holds.
const bedClothRanges = {
  stretchStiffness: [10, 20000], shearStiffness: [0.1, 2000], bendRigidity: [1e-5, 1], compression: [0.02, 1],
  stretchDamping: [0, 0.01], bendDamping: [0, 1], stretchIterations: [1, 16, true],
  friction: [0, 2], damping: [0, 20], airDrag: [0, 60],
  gripParticles: [1, 3, true], gripForce: [0.5, 200], gripSpeed: [0.2, 12], sleepFraction: [0, 0.5],
};
// Keys of the retired velocity-PBD solver. The XPBD solver ignores them, so on a simulated cloth they would be silent no-ops and are
// rejected. A `fixed` cloth never runs the solver; the shipped duvet block still carries them, so there they stay range-checked.
const legacyBedClothRanges = {
  stretch: [0.05, 1], shear: [0, 1], bend: [0, 1], bendFlat: [0, 1], iterations: [1, 8, true],
  gripStiffness: [0.02, 1], gripRadius: [0, 6, true],
};

function checkRange(label, field, value, [min, max, integer]) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}: ${field} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}] (got ${typeof value === 'number' ? value : JSON.stringify(value)}).`);
  }
}

function meshPatterns(value, field, optional = false) {
  if (optional && value === undefined) return;
  if (!Array.isArray(value) || (!optional && !value.length) || !value.every(item => typeof item === 'string' && item)) {
    throw new Error(`bedCloth.${field} must be a${optional ? 'n optional' : ' nonempty'} array of mesh names or * / ** globs.`);
  }
}

// Optional runtime bed-cloth block. Shapes only; mesh existence is checked against the loaded GLB.
export function validateBedCloth(config) {
  if (config === undefined) return;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('bedCloth must be an object.');
  if (!Number.isFinite(config.gravity) || config.gravity <= 0 || config.gravity > 30) throw new Error('bedCloth.gravity must be a positive acceleration in m/s² (at most 30).');
  if (!Number.isFinite(config.floorY)) throw new Error('bedCloth.floorY must be the Y-up floor height in metres.');
  if (config.substeps !== undefined && !(Number.isInteger(config.substeps) && config.substeps >= 1 && config.substeps <= 16)) throw new Error('bedCloth.substeps must be an integer from 1 to 16.');
  // contactInterval: collision passes run every N substeps (the solver also alternates self-contact every 2N).
  if (config.contactInterval !== undefined && !(Number.isInteger(config.contactInterval) && config.contactInterval >= 1 && config.contactInterval <= 8)) throw new Error('bedCloth.contactInterval must be an integer from 1 to 8 (substeps between contact passes).');
  // maxStep: per-substep displacement cap of a particle (m).
  if (config.maxStep !== undefined && !(Number.isFinite(config.maxStep) && config.maxStep >= 0.001 && config.maxStep <= 0.05)) throw new Error('bedCloth.maxStep must be 0.001-0.05 m.');
  meshPatterns(config.colliderMeshes, 'colliderMeshes');
  meshPatterns(config.softColliderMeshes, 'softColliderMeshes', true);
  if (!Array.isArray(config.cloths) || !config.cloths.length) throw new Error('bedCloth.cloths must list at least one cloth.');
  const ids = new Set();
  for (const cloth of config.cloths) {
    const label = `bedCloth cloth ${cloth?.id ?? '(unnamed)'}`;
    if (typeof cloth?.id !== 'string' || !cloth.id || ids.has(cloth.id)) throw new Error(`${label}: id must be a unique nonempty string.`);
    ids.add(cloth.id);
    if (typeof cloth.surfaceMesh !== 'string' || !cloth.surfaceMesh || cloth.surfaceMesh.includes('*')) throw new Error(`${label}: surfaceMesh must be one exact mesh name.`);
    meshPatterns(cloth.followMeshes, `${cloth.id}.followMeshes`, true);
    // grid is advisory (the loaded geometry decides); simGrid / simSpacing size the solver.
    for (const [field, min] of [['grid', 2], ['simGrid', 4]]) {
      if (cloth[field] === undefined) continue;
      if (!Array.isArray(cloth[field]) || cloth[field].length !== 2 || !cloth[field].every(value => Number.isInteger(value) && value >= min)) {
        throw new Error(`${label}: ${field} must be two integers of at least ${min}.`);
      }
    }
    if (cloth.simSpacing !== undefined && !(Number.isFinite(cloth.simSpacing) && cloth.simSpacing >= 0.012 && cloth.simSpacing <= 0.25)) throw new Error(`${label}: simSpacing must be 0.012-0.25 m.`);
    if (cloth.simGrid && cloth.simGrid[0] * cloth.simGrid[1] > 20000) throw new Error(`${label}: simGrid is too large for a real-time solver.`);
    if (cloth.loft !== undefined && !(Number.isFinite(cloth.loft) && cloth.loft >= 0 && cloth.loft <= 0.15)) throw new Error(`${label}: loft must be 0-0.15 m.`);
    if (!Number.isFinite(cloth.thickness) || cloth.thickness <= 0 || cloth.thickness > 0.1) throw new Error(`${label}: thickness must be between 0 and 0.1 m.`);
    if (!Number.isFinite(cloth.massPerM2) || cloth.massPerM2 <= 0 || cloth.massPerM2 > 20) throw new Error(`${label}: massPerM2 must be a positive areal density in kg/m².`);
    if (cloth.selfCollision !== undefined && typeof cloth.selfCollision !== 'boolean') throw new Error(`${label}: selfCollision must be a boolean.`);
    // fixed: the cloth is a static surface. It is never pickable, never simulated, and its authored mid-surface
    // acts as the collision surface for the other cloths.
    if (cloth.fixed !== undefined && typeof cloth.fixed !== 'boolean') throw new Error(`${label}: fixed must be a boolean.`);
    for (const [field, range] of Object.entries(bedClothRanges)) {
      if (cloth[field] !== undefined) checkRange(label, field, cloth[field], range);
    }
    for (const [field, range] of Object.entries(legacyBedClothRanges)) {
      if (cloth[field] === undefined) continue;
      if (!cloth.fixed) throw new Error(`${label}: ${field} belongs to the retired velocity-PBD solver and is ignored; use stretchStiffness, shearStiffness, bendRigidity, stretchIterations, gripParticles or gripForce.`);
      checkRange(label, field, cloth[field], range);
    }
  }
}

function finiteIn(value, min, max) { return Number.isFinite(value) && value >= min && value <= max; }

// Optional runtime shading block: reflection-probe parallax correction and the balance of the dynamic cloth's probe lighting.
// All values are calibrated against the native render; shapes only here.
export function validateShading(shading, lighting) {
  if (shading === undefined) return;
  if (!shading || typeof shading !== 'object' || Array.isArray(shading)) throw new Error('shading must be an object.');
  if (shading.probe !== undefined) {
    const probe = shading.probe;
    if (!probe || typeof probe !== 'object' || !finiteIn(probe.specularScale, 0, 4)) throw new Error('shading.probe needs a specularScale in [0, 4].');
    if (!vector3(lighting?.probe?.position)) throw new Error('shading.probe requires lighting.probe.position (the Y-up capture point of the reflection probe).');
  }
  if (shading.starvedIslands !== undefined) {
    const starved = shading.starvedIslands;
    if (!Array.isArray(starved?.meshes) || !starved.meshes.length || !starved.meshes.every(item => typeof item === 'string' && item)) {
      throw new Error('shading.starvedIslands.meshes must be a nonempty array of mesh names or * / ** globs.');
    }
    if (!finiteIn(starved.threshold, 0.001, 0.5) || !finiteIn(starved.groove, 0, 1)) throw new Error('shading.starvedIslands needs a threshold in [0.001, 0.5] and a groove albedo factor in [0, 1].');
  }
  if (shading.cloth !== undefined) {
    for (const layer of ['drape', 'sheer']) {
      const config = shading.cloth?.[layer];
      if (!config || !finiteIn(config.saturation, 0, 1) || !finiteIn(config.gain, 0.01, 8) || !finiteIn(config.translucency, 0, 2)
          || !vector3(config.tint) || config.tint.some(value => !(value > 0 && value <= 4))
          || !finiteIn(config.fold?.occlusion, 0, 1) || !finiteIn(config.fold?.radius, 0.005, 2) || !finiteIn(config.fold?.ridge, 0, 1)) {
        throw new Error(`shading.cloth.${layer} needs saturation in [0, 1], gain in [0.01, 8], translucency in [0, 2], a positive RGB tint and fold { occlusion in [0, 1], radius in [0.005, 2] m, ridge in [0, 1] }.`);
      }
    }
  }
  // Per-material texture sampler overrides for weaves the source view cannot resolve.
  if (shading.samplers !== undefined) {
    if (!Array.isArray(shading.samplers) || !shading.samplers.length) {
      throw new Error('shading.samplers must be a nonempty array of sampler overrides.');
    }
    for (const rule of shading.samplers) {
      if (!Array.isArray(rule?.meshes) || !rule.meshes.length || !rule.meshes.every(item => typeof item === 'string' && item)) {
        throw new Error('shading.samplers[].meshes must be a nonempty array of mesh names or * / ** globs.');
      }
      if (!finiteIn(rule.bias, -6, 0)) throw new Error('shading.samplers[].bias must be a LOD bias in [-6, 0].');
      if (rule.anisotropy !== undefined && !(Number.isInteger(rule.anisotropy) && rule.anisotropy >= 1 && rule.anisotropy <= 16)) {
        throw new Error('shading.samplers[].anisotropy must be an integer in [1, 16].');
      }
      if (rule.slots !== undefined && (!Array.isArray(rule.slots) || !rule.slots.length
          || !rule.slots.every(slot => ['map', 'normalMap', 'roughnessMap', 'metalnessMap'].includes(slot)))) {
        throw new Error('shading.samplers[].slots must list map, normalMap, roughnessMap or metalnessMap.');
      }
    }
  }
}

function assetPath(value, field) {
  if (typeof value !== 'string' || !value.startsWith('/assets/') || /[\\?#\s]/.test(value)) {
    throw new Error(`Missing local /assets/ URL: ${field}`);
  }
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new Error(`Invalid asset URL: ${field}`); }
  if (decoded.split('/').some(part => part === '.' || part === '..') || /[\\?#]/.test(decoded)) {
    throw new Error(`Asset URL must stay inside /assets/: ${field}`);
  }
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 2 || manifest.lighting?.model !== 'ambient-bake+shadowed-sun-v1') {
    throw new Error('Scene requires schema 2 SUN-free ambient atlases and ambient-bake+shadowed-sun-v1 lighting; full-sun bakes cannot be combined with a runtime sun.');
  }
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) throw new Error('Scene title is required.');
  if (!Array.isArray(manifest.sourceImageSize) || manifest.sourceImageSize.length !== 2
      || !manifest.sourceImageSize.every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('sourceImageSize must contain the source image width and height in pixels.');
  }
  for (const field of ['sourceImage', 'model', 'portableModel', 'blender', 'environment']) assetPath(manifest[field], field);
  if (manifest.background != null) {
    assetPath(manifest.background, 'background');
    if (!Number.isFinite(manifest.backgroundIntensity) || manifest.backgroundIntensity < 0) throw new Error('Background intensity is invalid.');
    if (!/\.(hdr|exr)$/i.test(manifest.background)) throw new Error('Background must be an HDR or EXR image.');
  }
  if (!manifest.views || typeof manifest.views !== 'object' || Array.isArray(manifest.views)) throw new Error('views must be an object of named camera poses (it may be empty).');
  if (Object.hasOwn(manifest.views, 'source')) throw new Error('The source view is implicit in camera; do not duplicate it in views.');
  for (const [name, pose] of [['source', manifest.camera], ...Object.entries(manifest.views)]) {
    if (!name.trim() || !vector3(pose?.position) || !vector3(pose?.target)) throw new Error(`View ${name} needs Y-up position and target vectors.`);
    if (pose.position.every((value, i) => value === pose.target[i])) throw new Error(`View ${name} has position equal to its target.`);
    const fov = pose.fov ?? manifest.camera?.fov;
    if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) throw new Error(`Invalid FOV: ${name}`);
    if (pose.label !== undefined && typeof pose.label !== 'string') throw new Error(`Invalid view label: ${name}`);
  }
  validateRoomBounds(manifest.roomBounds);
  const sun = manifest.lighting.sun;
  if (sun !== null) {
    for (const key of ['position', 'target', 'color']) if (!vector3(sun?.[key])) throw new Error(`Sun config is missing ${key}; use lighting.sun: null when there is no authored sun.`);
    if (sun.position.every((value, i) => value === sun.target[i]) || sun.color.some(value => value < 0)
        || !Number.isFinite(sun.intensity) || sun.intensity < 0
        || !Number.isInteger(sun.shadowMapSize) || sun.shadowMapSize < 512 || sun.shadowMapSize > 4096) {
      throw new Error('Sun direction, color, intensity or shadow map size is invalid.');
    }
  }
  const pendants = manifest.lighting.pendants ?? [];
  if (!Array.isArray(pendants) || (pendants.length && manifest.lighting.pendantsExcludedFromBake !== true)) {
    throw new Error('Switchable pendants require an array and lamp-free ambient/probe transport.');
  }
  const pendantIds = new Set();
  for (const lamp of pendants) {
    if (!lamp || typeof lamp.id !== 'string' || !lamp.id || pendantIds.has(lamp.id)
        || !vector3(lamp.position) || !vector3(lamp.target) || !vector3(lamp.color)
        || lamp.position.every((value, i) => value === lamp.target[i])
        || lamp.color.some(value => value < 0)
        || !Number.isFinite(lamp.intensity) || lamp.intensity <= 0
        || !Number.isFinite(lamp.distance) || lamp.distance <= 0
        || !Number.isFinite(lamp.angle) || lamp.angle <= 0 || lamp.angle >= Math.PI/2
        || !Number.isFinite(lamp.penumbra) || lamp.penumbra < 0 || lamp.penumbra > 1
        || lamp.decay !== 2 || typeof lamp.bulbMesh !== 'string' || !lamp.bulbMesh) {
      throw new Error('Pendant IDs, position, cone, physical falloff or bulb reference are invalid.');
    }
    pendantIds.add(lamp.id);
  }
  if (manifest.toneMapping !== 'neutral' || !Number.isFinite(manifest.exposure) || manifest.exposure <= 0) throw new Error('Need Neutral tone mapping and a valid exposure.');
  if (!Array.isArray(manifest.lightmaps) || !manifest.lightmaps.length) throw new Error('Manifest has no lightmap atlas.');
  const atlasIds = new Set();
  for (const atlas of manifest.lightmaps) {
    if (!atlas || typeof atlas.id !== 'string' || !atlas.id || atlasIds.has(atlas.id)
        || !Number.isFinite(atlas.intensity) || atlas.intensity <= 0) throw new Error('Lightmap atlas is invalid or has a duplicate id.');
    assetPath(atlas.url, `atlas ${atlas.id}`);
    atlasIds.add(atlas.id);
  }
  validateBedCloth(manifest.bedCloth);
  if (manifest.lighting.probe !== undefined && !vector3(manifest.lighting.probe?.position)) throw new Error('lighting.probe.position must be a Y-up point.');
  validateShading(manifest.shading, manifest.lighting);
  return manifest;
}

export function sourceLabel(manifest) {
  return ['synthetic', 'synthetic-design', 'synthetic-design-reference'].includes(manifest.sourceKind)
    ? 'Synthetic design reference' : 'Source reference image';
}

export function usesPolyHavenAPI(manifest) {
  return manifest.resourceCredit?.provider === 'Poly Haven' && manifest.resourceCredit?.apiDerived === true;
}
