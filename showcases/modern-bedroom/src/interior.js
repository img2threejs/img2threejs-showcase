import './interior.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAssetLoader, createTextureUploader } from './interior-loader.js';
import { createCurtainInteraction } from './interior-curtains.js';
import { createBedCloth, createBedClothOwnerLookup } from './interior-bedcloth.js';
import { createInteriorNavigation } from './interior-navigation.js';
import { validateManifest, sourceLabel } from './interior-manifest.js';
import { ambientReference, repairStarvedVertices, createMeshMatcher, applyLightFallbacks } from './interior-lightmaps.js';
import { createBakedShaderPatch, createClothShaderPatch } from './interior-shading.js';
import { createPalette } from './interior-palette.js';
import { mergeStaticMeshes } from './interior-merge.js';
import { mountPaletteUI } from './interior-palette-ui.js';
import './interior-panel.js';

const ui = Object.fromEntries([
  'viewport', 'canvas-host', 'source-panel', 'source-view', 'source-thumbnail', 'source-link',
  'mode-3d', 'mode-source', 'view-label', 'viewer-message', 'message-title', 'message-detail',
  'load-status', 'load-progress', 'retry-load', 'wireframe',
  'reset', 'reset-bed', 'download-glb', 'download-blend', 'pendant-lights',
  'curtain-amount', 'curtain-percent', 'curtain-open', 'curtain-close', 'curtain-wind',
  'scene-title', 'camera-actions', 'palette-controls', 'curtain-controls',
  'source-caption', 'thumbnail-caption', 'interaction-hint', 'representation-title', 'representation-detail',
].map(id => [id, document.getElementById(id)]));
let viewButtons = [];
const state = { status: 'loading', firstFrameMs: null, error: null, mode: '3d', view: 'source', wireframe: false, frames: 0, pendantLights: true };
const offset = new THREE.Vector3();
const orbit = new THREE.Spherical();
const number = new Intl.NumberFormat('en-US');
let session = null;
let paletteUI = null;
let loading = false;
let renderRequest = 0;
let applyingPose = false;
let stopped = false;

// Lets the page paint between long synchronous load steps. A hidden tab never paints (rAF is paused), so it does not wait.
function nextPaint() {
  return document.hidden ? Promise.resolve() : new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
}

function cameraSnapshot() {
  if (!session?.camera) return null;
  const { camera, controls } = session;
  return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
    target: controls.target.toArray(), fov: camera.fov, aspect: camera.aspect,
    near: camera.near, far: camera.far, view: state.view };
}

function textureSnapshot(texture) {
  if (!texture) return null;
  return { uuid: texture.uuid, channel: texture.channel, colorSpace: texture.colorSpace,
    flipY: texture.flipY, width: texture.image?.width, height: texture.image?.height };
}

function materialSnapshot(material) {
  const textures = {};
  for (const [name, value] of Object.entries(material)) {
    if (value?.isTexture) textures[name] = textureSnapshot(value);
  }
  return { uuid: material.uuid, name: material.name, type: material.type,
    color: material.color?.toArray(), roughness: material.roughness, metalness: material.metalness,
    transparent: material.transparent, opacity: material.opacity, alphaTest: material.alphaTest,
    transmission: material.transmission ?? 0, emissive: material.emissive?.toArray(),
    emissiveIntensity: material.emissiveIntensity,
    side: material.side, depthWrite: material.depthWrite, lightMapIntensity: material.lightMapIntensity,
    textures };
}

function inventorySnapshot() {
  return session?.entries.map(({ mesh, pbr, diagnostic }) => ({
    component: mesh.userData.component, uuid: mesh.uuid, name: mesh.name,
    geometryUuid: mesh.geometry.uuid,
    curtain: mesh.userData.curtain_id ?? null, curtainPart: mesh.userData.curtain_part ?? null,
    lightmap: mesh.userData.lightmap ?? null,
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attribute]) =>
      [name, { count: attribute.count, itemSize: attribute.itemSize, version: attribute.version }])),
    indexCount: mesh.geometry.index?.count ?? null,
    materials: (Array.isArray(pbr) ? pbr : [pbr]).map(materialSnapshot),
    activeMaterialUuids: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => material.uuid),
    diagnosticMaterialUuids: (Array.isArray(diagnostic) ? diagnostic : [diagnostic]).map(material => material.uuid),
  })) ?? [];
}

Object.defineProperty(window, 'interiorStudy', {
  value: Object.freeze({
    get status() { return state.status; },
    get error() { return state.error; },
    get camera() { return cameraSnapshot(); },
    get frames() { return state.frames; },
    get firstFrameMs() { return state.firstFrameMs; },   // ms since navigation start of the first completed render of the finished scene
    get stats() { return session?.stats ? structuredClone(session.stats) : null; },
    get inventory() { return inventorySnapshot(); },
    get mode() { return state.mode; },
    get palette() { return session?.palette ?? null; },
    get wireframe() { return state.wireframe; },
    get curtains() { return session?.curtains?.snapshot() ?? null; },
    get bedCloth() { return session?.bedCloth?.snapshot() ?? null; },
    resetBedCloth() { session?.bedCloth?.reset(); requestRender(); return !!session?.bedCloth; },
    // Perf diagnostics (read-only counters; bench renders synchronously and waits for the GPU, so it measures cost, not vsync).
    get perf() { return perfSnapshot(); },
    benchFrames(options) { return benchFrames(options); },
    get navigation() { return session?.navigation?.snapshot() ?? null; },
    get lighting() { return session?.renderer ? { model: session.manifest.lighting.model,
      exposure: session.renderer.toneMappingExposure, sunIntensity: session.sun?.intensity ?? null,
      shadowMapSize: session.sun?.shadow.mapSize.toArray() ?? null,
      pendantLights: state.pendantLights,
      pendants: session.pendants?.map(({ spec, light, bulbs }) => ({ id: spec.id,
        intensity: light.intensity, color: light.color.toArray(), position: light.position.toArray(), target: light.target.position.toArray(),
        bulbEmission: bulbs.map(({ material }) => material.emissiveIntensity) })) ?? [],
      bedRelight: Object.fromEntries([...(session.bedLighting?.clothes ?? [])].map(([id, cloth]) => [id, { blend: cloth.blend ?? 0, reference: cloth.reference }])) } : null; },
    setView, setMode, setWireframe, setCurtainClosure, setCurtainWind, setPendantLights, reset,
  }),
});

// What the curtain controls last showed (see syncCurtainControlsIfChanged).
const curtainControlSeen = { target: NaN, wind: null, count: -1, status: '', mode: '', reduced: null };

function syncCurtainControls() {
  const curtain = session?.curtains;
  Object.assign(curtainControlSeen, { target: curtain?.targetClosure ?? 0, wind: curtain?.wind ?? false, count: curtain?.count ?? 0,
    status: state.status, mode: state.mode, reduced: curtain?.reducedMotion ?? false });
  const percent = Math.round((curtain?.targetClosure ?? 0) * 100);
  if (ui['curtain-amount'].value !== String(percent)) ui['curtain-amount'].value = percent;
  ui['curtain-percent'].textContent = `${percent}%`;
  ui['curtain-amount'].setAttribute('aria-valuetext', `${ui['curtain-amount'].value}% coverage`);
  ui['curtain-wind'].setAttribute('aria-pressed', String(curtain?.wind ?? false));
  ui['curtain-wind'].disabled = !curtain?.count || state.status !== 'ready' || state.mode !== '3d' || !!curtain?.reducedMotion;
  ui['curtain-wind'].title = curtain?.reducedMotion ? 'Wind disabled by your reduced-motion setting.' : 'Toggle the gentle breeze that animates the fabric.';
}

