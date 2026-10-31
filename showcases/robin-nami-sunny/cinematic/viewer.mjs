import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSoftRig } from '../softbody.mjs';
import { createGarments } from '../garment.mjs';
import { roundChestMasks } from '../chest-field.mjs';
import { createInteraction } from './interaction.mjs';
import { loadSunnyEnvironment } from './sunny-environment.mjs';
import { createSunnyPatrol } from './deck-patrol.mjs';
import { createDeckWalker, gaitPhase, gaitRate } from './deck-walker.mjs';
import { loadNamiActor } from './nami-actor.mjs';
import { COLORWAYS } from './nami-colorways.mjs';
import { collectDisposer } from './resources.mjs';
import { pinSortSpheres } from './bounds.mjs';
import { regionFeel } from './labels.mjs';
import { buildCharacterPanel } from './panels.mjs';
import { createAmbience } from './ambience.mjs';
import { createHalloweenTheme } from './halloween-theme.mjs';
import { createRain } from './rain.mjs';
import { applyNightFill } from './night-fill.mjs';

// Serve the repository root; build with `npm --prefix cinematic run build`.
// Native Blender Z-up is already converted to glTF Y-up by the exporter.
const $ = id => document.getElementById(id);
const canvas = $('character'), variants = ['blue', 'violet', 'halloween'];
const canonicalNames = ['Body', 'BikiniTop', 'BikiniBottom', 'BikiniTieLeft', 'BikiniTieRight', 'EyeIris', 'Hair', 'Sunglasses', 'SunglassesFrame'];
const ROBIN_OUTFITS = [
  { id: 'blue', label: 'Ocean blue', swatch: '#2f6fb5' },
  { id: 'violet', label: 'Violet gingham', swatch: '#7a5bb5' },
  { id: 'halloween', label: 'Halloween', swatch: '#c4561d' },
];
const originalClips = [
  { id: 'StandingIdle', label: 'Stand idle', loop: true },
  { id: 'Walking', label: 'Walk in place', loop: true },
  { id: 'Running', label: 'Run in place', loop: true },
  { id: 'Jump', label: 'Jump', loop: false },
  { id: 'RobinBloomAttack', label: 'Hana Hana · Bloom', loop: false },
  { id: 'RobinClutchAttack', label: 'Hana Hana · Clutch', loop: false },
  { id: 'HairTurnPreview', label: 'Turn · hair lag', loop: true },
];
const NAMI_MODES = [
  { id: 'patrol', label: 'Walk the deck (autonomous)' },
  { id: 'patrol-run', label: 'Run the deck (autonomous)' },
  { id: 'StandingIdle', label: 'Stand idle' },
  { id: 'Walking', label: 'Walk in place' },
  { id: 'Running', label: 'Run in place' },
  { id: 'Jump', label: 'Jump' },
];
const PATROL = Object.freeze({ radius: .75, height: 2, speed: .7 });
const buildStamp = 'robin-nami-sunny-11-moving-film';
const state = { phase: 'loading', outfit: null, outfitTarget: null, clip: 'Walking', time: 0, playing: true, error: null, errors: [], frame: 0, assets: {}, ground: null, clock: 0 };
const loadedClips = {}, frameWaiters = new Set(), pointerEvents = [];
const listeners = new AbortController(), signal = listeners.signal;
const loader = new GLTFLoader();
let scene, renderer, camera, controls, environment, actor, nami, catalog, manifest, topTextures, patrol, robinWalker, ambience, theme, rain;
let rows = [], rowById = new Map(), loadSerial = 0, disposed = false, initialized = false;
let frameHandle = 0, lastTime, nextFrameTime = 0, fpsTime = 0, fpsFrames = 0, seaTime = 0, observer;
let renderQuality = 'auto';
let qualityElapsed = 0, qualityFrames = 0, qualityRecoverTime = 0;
let voyageX = 0, voyageZ = 0;
let view = { name: 'overview', who: null, reach: 0, last: 0 }, followYaw = 0;
let robinMode = 'patrol'; // 'patrol' walks or runs the deck loop; 'clip' plays a chosen motion
let robinGait = 'Walking'; // 'Walking' | 'Running' while patrolling
const robinAnchor = new THREE.Group();
robinAnchor.name = 'Robin deck position';
const followWorld = new THREE.Vector3(), scratchWorld = new THREE.Vector3(), scratchDelta = new THREE.Vector3();
const robinPoint = { x: 0, z: 0 }, namiPoint = { x: 0, z: 0 }, robinPoints = [robinPoint], namiPoints = [namiPoint];
const interactionModes = { robin: 'squeeze', nami: 'squeeze' };
// Soft-tissue deformation is invisible from far away, so skip the vertex pass beyond this range.
const DEFORM_RANGE = 8;
const wantsDeform = (anchor, interaction) => interaction.active || anchor.getWorldPosition(scratchWorld).distanceTo(camera.position) < DEFORM_RANGE;

buildCharacterPanel($('panel-robin'), { id: 'robin', name: 'Robin', outfits: ROBIN_OUTFITS, timeline: true, replay: true,
  outfitNote: 'Three outfits. The straps release, fabric folds and recolors, then reseats. Motion and deck position are kept.' });
buildCharacterPanel($('panel-nami'), { id: 'nami', name: 'Nami', outfits: COLORWAYS, timeline: false, replay: false,
  outfitNote: 'Seven colorways, including a Halloween witch costume with hat. Her top folds, recolors and reseats; jeans and sandals change with it.' });

function showLoading(title, message, mode = 'startup') {
  $('loading').dataset.mode = mode; $('loading-title').textContent = title;
  $('loading-message').textContent = message; $('loading').hidden = false;
}
function hideLoading() {
  $('loading').hidden = true; delete document.body.dataset.starting;
  document.querySelector('.stage').inert = false; canvas.setAttribute('aria-busy', 'false');
}