function syncControls() {
  const ready = state.status === 'ready';
  const interactive = ready && state.mode === '3d';
  for (const mode of ['3d', 'source']) {
    ui[`mode-${mode}`].disabled = !ready;
    ui[`mode-${mode}`].setAttribute('aria-pressed', String(state.mode === mode));
  }
  for (const button of viewButtons) {
    button.disabled = !interactive;
    button.setAttribute('aria-pressed', String(state.view === button.dataset.view));
  }
  ui.wireframe.disabled = !interactive;
  ui.wireframe.setAttribute('aria-pressed', String(state.wireframe));
  ui.reset.disabled = !ready;
  ui['reset-bed'].hidden = !session?.bedCloth?.count;
  ui['reset-bed'].disabled = !interactive;
  ui['pendant-lights'].disabled = !interactive || !session?.pendants?.length;
  ui['pendant-lights'].hidden = ready && !session?.pendants?.length;
  ui['pendant-lights'].setAttribute('aria-pressed', String(state.pendantLights));
  ui['pendant-lights'].textContent = `Pendant lights: ${state.pendantLights ? 'On' : 'Off'}`;
  for (const id of ['curtain-amount', 'curtain-open', 'curtain-close', 'curtain-wind']) ui[id].disabled = !interactive || !session?.curtains?.count;
  ui['curtain-controls'].hidden = !session?.curtains?.count;
  paletteUI?.setDisabled(!interactive);
  syncCurtainControls();
  ui['canvas-host'].hidden = state.mode !== '3d';
  ui['source-panel'].hidden = state.mode !== 'source';
  ui['viewer-message'].hidden = ready;
  ui['load-progress'].hidden = state.status !== 'loading';
  ui['retry-load'].hidden = state.status !== 'error';
  ui.viewport.setAttribute('aria-busy', String(state.status === 'loading'));
  ui['retry-load'].disabled = loading;
  ui['load-status'].dataset.state = state.status;
  ui['view-label'].textContent = state.mode === 'source' ? sourceLabel(session.manifest)
    : state.wireframe ? '3D · geometry wireframe'
      : session?.bedCloth?.count ? '3D · interactive curtains and bed linen' : session?.curtains?.count ? '3D · interactive curtains' : '3D · authored interior';
  for (const [id, field] of [['download-glb', 'portableModel'], ['download-blend', 'blender']]) {
    const link = ui[id];
    link.setAttribute('aria-disabled', String(!ready));
    link.tabIndex = ready ? 0 : -1;
    if (ready) link.href = import.meta.env.VITE_MODERN_BEDROOM_DOWNLOADS?.[field] ?? session.manifest[field];
    else link.removeAttribute('href');
  }
  if (session?.controls) {
    session.curtains?.setEnabled(interactive);
    session.bedCloth?.setEnabled(interactive);
    session.controls.enabled = interactive && !session.curtains?.grabbing && !session.bedCloth?.grabbing;
    session.renderer.domElement.tabIndex = interactive ? 0 : -1;
    session.renderer.domElement.setAttribute('aria-disabled', String(!interactive));
  }
}

function fail(error) {
  state.status = 'error';
  state.error = error instanceof Error ? error.message : String(error);
  session?.curtains?.setEnabled(false);
  session?.bedCloth?.setEnabled(false);
  cancelAnimationFrame(renderRequest);
  renderRequest = 0;
  ui['message-title'].textContent = 'Could not open the room';
  ui['message-detail'].textContent = state.error;
  ui['load-status'].textContent = 'Scene load did not finish. See the message above; once the cause is fixed, choose “Retry load”.';
  syncControls();
}

// Mean displacement (m) over which a bed cloth's baked per-texel shading fades into its open-light ambient. Zero displacement
// (the authored pose, also after Reset) is exactly the baked lighting; there is no step at wake-up.
const BED_RELIGHT_FROM = 0.01;
const BED_RELIGHT_TO = 0.12;

function syncBedLighting() {
  const lighting = session.bedLighting;
  if (!lighting?.clothes.size || !session.bedCloth) return;
  const states = session.bedCloth.lightingState();
  // The bake shaded each cloth with the other lying on it (a throw leaves a baked black footprint on the duvet beneath).
  // The bed linen therefore leaves its baked shading as one set as soon as any piece has moved.
  let displacement = 0;
  for (const item of states) if (lighting.clothes.has(item.id)) displacement = Math.max(displacement, item.displacement);
  const t = THREE.MathUtils.clamp((displacement - BED_RELIGHT_FROM) / (BED_RELIGHT_TO - BED_RELIGHT_FROM), 0, 1);
  const blend = t * t * (3 - 2 * t);
  for (const { id } of states) {
    const cloth = lighting.clothes.get(id);
    if (!cloth) continue;
    cloth.blend = blend;
    // Trim, hem and fringe tubes have no usable islands of their own (sub-texel, baked black): they always take the cloth ambient.
    for (const { uniforms, follower } of cloth.materials) uniforms.uBedAmbient.value.w = follower ? 1 : blend;
  }
}

function perfSnapshot() {
  if (!session?.renderer) return null;
  const { renderer, perf } = session;
  const { render, memory, programs } = renderer.info;
  return { calls: render.calls, triangles: render.triangles, renderFrame: render.frame, geometries: memory.geometries, textures: memory.textures,
    programs: programs?.length ?? 0, pixelRatio: renderer.getPixelRatio(), canvas: [renderer.domElement.width, renderer.domElement.height],
    restRatio: perf.restRatio, motionRatio: perf.motionRatio, quality: perf.quality, breezeQuality: perf.breezeQuality, shadowUpdates: perf.shadowUpdates, ratioChanges: perf.resizes,
    breezeOnly: perf.breezeOnly, merge: session.merge ? { batches: session.merge.merged, mergedMeshes: session.merge.hidden, thinGlassPanes: session.thinGlass.length } : null };
}

// Synchronous orbit benchmark: renders `frames` frames of a slow camera sweep, waiting for the GPU after each, so the numbers are
// the cost of a frame rather than the vsync interval. `shadows: true` redraws the shadow maps every frame (a cloth in motion),
// `ratio` renders at that pixel ratio. The camera pose and pixel ratio are restored afterwards.
function benchFrames({ frames = 120, sweep = 0.3, shadows = false, ratio = null } = {}) {
  if (state.status !== 'ready') return null;
  const { renderer, scene, camera, controls, perf } = session;
  const gl = renderer.getContext();
  const home = camera.position.clone();
  const radial = home.clone().sub(controls.target);
  const spherical = new THREE.Spherical().setFromVector3(radial);
  const savedRatio = perf.ratio;
  if (ratio !== null) applyPixelRatio(ratio);
  const times = [];
  let calls = 0, triangles = 0;
  for (let i = 0; i < frames; i++) {
    const next = spherical.clone();
    next.theta += Math.sin(i / frames * Math.PI * 2) * sweep;
    camera.position.copy(controls.target).add(radial.setFromSpherical(next));
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
    if (shadows) renderer.shadowMap.needsUpdate = true;
    const start = performance.now();
    renderer.render(scene, camera);
    gl.finish();
    times.push(performance.now() - start);
    calls = renderer.info.render.calls;
    triangles = renderer.info.render.triangles;
  }
  camera.position.copy(home);
  camera.lookAt(controls.target);
  camera.updateMatrixWorld();
  if (ratio !== null) applyPixelRatio(savedRatio);
  perf.shadowDirty = true;
  requestRender();
  times.sort((a, b) => a - b);
  const q = p => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  return { frames, p50: q(0.5), p95: q(0.95), max: times[times.length - 1], mean: times.reduce((a, b) => a + b, 0) / times.length, calls, triangles, pixelRatio: renderer.getPixelRatio() };
}

// ---- render scheduling ---------------------------------------------------------------------------------------------------
// The scene is drawn only when something changed. Three things keep frames coming: the camera being driven (orbit / zoom / pan
// events), a cloth being dragged or settling, and the idle curtain breeze. The breeze alone is capped at ~33 fps and refreshes the
// shadow map at ~15 Hz (it moves a few centimetres per second); everything else runs at display rate.
//
// While the camera is driven or a cloth is moving because of the user, the canvas renders at a lower pixel ratio (a pixel budget,
// further reduced if frames take too long) and returns to the full resolution REST_DELAY_MS after the last input.
const REST_DELAY_MS = 150;
const BREEZE_FRAME_MS = 30;
const BREEZE_SHADOW_MS = 66;
const MOTION_PIXELS = 1.5e6;
const MIN_QUALITY = 0.55;