function recordError(error) {
  if (disposed) return;
  actor?.interaction.releaseAll(); nami?.interaction.releaseAll();
  state.error = error instanceof Error ? error.message : String(error);
  nami?.pause();
  state.errors.push(state.error); state.playing = false; state.phase = actor ? 'error' : 'failed';
  $('error-message').textContent = `Could not load or play the scene: ${state.error}. Check the local files and reload.`;
  state.outfitTarget = null; $('error').hidden = false; hideLoading(); setPanel(true); updateUI();
}
function requireReady() {
  if (disposed) throw new Error('The scene has been closed.');
  if (!initialized || !actor || !environment || !nami || state.phase === 'loading') throw new Error('The scene is not ready yet.');
}
async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
function meshURL(variant, extension = 'glb') { return `../native/pinoc/odyssey/export-${variant}/scene.${extension}`; }
function sidecarURL(variant) { return `../native/pinoc/odyssey/export-${variant}/softbody.json`; }
function saveRest(root) {
  const transforms = [], morphs = [];
  root.traverse(node => {
    transforms.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() });
    if (node.morphTargetInfluences) morphs.push({ node, weights: [...node.morphTargetInfluences] });
  });
  return () => {
    for (const { node, position, quaternion, scale } of transforms) {
      node.position.copy(position); node.quaternion.copy(quaternion); node.scale.copy(scale);
    }
    for (const { node, weights } of morphs) weights.forEach((weight, i) => { node.morphTargetInfluences[i] = weight; });
  };
}
function releaseActor(value) {
  if (!value) return;
  value.interaction?.dispose(); value.garments?.dispose(); value.rig?.dispose();
  value.mixer?.stopAllAction(); value.mixer?.uncacheRoot(value.entity);
  value.entity?.removeFromParent(); value.releaseResources?.();
}
async function loadTopTextures() {
  // Only alternate CLOTH atlases. Never load the studio's old Body atlas: each
  // complete Odyssey GLB owns its repaired skin, eyes and other outfit materials.
  const textureLoader = new THREE.TextureLoader();
  const paths = { violet: '../materials/violet/BikiniTop-colour.png', halloween: '../materials/halloween/BikiniTop-colour.png' };
  const results = await Promise.allSettled(Object.values(paths).map(path => textureLoader.loadAsync(path)));
  const failure = results.find(result => result.status === 'rejected');
  if (failure || disposed) {
    for (const result of results) if (result.status === 'fulfilled') result.value.dispose();
    throw failure?.reason ?? new Error('The scene has been closed.');
  }
  return Object.fromEntries(Object.keys(paths).map((key, i) => {
    const texture = results[i].value;
    texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return [key, texture];
  }));
}
function bindClip(value, id) {
  const clip = value.tracks.get(id);
  if (!clip) throw new Error(`GLB ${value.variant} is missing animation ${id}`);
  value.mixer.stopAllAction(); value.restore();
  value.action = value.mixer.clipAction(clip);
  // Mixer never owns a second clock or repeat policy: the explicit timeline does.
  value.action.reset().setLoop(THREE.LoopOnce, 1);
  value.action.clampWhenFinished = true; value.action.play();
  // Legacy FX remain embedded in the preserved GLBs, but are never admitted or drawn.
  for (const node of value.fxNodes) node.visible = false;
}
function sampleActor(value, seconds, updateWorld = true) {
  value.action.paused = false; value.action.enabled = true;
  value.mixer.setTime(seconds);
  if (updateWorld) value.entity.updateWorldMatrix(true, true);
}
async function setOutfit(variant) {
  if (!variants.includes(variant)) throw new Error(`Invalid Robin outfit: ${variant}`);
  if (disposed) throw new Error('The scene has been closed.');
  if (!scene || !catalog || !topTextures) throw new Error('Wait for the scene to initialise before changing outfit.');
  if (state.phase === 'changing-outfit' || (actor?.variant === variant && state.phase !== 'loading')) return snapshot();
  const serial = ++loadSerial;
  actor?.interaction.releaseAll(); state.phase = initialized ? 'changing-outfit' : 'loading'; state.outfitTarget = variant;
  if (initialized) showLoading('Changing Robin’s outfit', 'Loading the native outfit. Her motion continues…', 'outfit');
  updateUI();
  let next, restoreEndpoint;
  try {
    // Retain/dispose a successful GLB even when its required sidecar fails.
    const results = await Promise.allSettled([loader.loadAsync(meshURL(variant)), json(sidecarURL(variant))]);
    if (results[0].status === 'fulfilled') {
      const gltf = results[0].value;
      next = { entity: gltf.scene, variant, releaseResources: collectDisposer(gltf.scene), tracks: new Map() };
      for (const clip of gltf.animations) {
        if (!rowById.has(clip.name)) continue;
        if (next.tracks.has(clip.name)) throw new Error(`Duplicate animation: ${clip.name}`);
        next.tracks.set(clip.name, clip);
      }
    }
    if (serial !== loadSerial || disposed) { releaseActor(next); return snapshot(); }
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw new Error(`Could not load the ${variant} GLB / soft-body masks: ${failure.reason?.message ?? failure.reason}`);
    const missing = rows.filter(row => !next.tracks.has(row.id));
    if (missing.length) throw new Error(`GLB ${variant} is missing ${missing.length} clips: ${missing.map(row => row.id).join(', ')}`);
    next.entity.updateMatrixWorld(true);
    next.meshes = canonicalNames.map(name => {
      const found = [];
      next.entity.traverse(node => { if (node.isMesh && node.name === name) found.push(node); });
      if (found.length !== 1) throw new Error(`GLB ${variant}: body mesh ${name} must exist exactly once.`);
      return found[0];
    });
    for (const mesh of next.meshes) {
      mesh.castShadow = true; mesh.receiveShadow = true;
      if (mesh.name.startsWith('Bikini')) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(material)) if (value?.isTexture) value.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      }
    }
    const bottom = next.meshes.find(mesh => mesh.name === 'BikiniBottom');
    if (bottom.geometry.hasAttribute('tangent')) {
      bottom.geometry.deleteAttribute('tangent');
      if (bottom.material.normalScale) bottom.material.normalScale.y *= -1;
      if (bottom.material.clearcoatNormalScale) bottom.material.clearcoatNormalScale.y *= -1;
    }
    next.restore = saveRest(next.entity);
    next.fxNodes = [];
    next.entity.traverse(node => { if (/^FX_.*_visibility$/.test(node.name)) next.fxNodes.push(node); });
    const sidecar = results[1].value;
    if (!Array.isArray(sidecar?.meshes) || !sidecar.meshes.length) throw new Error(`Invalid soft-body masks: ${sidecarURL(variant)}`);
    if (sidecar.meshes.some(spec => !canonicalNames.includes(spec.name))) throw new Error('The soft-body sidecar may only contain Robin meshes, not summoned limbs.');
    const round = roundChestMasks(next.entity, sidecar);
    next.rig = createSoftRig(next.entity, round.sidecar);
    const cupMasks = round.original.BikiniTop;
    if (!cupMasks) throw new Error('Missing the original chest masks on BikiniTop.');
    const top = next.meshes.find(mesh => mesh.name === 'BikiniTop');
    next.garments = createGarments({ bikini: top, rig: next.rig,
      membership: { 1: cupMasks['chest-left'], [-1]: cupMasks['chest-right'] },
      violetTexture: variant === 'violet' ? top.material.map : topTextures.violet,
      halloweenTexture: variant === 'halloween' ? top.material.map : topTextures.halloween,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    next.pinBounds = pinSortSpheres(next.rig);
    // The staged native actor is offscreen; only the visible actor plays the change.
    if (variant !== 'blue') { next.garments.transformTo(variant); next.garments.reset(); }
    next.mixer = new THREE.AnimationMixer(next.entity);
    bindClip(next, state.clip); sampleActor(next, Math.min(state.time, next.tracks.get(state.clip).duration));
    next.garments.apply();
    const staged = next;
    next.interaction = createInteraction({ canvas, camera, controls, root: next.entity, meshes: next.meshes,
      rig: next.rig, garments: next.garments, pointerEvents, owner: 'Robin', initialMode: interactionModes.robin,
      enabled: () => actor === staged && initialized && state.phase === 'ready' && !disposed,
      occluded: (raycaster, distance) => (nami?.interaction.probe(raycaster) ?? Infinity) < distance,
      onStatus: text => { $('robin-interaction-status').textContent = text; },
      onRegion: id => { $('robin-region').value = id; refreshProfile('robin'); } });
    const previous = actor;
    if (initialized && previous) {
      // Borrow the TARGET native atlas until the visible garment has fully reseated.
      // Its owner stays staged and alive; the old actor's captured disposer never owns it.
      const endpoint = variant === 'blue' ? previous.meshes.find(mesh => mesh.name === 'BikiniTop').material
        : previous.garments.uniforms[variant === 'violet' ? 'uVariant' : 'uHalloween'];
      const key = variant === 'blue' ? 'map' : 'value', original = endpoint[key];
      endpoint[key] = top.material.map;
      restoreEndpoint = () => { endpoint[key] = original; };
      showLoading('Changing Robin’s outfit', 'Releasing straps · folding · recoloring · reseating', 'outfit');
      previous.garments.transformTo(variant);
      while (previous.garments.transitioning) {
        await afterFrame();
        if (serial !== loadSerial || disposed) {
          restoreEndpoint(); restoreEndpoint = null; releaseActor(next); return snapshot();
        }
      }
      restoreEndpoint(); restoreEndpoint = null;
    }
    actor = next; next = null; robinAnchor.add(actor.entity);
    state.outfit = variant;
    loadedClips[variant] = [...actor.tracks].map(([name, clip]) => ({ name, duration: clip.duration }));
    state.assets.mesh = { path: meshURL(variant), loaded: true, variant };
    state.assets.softbody = { path: sidecarURL(variant), loaded: true, regions: [...actor.rig.regions.keys()] };
    releaseActor(previous); populateClips(); sample(state.time); refreshProfile('robin');
    state.error = null; state.outfitTarget = null; $('error').hidden = true; state.phase = initialized ? 'ready' : 'loading';
    if (initialized) hideLoading();
    $('robin-interaction-status').textContent = 'Ready · 9 soft regions and the top fabric';
    updateUI(); return snapshot();
  } catch (error) {
    restoreEndpoint?.();
    releaseActor(next);
    if (serial === loadSerial && !disposed) recordError(error);
    throw error;
  }
}
function duration() { return actor?.tracks.get(state.clip)?.duration ?? 0; }
function robinPhase() { return gaitPhase(robinGait, robinWalker.position.distance) % duration(); }
const patrolOption = () => robinMode === 'patrol' ? (robinGait === 'Running' ? 'patrol-run' : 'patrol') : state.clip;
function placeRobin() {
  const p = robinWalker.position;
  robinAnchor.position.set(p.x, p.y, p.z); robinAnchor.rotation.y = p.yaw;
  robinAnchor.updateWorldMatrix(true, false);
}
function sample(seconds, updateWorld = true) {
  state.time = Math.max(0, Math.min(seconds, duration()));
  if (actor) sampleActor(actor, state.time, updateWorld);
  updateTimeline();
}
function resetSoftState(keepGarmentTransition = false) {
  actor.interaction.releaseAll(); actor.rig.reset();
  if (!keepGarmentTransition) actor.garments.reset();
}
function enterPatrol(gait = 'Walking') {
  requireReady();
  resetSoftState(); robinMode = 'patrol'; robinGait = gait; state.clip = gait; bindClip(actor, gait);
  state.playing = true; lastTime = undefined; placeRobin(); sample(robinPhase()); actor.garments.apply();
  updateUI(); return snapshot();
}
function selectClip(id) {
  requireReady();
  if (id === 'patrol') return enterPatrol('Walking');
  if (id === 'patrol-run') return enterPatrol('Running');
  if (!actor.tracks.has(id)) throw new Error(`No clip ${id}`);
  robinMode = 'clip'; state.playing = false; resetSoftState(); bindClip(actor, id); state.clip = id;
  sample(0); actor.garments.apply();
  updateUI(); return snapshot();
}
function play() {
  requireReady();
  if (robinMode === 'clip' && state.time >= duration()) { resetSoftState(); sample(0); }
  state.playing = true; lastTime = undefined; updateUI(); return snapshot();
}
function pause() { actor?.interaction.releaseAll(); state.playing = false; updateUI(); return snapshot(); }
function seek(seconds) {
  requireReady();
  if (!Number.isFinite(seconds)) throw new Error('Time must be a finite number.');
  state.playing = false; resetSoftState();
  if (robinMode === 'patrol') { robinWalker.set(seconds); placeRobin(); sample(robinPhase()); } else sample(seconds);
  actor.garments.apply(); updateUI(); return snapshot();
}
function replay() {
  if (robinMode === 'patrol') { requireReady(); robinWalker.reset(); placeRobin(); resetSoftState(); return play(); }
  seek(0); return play();
}
function reset() {
  requireReady(); enterPatrol();
  $('robin-interaction-status').textContent = 'Reset · soft tissue at rest, outfit kept';
  return snapshot();
}