function createPerfState() {
  return { width: 0, height: 0, restRatio: 1, motionRatio: 1, ratio: 1, quality: 1, breezeQuality: 1, frameEma: 16, lastFastFrame: 0, lastAdjust: 0,
    interactUntil: 0, urgent: true, breezeOnly: false, lastDraw: -1e9, restTimer: 0,
    shadowDirty: true, shadowVersion: 0, bedWasMoving: false, lastShadow: -1e9, shadowUpdates: 0, resizes: 0 };
}

// Camera input: render cheaply until the input stops.
function markInteraction() {
  if (session?.perf) session.perf.interactUntil = performance.now() + REST_DELAY_MS;
}

// Something the user did that may change what casts a shadow (cloth input, wireframe, lamps, reset).
function markAction() {
  if (session?.perf) session.perf.shadowDirty = true;
}

function onSimChange() {
  markAction();
  requestRender();
}

function motionRatioFor(perf) {
  const budget = Math.sqrt(MOTION_PIXELS / Math.max(1, perf.width * perf.height));
  const ratio = Math.min(perf.restRatio, budget) * perf.quality;
  return Math.round(THREE.MathUtils.clamp(ratio, 0.5, perf.restRatio) * 20) / 20;
}

function applyPixelRatio(ratio) {
  const { perf, renderer } = session;
  if (!perf.width || perf.ratio === ratio) return;
  renderer.setPixelRatio(ratio);
  renderer.setSize(perf.width, perf.height, false);
  perf.ratio = ratio;
  perf.resizes++;
}

// Frame-to-frame time while frames are being produced back to back is the cost of a frame (the GPU backs the rAF cadence up):
// trade resolution for it. Driven frames (orbit, drag) should come at display rate. Breeze-only frames are capped at ~33 fps and are
// not an interaction, so they only give up resolution when the machine cannot even sustain ~11 fps.
function adaptQuality(perf, time, driven) {
  if (perf.lastFastFrame && time - perf.lastFastFrame < 250) {
    perf.frameEma = perf.frameEma * 0.8 + (time - perf.lastFastFrame) * 0.2;
    if (time - perf.lastAdjust > 400) {
      if (driven) {
        if (perf.frameEma > 24 && perf.quality > MIN_QUALITY) { perf.quality = Math.max(MIN_QUALITY, perf.quality * 0.85); perf.lastAdjust = time; }
        else if (perf.frameEma < 15 && perf.quality < 1) { perf.quality = Math.min(1, perf.quality * 1.08); perf.lastAdjust = time; }
        perf.motionRatio = motionRatioFor(perf);
      } else if (perf.frameEma > 90 && perf.breezeQuality > 0.7) { perf.breezeQuality = Math.max(0.7, perf.breezeQuality * 0.9); perf.lastAdjust = time; }
      else if (perf.frameEma < 60 && perf.breezeQuality < 1) { perf.breezeQuality = Math.min(1, perf.breezeQuality * 1.08); perf.lastAdjust = time; }
    }
  }
  perf.lastFastFrame = time;
}

// The curtain controls only change when the curtain state does, so the per-frame sync is a field comparison.
function syncCurtainControlsIfChanged() {
  const curtain = session?.curtains;
  const seen = curtainControlSeen;
  if (seen.target === (curtain?.targetClosure ?? 0) && seen.wind === (curtain?.wind ?? false) && seen.count === (curtain?.count ?? 0)
    && seen.status === state.status && seen.mode === state.mode && seen.reduced === (curtain?.reducedMotion ?? false)) return;
  syncCurtainControls();
}

function scheduleFrame() {
  if (!renderRequest) renderRequest = requestAnimationFrame(frame);
}

function frame(time) {
  renderRequest = 0;
  const current = session;
  if (!current || state.status !== 'ready' || state.mode !== '3d' || document.hidden) return;
  const perf = current.perf;
  try {
    const urgent = perf.urgent;
    if (!urgent && perf.breezeOnly && time - perf.lastDraw < BREEZE_FRAME_MS) { scheduleFrame(); return; }
    perf.urgent = false;
    const previous = current.lastRenderTime;
    current.lastRenderTime = time;
    const dt = previous === null ? 0 : (time - previous) / 1000;
    const curtainMoving = !!current.curtains?.update(dt, time / 1000);
    const bedMoving = !!current.bedCloth?.update(dt);
    const simMoving = curtainMoving || bedMoving;
    if (bedMoving || perf.bedWasMoving || urgent) syncBedLighting();
    perf.bedWasMoving = bedMoving;
    syncCurtainControlsIfChanged();

    // Reduced resolution is for what the user is driving: camera input, a cloth in the hand, a thrown cloth settling. A curtain that
    // merely settles (closing, a resize wake-up) or sways in the breeze is not an interaction and keeps the rest resolution.
    const interacting = time < perf.interactUntil || bedMoving || !!current.curtains?.grabbing || !!current.bedCloth?.grabbing;
    perf.breezeOnly = curtainMoving && !interacting && !!current.curtains.breezeOnly;
    const fast = interacting;
    if (fast || perf.breezeOnly) adaptQuality(perf, time, fast);
    applyPixelRatio(fast ? perf.motionRatio : perf.breezeOnly ? Math.max(0.7, Math.round(perf.restRatio * perf.breezeQuality * 20) / 20) : perf.restRatio);
    clearTimeout(perf.restTimer);
    perf.restTimer = fast && perf.ratio < perf.restRatio ? setTimeout(() => { perf.restTimer = 0; perf.urgent = true; requestRender(); }, REST_DELAY_MS + 30) : 0;

    // Shadow maps are redrawn only when a caster changed: the cloth buffers were rewritten (breeze alone: at most ~15 Hz, with the
    // last change always drawn once the cloth settles) or something called markAction().
    const geometryVersion = (current.curtains?.geometryVersion ?? 0) + (current.bedCloth?.geometryVersion ?? 0);
    const shadowPending = geometryVersion !== perf.shadowVersion;
    if (perf.shadowDirty || (shadowPending && (!perf.breezeOnly || !simMoving || time - perf.lastShadow >= BREEZE_SHADOW_MS))) {
      current.renderer.shadowMap.needsUpdate = true;
      perf.shadowDirty = false;
      perf.shadowVersion = geometryVersion;
      perf.lastShadow = time;
      perf.shadowUpdates++;
    }

    current.renderer.render(current.scene, current.camera);
    perf.lastDraw = time;
    if (current.shaderError) throw current.shaderError;
    state.frames++;
    if (simMoving) scheduleFrame();
    else current.lastRenderTime = null;
  } catch (error) { fail(error); }
}

function requestRender() {
  if (state.status !== 'ready' || state.mode !== '3d' || document.hidden) return;
  if (session?.perf) session.perf.urgent = true;
  scheduleFrame();
}

function resize() {
  if (!session?.camera) return;
  const width = ui.viewport.clientWidth;
  const height = ui.viewport.clientHeight;
  if (!width || !height) return;
  const { perf, renderer } = session;
  perf.width = width;
  perf.height = height;
  perf.restRatio = Math.min(window.devicePixelRatio || 1, 2);
  perf.motionRatio = motionRatioFor(perf);
  perf.ratio = perf.restRatio;
  renderer.setPixelRatio(perf.ratio);
  renderer.setSize(width, height, false);
  session.camera.aspect = width / height;
  session.camera.updateProjectionMatrix();
  requestRender();
}

function applyView(name) {
  const { manifest, camera, controls } = session;
  const pose = name === 'source' ? manifest.camera : manifest.views[name];
  applyingPose = true;
  camera.position.fromArray(pose.position);
  camera.fov = pose.fov ?? manifest.camera.fov;
  camera.updateProjectionMatrix();
  controls.target.fromArray(pose.target);
  camera.lookAt(controls.target);
  controls.update();
  applyingPose = false;
  state.view = name;
}

function setView(name) {
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  if (name !== 'source' && !Object.hasOwn(session.manifest.views, name)) throw new Error(`Unknown view: ${name}`);
  if (session.curtains?.grabbing) session.curtains.setEnabled(false);
  if (session.bedCloth?.grabbing) session.bedCloth.setEnabled(false);
  applyView(name);
  syncControls();
  requestRender();
  return true;
}

function setMode(mode) {
  if (!['3d', 'source'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  if (state.status !== 'ready') return false;
  state.mode = mode;
  syncControls();
  if (mode === '3d') resize();
  return true;
}

// Wireframe shows the authored per-mesh topology with the diagnostic material. The merged batches and the thin glass panes (which are
// not drawn in the shaded view, see optimizeStaticGeometry) take part in it as well.
function applyWireframeMaterials(current, enabled) {
  for (const { mesh, pbr, diagnostic } of current.entries) mesh.material = enabled ? diagnostic : pbr;
  for (const batch of current.merge?.meshes ?? []) batch.mesh.material = enabled ? batch.members[0].entry.diagnostic : batch.members[0].entry.pbr;
  for (const mesh of current.thinGlass ?? []) mesh.visible = enabled;
}

function setWireframe(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Wireframe requires a boolean.');
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  state.wireframe = enabled;
  markAction();
  applyWireframeMaterials(session, enabled);
  syncControls();
  requestRender();
  return true;
}

// Draw-call and fill-rate reduction for the static room, within the visual tolerance of the source view (see REPORT.md).
//  * The glass panes are 90 % see-through (opacity 0.1), have no thickness and no refraction, yet any transmissive material makes
//    three.js re-render the whole opaque scene into an MSAA, mip-mapped backdrop every frame (~70 % of the GPU time). Measured over
//    the shipped views, dropping them changes the image by < 0.4 mean RGB (worst 32 px block < 4); `?glass=full` keeps the real thing.
//  * Meshes that share a material, shadow behaviour and attribute layout become one draw call each (interior-merge.js). The originals
//    stay in the graph, hidden, for picking, the inventory and the palette.
function optimizeStaticGeometry(current) {
  const full = new URLSearchParams(location.search).get('glass') === 'full';
  current.thinGlass = [];
  if (!full) {
    for (const { mesh, pbr } of current.entries) {
      if (Array.isArray(pbr) || !(pbr.transmission > 0) || (pbr.thickness ?? 0) !== 0 || pbr.opacity > 0.25) continue;
      mesh.visible = false;
      mesh.userData.occluderOnly = true;
      current.thinGlass.push(mesh);
    }
  }
  current.merge = mergeStaticMeshes({ entries: current.entries, exclude: current.dynamicMeshes, scene: current.scene, root: current.root });
  for (const { mesh } of current.merge.meshes) current.geometries.add(mesh.geometry);
  current.stats.merge = { batches: current.merge.merged, mergedMeshes: current.merge.hidden, triangles: current.merge.triangles, thinGlassPanes: current.thinGlass.length,
    ranges: current.merge.meshes.map(({ mesh, members }) => ({ name: mesh.name, members: members.map(({ name, physicalId, range }) => ({ name, physicalId, ...range })) })) };
}

function setCurtainClosure(value) {
  if (state.status !== 'ready' || state.mode !== '3d' || !session.curtains?.count) return false;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Curtain coverage must be between 0 and 1.');
  markAction();
  session.curtains.setClosure(value);
  requestRender();
  return true;
}

function setCurtainWind(enabled) {
  if (state.status !== 'ready' || state.mode !== '3d' || !session.curtains?.count) return false;
  if (typeof enabled !== 'boolean') throw new TypeError('Gentle breeze requires a boolean.');
  const actual = session.curtains.setWind(enabled);
  markAction();
  syncCurtainControls();
  requestRender();
  return actual === enabled;
}
function setPendantLights(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Pendant lights require a boolean.');
  if (state.status !== 'ready' || state.mode !== '3d' || !session.pendants?.length) return false;
  state.pendantLights = enabled;
  markAction();
  for (const { light, spec, bulbs } of session.pendants) {
    light.intensity = enabled ? spec.intensity : 0;
    for (const { material, intensity } of bulbs) material.emissiveIntensity = enabled ? intensity : 0;
  }
  syncControls();
  requestRender();
  return true;
}


function reset() {
  if (state.status !== 'ready') return false;
  setMode('3d');
  markAction();
  session.curtains?.reset();
  session.bedCloth?.reset();
  setWireframe(false);
  setPendantLights(true);
  setView('source');
  return true;
}

function cameraKeys(event) {
  if (!session?.controls.enabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') { setView('source'); return; }
  const { camera, controls } = session;
  orbit.setFromVector3(offset.copy(camera.position).sub(controls.target));
  if (event.key === 'ArrowLeft') orbit.theta -= 0.045;
  if (event.key === 'ArrowRight') orbit.theta += 0.045;
  if (event.key === 'ArrowUp') orbit.phi -= 0.035;
  if (event.key === 'ArrowDown') orbit.phi += 0.035;
  if (event.key === '+' || event.key === '=') orbit.radius *= 0.9;
  if (event.key === '-' || event.key === '_') orbit.radius *= 1.1;
  orbit.phi = THREE.MathUtils.clamp(orbit.phi, controls.minPolarAngle, controls.maxPolarAngle);
  orbit.radius = THREE.MathUtils.clamp(orbit.radius, controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(offset.setFromSpherical(orbit));
  controls.update();
}


function configureSceneContent(manifest) {
  document.title = `${manifest.title} — Interior study`;
  ui['scene-title'].textContent = manifest.title;
  ui.viewport.style.setProperty('--source-aspect', `${manifest.sourceImageSize[0]} / ${manifest.sourceImageSize[1]}`);
  for (const id of ['source-view', 'source-thumbnail']) {
    ui[id].width = manifest.sourceImageSize[0];
    ui[id].height = manifest.sourceImageSize[1];
    ui[id].alt = `${sourceLabel(manifest)} for ${manifest.title}`;
  }
  ui['source-caption'].textContent = `${sourceLabel(manifest)} · not a viewer render`;
  ui['thumbnail-caption'].textContent = `${sourceLabel(manifest)}. Open the image to compare details.`;
  viewButtons = [['source', { label: 'Source view' }], ...Object.entries(manifest.views)].map(([name, pose]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.view = name;
    button.textContent = pose.label || name;
    button.disabled = true;
    button.setAttribute('aria-pressed', String(name === 'source'));
    button.addEventListener('click', () => setView(name));
    return button;
  });
  ui['camera-actions'].replaceChildren(...viewButtons);
}

function configureInteractionContent(current) {
  const cloth = current.curtains.count > 0;
  const cameraHint = 'Scroll or pinch to zoom, right-drag to pan inside the room. Keyboard: Tab into the 3D frame, arrow keys to rotate, + / − to zoom, Home returns to the source view.';
  const bed = !!current.bedCloth?.count;
  const bedHint = bed ? ' Drag the knitted throw to pull it off the bed; release and it drapes and settles under gravity. “Reset bed linen” puts it back.' : '';
  ui['interaction-hint'].textContent = cloth
    ? `Drag the fabric to open or close the curtains; drag elsewhere to orbit the camera.${bedHint} ${cameraHint} Adjust the curtains with the Coverage slider and buttons; turn off Gentle breeze to settle the cloth.`
    : `Drag to orbit the camera.${bedHint} ${cameraHint}`;
  current.renderer.domElement.setAttribute('aria-label', `${current.manifest.title}. Interactive 3D interior. ${ui['interaction-hint'].textContent}`);
  ui['representation-title'].textContent = cloth && current.sun ? 'Sunlight follows the curtain' : 'Baked light, editable geometry';
  ui['representation-detail'].textContent = !current.sun
    ? 'Lighting and reflections use the authored static bake and reflection probe. This scene has no runtime sun or dynamic GI; changing materials or cloth does not rebake lighting. The camera stays inside the declared room bounds.'
    : cloth
      ? 'Direct sunlight and cast shadows update with the curtain shape. Indirect bounce and reflections retain the authored open-curtain bake; this is not dynamic GI. The camera stays inside the declared room bounds.'
      : 'Direct sunlight and shadows are rendered in real time. Indirect bounce and reflections use the authored static bake; material changes do not rebake them. The camera stays inside the declared room bounds.';
  if (current.pendants.length) ui['representation-detail'].textContent += ' Pendant lights switch real warm spotlights and bulb glow; their light is excluded from the ambient bake and reflection probe. Indirect lamp bounce is not simulated.';
}

function collectResources(root, current) {
  root.traverse(object => {
    if (!object.isMesh) return;
    current.geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      current.materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) current.textures.add(value);
    }
  });
}

// glTF node extras live on a Group when an object has multiple material primitives.
// Carry those authored semantics to the rendered primitive, never infer a missing atlas.
const USER_DATA_KEYS = ['component', 'lightmap', 'curtain_id', 'curtain_part', 'physical_id'];
function propagateUserData(mesh, root) {
  for (const key of USER_DATA_KEYS) {
    if (mesh.userData[key] !== undefined) continue;
    let owner = mesh.parent;
    while (owner && owner !== root && owner.userData[key] === undefined) owner = owner.parent;
    if (owner?.userData[key] !== undefined) mesh.userData[key] = owner.userData[key];
  }
}

// Texture sampler overrides for the materials whose weave is finer than the source view can resolve.
// A 7.5 mm knit cell on a 0.48 m tile is 32 texels at mip 0, but only ~1.3 css px in the source view: the
// hardware picks mip ~4.6, where the box-filtered chain has already averaged the lobes into a flat grey.
// The knit contrast then has to come from the albedo map alone (the lightmap carries no stitch geometry),
// and the mip blur erases it. A negative LOD bias shifts the mip selection back toward the unblurred levels.
// Three r180 has no Texture.lodBias, so the bias is applied in the shader as `texture( map, uv, bias )`
// (WebGL2 / GLSL ES 3.0), which biases the mip selection by a fraction of a level.
const SAMPLER_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap'];

// Built-in sampler overrides for the weaves whose texture detail the source view cannot resolve.
// scene-spec.json runtime.shading.samplers carries the same numbers (that block is copied verbatim into
// the exported manifest, which is the long-term home of the settings); these defaults keep the shipped
// manifest - frozen at the last export - behaving the same way, and the manifest overrides them.
const DEFAULT_SAMPLERS = [
  // Throw: a 7.5 mm seed-stitch cell on a 0.48 m tile. At the source view the knit spans ~1.3 css px, so the
  // hardware picks mip ~4.6 and the box-filtered chain averages the lobes flat. -3 levels brings the sample
  // back to the lobe scale; the throw's albedo then carries the waffle the reference shows.
  { meshes: ['bedding.throw.knitted-drape', 'bedding.throw.bound-edge', 'bedding.throw.fringe.*'],
    bias: -3, anisotropy: 16, slots: ['map', 'normalMap'] },
  // Rug: a dense low-pile whose fibre grain is finer still (0.4-4 mm). -2 levels keeps the pile grain visible
  // where the mip chain would otherwise leave a smooth blur; the duvet and floor already match the
  // reference's high-frequency energy and are deliberately left alone.
  { meshes: ['rug.low-pile', 'rug.bound-fabric-edge'],
    bias: -2, anisotropy: 8, slots: ['map', 'normalMap'] },
];

// Applies one sampler override block to a material. `bias` shifts the mip selection; `anisotropy` is the
// hardware anisotropic filter count (ignored unless the min filter keeps the mipmap chain).
function applySamplerOverride(material, override, maxAnisotropy) {
  const bias = override.bias ?? 0;
  const anisotropy = override.anisotropy ?? 1;
  const slots = override.slots ?? SAMPLER_SLOTS;
  for (const slot of slots) {
    const texture = material[slot];
    if (!texture) continue;
    if (anisotropy > 1) {
      texture.anisotropy = Math.min(anisotropy, maxAnisotropy);
      texture.needsUpdate = true;
    }
  }
  if (!bias) return false;
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const biased = new Set(slots.filter(slot => material[slot]));
  // GLSL needs a float literal for the LOD bias.
  const biasLiteral = Number(bias).toFixed(3);
  material.onBeforeCompile = (shader, renderer) => {
    if (previous) previous(shader, renderer);
    if (biased.has('map')) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
        THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', `texture( map, vMapUv, ${biasLiteral} )`));
    }
    if (biased.has('normalMap')) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>',
        THREE.ShaderChunk.normal_fragment_maps.replace('texture2D( normalMap, vNormalMapUv )', `texture( normalMap, vNormalMapUv, ${biasLiteral} )`));
    }
  };
  // The program cache key must separate the biased program from the plain one, and keep the baked-diffuse key.
  material.customProgramCacheKey = () => `${previousKey ? previousKey.call(material) : ''}|sampler-bias-${biasLiteral}-${[...biased].join('+')}`;
  material.needsUpdate = true;
  return true;
}