// Character views stay in the character's own frame (+Z is where she faces).
// Follow is close enough for direct touch; the clearance guard avoids deck obstacles.
// Overview follows the voyage without rocking.
const views = {
  overview: { position: [8, 7, 15], target: [0, 1, 1], fov: 50 },
  follow: { position: [0, 1.35, 3.2], target: [0, .9, 0], fov: 54 },
  front: { position: [0, .96, 3.8], target: [0, .9, 0], fov: 32 },
  quarter: { position: [2.25, 1.15, 3.4], target: [0, .9, 0], fov: 32 },
  profile: { position: [3.6, 1.15, 0], target: [0, .9, 0], fov: 32 },
  rear: { position: [0, .96, -2.4], target: [0, .9, 0], fov: 44 },
  torso: { position: [0, 1.25, 1.24], target: [0, 1.25, 0], fov: 30 },
  hips: { position: [0, 1.035, -1.24], target: [0, 1.035, 0], fov: 30 },
  face: { position: [0, 1.61, .73], target: [0, 1.605, 0], fov: 30 },
  grab: { position: [2.7, 1.7, 4.5], target: [0, .9, 1.1], fov: 42 },
  skill: { position: [4.2, 3.8, 7.4], target: [0, 1.1, 2.5], fov: 45 },
  skillSide: { position: [7, 3, 2.4], target: [0, 1.2, 2.4], fov: 54 },
  wide: { position: [8, 6.5, 15], target: [0, 3.6, 2.5], fov: 60 },
};
const characterAnchor = who => who === 'robin' ? robinAnchor : who === 'nami' ? nami?.anchor : null;
function updateCameraProjection(aspectChanged = false) {
  const follow = view.name === 'follow';
  const aspectScale = follow ? 1 : Math.min(1, camera.aspect);
  // A clearance pull-in must not magnify the body out of the frame. User zoom
  // changes the wanted reach too, so its intended magnification is preserved.
  const clearanceScale = follow && view.last > 1e-6 ? Math.max(1, view.reach / view.last) : 1;
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(views[view.name].fov) / 2) * clearanceScale / aspectScale));
  if (aspectChanged || Math.abs(camera.fov - fov) > .001) {
    camera.fov = fov; camera.updateProjectionMatrix();
  }
}
function updateCameraAspect() {
  if (!camera) return;
  const rect = canvas.getBoundingClientRect();
  camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
  // Auto changes only raster resolution. Geometry, waves, rain and interactions stay intact.
  const cap = Math.min(devicePixelRatio, 1.5, Math.sqrt(3_000_000 / Math.max(1, rect.width * rect.height)));
  const ratio = renderQuality === 'native' ? Math.min(devicePixelRatio, 2)
    : !initialized ? cap : Math.min(cap, Math.max(Math.min(cap, .75), renderer.getPixelRatio()));
  if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
  updateCameraProjection(true);
  renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
}
function adaptResolution(dt) {
  if (renderQuality !== 'auto' || dt <= 0) return;
  qualityElapsed += dt; qualityFrames++;
  if (qualityElapsed < 1.5) return;
  const averageMs = qualityElapsed * 1000 / qualityFrames;
  qualityRecoverTime += qualityElapsed;
  const rect = canvas.getBoundingClientRect();
  const cap = Math.min(devicePixelRatio, 1.5, Math.sqrt(3_000_000 / Math.max(1, rect.width * rect.height)));
  const current = renderer.getPixelRatio();
  let next = current;
  if (averageMs > 20) {
    next = Math.max(Math.min(cap, .75), current * Math.sqrt(17 / averageMs));
    qualityRecoverTime = 0;
  } else if (averageMs < 17.5 && qualityRecoverTime >= 10) {
    next = Math.min(cap, current * 1.04);
    qualityRecoverTime = 0;
  }
  if (Math.abs(next - current) > .005) renderer.setPixelRatio(next);
  qualityElapsed = 0; qualityFrames = 0;
}
const WORLD_UP = new THREE.Vector3(0, 1, 0), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
// A low camera must not end up inside the cabin, mast or planters while its character walks past
// them (above 2.2 m nothing on the lawn can block it). `view.reach` is the horizontal distance the
// user wants; the camera is pulled in to the largest clear distance and eases back out when free.
function constrainReach(targetWorld, positionWorld, dt) {
  if (!patrol) return;
  const t = environment.deck.worldToLocal(tmpA.copy(targetWorld)), p = environment.deck.worldToLocal(tmpB.copy(positionWorld));
  const dx = p.x - t.x, dz = p.z - t.z, length = Math.hypot(dx, dz);
  if (length < 1e-6 || p.y > 2.2) { view.reach = view.last = length; return; }
  // Follow's compensated projection represents the wanted reach, so user dolly
  // scales that reach rather than replacing it with the pulled-in distance.
  if (Math.abs(length - view.last) > .03) {
    view.reach = view.name === 'follow' && view.last > 1e-6 ? view.reach * length / view.last : length;
  }
  const ux = dx / length, uz = dz / length;
  let free = Math.min(view.reach, 1.2);
  for (let d = 1.2; d < view.reach + .15; d += .15) {
    const reach = Math.min(d, view.reach);
    if (patrol.surfaceClearance(t.x + ux * reach, t.z + uz * reach) < .35) break;
    free = reach;
  }
  const next = length > free ? free : Math.min(view.reach, free, length + 1.5 * dt);
  view.last = next;
  if (Math.abs(next - length) > 1e-4) positionWorld.copy(environment.deck.localToWorld(tmpB.set(t.x + ux * next, p.y, t.z + uz * next)));
}
function setCamera(name, who = view.who) {
  const preset = views[name]; if (!preset || !controls) throw new Error(`Camera view unavailable: ${name}`);
  const anchor = name === 'overview' ? null : characterAnchor(who);
  if (name !== 'overview' && !anchor) throw new Error(`Camera view ${name} needs a loaded character (robin or nami), got ${who}`);
  actor?.interaction.releaseAll(); nami?.interaction.releaseAll();
  view = { name, who: anchor ? who : null, reach: 0, last: 0 };
  const damping = controls.enableDamping; controls.enableDamping = false;
  const target = new THREE.Vector3().fromArray(preset.target), position = new THREE.Vector3().fromArray(preset.position);
  if (anchor) {
    anchor.updateWorldMatrix(true, false);
    anchor.localToWorld(target); anchor.localToWorld(position);
    view.last = view.reach = Math.hypot(position.x - target.x, position.z - target.z);
    constrainReach(target, position, 0);
    anchor.getWorldPosition(followWorld); followYaw = anchor.rotation.y;
  } else if (environment) {
    target.x += environment.voyage.x; target.z += environment.voyage.z;
    position.x += environment.voyage.x; position.z += environment.voyage.z;
  }
  camera.position.copy(position); controls.target.copy(target); controls.update(); controls.enableDamping = damping;
  document.querySelector('.stage').classList.toggle('face-view', name === 'face');
  document.querySelector('.stage').classList.toggle('ability-view', ['skill', 'wide', 'skillSide'].includes(name));
  updateCameraButtons(); updateCameraAspect(); return snapshot();
}
function updateCameraButtons() {
  const focus = view.name === 'overview' ? 'overview' : view.name === 'follow' ? view.who : null;
  document.querySelectorAll('[data-focus]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.focus === focus)));
  document.querySelectorAll('[data-character][data-view]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.character === view.who && button.dataset.view === view.name)));
}
function selectTab(tab) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(`panel-${button.dataset.tab}`).hidden = !selected;
  });
}
function actorPoseSnapshot() {
  const rig = actor?.entity.getObjectByName('RobinRig'); if (!rig) return null;
  let checksum = 2166136261, nodes = 0, finite = true, scaleDeviation = 0, quaternionDeviation = 0;
  rig.traverse(node => {
    nodes++;
    const p = node.position, q = node.quaternion, s = node.scale;
    for (const value of [p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z]) {
      finite &&= Number.isFinite(value); checksum = Math.imul(checksum ^ Math.round(value * 1e6), 16777619);
    }
    scaleDeviation = Math.max(scaleDeviation, Math.abs(s.x - 1), Math.abs(s.y - 1), Math.abs(s.z - 1));
    quaternionDeviation = Math.max(quaternionDeviation, Math.abs(q.length() - 1));
  });
  return { nodes, finite, scaleDeviation, unitBoneDeviation: scaleDeviation, quaternionDeviation, localPoseChecksum: (checksum >>> 0).toString(16), precision: 1e-6 };
}
function robinSnapshot() {
  return {
    mode: robinMode, outfit: state.outfit, clip: state.clip, time: state.time, duration: duration(), playing: state.playing,
    position: robinAnchor.position.toArray(), yaw: robinAnchor.rotation.y, blocked: robinWalker?.blocked ?? false,
    held: actor?.interaction.active ?? false, pose: actorPoseSnapshot(),
    walker: robinWalker ? { seconds: robinWalker.seconds, distance: robinWalker.position.distance } : null,
    interaction: actor ? { mode: interactionModes.robin, contacts: actor.interaction.active ? 1 : 0, regions: [...actor.rig.regions.keys()] } : null,
  };
}
function snapshot() {
  const offset = camera && controls ? camera.position.clone().sub(controls.target) : null;
  return {
    build: buildStamp, phase: state.phase, ready: state.phase === 'ready', error: state.error, errors: [...state.errors],
    outfit: state.outfit, clip: state.clip, time: state.time, duration: duration(), playing: state.playing, frame: state.frame,
    catalogClips: rows.map(row => row.id), loadedClips: structuredClone(loadedClips), assets: structuredClone(state.assets), ground: structuredClone(state.ground),
    robin: robinSnapshot(), nami: nami?.snapshot() ?? null, actorPose: actorPoseSnapshot(), source: catalog?.source ?? null,
    camera: controls ? { name: view.name, who: view.who, yaw: THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z)), pitch: THREE.MathUtils.radToDeg(Math.asin(offset.y / offset.length())), distance: offset.length(), target: controls.target.toArray(), position: camera.position.toArray(), fov: camera.fov, horizontalFov: view.name !== 'follow' && camera.aspect < 1 } : null,
    scene: environment?.snapshot() ?? null, ambience: ambience?.snapshot() ?? null,
    pointerEvents: pointerEvents.map(event => ({ ...event })),
    rendering: renderer ? { backend: 'webgl2', depth: true, cameraCount: 1, sortObjects: renderer.sortObjects, stockSkinning: true, shadows: renderer.shadowMap.enabled, quality: renderQuality, pixelRatio: renderer.getPixelRatio(), maxFrameRate: 60 } : null,
    packages: { three: '0.186.1' }, assetManifest: manifest?.schema ?? null
  };
}
function afterFrame() {
  if (disposed) return Promise.reject(new Error('The scene has been closed.'));
  return new Promise((resolve, reject) => frameWaiters.add({ resolve, reject }));
}
function populateClips() {
  const groups = new Map();
  const all = [{ id: 'patrol', label: 'Walk the deck (autonomous)', group: 'Deck' }, { id: 'patrol-run', label: 'Run the deck (autonomous)', group: 'Deck' }, ...rows];
  $('robin-animation').replaceChildren();
  for (const row of all) {
    const name = row.group ?? 'Basic motions';
    if (!groups.has(name)) { const group = document.createElement('optgroup'); group.label = name; groups.set(name, group); $('robin-animation').append(group); }
    const option = document.createElement('option'); option.value = row.id; option.textContent = row.label; groups.get(name).append(option);
  }
  $('robin-animation').value = patrolOption();
}
function updateTimeline() {
  const patrolling = robinMode === 'patrol';
  $('robin-timeline-box').hidden = patrolling;
  if (patrolling) return;
  $('robin-timeline').max = String(duration()); $('robin-timeline').value = String(state.time);
  $('robin-time').textContent = `${state.time.toFixed(2)} / ${duration().toFixed(2)} s`;
}
function refreshProfile(who) {
  const rig = who === 'robin' ? actor?.rig : nami?.rig;
  const id = $(`${who}-region`).value, profile = rig?.regions.get(id)?.profile;
  if (!profile) return;
  $(`${who}-frequency`).textContent = `${profile.frequency.toFixed(1)} Hz`; $(`${who}-damping`).textContent = profile.dampingRatio.toFixed(2);
  $(`${who}-tissue`).textContent = regionFeel(id);
}
function setMode(value, who = 'robin') {
  requireReady();
  if (who === 'robin') actor.interaction.setMode(value); else nami.setInteractionMode(value);
  interactionModes[who] = value;
  document.querySelectorAll(`[data-character="${who}"][data-mode]`).forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === value)));
  $(`${who}-interaction-status`).textContent = value === 'fabric' ? 'Drag the top by its strap or panel; release to let it settle.' : value === 'grab' ? 'Hold and pull a soft region; release for the elastic rebound.' : 'Press and hold a region to squeeze; drag lightly to change direction.';
  return snapshot();
}
function focusRegion(who, id) {
  setCamera(id.startsWith('hips') ? 'hips' : id.startsWith('cheek') ? 'face' : 'torso', who);
}
function namiAction(method, ...args) {
  requireReady();
  const result = nami[method](...args); updateUI();
  return result?.started === undefined ? snapshot() : result;
}
function updateUI() {
  const robinBusy = disposed || !initialized || state.phase === 'loading' || state.phase === 'changing-outfit' || !actor || !environment;
  const namiBusy = disposed || !initialized || !nami;
  document.querySelectorAll('#panel-robin button, #panel-robin select, #panel-robin input').forEach(control => { control.disabled = robinBusy; });
  document.querySelectorAll('#panel-nami button, #panel-nami select, #panel-nami input').forEach(control => { control.disabled = namiBusy; });
  document.querySelectorAll('[data-focus]').forEach(control => { control.disabled = robinBusy || namiBusy || (control.dataset.focus === 'robin' && !actor) || (control.dataset.focus === 'nami' && !nami); });
  document.querySelectorAll('[data-character="robin"][data-outfit]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.outfit === (state.outfitTarget ?? state.outfit))));
  // Robin motion
  $('robin-motion').setAttribute('aria-pressed', String(state.playing));
  $('robin-motion').textContent = state.playing ? 'Pause' : robinMode === 'patrol' ? (robinGait === 'Running' ? 'Resume running' : 'Resume walking') : 'Play';
  $('robin-replay').textContent = robinMode === 'patrol' ? (robinGait === 'Running' ? 'Restart the run' : 'Restart the walk') : 'Replay from the start';
  $('robin-reset').textContent = 'Back to deck walk';
  $('robin-animation').value = patrolOption();
  const row = rowById.get(state.clip);
  $('robin-clip-note').textContent = robinMode === 'patrol'
    ? `${robinGait === 'Running' ? 'Runs' : 'Walks'} the deck loop on her own.`
    : row ? [row.note, 'Motion comes from the Blender scene.'].filter(Boolean).join(' · ') : '';
  if (state.outfit) { $('download-glb').href = meshURL(state.outfit); $('download-blend').href = meshURL(state.outfit, 'blend'); }
  updateTimeline(); updateNamiUI(); updateStatus(); updateCameraButtons(); updateSceneUI();
}
function updateSceneUI() {
  const busy = disposed || !initialized || !ambience;
  document.querySelectorAll('#panel-scene button, #panel-scene input, #panel-scene select').forEach(control => { control.disabled = busy; });
  if (busy) return;
  $('preset-halloween').disabled = state.phase === 'changing-outfit' || Boolean(nami?.outfitBusy);
  const a = ambience.state;
  document.querySelectorAll('[data-theme]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.theme === 'halloween') === (a.themeTarget > .5))));
  document.querySelectorAll('[data-weather]').forEach(button => {
    const closest = [0, .4, 1].reduce((best, value) => Math.abs(value - a.rainTarget) < Math.abs(best - a.rainTarget) ? value : best, 0);
    button.setAttribute('aria-pressed', String(Number(button.dataset.weather) === closest));
  });
  const slider = $('time-of-day'), dragging = document.activeElement === slider;
  if (!dragging) slider.value = String(a.night);
  $('time-label').textContent = a.night < .12 ? 'Day' : a.night < .45 ? 'Late afternoon' : a.night < .7 ? 'Sunset' : a.night < .92 ? 'Dusk' : 'Night';
  $('time-play').textContent = a.nightTarget < .5 ? 'Play day to night' : 'Play night to day';
}
function setAmbience({ halloween, night, rain, animated = true }) {
  requireReady();
  if (halloween !== undefined) ambience.setTheme(halloween ? 1 : 0);
  if (night !== undefined) ambience.setNight(night, { animated, seconds: 10 });
  if (rain !== undefined) ambience.setRain(rain);
  updateSceneUI(); return snapshot();
}
function updateNamiUI() {
  const value = nami?.snapshot();
  if (!value) return;
  const busy = nami.outfitBusy;
  document.querySelectorAll('[data-character="nami"][data-outfit]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.outfit === (value.outfit.pending ?? value.outfit.current)));
    button.disabled = busy || disposed;
  });
  $('nami-animation').value = value.mode;
  $('nami-motion').textContent = value.playing ? 'Pause' : value.mode === 'patrol' ? 'Resume walking' : value.mode === 'patrol-run' ? 'Resume running' : 'Play';
  $('nami-motion').setAttribute('aria-pressed', String(value.playing));
  $('nami-reset').textContent = 'Back to deck walk';
  $('nami-clip-note').textContent = value.mode.startsWith('patrol')
    ? `${value.mode === 'patrol-run' ? 'Runs' : 'Walks'} the deck loop on her own, avoiding the hull furniture, the mast, the planters and Robin.`
    : 'In-place preview. Choose a deck walk or run to resume her route.';
}
function updateStatus() {
  if (disposed) { $('status').textContent = 'Scene closed'; return; }
  if (state.error) { $('status').textContent = 'Asset error'; return; }
  if (!initialized || state.phase === 'loading' || !actor || !environment) { $('status').textContent = 'Loading local assets'; return; }
  const robinText = robinMode === 'patrol' ? (robinGait === 'Running' ? 'running the deck' : 'walking the deck') : (rowById.get(state.clip)?.label ?? state.clip).toLowerCase();
  const namiValue = nami?.snapshot(), namiText = namiValue ? (namiValue.mode === 'patrol' ? 'walking the deck' : namiValue.mode === 'patrol-run' ? 'running the deck' : NAMI_MODES.find(m => m.id === namiValue.mode)?.label.toLowerCase()) : 'loading';
  $('status').textContent = `Robin ${state.playing ? robinText : 'paused'} · Nami ${namiValue?.playing ? namiText : 'paused'}`;
}
function action(callback) {
  return event => { try { Promise.resolve(callback(event)).catch(recordError); } catch (error) { recordError(error); } };
}
function dispose() {
  if (disposed) return;
  disposed = true; loadSerial++; state.playing = false; state.phase = 'disposed';
  cancelAnimationFrame(frameHandle); listeners.abort(); observer?.disconnect();
  releaseActor(actor); actor = null; controls?.dispose();
  nami?.dispose(); nami = null;
  robinAnchor.removeFromParent();
  rain?.destroy(); theme?.destroy(); ambience?.destroy(); rain = theme = ambience = null;
  environment?.destroy(); environment = null;
  for (const texture of Object.values(topTextures ?? {})) texture.dispose(); topTextures = null;
  scene?.traverse(node => node.shadow?.dispose());
  renderer?.dispose(); scene?.clear();
  for (const waiter of frameWaiters) waiter.reject(new Error('The scene has been closed.'));
  frameWaiters.clear(); updateUI();
}
function describeSea() {
  const waves = environment?.snapshot().wave;
  const next = waves?.bigWaves?.find(event => event.time >= state.clock - 1);
  const motion = environment?.motion;
  if (motion?.waveEvent && motion.waveEvent.age < 3) return `Sea: big wave hitting the ${motion.waveEvent.side}`;
  return next ? `Sea: swell · next big wave in ${Math.max(0, Math.round(next.time - state.clock))} s` : 'Sea: swell';
}
function frame(time) {
  if (disposed) return;
  if (document.hidden) { frameHandle = 0; return; }
  // Do not run the whole simulation/render pipeline at 120/144 Hz.
  if (time < nextFrameTime - .5) { frameHandle = requestAnimationFrame(frame); return; }
  nextFrameTime = Math.max(nextFrameTime + 1000 / 60, time);
  const dt = lastTime === undefined ? 1 / 60 : Math.max(0, Math.min(.25, (time - lastTime) / 1000)); lastTime = time;
  adaptResolution(dt);
  drawFrame(dt);
  if (!state.error && !disposed) frameHandle = requestAnimationFrame(frame);
}
function drawFrame(dt) {
  try {
    if (controls.enabled) controls.update();
    state.clock += dt;
    environment.update(state.clock, dt);
    const voyage = environment.voyage;
    if (!characterAnchor(view.who)) {
      camera.position.x += voyage.x - voyageX; camera.position.z += voyage.z - voyageZ;
      controls.target.x += voyage.x - voyageX; controls.target.z += voyage.z - voyageZ;
    }
    voyageX = voyage.x; voyageZ = voyage.z;
    // The sea runs on its own wall clock: waves and ship motion never depend on any animation.
    // Theme, night and rain ease toward their targets and set every light; Nami's unlit atlas gets a tint.
    const tint = ambience.update(dt, state.clock, camera);
    nami?.setLighting(tint);
    if (nami) applyNightFill(nami.anchor, tint);
    if (actor) applyNightFill(actor.entity, tint);
    if (actor && state.phase !== 'loading') {
      let next = state.time;
      if (robinMode === 'patrol') {
        // A held character is frozen like a grabbed doll; a paused one stands still.
        if (state.playing && !actor.interaction.active) robinWalker.advance(dt, gaitRate(robinGait));
        placeRobin(); next = robinPhase();
      } else if (state.playing) {
        next += dt;
        if (next >= duration()) {
          if (rowById.get(state.clip)?.loop && duration() > 0) { resetSoftState(actor.garments.transitioning); next %= duration(); }
          else { next = duration(); state.playing = false; actor.interaction.releaseAll(); updateUI(); }
        }
      }
      // Exactly one animation/interaction pipeline and one requestAnimationFrame.
      // rig.update refreshes the animated hierarchy once before skin/inertia work.
      sample(next, false);
      actor.garments.update(dt); actor.rig.update(dt, wantsDeform(robinAnchor, actor.interaction)); actor.garments.apply(); actor.pinBounds();
    }
    if (nami?.update(dt, wantsDeform(nami.anchor, nami.interaction))) updateUI();
    robinPoint.x = robinAnchor.position.x; robinPoint.z = robinAnchor.position.z;
    if (nami) { namiPoint.x = nami.anchor.position.x; namiPoint.z = nami.anchor.position.z; }
    const anchor = characterAnchor(view.who);
    if (anchor) {
      // Carry the user's orbit/zoom with the character, including her turns.
      anchor.getWorldPosition(scratchWorld);
      const yaw = anchor.rotation.y;
      const turn = Math.atan2(Math.sin(yaw - followYaw), Math.cos(yaw - followYaw));
      for (const point of [camera.position, controls.target]) point.sub(followWorld).applyAxisAngle(WORLD_UP, turn).add(scratchWorld);
      constrainReach(controls.target, camera.position, dt);
      if (view.name === 'follow') updateCameraProjection();
      followWorld.copy(scratchWorld); followYaw = yaw;
    }
    renderer.render(scene, camera); state.frame++;
    fpsTime += dt; fpsFrames++; seaTime += dt;
    if (fpsTime >= 1) { $('performance').textContent = `${Math.round(fpsFrames / fpsTime)} fps · ${renderer.getPixelRatio().toFixed(2)}×`; fpsTime = 0; fpsFrames = 0; }
    if (seaTime >= .5) { seaTime = 0; $('sea-state').textContent = describeSea(); updateStatus(); updateNamiUI(); updateSceneUI(); }
    if (frameWaiters.size) {
      const result = snapshot(); for (const waiter of frameWaiters) waiter.resolve(result); frameWaiters.clear();
    }
  } catch (error) {
    recordError(error);
    for (const waiter of frameWaiters) waiter.reject(error); frameWaiters.clear();
    return;
  }
}
async function initialize() {
  showLoading('Preparing the Sunny.', 'Reading the local asset catalog…');
  [catalog, manifest] = await Promise.all([json('../native/pinoc/ability-catalog.json'), json('assets/manifest.json')]);
  if (disposed) throw new Error('The scene has been closed.');
  rows = [...originalClips.map(row => ({ ...row, group: 'Basic motions' })), ...catalog.motions.map(row => ({ ...row, group: 'Support motions' }))];
  rowById = new Map(rows.map(row => [row.id, row])); populateClips();
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.sortObjects = true; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x9ddcff);
  camera = new THREE.PerspectiveCamera(32, 1, .1, 3000);
  controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = .1;
  controls.minDistance = .3; controls.maxDistance = 140; controls.maxPolarAngle = Math.PI * .94;
  ambience = createAmbience({ scene, renderer });
  scene.add(robinAnchor);
  setCamera('overview'); observer = new ResizeObserver(updateCameraAspect); observer.observe(canvas);
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); recordError(new Error('WebGL context lost; reload to continue.')); }, { signal });
  showLoading('Preparing the Sunny.', 'Loading the ship, Robin and her animations…');
  const results = await Promise.allSettled([
    loadSunnyEnvironment(scene, loader).then(value => {
      if (disposed) { value.destroy(); return; }
      environment = value;
      state.ground = { deckHeight: 0, seaHeight: -5, units: 'metres', upAxis: '+y', forwardAxis: '+z' };
      state.assets.environment = { path: 'assets/thousand-sunny/scene.glb', loaded: true, type: 'mesh' };
    }),
    loadTopTextures().then(value => { topTextures = value; return setOutfit('blue'); })
  ]);
  if (disposed) throw new Error('The scene has been closed.');
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new Error(failures.map(result => result.reason?.message ?? String(result.reason)).join('; '));
  // Characters ride the ship: attach them to the rocking deck. The route is derived from the
  // un-rocked ship (the deck is the identity until the first update) in deck-local coordinates.
  environment.deck.updateMatrixWorld(true);
  patrol = createSunnyPatrol(environment.entity, PATROL);
  environment.deck.add(robinAnchor);
  ambience.attach({ environment });
  rain = createRain({ scene, camera, deck: environment.deck, viewportHeight: canvas.clientHeight || 1000 });
  showLoading('Preparing the Sunny.', 'Preparing the ship’s weather and theme…');
  theme = await createHalloweenTheme({ scene, deck: environment.deck, ship: environment.entity, patrol, loader,
    textureLoader: new THREE.TextureLoader(), renderer, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
  ambience.attach({ theme, rain });
  const route = patrol.snapshot();
  // Robin starts half a loop ahead of Nami, so they begin on opposite sides of the stage.
  robinWalker = createDeckWalker({ patrol, startSeconds: route.duration / 2, others: () => namiPoints });
  placeRobin();
  showLoading('Preparing the Sunny.', 'Loading Nami and her animations…');
  nami = await loadNamiActor({ parent: environment.deck, loader, patrol, canvas, camera, controls, pointerEvents,
    others: () => robinPoints, occluded: (raycaster, distance) => (actor?.interaction.probe(raycaster) ?? Infinity) < distance,
    onStatus: text => { $('nami-interaction-status').textContent = text; },
    onRegion: id => { $('nami-region').value = id; refreshProfile('nami'); },
    anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  if (disposed) { nami.dispose(); nami = null; throw new Error('The scene has been closed.'); }
  state.assets.nami = { path: '../native/nami-showcase/export/scene.glb', loaded: true, type: 'skinned-mesh', softbody: true };
  initialized = true; state.phase = 'ready'; sample(robinPhase()); actor.garments.apply();
  refreshProfile('robin'); refreshProfile('nami');
  $('nami-interaction-status').textContent = 'Ready · 9 soft regions and the top fabric';
  theme.warm(camera);
  showLoading('Preparing the Sunny.', 'Rendering the first view…');
  $('build-stamp').textContent = buildStamp; updateUI();
  frameHandle = requestAnimationFrame(frame);
  await afterFrame(); hideLoading(); return snapshot();
}

// The canvas fills the window; the panel is an overlay that never resizes or resets the camera.
const panelEl = $('panel'), panelToggle = $('panel-toggle');
function setPanel(open) {
  panelEl.dataset.collapsed = String(!open);
  panelEl.inert = !open;
  panelToggle.setAttribute('aria-expanded', String(open));
  panelToggle.textContent = open ? 'Hide panel' : 'Panel';
}
setPanel(innerWidth > 850);
panelToggle.addEventListener('click', () => setPanel(panelEl.dataset.collapsed === 'true'), { signal });

for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => selectTab(tab.dataset.tab), { signal });
document.querySelector('.tabs').addEventListener('keydown', event => {
  const order = ['robin', 'nami', 'scene'], current = order.indexOf(document.querySelector('[data-tab][aria-selected="true"]').dataset.tab);
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  const next = order[(current + step + order.length) % order.length];
  selectTab(next); $(`tab-${next}`).focus(); event.preventDefault();
}, { signal });
$('robin-motion').addEventListener('click', action(() => state.playing ? pause() : play()), { signal });
$('robin-replay').addEventListener('click', action(replay), { signal }); $('robin-reset').addEventListener('click', action(reset), { signal });
$('robin-animation').addEventListener('change', action(event => selectClip(event.target.value)), { signal });
$('robin-timeline').addEventListener('input', action(event => seek(Number(event.target.value))), { signal });
$('nami-animation').replaceChildren(...NAMI_MODES.map(mode => Object.assign(document.createElement('option'), { value: mode.id, textContent: mode.label })));
$('nami-animation').addEventListener('change', action(event => namiAction('setMode', event.target.value)), { signal });
$('nami-motion').addEventListener('click', action(() => namiAction(nami.snapshot().playing ? 'pause' : 'play')), { signal });
$('nami-reset').addEventListener('click', action(() => namiAction('reset')), { signal });
$('retry').addEventListener('click', () => location.reload(), { signal });
document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', action(() => setAmbience({ halloween: button.dataset.theme === 'halloween' })), { signal }));
document.querySelectorAll('[data-weather]').forEach(button => button.addEventListener('click', action(() => setAmbience({ rain: Number(button.dataset.weather) })), { signal }));
$('time-of-day').addEventListener('input', action(event => setAmbience({ night: Number(event.target.value), animated: false })), { signal });
$('render-quality').addEventListener('change', action(event => {
  renderQuality = event.target.value;
  qualityElapsed = qualityFrames = qualityRecoverTime = 0;
  const rect = canvas.getBoundingClientRect();
  renderer.setPixelRatio(renderQuality === 'native' ? Math.min(devicePixelRatio, 2)
    : Math.min(devicePixelRatio, 1.5, Math.sqrt(3_000_000 / Math.max(1, rect.width * rect.height))));
  updateCameraAspect();
}), { signal });
$('time-play').addEventListener('click', action(() => setAmbience({ night: ambience.state.nightTarget < .5 ? 1 : 0 })), { signal });
$('preset-halloween').addEventListener('click', action(async () => {
  setAmbience({ halloween: true, night: 1, rain: .4 });
  await Promise.all([setOutfit('halloween'), Promise.resolve(nami.setOutfit('halloween'))]);
  updateUI();
}), { signal });
$('preset-day').addEventListener('click', action(() => setAmbience({ halloween: false, night: 0, rain: 0 })), { signal });
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', action(() => setMode(button.dataset.mode, button.dataset.character)), { signal }));
const impulseVector = new THREE.Vector3();
for (const who of ['robin', 'nami']) {
  $(`${who}-region`).addEventListener('change', action(() => { requireReady(); refreshProfile(who); focusRegion(who, $(`${who}-region`).value); }), { signal });
  $(`${who}-impulse`).addEventListener('click', action(() => {
    requireReady();
    const target = who === 'robin' ? actor : nami, id = $(`${who}-region`).value, profile = target.rig.regions.get(id).profile;
    target.interaction.releaseAll(); focusRegion(who, id);
    target.rig.impulse(id, impulseVector.set(0, 0, profile.cap * 2 * Math.PI * profile.frequency * .65));
    $(`${who}-interaction-status`).textContent = 'Test bounce · watch the elastic recovery';
  }), { signal });
}
document.querySelectorAll('[data-outfit]').forEach(button => button.addEventListener('click', action(() => {
  if (button.dataset.character === 'robin') return setOutfit(button.dataset.outfit);
  requireReady(); return namiAction('setOutfit', button.dataset.outfit);
}), { signal }));
document.querySelectorAll('[data-character][data-view]').forEach(button => button.addEventListener('click', action(() => {
  requireReady(); setCamera(button.dataset.view, button.dataset.character);
}), { signal }));
document.querySelectorAll('[data-focus]').forEach(button => button.addEventListener('click', action(() => {
  requireReady();
  if (button.dataset.focus === 'overview') { setCamera('overview'); return; }
  setCamera('follow', button.dataset.focus); selectTab(button.dataset.focus);
  setPanel(false); canvas.focus({ preventScroll: true });
}), { signal }));
canvas.addEventListener('keydown', action(event => {
  if (!controls) return;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) return;
  event.preventDefault(); actor?.interaction.releaseAll(); nami?.interaction.releaseAll();
  if (event.key === 'Home') { setCamera('overview'); return; }
  const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  if (event.key === 'ArrowLeft') spherical.theta -= .0873;
  else if (event.key === 'ArrowRight') spherical.theta += .0873;
  else if (event.key === 'ArrowUp') spherical.phi -= .0873;
  else if (event.key === 'ArrowDown') spherical.phi += .0873;
  else spherical.radius *= event.key === '-' ? 1.1 : 1 / 1.1;
  spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
  spherical.phi = THREE.MathUtils.clamp(spherical.phi, .01, controls.maxPolarAngle);
  camera.position.setFromSpherical(spherical).add(controls.target); controls.update();
}), { signal });
window.addEventListener('resize', updateCameraAspect, { signal });
document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(frameHandle); frameHandle = 0;
  lastTime = undefined; nextFrameTime = 0;
  qualityElapsed = qualityFrames = qualityRecoverTime = 0;
  if (document.hidden) { actor?.interaction.releaseAll(); nami?.interaction.releaseAll(); }
  else if (initialized && !disposed && !state.error) frameHandle = requestAnimationFrame(frame);
}, { signal });
window.addEventListener('pagehide', dispose, { signal });
const ready = initialize();
// Diagnostics: each character has its own namespace; both share one camera and one sea.
window.__cinematic = {
  ready, snapshot, afterFrame, dispose, setCamera, selectTab, pointerEvents, scene: () => scene, renderer: () => renderer,
  ambience: {
    set: options => setAmbience(options),
    snapshot: () => ambience?.snapshot() ?? null,
    theme: () => theme?.snapshot() ?? null,
    rain: () => rain?.snapshot() ?? null,
  },
  robin: {
    selectClip, setOutfit, play, pause, seek, replay, reset, setMode: value => setMode(value, 'robin'),
    locate: id => { requireReady(); return actor.interaction.locate(id); },
    locateGarment: (kind, side) => { requireReady(); return actor.interaction.locateGarment(kind, side); },
    diagnostics: () => actor ? { ...actor.rig.getDiagnostics(), garments: actor.garments.getState() } : null,
    interaction: () => actor?.interaction.snapshot() ?? null,
    releaseAll: () => actor?.interaction.releaseAll(),
  },
  nami: {
    setMode: value => namiAction('setMode', value), setOutfit: value => namiAction('setOutfit', value),
    play: () => namiAction('play'), pause: () => namiAction('pause'), seek: seconds => namiAction('seek', seconds), reset: () => namiAction('reset'),
    setInteractionMode: value => setMode(value, 'nami'),
    locate: id => { requireReady(); return nami.interaction.locate(id); },
    locateGarment: (kind, side) => { requireReady(); return nami.interaction.locateGarment(kind, side); },
    diagnostics: () => nami?.diagnostics() ?? null,
    interaction: () => nami?.interaction.snapshot() ?? null,
    releaseAll: () => nami?.interaction.releaseAll(),
  },
};
ready.catch(error => {
  // Failed initialization owns no live scene resources; keep the error UI and
  // rejected ready Promise available for diagnostics, not a half-ready viewer.
  releaseActor(actor); actor = null; rain?.destroy(); theme?.destroy(); ambience?.destroy(); rain = theme = ambience = null;
  environment?.destroy(); environment = null;
  nami?.dispose(); nami = null;
  for (const texture of Object.values(topTextures ?? {})) texture.dispose(); topTextures = null;
  controls?.dispose(); observer?.disconnect();
  scene?.traverse(node => node.shadow?.dispose()); scene?.clear(); renderer?.dispose();
  recordError(error);
});