function bindMaterials(root, current) {
  const { manifest } = current;
  const probeShading = manifest.shading?.probe;
  // Box-projected reflections need the probe capture point; without one the probe stays an infinitely distant sky.
  const bakedPatch = createBakedShaderPatch({ probe: manifest.lighting.probe
    ? { position: manifest.lighting.probe.position, min: manifest.roomBounds.min, max: manifest.roomBounds.max,
        specularScale: probeShading?.specularScale }
    : null });
  const clothPatch = createClothShaderPatch();
  current.bakedPatch = bakedPatch;
  current.clothLayers = [];
  current.bedLighting = { clothes: new Map() };
  const bedOwner = createBedClothOwnerLookup(manifest.bedCloth);
  const starvedConfig = manifest.shading?.starvedIslands;
  const starvedMatch = createMeshMatcher(starvedConfig?.meshes);
  const floorPlankMatch = createMeshMatcher(['floor.plank.**']);
  // Per-material sampler overrides (see scene-spec.json runtime.shading.samplers; the shipped manifest is
  // frozen at the last export, so the built-in defaults apply until a new export carries the block).
  const samplerRules = (manifest.shading?.samplers ?? DEFAULT_SAMPLERS).map(rule => ({
    ...rule, match: createMeshMatcher(rule.meshes),
  }));
  const maxAnisotropy = current.renderer.capabilities.getMaxAnisotropy();
  current.starvedVertices = 0;
  const cache = new Map();
  const wireCache = new Map();
  const clothTextures = new Map();
  const clothAnisotropy = Math.max(1, Math.min(8, current.renderer.capabilities.getMaxAnisotropy()));
  let triangles = 0;
  root.traverse(mesh => {
    if (mesh.isLight) throw new Error('Runtime GLB must not contain lights outside the manifest sun configuration.');
    if (!mesh.isMesh) return;
    // glTF node extras live on a Group when an object has multiple material primitives.
    // Carry those authored semantics to the rendered primitive, never infer a missing atlas.
    propagateUserData(mesh, root);
    const component = mesh.userData.component;
    const atlasId = mesh.userData.lightmap;
    const atlas = current.atlases.get(atlasId);
    if (!component) throw new Error(`Mesh ${mesh.name || mesh.uuid} is missing a component.`);
    if (atlasId !== undefined && !atlas) throw new Error(`Mesh ${component} has an invalid lightmap.`);
    const { position, uv, uv1 } = mesh.geometry.attributes;
    if (!position || !uv || uv.count !== position.count || uv.itemSize !== 2) throw new Error(`Mesh ${component} is missing a full UV0 channel.`);
    if (atlas && (!uv1 || uv1.count !== position.count || uv1.itemSize !== 2)) throw new Error(`Mesh ${component} is missing a full UV1 channel for the atlas.`);
    const dynamic = mesh.userData.curtain_id !== undefined;
    // Cloth meshes deform at run time: they are never merged into the static batches.
    if (dynamic || (atlas && bedOwner(mesh))) current.dynamicMeshes.add(mesh);
    // Joint bevels / side faces baked into near-black islands (see repairStarvedVertices).
    const starved = !!atlas && !dynamic && starvedMatch(mesh.userData.physical_id ?? mesh.name);
    const isFloorPlank = !!atlas && !dynamic && floorPlankMatch(mesh.userData.physical_id ?? mesh.name);
    if (starved) current.starvedVertices += repairStarvedVertices(mesh, current.lightmapSamples, starvedConfig);
    function bind(source) {
      if (!source.isMeshStandardMaterial) throw new Error(`Material ${source.name} of ${component} is not a standard PBR material.`);
      if (dynamic) {
        const key = `${source.uuid}:cloth`;
        if (cache.has(key)) return cache.get(key);
        const material = source.clone();
        material.lightMap = null;
        material.side = material.shadowSide = THREE.DoubleSide;
        // Keep the scan's yarn detail at grazing angles without changing sofa samplers.
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
          const sourceTexture = material[key];
          if (!sourceTexture) continue;
          if (!clothTextures.has(sourceTexture)) {
            const texture = sourceTexture.clone();
            texture.anisotropy = clothAnisotropy;
            texture.needsUpdate = true;
            current.textures.add(texture);
            clothTextures.set(sourceTexture, texture);
          }
          material[key] = clothTextures.get(sourceTexture);
        }
        const clothShading = manifest.shading?.cloth;
        if (clothShading) {
          // Alpha-blended cloth is the translucent voile; opaque cloth is the drape.
          const layer = material.transparent && material.opacity < 1 ? 'sheer' : 'drape';
          const uniforms = clothPatch.uniformsFor(clothShading[layer], layer);
          material.onBeforeCompile = shader => clothPatch.apply(shader, uniforms);
          material.customProgramCacheKey = () => clothPatch.key;
          current.clothLayers.push({ layer, material, uniforms });
        }
        current.materials.add(material);
        cache.set(key, material);
        return material;
      }
      // Glass and the emissive bulb intentionally have no baked atlas.
      // Leave their native physical/emissive material and environment response intact.
      if (!atlas) {
        cache.set(`${source.uuid}:unbaked`, source);
        return source;
      }
      // Partition material identity by atlas and bed-cloth owner.
      const owner = atlas ? bedOwner(mesh) : null;
      const floor = isFloorPlank || mesh.userData.physical_id === 'shell.floor.substrate';
      const key = `${source.uuid}:${atlas?.id ?? 'unbaked'}:${owner?.id ?? ''}:${starved ? 'groove' : ''}:${floor ? 'floor' : ''}`;
      if (cache.has(key)) return cache.get(key);
      const material = source.clone();
      material.vertexColors = starved;
      current.materials.add(material);
      if (atlas) {
        material.lightMap = atlas.texture;
        // Exporter records PI irradiance compensation in atlas.intensity.
        material.lightMapIntensity = atlas.intensity;
        let materialUniforms;
        // The floor carries its own balance (see FLOOR_TINT in interior-shading.js): the baked ambient
        // is too bright and too warm on the open floor, and the window glare strip is missing.
        if (floor) {
          materialUniforms = bakedPatch.floorUniforms();
          // The floor's sheen is clamped to the brightest floor the reference shows, so a re-rendered
          // probe with a brighter window cannot turn the open floor into a near-white wedge.
          material.defines = { ...material.defines, ...bakedPatch.floorDefines() };
        }
        if (owner) {
          // Cloth materials are exclusive to their cloth so the ambient override can differ per cloth.
          materialUniforms = { uBedAmbient: { value: new THREE.Vector4() } };
          if (!current.bedLighting.clothes.has(owner.id)) current.bedLighting.clothes.set(owner.id, { id: owner.id, materials: [], surface: null, reference: null });
          const cloth = current.bedLighting.clothes.get(owner.id);
          cloth.materials.push({ uniforms: materialUniforms, follower: !owner.surface });
          if (owner.surface) cloth.surface = { mesh, atlas };
        }
        material.onBeforeCompile = shader => bakedPatch.apply(shader, materialUniforms);
        // The floor's program is a different one (the sheen clamp), so the cache key must differ too.
        material.customProgramCacheKey = () => floor ? `${bakedPatch.key}-floor` : bakedPatch.key;
      }
      // Sampler overrides for weaves the source view cannot resolve (see applySamplerOverride).
      // They run after the baked patch so the sampler bias wraps the baked-diffuse shader.
      for (const rule of samplerRules) {
        if (!rule.match(mesh.userData.physical_id ?? mesh.name)) continue;
        applySamplerOverride(material, rule, maxAnisotropy);
      }
      // Cloning retains authored alpha blending, alpha test, side and depth settings (including foliage).
      cache.set(key, material);
      return material;
    }
    function diagnostic(material) {
      if (!wireCache.has(material.uuid)) {
        const wire = new THREE.MeshBasicMaterial({ color: '#d8d2c6', wireframe: true, side: material.side });
        current.materials.add(wire);
        wireCache.set(material.uuid, wire);
      }
      return wireCache.get(material.uuid);
    }
    const pbr = Array.isArray(mesh.material) ? mesh.material.map(bind) : bind(mesh.material);
    const wire = Array.isArray(pbr) ? pbr.map(diagnostic) : diagnostic(pbr);
    mesh.material = pbr;
    const materials = Array.isArray(pbr) ? pbr : [pbr];
    mesh.castShadow = !materials.some(material => (material.transmission ?? 0) > 0.5);
    mesh.receiveShadow = true;
    current.entries.push({ mesh, pbr, diagnostic: wire });
    triangles += (mesh.geometry.index?.count ?? position.count) / 3;
  });
  if (!current.entries.length) throw new Error('Scene has no meshes.');
  // Per-vertex open-ambient fallback for baked holes (seams, welts, tubes); reads the precomputed per-vertex lightmap samples.
  current.lightFallbacks = applyLightFallbacks(current.entries, current.lightmapSamples);
  // Window aperture for the floor glare shader uniforms.
  current.opening = current.bakedPatch.fitOpening(current.entries, current.manifest.roomBounds);
  // A bed cloth that leaves its baked rest pose is relit with its own open-light ambient instead of the baked per-texel shading.
  for (const cloth of current.bedLighting.clothes.values()) {
    if (!cloth.surface) throw new Error(`Bed cloth ${cloth.id} has no lightmapped surface mesh.`);
    const reference = ambientReference(cloth.surface.mesh, current.lightmapSamples);
    cloth.reference = reference;
    for (const { uniforms } of cloth.materials) uniforms.uBedAmbient.value.set(reference[0], reference[1], reference[2], 0);
  }
  // Every CPU-side lightmap lookup is done: the sample table (2.5 MB) is not needed any more.
  const sampleStats = { meshes: current.lightmapSamples.meshCount, vertices: current.lightmapSamples.vertexCount };
  current.lightmapSamples = null;
  current.stats = { meshes: current.entries.length, components: new Set(current.entries.map(entry => entry.mesh.userData.component)).size,
    triangles, geometries: current.geometries.size, pbrMaterials: cache.size, lightmaps: current.atlases.size, lightmapSamples: sampleStats,
    environmentTextureUuid: current.environmentTarget.texture.uuid, atlasRepair: current.atlasRepair, loader: current.assets?.stats ?? null, starvedVertices: current.starvedVertices, lightFallbacks: current.lightFallbacks, opening: current.opening, manifest: current.manifest.stats ?? {},
    // Milliseconds since the manifest was validated; filled in as loading advances (cumulative, not per phase).
    timingsMs: current.timings };
}

function createPendants(current) {
  current.pendants = [];
  for (const spec of current.manifest.lighting.pendants ?? []) {
    const entries = current.entries.filter(({ mesh }) => mesh.userData.physical_id === spec.bulbMesh);
    if (entries.length !== 1) throw new Error(`Pendant ${spec.id} needs its actual unique bulb mesh.`);
    const pbr = entries[0].pbr;
    const bulbs = (Array.isArray(pbr) ? pbr : [pbr]).map(material => {
      if (!material.emissive || material.emissiveIntensity <= 0 || material.emissive.getHex() === 0) {
        throw new Error(`Pendant ${spec.id} bulb has no authored emission.`);
      }
      return { material, intensity: material.emissiveIntensity };
    });
    const light = new THREE.SpotLight();
    light.color.setRGB(...spec.color);
    light.intensity = spec.intensity;
    light.position.fromArray(spec.position);
    light.target.position.fromArray(spec.target);
    light.distance = spec.distance;
    light.angle = spec.angle;
    light.penumbra = spec.penumbra;
    light.decay = spec.decay;
    light.castShadow = true;
    light.shadow.mapSize.setScalar(1024);
    light.shadow.camera.near = .015;
    light.shadow.camera.far = spec.distance;
    // The cone is ~150 degrees wide and the fabric headboard / wall are hit at a grazing angle (cos ~0.3), where a 1024 map
    // resolves ~4 mm per texel at 0.5 m: a smaller offset draws concentric acne rings through the lamp glow.
    light.shadow.bias = -.0004;
    light.shadow.normalBias = .02;
    current.pendants.push({ spec, light, bulbs });
    current.scene.add(light, light.target);
  }
}

function disposeSession() {
  cancelAnimationFrame(renderRequest);
  renderRequest = 0;
  clearTimeout(session?.perf?.restTimer);
  curtainControlSeen.target = NaN;
  if (!session) return;
  paletteUI?.dispose();
  paletteUI = null;
  ui['palette-controls'].hidden = true;
  session.palette?.dispose();
  session.bedCloth?.dispose();
  session.curtains?.dispose();
  session.navigation?.dispose();
  session.assets?.abort();
  session.sun?.dispose();
  for (const { light } of session.pendants ?? []) light.dispose();
  session.controls?.dispose();
  session.environmentTarget?.dispose();
  for (const geometry of session.geometries) geometry.dispose();
  for (const material of session.materials) material.dispose();
  const closedImages = new Set();
  for (const texture of session.textures) {
    texture.dispose();
    if (texture.image?.close && !closedImages.has(texture.image)) {
      texture.image.close();
      closedImages.add(texture.image);
    }
  }
  // Detach first: forcing the loss below must not report a viewer failure. three.js never disposes its transmission target
  // (glass), so release the context itself rather than relying on per-object disposal.
  const { renderer } = session;
  if (renderer) renderer.domElement.removeEventListener('webglcontextlost', session.onContextLost);
  renderer?.dispose();
  if (renderer && !renderer.getContext().isContextLost()) renderer.forceContextLoss();
  session.renderer?.domElement.remove();
  session = null;
}

async function start() {
  if (loading || stopped) return;
  loading = true;
  disposeSession();
  Object.assign(state, { status: 'loading', firstFrameMs: null, error: null, mode: '3d', view: 'source', wireframe: false, frames: 0, pendantLights: true });
  ui['message-title'].textContent = 'Opening room';
  ui['message-detail'].textContent = 'Reading model, materials and lightmap atlases.';
  ui['load-status'].textContent = 'Reading scene manifest…';
  ui['load-progress'].removeAttribute('value');
  syncControls();
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}assets/interior-runtime/manifest.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load manifest (${response.status}). The viewer needs the optimised runtime set: run npm run optimize:assets.`);
    const manifest = await response.json();
    if (stopped) return;
    validateManifest(manifest);
    // Export manifests use workspace-root /assets paths; deployments may live below a gallery route.
    const assetUrl = value => value ? `${import.meta.env.BASE_URL}${value.slice(1)}` : value;
    for (const field of ['sourceImage', 'model', 'portableModel', 'blender', 'environment', 'background']) {
      if (manifest[field]) manifest[field] = assetUrl(manifest[field]);
    }
    for (const atlas of manifest.lightmaps) atlas.url = assetUrl(atlas.url);
    if (manifest.lightmapSamples) {
      manifest.lightmapSamples.url = assetUrl(manifest.lightmapSamples.url);
      manifest.lightmapSamples.index = assetUrl(manifest.lightmapSamples.index);
    }
    const sourceDownload = document.getElementById('download-source');
    if (sourceDownload) {
      sourceDownload.href = import.meta.env.VITE_MODERN_BEDROOM_DOWNLOADS?.source ?? `${import.meta.env.BASE_URL}source/modern-bedroom.zip`;
      sourceDownload.hidden = false;
    }
    configureSceneContent(manifest);
    // The reference image does not depend on WebGL: show it even if the 3D viewer cannot start.
    for (const id of ['source-view', 'source-thumbnail']) ui[id].src = manifest.sourceImage;
    ui['source-link'].href = manifest.sourceImage;
    const loadStart = performance.now();
    const current = { manifest, geometries: new Set(), materials: new Set(), textures: new Set(), timings: {},
      atlases: new Map(), entries: [], shaderError: null, lastRenderTime: null, perf: createPerfState(), dynamicMeshes: new Set() };
    session = current;
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    catch (error) { throw new Error(`This browser or device could not start WebGL, which the 3D room needs. The source reference image is still shown for comparison. (${error.message})`); }
    current.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = manifest.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadow maps are redrawn on demand (frame() sets needsUpdate when a caster moved); the first render draws them.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.setClearColor('#282722');
    renderer.debug.onShaderError = () => { current.shaderError = new Error('Could not compile the PBR/lightmap shader on this device.'); };
    const canvas = renderer.domElement;
    canvas.tabIndex = -1;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${manifest.title}. Interactive 3D interior.`);
    canvas.setAttribute('aria-describedby', 'interaction-hint');
    canvas.addEventListener('keydown', cameraKeys);
    current.onContextLost = event => { event.preventDefault(); fail(new Error('Lost the WebGL context. Choose Retry load to rebuild the viewer.')); };
    canvas.addEventListener('webglcontextlost', current.onContextLost);
    ui['canvas-host'].append(canvas);
    const scene = new THREE.Scene();
    current.scene = scene;
    const roomSize = new THREE.Vector3().fromArray(manifest.roomBounds.max).sub(new THREE.Vector3().fromArray(manifest.roomBounds.min)).length();
    current.camera = new THREE.PerspectiveCamera(manifest.camera.fov, manifest.sourceImageSize[0] / manifest.sourceImageSize[1], 0.03, Math.max(250, roomSize * 4));
    const controls = new OrbitControls(current.camera, canvas);
    current.controls = controls;
    controls.enabled = false;
    controls.enableDamping = false;
    controls.enablePan = true;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.7;
    current.navigation = createInteriorNavigation(current.camera, controls, manifest.roomBounds);
    controls.addEventListener('change', () => {
      if (!applyingPose && state.status === 'ready') {
        markInteraction();
        if (state.view !== null) { state.view = null; syncControls(); }
      }
      requestRender();
    });
    applyView('source');
    resize();
    // Real progress (bytes fetched + assets decoded) comes from the asset loader; `tracked` only names failures.
    ui['load-progress'].max = 1;
    ui['load-progress'].value = 0;
    const tracked = async (promise, label) => {
      try { return await promise; }
      catch (error) { throw new Error(`Could not load ${label}: ${error.message}`); }
    };
    const assets = createAssetLoader({ renderer,
      onProgress: ({ loaded, total, fraction }) => {
        if (state.status !== 'loading') return;
        ui['load-progress'].value = fraction;
        ui['load-status'].textContent = `Loading ${(loaded / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`;
      } });
    current.assets = assets;
    current.atlasRepair = [];
    const uploader = createTextureUploader(renderer, { shouldStop: () => stopped });
    const tasks = [
      tracked(assets.loadGltf(manifest.model).then(async gltf => {
        current.root = gltf.scene;
        collectResources(gltf.scene, current);
        // GLTFLoader deliberately resolves failed texture loads as null. Never call that ready.
        const textures = await gltf.parser.getDependencies('texture');
        for (const texture of textures) if (texture) current.textures.add(texture);
        if (textures.some(texture => !texture)) throw new Error('One or more textures inside the GLB are missing.');
      }), 'model and PBR textures'),
      tracked(assets.loadHdr(manifest.environment).then(texture => {
        texture.colorSpace = THREE.NoColorSpace;
        texture.mapping = THREE.EquirectangularReflectionMapping;
        // Prefilter the reflection probe now, while the model and atlases are still downloading.
        const pmrem = new THREE.PMREMGenerator(renderer);
        try { current.environmentTarget = pmrem.fromEquirectangular(texture); }
        finally { pmrem.dispose(); texture.dispose(); }
        scene.environment = current.environmentTarget.texture;
        current.timings.probeMs = Math.round(performance.now() - loadStart);
      }), 'room reflection probe'),
      tracked(Promise.all([ui['source-view'].decode(), ui['source-thumbnail'].decode()]).then(() => {
        const image = ui['source-view'];
        if (image.naturalWidth !== manifest.sourceImageSize[0] || image.naturalHeight !== manifest.sourceImageSize[1]) {
          throw new Error('sourceImageSize does not match the decoded source image; correct the scene specification and re-export.');
        }
      }), 'source reference image'),
      ...manifest.lightmaps.map(atlas => tracked(assets.loadLightmap(atlas.url)
        .then(texture => {
          current.atlases.set(atlas.id, { ...atlas, texture });
          // Oriented and rim-repaired offline by the optimiser; the record keeps the stats shape the repair report had.
          current.atlasRepair.push({ id: atlas.id, width: texture.image.width, height: texture.image.height, precomputed: true, ms: 0 });
          // Upload right away, while the rest is still loading.
          current.textures.add(texture);
          uploader.add(texture);
        }), `atlas ${atlas.id}`)),
      tracked(assets.loadLightmapSamples(manifest.lightmapSamples).then(samples => { current.lightmapSamples = samples; }), 'lightmap samples'),
    ];
    if (manifest.background != null) {
      tasks.push(tracked(assets.loadHdr(manifest.background).then(texture => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.NoColorSpace;
        current.background = texture;
        current.textures.add(texture);
        scene.background = texture;
        scene.backgroundIntensity = manifest.backgroundIntensity;
      }), 'scene background'));
    }
    // Settle every load before disposal/retry; a late texture must not leak into another session.
    const results = await Promise.allSettled(tasks);
    assets.release();                       // ends the Basis transcoder workers
    current.timings.assetsMs = Math.round(performance.now() - loadStart);
    if (stopped) throw new Error('Viewer was disposed while assets were loading.');
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    if (state.error) throw new Error(state.error);
    ui['load-status'].textContent = 'Compiling materials…';
    bindMaterials(current.root, current);
    current.timings.bindMs = Math.round(performance.now() - loadStart);
    scene.add(current.root);
    const sunSpec = manifest.lighting.sun;
    if (sunSpec) {
      const sun = new THREE.DirectionalLight();
      sun.color.setRGB(...sunSpec.color);
      sun.intensity = sunSpec.intensity;
      // Fit the shadow volume to the authored room, not Oak/Linen coordinates.
      const roomCenter = new THREE.Vector3().fromArray(manifest.roomBounds.min).add(new THREE.Vector3().fromArray(manifest.roomBounds.max)).multiplyScalar(0.5);
      const shadowExtent = roomSize * 0.6;
      sun.target.position.copy(roomCenter);
      sun.position.fromArray(sunSpec.position).sub(new THREE.Vector3().fromArray(sunSpec.target)).normalize().multiplyScalar(roomSize * 1.5).add(roomCenter);
      sun.castShadow = true;
      sun.shadow.mapSize.setScalar(sunSpec.shadowMapSize);
      sun.shadow.camera.near = 0.1;
      sun.shadow.camera.far = roomSize * 3;
      sun.shadow.camera.left = sun.shadow.camera.bottom = -shadowExtent;
      sun.shadow.camera.right = sun.shadow.camera.top = shadowExtent;
      sun.shadow.bias = -0.00008;
      sun.shadow.normalBias = 0.015;
      sun.shadow.camera.updateProjectionMatrix();
      current.sun = sun;
      scene.add(sun, sun.target);
    }
    createPendants(current);
    // Recolouring is a shader term patched into the claimed materials: create it before the first compile so no program is ever rebuilt.
    current.palette = createPalette({ session: current, entries: current.entries, renderer, requestRender });
    if (current.palette.unmatched.length) console.warn(`Palette groups matched no material: ${current.palette.unmatched.join(', ')}`);
    // Cloth input and motion invalidate the shadow maps and keep the interaction resolution (see frame()).
    current.curtains = createCurtainInteraction({ root: current.root, camera: current.camera, roomBounds: manifest.roomBounds,
      canvas, controls, onChange: onSimChange, isInteractive: () => state.status === 'ready' && state.mode === '3d' && !current.bedCloth?.grabbing });
    if (manifest.bedCloth) {
      current.bedCloth = createBedCloth({ root: current.root, camera: current.camera, roomBounds: manifest.roomBounds, config: manifest.bedCloth,
        canvas, controls, onChange: onSimChange, isInteractive: () => state.status === 'ready' && state.mode === '3d' && !current.curtains?.grabbing });
      syncBedLighting();
    }
    optimizeStaticGeometry(current);
    configureInteractionContent(current);
    current.timings.interactionsMs = Math.round(performance.now() - loadStart);
    // Atlas uploads are already in flight; the rest upload while the shader compile is pending.
    ui['load-status'].textContent = 'Compiling materials and uploading textures…';
    uploader.add(...current.textures);      // already-uploaded atlases are no-ops
    await Promise.all([renderer.compileAsync(scene, current.camera), uploader.idle()]);
    // The wireframe materials compile now too, so the first toggle does not hitch.
    applyWireframeMaterials(current, true);
    try { await renderer.compileAsync(scene, current.camera); } finally { applyWireframeMaterials(current, false); }
    current.timings.compileMs = Math.round(performance.now() - loadStart);
    if (stopped) throw new Error('Viewer was disposed while shaders were compiling.');
    if (state.error) throw new Error(state.error);
    if (current.shaderError) throw current.shaderError;
    current.timings.uploadMs = Math.round(performance.now() - loadStart);
    current.timings.uploadedTextures = current.textures.size;
    renderer.render(scene, current.camera);
    if (current.shaderError) throw current.shaderError;
    state.frames++;
    state.firstFrameMs = Math.round(performance.now());
    current.timings.firstFrameMs = Math.round(performance.now() - loadStart);
    current.perf.shadowDirty = false;
    current.perf.shadowUpdates++;
    current.perf.shadowVersion = (current.curtains?.geometryVersion ?? 0) + (current.bedCloth?.geometryVersion ?? 0);
    state.status = 'ready';
    current.timings.readyMs = Math.round(performance.now() - loadStart);
    ui['load-status'].textContent = `${number.format(current.stats.meshes)} meshes · ${number.format(current.stats.triangles)} triangles · all textures and atlases loaded.`;
    paletteUI = mountPaletteUI({ root: ui['palette-controls'], palette: current.palette });
    syncControls();
    requestRender();
  } catch (error) {
    disposeSession();
    if (!stopped) fail(error);
  } finally {
    loading = false;
    if (stopped) disposeSession();
    else syncControls();
  }
}

ui['mode-3d'].addEventListener('click', () => setMode('3d'));
ui['mode-source'].addEventListener('click', () => setMode('source'));
ui.wireframe.addEventListener('click', () => setWireframe(!state.wireframe));
ui.reset.addEventListener('click', reset);
ui['reset-bed'].addEventListener('click', () => { if (state.status === 'ready') { session.bedCloth?.reset(); requestRender(); } });
ui['pendant-lights'].addEventListener('click', () => setPendantLights(!state.pendantLights));
ui['retry-load'].addEventListener('click', start);
ui['curtain-amount'].addEventListener('input', () => setCurtainClosure(Number(ui['curtain-amount'].value)/100));
ui['curtain-open'].addEventListener('click', () => setCurtainClosure(0));
ui['curtain-close'].addEventListener('click', () => setCurtainClosure(1));
ui['curtain-wind'].addEventListener('click', () => setCurtainWind(!session.curtains.wind));
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(ui.viewport);
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', requestRender);
window.addEventListener('pagehide', event => {
  session?.palette?.flush();
  if (!event.persisted) {
    stopped = true;
    cancelAnimationFrame(renderRequest);
    resizeObserver.disconnect();
    session?.curtains?.setEnabled(false);
    session?.bedCloth?.setEnabled(false);
    // In-flight loaders retain ownership until all settle, then finally disposes.
    if (!loading) disposeSession();
  }
});
start();
