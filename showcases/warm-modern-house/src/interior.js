import './interior.css';
import videoReference from '../../../public/references/warm-modern-house.webp?url';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RuntimeAssetLoader } from './interior-assets.js';
import { createObjectController, createHouseObjects, describeCondition, objectMetadata } from './interior-objects.js';
import { InteriorRenderPipeline, SHADOW_CHANGING_REASONS } from './interior-render-pipeline.js';
import { uploadRoomTextures } from './interior-room-upload.js';
import { substituteThinGlass, bindGlazingShadows } from './interior-thin-glass.js';
import { tierAffectsShadow, publishTier } from './interior-tier-publication.js';
import { InteriorScheduler } from './interior-performance.js';
import { InteriorBenchmark, benchmarkOptions, hashFetchedBytes } from './interior-benchmark.js';
import { InteriorResidency } from './interior-residency.js';
import { createCurtainInteraction } from './interior-curtains.js';
import { createInteriorNavigation } from './interior-navigation.js';
import { validateManifest, validateReferences, usesPolyHavenAPI } from './interior-manifest.js';
import { bindBakedLightmap } from './interior-lightmaps.js';
import { bindBoxProjectedProbe } from './interior-probes.js';
import { buildRoomGraph, visibleRooms } from './interior-portals.js';
import { createWalkNavigation } from './interior-walk.js';
import { createGuidedJourney } from './interior-journey.js';
import { RoomStreamer } from './interior-streaming.js';
import { parseViewId, viewCatalog, viewLabel, resolveCurrentRoom, attributeRoomBytes, planRoomPressure,
  memoryBudgetOverride, tierBudget, findWalkablePoint } from './interior-house.js';
import { WALK_BUTTONS, keyAction, intentFromActions, hasIntent, stepFromIntent, buttonStep,
  joystickIntent, lookFromDrag } from './interior-walk-input.js';

const ui = Object.fromEntries([
  'viewport', 'canvas-host', 'source-panel', 'source-view', 'source-thumbnail', 'source-link',
  'mode-3d', 'mode-source', 'view-label', 'room-label', 'viewer-message', 'message-title', 'message-detail',
  'load-status', 'load-progress', 'retry-load', 'finish-swatches', 'finish-label', 'wireframe',
  'reset', 'download-glb', 'download-blend',
  'curtain-amount', 'curtain-percent', 'curtain-open', 'curtain-close', 'curtain-wind',
  'scene-title', 'camera-actions', 'finish-controls', 'curtain-controls', 'resource-credit',
  'source-caption', 'thumbnail-caption', 'interaction-hint', 'representation-title', 'representation-detail',
  'performance-status', 'retry-detail', 'finish-title', 'finish-group', 'panel-lead', 'source-note', 'portability-note',
  'object-controls', 'object-list', 'object-hide', 'object-isolate', 'objects-show-all', 'object-details', 'object-live',
  'viewer-notice', 'nav-orbit', 'nav-walk', 'walk-note', 'walk-controls', 'walk-buttons', 'walk-live',
  'walk-joystick', 'walk-joystick-knob',
  'journey-controls', 'journey-path', 'journey-start', 'journey-pause', 'journey-stop', 'journey-status',
].map(id => [id, document.getElementById(id)]));
let viewButtons = [];
const state = { status: 'loading', error: null, mode: '3d', navMode: 'orbit', view: null, room: null, finish: null,
  finishGroup: null, selected: null, isolated: null, wireframe: false, frames: 0, pitch: 0 };
const offset = new THREE.Vector3();
const orbit = new THREE.Spherical();
const forward = new THREE.Vector3();
const number = new Intl.NumberFormat('en-US');
const baseUrl = new URL(import.meta.env.BASE_URL, location.origin).href;
const downloads = import.meta.env.VITE_INTERIOR_DOWNLOADS ?? {};
const keysHeld = new Set();
const buttonsHeld = new Set();
let session = null;
let loading = false;
let generation = 0;
let startAbort = null;
let applyingPose = false;
let stopped = false;
let loadPhase = 0;

function cameraSnapshot() {
  if (!session?.camera) return null;
  const { camera, controls } = session;
  return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
    target: controls.target.toArray(), fov: camera.fov, aspect: camera.aspect,
    near: camera.near, far: camera.far, view: state.view, room: state.room };
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
    envMapUuid: material.envMap?.uuid ?? null,
    textures };
}

function inventorySnapshot() {
  return session?.entries.map(({ mesh }) => ({
    objectId: mesh.userData.objectId, room: mesh.userData.room, class: mesh.userData.class,
    component: mesh.userData.component, uuid: mesh.uuid, name: mesh.name,
    geometryUuid: mesh.geometry.uuid, finishGroup: mesh.userData.finishGroup ?? null,
    currentFinish: session.finishSelections.get(mesh.userData.finishGroup) ?? null,
    curtain: mesh.userData.curtain_id ?? null, curtainPart: mesh.userData.curtain_part ?? null,
    lightmap: mesh.userData.lightmap ?? null,
    attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attribute]) =>
      [name, { count: attribute.count, itemSize: attribute.itemSize, version: attribute.version }])),
    indexCount: mesh.geometry.index?.count ?? null,
    materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(materialSnapshot),
  })) ?? [];
}

function navigationSnapshot() {
  if (!session?.camera) return null;
  const base = { mode: state.navMode, room: state.room, scope: session.overview ? 'house' : 'room',
    limit: session.navigationData?.limit ?? null, blocked: false };
  if (state.navMode === 'walk' && session.walk) {
    const walk = session.walk.snapshot();
    return { ...walk, ...base, pitch: state.pitch, blocked: walk.blockedLast };
  }
  const orbitState = session.navigation?.snapshot();
  return { ...orbitState, ...base, blocked: orbitState?.safety.atBoundary ?? false };
}

Object.defineProperty(window, 'interiorStudy', {
  value: Object.freeze({
    get status() { return state.status; },
    get error() { return state.error; },
    get manifest() { return session ? structuredClone(session.manifest) : null; },
    get camera() { return cameraSnapshot(); },
    get frames() { return state.frames; },
    get stats() { return session?.stats ? structuredClone(session.stats) : null; },
    get inventory() { return inventorySnapshot(); },
    get mode() { return state.mode; },
    get finish() { return state.finish; },
    get wireframe() { return state.wireframe; },
    get curtains() { return currentCurtains()?.snapshot() ?? null; },
    get navigation() { return navigationSnapshot(); },
    get journey() { return session?.journey?.snapshot() ?? null; },
    get performance() { return session?.scheduler?.snapshot ?? null; },
    get streaming() { return session?.streamer?.snapshot() ?? null; },
    // "loading" while any room request or decoded high tier is still outstanding after P0.
    get refinement() {
      if (!session || state.status !== 'ready') return null;
      if (session.failures.size) return 'degraded';
      return session.streamer.inflight.size || session.pendingHighs.size ? 'loading' : 'complete';
    },
    get benchmark() { return session?.benchmark?.receipt ?? null; },
    get benchmarkError() { return session?.benchmark?.error ?? null; },
    get objects() { return session?.objectApi ?? null; },
    get view() { return state.view; },
    get room() { return state.room; },
    get views() { return session ? [...session.views.keys()] : []; },
    get canvas() {
      const canvas = session?.renderer?.domElement;
      return canvas ? { width: canvas.width, height: canvas.height, connected: canvas.isConnected,
        clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null;
    },
    get lighting() { return session?.renderer ? { model: session.manifest.lighting.model,
      exposure: session.renderer.toneMappingExposure, sunIntensity: session.sun?.intensity ?? null,
      shadowMapSize: session.sun?.shadow.mapSize.toArray() ?? null } : null; },
    setView, setFinish, setMode, setWireframe, setCurtainClosure, setCurtainWind, reset,
    setNavigationMode, walkBy,
  }),
});

function currentCurtains() { return session?.rooms.get(state.room)?.curtains ?? null; }

function allCurtains() { return session ? [...session.rooms.values()].map(room => room.curtains).filter(Boolean) : []; }

function syncCurtainControls() {
  const curtain = currentCurtains();
  const percent = Math.round((curtain?.targetClosure ?? 0) * 100);
  if (ui['curtain-amount'].value !== String(percent)) ui['curtain-amount'].value = percent;
  ui['curtain-percent'].textContent = `${percent}%`;
  ui['curtain-amount'].setAttribute('aria-valuetext', `${ui['curtain-amount'].value}% coverage`);
  ui['curtain-wind'].setAttribute('aria-pressed', String(curtain?.wind ?? false));
  ui['curtain-wind'].disabled = !curtain?.count || state.status !== 'ready' || state.mode !== '3d' || !!curtain?.reducedMotion;
  ui['curtain-wind'].title = curtain?.reducedMotion ? 'Wind disabled by your reduced-motion setting.' : 'Toggle the gentle breeze that animates the fabric.';
}

const coarsePointer = () => !!window.matchMedia?.('(pointer: coarse)').matches;

function showNotices() {
  const text = session ? [...session.notices.values()].join(' ') : '';
  ui['viewer-notice'].textContent = text;
  ui['viewer-notice'].hidden = !text;
}

function syncControls() {
  const ready = state.status === 'ready';
  const interactive = ready && state.mode === '3d';
  const walking = state.navMode === 'walk';
  const journey = session?.journey?.snapshot();
  const touring = state.navMode === 'tour';
  ui['journey-controls'].hidden = !walkAvailableForJourney();
  ui['journey-path'].disabled = !interactive || touring;
  ui['journey-start'].disabled = !interactive || !walkAvailableForJourney() || touring;
  ui['journey-pause'].disabled = !interactive || !touring || !['playing', 'paused'].includes(journey?.state);
  ui['journey-pause'].textContent = journey?.state === 'paused' ? 'Resume journey' : 'Pause journey';
  ui['journey-stop'].disabled = !interactive || !touring;
  for (const mode of ['3d', 'source']) {
    ui[`mode-${mode}`].disabled = !ready;
    ui[`mode-${mode}`].setAttribute('aria-pressed', String(state.mode === mode));
  }
  for (const button of viewButtons) {
    button.disabled = !interactive;
    button.setAttribute('aria-pressed', String(state.view === button.dataset.view));
  }
  for (const button of ui['finish-swatches'].children) {
    button.disabled = !interactive;
    button.setAttribute('aria-pressed', String(state.finish === button.dataset.finish));
  }
  ui.wireframe.disabled = !interactive;
  ui.wireframe.setAttribute('aria-pressed', String(state.wireframe));
  ui.reset.disabled = !ready;
  const walkAvailable = !!session?.walkAvailable;
  ui['nav-orbit'].disabled = !interactive;
  ui['nav-orbit'].setAttribute('aria-pressed', String(state.navMode === 'orbit'));
  ui['nav-walk'].disabled = !interactive || !walkAvailable;
  ui['nav-walk'].setAttribute('aria-pressed', String(walking));
  ui['walk-note'].hidden = !session || (walkAvailable && !session.walkNote);
  ui['walk-note'].textContent = session?.walkNote ?? '';
  ui['walk-controls'].hidden = !walking || !interactive;
  for (const button of ui['walk-buttons'].children) button.disabled = !interactive || !walking;
  ui['walk-joystick'].hidden = !(walking && interactive && coarsePointer());
  ui['room-label'].textContent = session && state.room ? `Room: ${session.roomDefs.get(state.room).label}` : '';
  const cloth = currentCurtains();
  for (const id of ['curtain-amount', 'curtain-open', 'curtain-close', 'curtain-wind']) ui[id].disabled = !interactive || !cloth?.count;
  ui['curtain-controls'].hidden = !cloth?.count;
  ui['finish-controls'].hidden = !session?.manifest.variants.length;
  ui['finish-group'].disabled = !interactive;
  ui['object-controls'].hidden = !session?.objects;
  ui['object-controls'].disabled = !interactive;
  ui['performance-status'].hidden = !ready;
  ui['retry-detail'].hidden = !session?.failures.size;
  ui['retry-detail'].disabled = loading;
  syncCurtainControls();
  showNotices();
  ui['canvas-host'].hidden = state.mode !== '3d';
  ui['source-panel'].hidden = state.mode !== 'source';
  ui['viewer-message'].hidden = ready;
  ui['load-progress'].hidden = state.status !== 'loading';
  ui['retry-load'].hidden = state.status !== 'error';
  ui.viewport.setAttribute('aria-busy', String(state.status === 'loading'));
  ui['retry-load'].disabled = loading;
  ui['load-status'].dataset.state = state.status;
  ui['viewer-message'].dataset.state = state.status;
  ui['view-label'].textContent = state.mode === 'source' && session ? 'Reference image · video frame'
    : state.wireframe ? '3D · geometry wireframe'
      : cloth?.count ? '3D · interactive curtains' : walking ? '3D · walking' : '3D · authored interior';
  for (const [id, field] of [['download-glb', 'portable'], ['download-blend', 'native']]) {
    const link = ui[id];
    link.setAttribute('aria-disabled', String(!ready));
    link.tabIndex = ready ? 0 : -1;
    if (ready) link.href = downloads[field] ?? session.loader.assetUrl(session.manifest.products[field]);
    else link.removeAttribute('href');
  }
  if (session?.controls) {
    for (const curtains of allCurtains()) curtains.setEnabled(interactive);
    const benchmarkActive = ['moving', 'stopping', 'finishing'].includes(session.benchmark?.phase);
    session.controls.enabled = interactive && !walking && !touring && !benchmarkActive && !currentCurtains()?.grabbing;
    // While loading, the scheduler must keep running until its refresh calibration finishes
    // (start() hides it afterwards); a mid-load sync from a room notice must not stop it.
    if (state.status !== 'loading') session.scheduler?.setVisible(interactive);
    session.renderer.domElement.tabIndex = interactive ? 0 : -1;
    session.renderer.domElement.setAttribute('aria-disabled', String(!interactive));
  }
}

async function fail(error) {
  // Invalidate startup before aborting; late failures cannot tear down a retry.
  const run = ++generation;
  loading = true;
  state.status = 'error';
  state.error = error instanceof Error ? error.message : String(error);
  setLoadPhase(Math.min(loadPhase, 3), true);
  ui['message-title'].textContent = 'Could not open the house';
  ui['message-detail'].textContent = state.error;
  ui['load-status'].textContent = 'Scene load did not finish. Check your connection, then choose “Retry load”.';
  syncControls();
  try { await disposeSession(); }
  finally {
    if (generation === run) {
      loading = false;
      syncControls();
    }
  }
}

function requestRender(reason = 'scene') {
  session?.scheduler?.request(reason);
}

function resize() {
  if (!session?.camera) return;
  const { renderer, camera, pipeline, benchmarkOptions: options } = session;
  const width = options?.size[0] ?? ui.viewport.clientWidth;
  const height = options?.size[1] ?? ui.viewport.clientHeight;
  if (!width || !height) return;
  renderer.setPixelRatio(options ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  pipeline?.resize();
  requestRender('resize');
}

/* ---------- rooms, sources and the current room ---------- */

function sourceFor(manifest, roomId) {
  return manifest.sources.find(source => source.room === roomId) ?? manifest.sources[0];
}

function updateSourceImage(current) {
  const url = current.sourceBlobs.get(videoReference);
  ui.viewport.style.setProperty('--source-aspect', '1000 / 563');
  for (const id of ['source-view', 'source-thumbnail']) {
    ui[id].width = 1000;
    ui[id].height = 563;
    ui[id].alt = 'Reference image: exterior of a three-storey house from the supplied video';
    if (url) { if (ui[id].src !== url) ui[id].src = url; }
    else ui[id].removeAttribute('src');
  }
  ui['source-link'].href = videoReference;
  ui['source-caption'].textContent = 'Reference image · video frame · not a viewer render';
  if (ui['thumbnail-caption']) ui['thumbnail-caption'].textContent = 'Reference image from the video. Open the image to see it full size.';
  ui['source-note'].textContent = 'This reference is a frame from the supplied video. The 3D house was authored from separate synthetic design references; its dimensions and hidden surfaces are estimates.';
}

function ensureSource(current, roomId, priority = 'P0') {
  if (!current.sourcePromises.has(videoReference)) {
    const promise = (async () => {
      const url = new URL(videoReference, location.href).href;
      const image = new Image();
      image.src = url;
      await image.decode();
      if (image.naturalWidth !== 1000 || image.naturalHeight !== 563) {
        throw new Error('Video reference dimensions do not match the bundled image.');
      }
      current.sourceBlobs.set(videoReference, url);
      if (session === current) updateSourceImage(current);
      return url;
    })();
    current.sourcePromises.set(videoReference, promise);
    promise.catch(() => current.sourcePromises.delete(videoReference));
  }
  return current.sourcePromises.get(videoReference);
}

function announce(text) { ui['walk-live'].textContent = text; }

function setCurrentRoom(roomId, reason) {
  const current = session;
  if (!current || state.room === roomId) return false;
  if (!current.roomDefs.has(roomId)) throw new Error(`Unknown room: ${roomId}`);
  state.room = roomId;
  const def = current.roomDefs.get(roomId);
  current.streamer?.setCurrent(roomId);
  updateSourceImage(current);
  if (state.status === 'ready') {
    void ensureSource(current, roomId, 'P0').catch(error => reportFailure(current, { room: roomId, tier: 'source', priority: 'P1', error }));
    announce(`Now in ${def.label}.`);
  }
  syncControls();
  syncObjectControls();
  evaluatePressure(current);
  requestRender('room');
  return true;
}

// Orbit and benchmark paths place the camera by position; walk mode reports its own room.
function syncRoomFromCamera(current) {
  if (current.overview) return;
  const room = resolveCurrentRoom({ rooms: current.roomList, position: current.camera.position.toArray(), previous: state.room,
    navigation: current.navigationData });
  if (room !== state.room) setCurrentRoom(room, current.benchmark ? 'path' : 'camera');
}

function updateVisibility(current) {
  const result = visibleRooms({ graph: current.graph, current: state.room, camera: current.camera,
    depth: 3, overview: current.overview });
  const visible = new Set(result.rooms);
  current.visible = result.rooms;
  let changed = false;
  for (const [id, room] of current.rooms) {
    const next = visible.has(id);
    if (room.root.visible !== next) changed = true;
    room.root.visible = next;
  }
  // The visible set changes the shadow-casting geometry, so the shadow map must be redrawn.
  if (changed) current.pipeline?.invalidateShadows();
}

/* ---------- views and camera ---------- */

function isOverviewPose(entry) {
  const { pose } = entry;
  const bounds = session.roomDefs.get(entry.room).bounds;
  return pose.position.some((value, axis) => value < bounds.min[axis] + .2 || value > bounds.max[axis] - .2)
    || pose.target.some((value, axis) => value < bounds.min[axis] + (axis === 1 ? 0 : .2)
      || value > bounds.max[axis] - (axis === 1 ? .15 : .2));
}

function applyOrbitPose(entry) {
  const { camera, controls } = session;
  const pose = entry.pose;
  session.navigation?.dispose();
  session.navigation = null;
  const bounds = session.roomDefs.get(entry.room).bounds;
  session.overview = !session.benchmarkOptions && isOverviewPose(entry);
  applyingPose = true;
  camera.position.fromArray(pose.position);
  camera.fov = pose.fov ?? session.roomDefs.get(entry.room).views.source.fov;
  camera.updateProjectionMatrix();
  controls.target.fromArray(pose.target);
  camera.lookAt(controls.target);
  controls.update();
  if (!session.overview && !session.benchmarkOptions) {
    session.navigation = createInteriorNavigation(camera, controls, bounds);
  }
  applyingPose = false;
}

function viewYawPitch(pose) {
  const dx = pose.target[0] - pose.position[0], dy = pose.target[1] - pose.position[1], dz = pose.target[2] - pose.position[2];
  const horizontal = Math.hypot(dx, dz);
  return { yaw: horizontal > 1e-9 ? Math.atan2(-dx, -dz) : session.walk?.yaw ?? 0, pitch: Math.atan2(dy, horizontal) };
}

function moveToView(entry) {
  const current = session;
  stopJourney(false);
  const changing = entry.room !== state.room;
  if (state.navMode === 'walk' && isOverviewPose(entry)) setNavigationMode('orbit');
  if (state.navMode === 'walk') {
    const { yaw, pitch } = viewYawPitch(entry.pose);
    const def = current.roomDefs.get(entry.room);
    const point = findWalkablePoint({ preferred: [entry.pose.position[0], entry.pose.position[2]], bounds: def.bounds,
      surfaces: current.navigationData?.rooms.find(room => room.id === entry.room)?.surfaces,
      attempt: (x, z) => { try { current.walk.teleport(entry.room, x, z); return true; } catch { return false; } } });
    if (!point) throw new Error(`No walkable floor near view ${entry.id}.`);
    current.walk.setYaw(yaw);
    state.pitch = Math.max(-1.2, Math.min(1.2, pitch));
    current.camera.fov = entry.pose.fov ?? current.camera.fov;
    current.camera.updateProjectionMatrix();
    syncWalkCamera();
  } else {
    applyOrbitPose(entry);
  }
  state.view = entry.id;
  if (changing) setCurrentRoom(entry.room, 'view');
}

function setView(id) {
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  const { room, view } = parseViewId(id);
  const entry = session.views.get(id);
  if (!entry) throw new Error(`Unknown view: ${id} (room ${room}, view ${view}).`);
  const cloth = currentCurtains();
  if (cloth?.grabbing) cloth.setEnabled(false);
  moveToView(entry);
  state.view = id;
  syncControls();
  requestRender();
  return true;
}

function setFinish(id) {
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  return setGroupFinish(state.finishGroup, id);
}

function setGroupFinish(group, id) {
  if (state.status !== 'ready') return false;
  session.objects.setFinish(group, id);
  session.finishSelections.set(group, id);
  if (state.finishGroup === group) {
    state.finish = id;
    ui['finish-label'].textContent = session.manifest.variants.find(item => item.group === group).options.find(item => item.id === id).label;
  }
  syncControls();
  syncObjectControls();
  return true;
}

function chooseFinishGroup(group) {
  if (!session.manifest.variants.some(item => item.group === group)) throw new Error(`Unknown finish group: ${group}`);
  state.finishGroup = group;
  state.finish = session.finishSelections.get(group);
  ui['finish-group'].value = group;
  createSwatches();
  syncControls();
}

function setMode(mode) {
  if (!['3d', 'source'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  if (state.status !== 'ready') return false;
  if (mode === 'source') session?.journey?.pause();
  state.mode = mode;
  keysHeld.clear(); buttonsHeld.clear();
  syncControls();
  syncObjectControls();
  if (mode === '3d') resize();
  return true;
}

function setWireframe(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Wireframe requires a boolean.');
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  state.wireframe = enabled;
  session.objects.setWireframe(enabled);
  syncControls();
  requestRender();
  return true;
}

function setCurtainClosure(value) {
  const cloth = currentCurtains();
  if (state.status !== 'ready' || state.mode !== '3d' || !cloth?.count) return false;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Curtain coverage must be between 0 and 1.');
  cloth.setClosure(value);
  requestRender();
  return true;
}

function setCurtainWind(enabled) {
  const cloth = currentCurtains();
  if (state.status !== 'ready' || state.mode !== '3d' || !cloth?.count) return false;
  if (typeof enabled !== 'boolean') throw new TypeError('Gentle breeze requires a boolean.');
  const actual = cloth.setWind(enabled);
  syncCurtainControls();
  requestRender();
  return actual === enabled;
}

function reset() {
  if (state.status !== 'ready') return false;
  setMode('3d');
  if (state.navMode === 'walk') setNavigationMode('orbit');
  for (const cloth of allCurtains()) cloth.reset();
  setWireframe(false);
  for (const group of session.manifest.variants) setGroupFinish(group.group, group.options[0].id);
  session.objects.isolate(null);
  for (const object of session.objects.list()) if (object.hidden) session.objects.show(object.objectId);
  session.objects.select(null);
  state.isolated = null;
  setView(`${session.initialRoom}/source`);
  return true;
}

function walkAvailableForJourney() {
  return !!session?.walkAvailable && !session.benchmarkOptions && session.manifest.paths.length > 0;
}

function stopJourney(resumeWalk = true) {
  const current = session;
  if (!current?.journey) return;
  const journey = current.journey;
  const finalStatus = ui['journey-status'].textContent;
  const terminal = ['completed', 'error'].includes(journey.snapshot().state);
  current.journey = null;
  journey.stop();
  state.navMode = 'orbit';
  // A doorway bridge is valid for walking but outside the inset orbit bounds.
  // Enter walking first so an intermediate orbit controller cannot move the eye.
  if (!resumeWalk || !setNavigationMode('walk')) {
    current.navigation = createInteriorNavigation(current.camera, current.controls, current.roomDefs.get(state.room).bounds);
  }
  if (terminal) ui['journey-status'].textContent = finalStatus;
  syncControls();
  requestRender('journey-stop');
}

function revealViewport() {
  // The scheduler intentionally sleeps offscreen; explicit navigation input
  // must reveal the scene rather than bypass that visibility and power-saving policy.
  ui.viewport.scrollIntoView({ block: 'center' });
  session?.renderer?.domElement.focus({ preventScroll: true });
}

async function startJourney() {
  const current = session;
  if (state.status !== 'ready' || state.mode !== '3d' || !walkAvailableForJourney()) return false;
  const path = current.manifest.paths.find(value => value.id === ui['journey-path'].value);
  if (!path) return false;
  stopJourney(false);
  let journey;
  try {
    journey = createGuidedJourney({
      navigation: current.navigationData, path, room: path.rooms[0],
      onPose({ position, target }) {
        applyingPose = true;
        current.camera.position.fromArray(position);
        current.controls.target.fromArray(target);
        current.camera.lookAt(current.controls.target);
        current.camera.updateMatrixWorld();
        applyingPose = false;
      },
      onRoom(room) { setCurrentRoom(room, 'journey'); },
      onState(snapshot) {
        ui['journey-status'].hidden = false;
        ui['journey-status'].textContent = snapshot.error
          ? `Journey stopped: ${snapshot.error}`
          : `Journey ${snapshot.state}: ${path.id}.`;
        syncControls();
      },
    });
    current.navigation?.dispose();
    current.navigation = null;
    current.overview = false;
    current.walk = null;
    current.journey = journey;
    state.navMode = 'tour';
    state.view = null;
    keysHeld.clear(); buttonsHeld.clear();
    current.joystick = { forward: 0, strafe: 0 };
    ui['journey-status'].hidden = false;
    ui['journey-status'].textContent = `Loading journey rooms: ${path.id}.`;
    syncControls();
    // Standard rooms are already in the streaming plan; never enter unbound
    // geometry or force every room into the high tier.
    await Promise.all(path.rooms.map(room => current.streamer.whenStandard(room)));
    if (session !== current || current.journey !== journey) return false;
    journey.start();
    if (state.mode !== '3d') journey.pause();
    else revealViewport();
    syncControls();
    requestRender('journey-start');
    return true;
  } catch (error) {
    if (session !== current || (journey && current.journey !== journey)) return false;
    stopJourney(true);
    ui['journey-status'].hidden = false;
    ui['journey-status'].textContent = `Journey could not start: ${error.message}`;
    return false;
  }
}

/* ---------- walk mode ---------- */

function syncWalkCamera() {
  const { camera, controls, walk } = session;
  const eye = walk.snapshot().position;
  camera.position.set(eye[0], eye[1], eye[2]);
  camera.rotation.set(state.pitch, walk.yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  controls.target.copy(camera.position).addScaledVector(forward, 1.5);
}

function setNavigationMode(mode) {
  if (!['orbit', 'walk'].includes(mode)) throw new Error(`Unknown navigation mode: ${mode}`);
  if (state.status !== 'ready' || state.mode !== '3d') return false;
  if (mode === state.navMode) return true;
  if (session.benchmarkOptions) return false; // a benchmark path owns the camera
  stopJourney(false);
  const current = session;
  const { camera, controls } = current;
  if (mode === 'walk') {
    if (!current.walkAvailable) return false;
    camera.getWorldDirection(forward);
    const yaw = Math.atan2(-forward.x, -forward.z);
    const bounds = current.roomDefs.get(state.room).bounds;
    let walk = null;
    try {
      const point = findWalkablePoint({ preferred: [camera.position.x, camera.position.z], bounds,
        surfaces: current.navigationData?.rooms.find(room => room.id === state.room)?.surfaces,
        attempt(x, z) {
          try { walk = createWalkNavigation({ navigation: current.navigationData, room: state.room, position: [x, z], yaw }); return true; }
          catch (error) { if (/not walkable/.test(error.message)) return false; throw error; }
        } });
      if (!point) throw new Error(`No walkable floor in ${current.roomDefs.get(state.room).label}.`);
    } catch (error) {
      current.walkNote = `Walk mode could not start: ${error.message}`;
      syncControls();
      return false;
    }
    current.walkNote = null;
    current.navigation?.dispose();
    current.navigation = null;
    current.overview = false;
    current.walk = walk;
    state.navMode = 'walk';
    state.pitch = Math.max(-1.2, Math.min(1.2, Math.asin(forward.y)));
    state.view = null;
    syncWalkCamera();
    announce(`Walk mode in ${current.roomDefs.get(state.room).label}.`);
  } else {
    camera.getWorldDirection(forward);
    current.walk = null;
    keysHeld.clear(); buttonsHeld.clear();
    current.joystick = { forward: 0, strafe: 0 };
    state.navMode = 'orbit';
    state.pitch = 0;
    applyingPose = true;
    controls.target.copy(camera.position).addScaledVector(forward, 1.5);
    camera.lookAt(controls.target);
    controls.update();
    applyingPose = false;
    if (!current.benchmarkOptions) current.navigation = createInteriorNavigation(camera, controls, current.roomDefs.get(state.room).bounds);
    announce(`Orbit mode in ${current.roomDefs.get(state.room).label}.`);
  }
  syncControls();
  requestRender('navigation');
  return true;
}

function applyWalkStep({ forward: ahead = 0, strafe = 0, turn = 0 }) {
  const { walk } = session;
  if (turn) walk.setYaw(walk.yaw + turn);
  if (ahead) walk.forward(ahead);
  if (strafe) walk.strafe(strafe);
  state.view = null;
  syncWalkCamera();
  if (walk.room !== state.room) setCurrentRoom(walk.room, 'walk');
  requestRender('walk');
}

function walkBy(ahead = 0, strafe = 0, turn = 0) {
  if (state.status !== 'ready' || state.mode !== '3d' || state.navMode !== 'walk') return false;
  for (const value of [ahead, strafe, turn]) if (!Number.isFinite(value)) throw new RangeError('walkBy needs finite numbers.');
  applyWalkStep({ forward: ahead, strafe, turn });
  return navigationSnapshot();
}

function walkStep(current, delta) {
  const actions = new Set([...keysHeld, ...buttonsHeld]);
  const intent = intentFromActions(actions);
  intent.forward = Math.max(-1, Math.min(1, intent.forward + current.joystick.forward));
  intent.strafe = Math.max(-1, Math.min(1, intent.strafe + current.joystick.strafe));
  if (!hasIntent(intent)) return false;
  applyWalkStep(stepFromIntent(intent, delta, { run: current.run }));
  return true;
}

function walkKey(event, down) {
  const action = keyAction(event.key);
  if (!action) return false;
  if (down) { keysHeld.add(action); session.run = event.shiftKey; session.scheduler.request('walk'); } else keysHeld.delete(action);
  return true;
}

// A pointer that already ended (or a synthetic event) has nothing to capture.
function capturePointer(element, pointerId) {
  try { element.setPointerCapture(pointerId); } catch { /* not an active pointer */ }
}

function setupWalkInput(current) {
  const { renderer } = current;
  const canvas = renderer.domElement;
  let look = null;
  canvas.addEventListener('pointerdown', event => {
    if (state.navMode !== 'walk' || state.status !== 'ready' || state.mode !== '3d' || event.button !== 0 || currentCurtains()?.grabbing) return;
    look = { id: event.pointerId, x: event.clientX, y: event.clientY };
    capturePointer(canvas, event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!look || look.id !== event.pointerId || state.navMode !== 'walk') return;
    const next = lookFromDrag(event.clientX - look.x, event.clientY - look.y, state.pitch, current.walk.yaw);
    look.x = event.clientX; look.y = event.clientY;
    current.walk.setYaw(next.yaw);
    state.pitch = next.pitch;
    state.view = null;
    syncWalkCamera();
    requestRender('look');
  });
  const endLook = event => { if (look?.id === event.pointerId) look = null; };
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);
  current.joystick = { forward: 0, strafe: 0 };
}

// Touch joystick: a pad whose knob offset becomes a movement intent for the live session.
function setupJoystick() {
  const pad = ui['walk-joystick'], knob = ui['walk-joystick-knob'];
  let stick = null;
  const moveStick = event => {
    const rect = pad.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = event.clientX - (rect.left + radius), dy = event.clientY - (rect.top + radius);
    const length = Math.hypot(dx, dy);
    if (length > radius) { dx *= radius / length; dy *= radius / length; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const intent = joystickIntent(dx, dy, radius);
    if (session) { session.joystick = { forward: intent.forward, strafe: intent.strafe }; session.scheduler.request('walk'); }
  };
  const endStick = event => {
    if (stick !== event.pointerId) return;
    stick = null;
    knob.style.transform = '';
    if (session) session.joystick = { forward: 0, strafe: 0 };
  };
  pad.addEventListener('pointerdown', event => { stick = event.pointerId; capturePointer(pad, event.pointerId); moveStick(event); });
  pad.addEventListener('pointermove', event => { if (stick === event.pointerId) moveStick(event); });
  pad.addEventListener('pointerup', endStick);
  pad.addEventListener('pointercancel', endStick);
}

function buildWalkButtons() {
  ui['walk-buttons'].replaceChildren(...WALK_BUTTONS.map(({ action, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = action;
    button.disabled = true;
    // Hold with a pointer to keep moving; Enter/Space (detail 0) takes one discrete step.
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      buttonsHeld.add(action);
      capturePointer(button, event.pointerId);
      revealViewport();
      session?.scheduler.request('walk');
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => buttonsHeld.delete(action));
    button.addEventListener('click', event => {
      if (event.detail === 0 && state.navMode === 'walk' && state.status === 'ready') {
        applyWalkStep(buttonStep(action));
        revealViewport();
      }
    });
    return button;
  }));
}

function focusObjectControls() {
  const toggle = document.getElementById('panel-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
  ui['object-list'].focus();
}

function cameraKeys(event) {
  if (event.key === 'Escape' && session?.objects) {
    event.preventDefault();
    event.stopImmediatePropagation();
    session.objects.select(null);
    focusObjectControls();
    return;
  }
  if (state.status !== 'ready' || state.mode !== '3d' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Home') { event.preventDefault(); setView(`${state.room}/source`); return; }
  if (state.navMode === 'walk') {
    if (walkKey(event, true)) event.preventDefault();
    return;
  }
  if (!session?.controls.enabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_'].includes(event.key)) return;
  event.preventDefault();
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

function cameraKeyUp(event) {
  const action = keyAction(event.key);
  if (action) keysHeld.delete(action);
}

function configureSceneContent(current) {
  const { manifest } = current;
  document.title = `${manifest.title} — Interior study`;
  ui['scene-title'].textContent = manifest.title;
  ui['resource-credit'].hidden = !usesPolyHavenAPI(manifest);
  ui['portability-note'].textContent = manifest.portability;
  const multiple = manifest.house.rooms.length > 1;
  viewButtons = [];
  const groups = manifest.house.rooms.map(room => {
    const group = document.createElement('div');
    group.className = 'view-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `${room.label} views`);
    if (multiple) {
      const heading = document.createElement('span');
      heading.className = 'view-group-label';
      heading.textContent = room.label;
      heading.setAttribute('aria-hidden', 'true');
      group.append(heading);
    }
    for (const [name, pose] of Object.entries(room.views)) {
      const id = `${room.id}/${name}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.view = id;
      button.textContent = viewLabel(name, pose);
      button.disabled = true;
      button.setAttribute('aria-pressed', String(id === `${current.initialRoom}/source`));
      button.addEventListener('click', () => setView(id));
      viewButtons.push(button);
      group.append(button);
    }
    return group;
  });
  ui['camera-actions'].replaceChildren(...groups);
  ui['finish-group'].replaceChildren(...manifest.variants.map(group => {
    const option = document.createElement('option');
    option.value = group.group;
    option.textContent = group.group;
    return option;
  }));
  ui['finish-group'].parentElement.hidden = manifest.variants.length < 2;
  state.finishGroup = manifest.variants[0]?.group ?? null;
  state.finish = current.finishSelections.get(state.finishGroup) ?? null;
  createSwatches();
}

function configureInteractionContent(current) {
  const cloth = [...current.rooms.values()].some(room => room.curtains?.count > 0);
  const cameraHint = 'Scroll or pinch to zoom, right-drag to pan inside the room. Keyboard: Tab into the 3D frame; Tab / Shift+Tab selects objects in the current room, Enter inspects, Escape returns to the object controls. Arrow keys rotate, + / − zoom, Home returns to the current room\'s source view. Choose Walk in Navigation to move through doorways.';
  ui['interaction-hint'].textContent = cloth
    ? `Drag the fabric to open or close the curtains; drag elsewhere to orbit the camera. ${cameraHint} Adjust the curtains with the Coverage slider and buttons; turn off Gentle breeze to settle the cloth.`
    : `Drag to orbit the camera. ${cameraHint}`;
  current.renderer.domElement.setAttribute('aria-label', `${current.manifest.title}. Interactive 3D interior. ${ui['interaction-hint'].textContent}`);
  ui['panel-lead'].textContent = 'A Blender-authored interior rendered live with Three.js. Explore the rooms, inspect objects and compare the separate source reference.';
  ui['representation-title'].textContent = cloth && current.sun ? 'Sunlight follows the curtain' : 'Baked light, editable geometry';
  ui['representation-detail'].textContent = !current.sun
    ? 'Lighting and reflections use the authored static bake and one reflection probe per room. This scene has no runtime sun or dynamic GI; changing materials or cloth does not rebake lighting. Orbit stays inside the current room; walking uses a floor-plan polygon proxy, not furniture-mesh collision.'
    : cloth
      ? 'Direct sunlight and cast shadows update with the curtain shape. Indirect bounce and reflections retain the authored open-curtain bake and per-room probes; this is not dynamic GI. Orbit stays inside the current room; walking uses a floor-plan polygon proxy.'
      : 'Direct sunlight and shadows are rendered in real time. Indirect bounce and per-room reflections use the authored static bake; material changes do not rebake them. Orbit stays inside the current room; walking uses a floor-plan polygon proxy.';
}

function createSwatches() {
  const group = session.manifest.variants.find(item => item.group === state.finishGroup);
  ui['finish-swatches'].replaceChildren();
  for (const variant of group?.options ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'finish-swatch';
    button.dataset.finish = variant.id;
    button.disabled = true;
    button.setAttribute('aria-pressed', String(variant.id === state.finish));
    const chip = document.createElement('span');
    chip.className = 'swatch-chip';
    chip.style.setProperty('--swatch-color', variant.color);
    chip.setAttribute('aria-hidden', 'true');
    button.append(chip, document.createTextNode(variant.label));
    button.addEventListener('click', () => setFinish(variant.id));
    ui['finish-swatches'].append(button);
  }
  ui['finish-title'].textContent = group ? `${group.group} finish` : 'Material finish';
  ui['finish-label'].textContent = group?.options.find(item => item.id === state.finish)?.label ?? '';
}

function rebuildObjectList() {
  if (!session?.objects) return;
  const empty = document.createElement('option');
  empty.value = ''; empty.textContent = 'Select an object';
  const groups = [];
  for (const room of session.manifest.house.rooms) {
    if (!session.houseObjects.has(room.id)) continue;
    const group = document.createElement('optgroup');
    group.label = room.label;
    for (const object of session.objects.list().filter(item => item.room === room.id)) {
      const option = document.createElement('option');
      option.value = object.objectId; option.textContent = object.label;
      group.append(option);
    }
    groups.push(group);
  }
  ui['object-list'].replaceChildren(empty, ...groups);
  ui['object-list'].value = state.selected ?? '';
}

function syncObjectControls() {
  if (!session?.objects) return;
  const objects = session.objects.list();
  const selected = objects.find(item => item.objectId === state.selected);
  ui['object-list'].value = state.selected ?? '';
  ui['object-hide'].disabled = !selected || state.mode !== '3d';
  ui['object-hide'].textContent = selected?.hidden ? 'Show selected' : 'Hide selected';
  ui['object-isolate'].disabled = !selected || state.mode !== '3d';
  ui['object-isolate'].setAttribute('aria-pressed', String(!!selected && state.isolated === selected.objectId));
  const fields = selected ? [['Object', selected.label], ['Room', session.roomDefs.get(selected.room)?.label ?? selected.room],
    ['Class', selected.class], ['Finish', selected.finish ?? 'No finish variants'],
    ['Condition', describeCondition(selected.condition) ?? 'No authored condition note.']] : [];
  ui['object-details'].replaceChildren(...fields.map(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value;
    row.append(term, detail);
    return row;
  }));
}

/* ---------- binding a loaded room into the house ---------- */

function bindMaterials(room, current) {
  const cache = new Map(), clothTextures = new Map();
  const clothAnisotropy = Math.max(1, Math.min(8, current.renderer.capabilities.getMaxAnisotropy()));
  const { root, def } = room;
  const probe = { box: def.probe.box, position: def.probe.position };
  let triangles = 0;
  // Every PBR material of the room reflects the room's own probe, parallax-corrected against its box.
  const bindProbe = material => {
    material.envMap = room.environmentTarget.texture;
    return bindBoxProjectedProbe(material, probe);
  };
  root.traverse(mesh => {
    if (mesh.isLight) throw new Error('Runtime GLB must not contain lights outside the manifest sun configuration.');
    if (!mesh.isMesh) return;
    const metadata = objectMetadata(mesh, root);
    const record = current.registryById.get(metadata?.objectId);
    if (!record) throw new Error(`Mesh ${mesh.name || mesh.uuid} has no registered objectId.`);
    if (record.room !== room.id) throw new Error(`Mesh ${mesh.name || mesh.uuid} belongs to room ${record.room} in objects.json but was loaded with room ${room.id}.`);
    Object.assign(mesh.userData, metadata, { component: record.component });
    const atlasId = mesh.userData.lightmap;
    const atlas = room.atlases.get(atlasId);
    const { position, uv, uv1 } = mesh.geometry.attributes;
    if (atlasId !== undefined && !atlas) throw new Error(`Object ${record.objectId} has an invalid lightmap.`);
    if (!position || !uv || uv.count !== position.count || uv.itemSize !== 2) throw new Error(`Object ${record.objectId} is missing UV0.`);
    if (atlas && (!uv1 || uv1.count !== position.count || uv1.itemSize !== 2)) throw new Error(`Object ${record.objectId} is missing UV1.`);
    const dynamic = mesh.userData.curtain_id !== undefined;
    function bind(source) {
      if (!source.isMeshStandardMaterial) throw new Error(`Material ${source.name} of ${record.objectId} is not standard PBR.`);
      const key = `${source.uuid}:${atlas?.id ?? 'unbaked'}:${mesh.userData.finishGroup ?? ''}:${dynamic}`;
      if (cache.has(key)) return cache.get(key);
      let material = source;
      if (dynamic || atlas) {
        material = source.clone();
        current.materials.add(material);
        if (dynamic) {
          material.lightMap = null;
          material.side = material.shadowSide = THREE.DoubleSide;
          for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
            const original = material[slot];
            if (!original) continue;
            if (!clothTextures.has(original)) {
              const texture = original.clone();
              texture.anisotropy = clothAnisotropy;
              texture.needsUpdate = true;
              current.loader.ownTexture(texture, { role: 'cloth-sampler' });
              clothTextures.set(original, texture);
            }
            material[slot] = clothTextures.get(original);
          }
        } else bindBakedLightmap(material, atlas);
      }
      bindProbe(material);
      cache.set(key, material);
      return material;
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(bind) : bind(mesh.material);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // A transmissive material would make three.js render every opaque object a second time into
    // its transmission target. The runtime substitutes the glazing instead. The portable GLB keeps
    // KHR_materials_transmission: this substitution is runtime-only.
    for (const material of materials) substituteThinGlass(material);
    // Only a thin pane lets the sun through (the sun's declared shadow-ray transmittance is a
    // property of the light, not of the pane's shadow). The decision follows each material's own
    // recorded classification, so a weak transmission factor or a solid volume still blocks the sun
    // and a mesh that mixes a pane with opaque parts keeps casting for those parts.
    bindGlazingShadows(mesh);
    mesh.receiveShadow = true;
    room.entries.push({ mesh });
    triangles += (mesh.geometry.index?.count ?? position.count) / 3;
  });
  if (!room.entries.length) throw new Error(`Room ${room.id} has no meshes.`);
  room.triangles = triangles;
  room.pbrMaterials = cache.size;
}

function updateStats(current) {
  let meshes = 0, triangles = 0, pbrMaterials = 0, lightmaps = 0;
  const environmentTextureUuids = {};
  for (const [id, room] of current.rooms) {
    meshes += room.entries.length; triangles += room.triangles; pbrMaterials += room.pbrMaterials;
    lightmaps += room.atlases.size;
    environmentTextureUuids[id] = room.environmentTarget.texture.uuid;
  }
  current.stats = { rooms: current.rooms.size, meshes, objects: current.registryById.size, triangles,
    pbrMaterials, lightmaps, environmentTextureUuids };
}

// Attribute every real draw call (shadow pass included) to the room that issued it: the object sets
// the active room around its draw and info.update() runs inside that window (see start()).
function instrumentRoom(current, room) {
  room.root.traverse(node => {
    if (!(node.isMesh || node.isLine || node.isPoints)) return;
    // BatchedMesh prepares its multi-draw ranges in onBeforeRender: wrap it, never replace it.
    const before = node.onBeforeRender, after = node.onAfterRender;
    node.onBeforeRender = function (...args) { current.activeRoom = room.id; return before.apply(this, args); };
    node.onAfterRender = function (...args) { current.activeRoom = null; return after.apply(this, args); };
  });
}

const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));



// Compile only this room's programs, in the same HDR-target state the scheduler renders with.
async function compileRoom(current, room) {
  const { renderer, scene, camera, pipeline } = current;
  const start = performance.now(), oldTarget = renderer.getRenderTarget(), oldTone = renderer.toneMapping;
  let compiling;
  try {
    renderer.setRenderTarget(pipeline.movingSceneTarget);
    renderer.toneMapping = THREE.NoToneMapping;
    compiling = renderer.compileAsync(room.root, camera, scene);
  } finally { renderer.setRenderTarget(oldTarget); renderer.toneMapping = oldTone; }
  await compiling;
  current.shaderCompilation.push({ startMs: start, durationMs: performance.now() - start, label: `${room.id} HDR compileAsync` });
}

async function bindRoom(current, roomId, assets) {
  const { shell } = await current.shellReady;
  if (session !== current) throw new DOMException('Session closed.', 'AbortError');
  const initial = roomId === current.initialRoom;
  // Streaming rooms bind only after the first interactive frame so P0 is never delayed by P2/P3 work.
  // Each one then starts in a task of its own: the continuations of the interactive promise would
  // otherwise run every waiting room's synchronous PMREM conversion back to back in the task that
  // declared interactivity, i.e. inside the first frames of the navigation window.
  if (!initial) {
    await current.interactive.promise;
    await yieldToBrowser();
  }
  if (session !== current) throw new DOMException('Session closed.', 'AbortError');
  // From here the binding owns detached resources (PMREM target, controllers, curtain listeners)
  // and awaits upload and shader compilation. The session tracks the binding so its teardown can
  // wait for it to release them before the renderer goes away.
  const binding = bindRoomResources(current, roomId, assets, shell, initial);
  current.roomBinds.add(binding);
  const release = () => current.roomBinds.delete(binding);
  binding.then(release, release);
  return binding;
}

async function bindRoomResources(current, roomId, assets, shell, initial) {
  const def = current.roomDefs.get(roomId);
  validateReferences(current.manifest, { roomTextureIds: { [roomId]: assets.textureIds } });
  const room = { id: roomId, def, root: assets.scene, atlases: assets.lightmaps, textureIds: assets.textureIds,
    tier: 'standard', entries: [], triangles: 0, pbrMaterials: 0, curtains: null };
  // One generator serves every room of the session. A generator owns its conversion programs, and
  // disposing it releases them: a generator per room recompiled (and link-stalled on) both programs
  // for every streamed room, inside the navigation window.
  current.pmrem ??= new THREE.PMREMGenerator(current.renderer);
  room.environmentTarget = current.pmrem.fromEquirectangular(assets.probe);
  // The equirect source is only needed for the conversion; PMREM is what stays resident.
  assets.probe.dispose();
  current.residency.trackTarget(`room-pmrem:${roomId}`, room.environmentTarget);
  current.pmremTargets.set(roomId, room.environmentTarget);
  let controller = null;
  const live = () => { if (session !== current) throw new DOMException('Session closed.', 'AbortError'); };
  try {
    if (!initial) { await yieldToBrowser(); live(); }
    bindMaterials(room, current);
    room.root.name = `room:${roomId}`;
    // The root stays detached and visible while its controllers are built: batch instance visibility
    // is derived from the tree. It joins the scene hidden, in one step, when everything is ready.
    if (!initial) { await yieldToBrowser(); live(); }
    controller = createObjectController({ root: room.root, registry: shell.registry, roomId, variants: current.manifest.variants,
      camera: current.camera, announce: text => current.houseObjects.say(text),
      onChange: reason => current.houseObjects.handleChange(reason),
      onSelect: value => current.houseObjects.handleSelect(roomId, value) });
    current.houseObjects.add(roomId, controller);
    current.residency.trackBatches(room.root);
    const hasCloth = (() => {
      let found = false;
      room.root.traverse(node => { if (node.userData.curtain_id !== undefined || node.userData.curtain_part !== undefined) found = true; });
      return found;
    })();
    if (hasCloth) {
      room.curtains = createCurtainInteraction({ root: room.root, camera: current.camera, roomBounds: def.bounds,
        canvas: current.renderer.domElement, controls: current.controls, onChange: requestRender,
        isInteractive: () => session === current && state.status === 'ready' && state.mode === '3d' && state.room === roomId });
      if (current.benchmarkOptions) room.curtains.setWind(false);
    }
    instrumentRoom(current, room);
    // The session's own signal stops the upload when the session closes, and nothing compiles on a closed renderer.
    const uploaded = await uploadRoomTextures(current.renderer, room, { yieldToBrowser, signal: current.abort.signal });
    if (uploaded.aborted) throw new DOMException('Session closed.', 'AbortError');
    live();
    await compileRoom(current, room);
    // A session that closed during the compile must not attach the room. The check sits inside
    // the guarded block so the cleanup below releases everything this binding owns.
    live();
  } catch (error) {
    current.houseObjects.remove(roomId);
    // A controller that was built but never registered is not reachable through the manager.
    controller?.dispose();
    room.root.removeFromParent();
    room.curtains?.dispose();
    room.environmentTarget.dispose();
    current.pmremTargets.delete(roomId);
    throw error;
  }
  room.root.visible = false;
  current.scene.add(room.root);
  current.rooms.set(roomId, room);
  current.entries.push(...room.entries);
  // The new room adds shadow-casting geometry to the house.
  current.pipeline?.invalidateShadows();
  updateStats(current);
  rebuildObjectList();
  if (!initial) {
    current.loader.markReady(roomId);
    current.readyGates.get(roomId).resolve();
    void ensureSource(current, roomId, 'P2').catch(error => reportFailure(current, { room: roomId, tier: 'source', priority: 'P2', error }));
  }
  if (state.status === 'ready') {
    syncControls();
    ui['load-status'].textContent = loadSummary(current);
    requestRender('room-ready');
    evaluatePressure(current);
  }
}

function loadSummary(current) {
  const high = [...current.rooms.values()].filter(room => room.tier === 'high').length;
  const detail = current.globalTier === 'standard' ? 'standard detail everywhere' : `${high}/${current.rooms.size} rooms at high detail`;
  return `${number.format(current.stats.objects)} objects · ${number.format(current.stats.triangles)} triangles · ${current.rooms.size}/${current.roomList.length} rooms loaded · ${detail}.`;
}

/* ---------- memory pressure ---------- */

function currentTier(current) {
  return current.globalTier === 'standard' ? 'standard' : current.rooms.get(state.room)?.tier ?? 'standard';
}

function evictRoomHigh(current, roomId) {
  const room = current.rooms.get(roomId);
  // A loaded tier that was never published still holds its source textures.
  const pending = current.pendingHighs.get(roomId);
  current.pendingHighs.delete(roomId);
  if (pending) current.loader.releaseHighSources(roomId, pending);
  // A publication that is still uploading for this room must not install its tier afterwards.
  current.tierUploads.get(roomId)?.abort();
  current.tierUploads.delete(roomId);
  if (room?.tier === 'high') {
    current.loader.revertTier(roomId);
    room.tier = 'standard';
    // The reverted slots can take part in the depth pass, so the shadow map follows.
    if (tierAffectsShadow(room)) current.pipeline?.invalidateShadows();
  }
  current.streamer.evictHigh(roomId);
}

// The object controller reports every change with a reason. Hiding or isolating an object changes
// the shadow-casting geometry. Wireframe does too: three.js copies material.wireframe into the
// shadow depth material, so a wireframe surface rasterises a different silhouette into the shadow
// map. A selection outline or a finish tint changes neither.
function noteObjectChange(current, reason) {
  if (SHADOW_CHANGING_REASONS.has(reason)) current.pipeline?.invalidateShadows();
  queueObjectControls(current);
}

// One frame of the current room's cloth. Animated cloth deforms the shadow-casting geometry, so the
// shadow map must follow it. The final settling step deforms the cloth and then reports "not
// moving": the separate geometry-change signal covers that last silhouette, which the motion flag
// alone misses.
function stepCloth(current, delta, now) {
  const cloth = currentCurtains();
  current.clothMoving = cloth?.update(delta, now / 1000) ?? false;
  if (current.clothMoving) current.pipeline?.invalidateShadows();
  else if (cloth?.consumeGeometryChange()) current.pipeline?.invalidateShadows();
  syncCurtainControls();
}

// Publish the high tier of one waiting room, when the camera is at rest. Returns true when a
// publication was started.
function publishNextHigh(current, resting) {
  if (!current.pendingHighs.size || !resting) return false;
  // One room per frame: the room being visited first, then its neighbours by distance.
  const hops = current.graph.hops(state.room);
  const [roomId] = [...current.pendingHighs.keys()].sort((a, b) => (hops.get(a) ?? Infinity) - (hops.get(b) ?? Infinity));
  const room = current.rooms.get(roomId);
  const result = current.pendingHighs.get(roomId);
  current.pendingHighs.delete(roomId);
  if (!room || room.tier !== 'standard' || current.globalTier !== 'high') return false;
  // The tier is prepared but NOT installed: the new textures are uploaded first, and only then are
  // the material slots swapped, so no frame renders a texture that was never uploaded. A
  // publication that was aborted, or that lost its session, epoch, global tier or room while
  // uploading, installs nothing.
  const epoch = current.tierEpoch;
  const publication = publishTier({
    loader: current.loader, renderer: current.renderer, room, roomId, result,
    uploads: current.tierUploads, yieldToBrowser,
    liveness: () => ({
      sessionAlive: session === current,
      epochMatches: current.tierEpoch === epoch,
      tierIsHigh: current.globalTier === 'high',
      roomIsCurrent: current.rooms.get(roomId) === room,
      roomIsStandard: room.tier === 'standard',
    }),
    onCommitted: () => {
      current.highPublished = true;
      // A swapped slot that takes part in the depth pass changes the shadow silhouette.
      if (tierAffectsShadow(room)) current.pipeline?.invalidateShadows();
      evaluatePressure(current);
      requestRender('high-ready');
    },
    // The room stays at standard; the failure is reported with the streamer's retry path.
    onFailure: error => current.streamer?.failHigh(roomId, error),
  });
  current.tierPublications.add(publication);
  publication.catch(error => { if (session === current) void fail(error); })
    .finally(() => current.tierPublications.delete(publication));
  return true;
}

function evaluatePressure(current) {
  if (session !== current || !current.budget || !current.streamer || state.status !== 'ready') return;
  const resources = [...current.loader.residentResources()];
  const supplemental = current.residency.snapshot().resources;
  for (const id of current.pmremTargets.keys()) {
    const record = supplemental.find(item => item.id === `room-pmrem:${id}`);
    resources.push({ id: `room-pmrem:${id}`, tier: 'standard', bytes: record?.bytes ?? 0, rooms: [id] });
  }
  const highRooms = new Set([...current.rooms].filter(([, room]) => room.tier === 'high').map(([id]) => id));
  const rows = attributeRoomBytes({ roomIds: [...current.rooms.keys()], resources, highRooms, globalTier: current.globalTier });
  const attributed = rows.reduce((sum, row) => sum + row.standardBytes + row.highBytes, 0);
  const fixedBytes = Math.max(0, measureResources(current).gpuBytes - attributed);
  const budgetBytes = tierBudget(current.budget, current.globalTier, current.memoryOverride);
  const plan = planRoomPressure({ graph: current.graph, current: state.room, rows, globalTier: current.globalTier, budgetBytes, fixedBytes });
  for (const step of plan.steps) {
    for (const roomId of step.rooms) evictRoomHigh(current, roomId);
    if (step.step === 3) {
      current.globalTier = 'standard';
      // The publication epoch changes: a tier publication that is still uploading must not
      // install its tier after the global cutover to the standard tier.
      current.tierEpoch++;
      for (const roomId of current.rooms.keys()) evictRoomHigh(current, roomId);
      current.streamer.setGlobalTier('standard');
      current.notices.set('memory', plan.notice);
      current.benchmark?.fail(new Error('Memory pressure switched every room to standard tier; this benchmark run is not valid evidence.'));
    }
    current.evictions.push({ step: step.step, kind: step.kind, rooms: [...step.rooms], freedBytes: step.freedBytes,
      residentBytesAfter: step.residentBytesAfter, budgetBytes, fixedBytes, globalTier: current.globalTier, atMs: performance.now() });
  }
  if (plan.steps.length) {
    ui['load-status'].textContent = loadSummary(current);
    syncControls();
    requestRender('eviction');
  }
}

/* ---------- failures ---------- */

function reportFailure(current, { room, tier, priority, error }) {
  if (session !== current) return;
  if (priority === 'P0') {
    // While opening, start() awaits the P0 request and reports it; afterwards the session is unusable.
    if (state.status === 'ready') void fail(error);
    return;
  }
  const label = current.roomDefs.get(room)?.label ?? room;
  const what = tier === 'standard' ? 'did not finish loading and is not shown' : tier === 'source' ? 'reference image failed' : 'high detail failed; the room stays at standard detail';
  current.failures.set(`${room}:${tier}`, error.message);
  current.notices.set(`fail:${room}:${tier}`, `${label} ${what}: ${error.message}`);
  ui['load-status'].textContent = `${label} ${what}. Choose Retry high-detail loading to try again.`;
  current.benchmark?.fail(error);
  syncControls();
}

function retryFailures() {
  const current = session;
  if (!current || state.status !== 'ready') return;
  for (const key of current.failures.keys()) current.notices.delete(`fail:${key}`);
  const sources = [...current.failures.keys()].filter(key => key.endsWith(':source')).map(key => key.split(':')[0]);
  current.failures.clear();
  current.streamer.retryFailed();
  for (const room of sources) void ensureSource(current, room, 'P1').catch(error => reportFailure(current, { room, tier: 'source', priority: 'P1', error }));
  syncControls();
}

async function disposeSession() {
  startAbort?.abort();
  startAbort = null;
  const current = session;
  if (!current) return;
  session = null;
  keysHeld.clear(); buttonsHeld.clear();
  // Every pending tier upload is aborted, so a closed session stops uploading textures that
  // nothing will ever render. The publication promise resolves as aborted and installs nothing.
  for (const controller of current.tierUploads.values()) controller.abort();
  current.tierUploads.clear();
  // Aborted publications finish without touching the renderer; wait so none outlives the session.
  await Promise.allSettled([...current.tierPublications]);
  // A standard room that is still uploading or compiling observes the closed session at its next
  // checkpoint and releases the resources it owns (controller, curtain listeners, PMREM target).
  // Wait for that, so no binding outlives the session or touches a disposed renderer.
  await Promise.allSettled([...current.roomBinds]);
  current.streamer?.dispose();
  current.scheduler?.dispose();
  current.benchmark?.dispose();
  current.journey?.stop();
  for (const room of current.rooms.values()) room.curtains?.dispose();
  current.navigation?.dispose();
  current.houseObjects?.dispose();
  current.controls?.dispose();
  current.interactive?.reject(new DOMException('Session closed.', 'AbortError'));
  for (const gate of current.readyGates.values()) gate.reject(new DOMException('Session closed.', 'AbortError'));
  await current.loader?.dispose();
  current.sun?.dispose();
  current.backgroundTarget?.dispose();
  for (const target of current.pmremTargets.values()) target.dispose();
  current.pmrem?.dispose();
  for (const material of current.materials) material.dispose();
  current.pipeline?.dispose();
  current.renderer?.dispose();
  current.residency?.dispose();
  current.renderer?.domElement.remove();
  for (const url of current.sourceUrls) URL.revokeObjectURL(url);
}

function setLoadPhase(index, failed = false) {
  loadPhase = index;
  for (const item of document.querySelectorAll('[data-phase-step]')) {
    const step = Number(item.dataset.phaseStep);
    item.dataset.state = step < index ? 'done' : step === index ? (failed ? 'error' : 'active') : 'pending';
  }
}

function fetchedRecord(record) {
  const url = new URL(record.url, baseUrl);
  if (url.origin !== location.origin) throw new Error(`Unpinned cross-origin runtime asset: ${url.origin}`);
  const prefix = new URL(baseUrl).pathname;
  if (!url.pathname.startsWith(prefix)) throw new Error(`Runtime asset outside deployment base: ${url.pathname}`);
  return { ...record, fetchedUrl: url.href, url: `/${url.pathname.slice(prefix.length)}` };
}

function measureResources(current, includeResources = true) {
  const assets = current.loader.snapshot(includeResources);
  const supplemental = current.residency.snapshot(includeResources);
  const targets = current.pipeline.residency;
  const roomDrawCalls = Object.fromEntries([...current.rooms.keys()].map(id => [id, current.roomCalls.get(id) ?? 0]));
  const nonCurrentDrawCalls = Object.entries(roomDrawCalls).filter(([id]) => id !== state.room).reduce((sum, [, calls]) => sum + calls, 0);
  return { tier: currentTier(current), globalTier: current.globalTier,
    roomTiers: Object.fromEntries([...current.rooms].map(([id, room]) => [id, room.tier])),
    evictions: current.evictions.map(entry => ({ ...entry, rooms: [...entry.rooms] })),
    currentRoom: state.room, visibleRooms: [...current.visible],
    drawnRooms: [...current.rooms].filter(([, room]) => room.root.visible).map(([id]) => id),
    roomDrawCalls, nonCurrentDrawCalls,
    gpuBytes: assets.gpuBytes + supplemental.gpuBytes + targets.reduce((sum, resource) => sum + resource.bytes, 0),
    resources: [...assets.resources, ...supplemental.resources, ...targets] };
}

function renderCurrent(current, accumulate) {
  updateVisibility(current);
  current.roomCalls.clear();
  current.pipeline.render(current.scene, current.camera, { accumulate });
  if (current.shaderError) throw current.shaderError;
  if (current.sun?.shadow.map) current.residency.trackTarget('sun-shadow', current.sun.shadow.map);
  state.frames++;
  if (current.highPublished) {
    current.highPublished = false;
    ui['load-status'].textContent = loadSummary(current);
    current.refinementCheck = true;
  }
  if (current.refinementCheck && current.benchmark && !current.refinementReported) {
    const pathRooms = current.benchmark.path.rooms;
    if (pathRooms.every(id => current.rooms.get(id)?.tier === 'high')) {
      current.refinementReported = true;
      current.benchmark.markRefinementReady();
    }
  }
}

function showPerformance(current, snapshot, now) {
  if (now - (current.performanceAt ?? -Infinity) < 250 && current.performanceState === snapshot.state
    && current.performanceTier === snapshot.tier) return;
  current.performanceAt = now;
  current.performanceState = snapshot.state;
  current.performanceTier = snapshot.tier;
  const text = `${snapshot.tier === 'high' ? 'High detail' : 'Standard'} · ${snapshot.state} ${snapshot.samples}/32 · motion ${snapshot.motionScale.toFixed(1)}× · ${snapshot.drawCalls} scene draws · ${snapshot.drawnRooms.length}/${current.roomList.length} rooms drawn · GPU ${(snapshot.gpuBytes / 1048576).toFixed(0)} MiB · ${snapshot.timer}`;
  if (ui['performance-status'].textContent !== text) ui['performance-status'].textContent = text;
}

async function collectViewerRecords(current) {
  const urls = new Set([new URL('index.html', baseUrl).href]);
  for (const resource of performance.getEntriesByType('resource')) {
    const url = new URL(resource.name, baseUrl);
    if (url.origin === location.origin && /\.(?:m?js|css|wasm)$/.test(url.pathname)) urls.add(url.href);
  }
  const records = await Promise.all([...urls].map(async url => {
    const response = await fetch(url, { cache: 'force-cache', signal: current.abort.signal });
    if (!response.ok) throw new Error(`Cannot hash viewer file ${url}: HTTP ${response.status}`);
    return fetchedRecord(await hashFetchedBytes(url, await response.arrayBuffer()));
  }));
  if (session === current) current.viewerRecords.push(...records);
}

// The urls a receipt must bind for the rooms its path crosses (see tools/runtime_benchmark_audit.py).
function benchmarkRequirement(current) {
  const path = current.benchmark?.path ?? current.manifest.paths.find(item => item.id === current.benchmarkOptions?.pathId);
  const warm = current.benchmarkOptions?.mode === 'warm';
  const urls = new Set(), pending = [];
  for (const roomId of path.rooms) {
    const def = current.roomDefs.get(roomId);
    urls.add(def.geometry); urls.add(def.probe.url);
    for (const atlas of def.lightmaps) urls.add(atlas.url);
    const room = current.rooms.get(roomId);
    if (!room) { pending.push(roomId); continue; }
    for (const id of room.textureIds) {
      urls.add(current.manifest.textures[id].standard);
      if (warm) urls.add(current.manifest.textures[id].high);
    }
  }
  urls.add(sourceFor(current.manifest, path.rooms[0]).url);
  return { urls, complete: pending.length === 0 };
}

function queueObjectControls(current) {
  requestRender('objects');
  if (current.objectControlsQueued) return;
  current.objectControlsQueued = true;
  queueMicrotask(() => {
    current.objectControlsQueued = false;
    if (session === current) { syncObjectControls(); syncControls(); }
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function start() {
  if (loading || stopped) return;
  loading = true;
  setLoadPhase(0);
  const run = ++generation;
  Object.assign(state, { status: 'loading', error: null, mode: '3d', navMode: 'orbit', view: null, room: null, finish: null,
    finishGroup: null, selected: null, isolated: null, wireframe: false, frames: 0, pitch: 0 });
  ui['message-title'].textContent = 'Opening house';
  ui['message-detail'].textContent = 'Loading the standard room, lightmaps and reference.';
  ui['load-status'].textContent = 'Reading scene manifest…';
  ui['load-progress'].removeAttribute('value');
  syncControls();
  try {
    await disposeSession();
    if (stopped || generation !== run) return;
    startAbort = new AbortController();
    const options = benchmarkOptions();
    const memoryOverride = memoryBudgetOverride();
    const manifestUrl = new URL('assets/interior/manifest.json', baseUrl).href;
    const response = await fetch(manifestUrl, { cache: 'no-cache', signal: startAbort.signal });
    if (!response.ok) throw new Error(`Could not load manifest (${response.status}).`);
    const manifestBytes = await response.arrayBuffer();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    validateManifest(manifest);
    setLoadPhase(1);
    if (stopped || generation !== run) return;
    const graph = buildRoomGraph(manifest.house.rooms);
    const roomDefs = new Map(manifest.house.rooms.map(room => [room.id, room]));
    const roomList = manifest.house.rooms;
    const benchmarkPath = options ? manifest.paths.find(path => path.id === options.pathId) : null;
    if (options && !benchmarkPath) throw new Error(`Unknown benchmark path: ${options.pathId}`);
    // A benchmark begins where its path begins; otherwise the house opens in its first room.
    const initialRoom = benchmarkPath
      ? resolveCurrentRoom({ rooms: roomList, position: benchmarkPath.keys[0].position })
      : roomList[0].id;
    const views = viewCatalog(manifest);
    const current = { manifest, graph, roomDefs, roomList, views, initialRoom, rooms: new Map(), entries: [],
      source: sourceFor(manifest, initialRoom), abort: startAbort, benchmarkOptions: options, materials: new Set(),
      tier: 'standard', globalTier: 'high', memoryOverride, evictions: [], pendingHighs: new Map(),
      // The publication epoch: a tier publication is only valid while the epoch is unchanged.
      tierEpoch: 0, tierUploads: new Map(), tierPublications: new Set(), roomBinds: new Set(),
      pmremTargets: new Map(), roomCalls: new Map(), visible: [initialRoom], notices: new Map(), failures: new Map(),
      sourceBlobs: new Map(), sourcePromises: new Map(), sourceUrls: new Set(), readyGates: new Map(),
      finishSelections: new Map(manifest.variants.map(group => [group.group, group.options[0].id])),
      fetchedAssets: [], viewerRecords: [], shaderCompilation: [], walk: null, run: false,
      joystick: { forward: 0, strafe: 0 }, walkAvailable: false, walkNote: null };
    for (const room of roomList) current.readyGates.set(room.id, deferred());
    current.interactive = deferred();
    session = current;
    state.room = initialRoom;
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, depth: false,
      powerPreference: 'high-performance' });
    // Batched opaque draws can reject covered fragments before running the PBR
    // shader. Keep authored group/render ordering and the stable tie-breaks.
    renderer.setOpaqueSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder
      || a.z - b.z || a.material.id - b.material.id || a.id - b.id);
    current.renderer = renderer;
    current.residency = new InteriorResidency(renderer);
    const updateInfo = renderer.info.update;
    renderer.info.update = (...args) => {
      updateInfo(...args);
      if (current.activeRoom) current.roomCalls.set(current.activeRoom, (current.roomCalls.get(current.activeRoom) ?? 0) + 1);
    };
    current.pipeline = new InteriorRenderPipeline(renderer);
    if (options?.stress) current.pipeline.setStress(true);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = manifest.lighting.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor('#282722');
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      current.shaderError = new Error(`PBR/lightmap shader failed: ${gl.getProgramInfoLog(program)} ${gl.getShaderInfoLog(vertex)} ${gl.getShaderInfoLog(fragment)}`);
    };
    current.loader = new RuntimeAssetLoader({ manifest, renderer, baseUrl, benchmark: !!options,
      onFetchedAsset(record) {
        const actual = fetchedRecord(record);
        current.fetchedAssets.push(actual);
        current.benchmark?.recordAsset(actual);
      },
      onProgress() {
        if (session === current && state.status === 'loading') {
          const bytes = current.fetchedAssets.reduce((sum, item) => sum + item.bytes, 0);
          ui['load-status'].textContent = `Loading standard room · ${(bytes / 1048576).toFixed(1)} MiB received`;
        }
      },
    });
    configureSceneContent(current);
    updateSourceImage(current);
    buildWalkButtons();
    const canvas = renderer.domElement;
    canvas.tabIndex = -1;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-describedby', 'interaction-hint');
    canvas.addEventListener('keydown', cameraKeys);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      if (session === current) void fail(new Error('Lost the WebGL context. Choose Retry load to rebuild the viewer.'));
    });
    ui['canvas-host'].append(canvas);
    const scene = current.scene = new THREE.Scene();
    const houseMin = new THREE.Vector3(Infinity, Infinity, Infinity), houseMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const room of roomList) {
      houseMin.min(new THREE.Vector3().fromArray(room.bounds.min));
      houseMax.max(new THREE.Vector3().fromArray(room.bounds.max));
    }
    const houseSize = houseMax.clone().sub(houseMin).length();
    const initialDef = roomDefs.get(initialRoom);
    current.camera = new THREE.PerspectiveCamera(initialDef.views.source.fov, current.source.size[0] / current.source.size[1], .03, Math.max(250, houseSize * 4));
    const controls = current.controls = new OrbitControls(current.camera, canvas);
    Object.assign(controls, { enabled: false, enableDamping: false, enablePan: true, rotateSpeed: .55, zoomSpeed: .7 });
    controls.addEventListener('change', () => {
      current.cameraChangedAt = performance.now();
      if (!applyingPose && state.status === 'ready') { state.view = null; syncControls(); }
      requestRender('camera');
    });
    setupWalkInput(current);
    applyOrbitPose(views.get(`${initialRoom}/source`));
    state.view = `${initialRoom}/source`;
    resize();
    // The sun spans the house; it exists before any room compiles so programs are built once.
    const sunSpec = manifest.lighting.sun;
    if (sunSpec) {
      const sun = current.sun = new THREE.DirectionalLight();
      sun.color.setRGB(...sunSpec.color); sun.intensity = sunSpec.intensity;
      const center = houseMin.clone().add(houseMax).multiplyScalar(.5);
      const extent = houseSize * .6;
      sun.target.position.copy(center);
      sun.position.fromArray(sunSpec.position).sub(new THREE.Vector3().fromArray(sunSpec.target)).normalize().multiplyScalar(houseSize * 1.5).add(center);
      sun.castShadow = true;
      sun.shadow.mapSize.setScalar(sunSpec.shadowMapSize);
      Object.assign(sun.shadow.camera, { near: .1, far: houseSize * 3, left: -extent, bottom: -extent, right: extent, top: extent });
      sun.shadow.bias = -.00008; sun.shadow.normalBias = .015;
      sun.shadow.camera.updateProjectionMatrix();
      scene.add(sun, sun.target);
    }
    current.houseObjects = createHouseObjects({ canvas, camera: current.camera, liveRegion: ui['object-live'],
      roomOrder: roomList.map(room => room.id), variants: manifest.variants, getCurrentRoom: () => state.room,
      isInteractive: () => session === current && state.status === 'ready' && state.mode === '3d',
      onChange: reason => noteObjectChange(current, reason),
      onSelect(object) {
        state.selected = object?.objectId ?? null;
        if (object?.finishGroup && object.finishGroup !== state.finishGroup) chooseFinishGroup(object.finishGroup);
        syncObjectControls();
      },
      onInspect: () => { syncObjectControls(); focusObjectControls(); } });
    current.objects = current.houseObjects;
    current.objectApi = Object.freeze({
      list: () => current.objects.list(), select: id => current.objects.select(id),
      hide: id => current.objects.hide(id), show: id => current.objects.show(id),
      isolate: id => { state.isolated = id; current.objects.isolate(id); syncObjectControls(); },
      setFinish: setGroupFinish,
    });
    current.scheduler = new InteriorScheduler({
      renderer, pipeline: current.pipeline,
      update(delta, now) {
        if (session !== current || state.status !== 'ready') return false;
        const wasMoving = current.benchmark?.phase === 'moving';
        const benchmarkMoving = current.benchmark?.update(delta, now) ?? false;
        const benchmarkActive = ['moving', 'stopping', 'finishing'].includes(current.benchmark?.phase);
        const touring = state.navMode === 'tour';
        const journeyMoving = touring ? current.journey?.update(delta) ?? false : false;
        let controlsMoving = false, walkMoving = false;
        if (!touring && state.navMode === 'walk') walkMoving = walkStep(current, delta);
        else if (!touring) controlsMoving = benchmarkActive ? false : controls.update();
        if (benchmarkMoving || journeyMoving || controlsMoving || walkMoving) current.cameraChangedAt = now;
        if (state.navMode !== 'walk' && !touring) syncRoomFromCamera(current);
        if (touring && ['completed', 'error'].includes(current.journey?.snapshot().state)) stopJourney(true);
        stepCloth(current, delta, now);
        const resting = !wasMoving && !benchmarkMoving && !journeyMoving && !controlsMoving && !walkMoving && now - (current.cameraChangedAt ?? 0) >= 150;
        const published = publishNextHigh(current, resting);
        current.objects?.updateHighlight();
        if (published || current.pendingHighs.size > 0 && !resting) current.scheduler.request('streaming');
        return benchmarkMoving || journeyMoving || controlsMoving || walkMoving;
      },
      render(accumulate) {
        try { renderCurrent(current, accumulate); }
        catch (error) { if (session === current) void fail(error); }
      },
      isAnimating: () => !!current.clothMoving || current.journey?.snapshot().state === 'playing',
      measure: includeResources => measureResources(current, includeResources),
      onState(snapshot, now) {
        if (session !== current || state.status !== 'ready') return;
        showPerformance(current, snapshot, now);
        current.benchmark?.recordFrame(snapshot, now);
      },
    });
    current.scheduler.ready.then(() => {
      if (session === current && state.status === 'loading') current.scheduler.setVisible(false);
    });
    const json = async (path, role) => JSON.parse(new TextDecoder().decode(
      await current.loader.fetchBytes(path, { priority: 'P0', role, roomId: initialRoom })));
    const registryJson = json(manifest.objects, 'registry');
    const navigationJson = json(manifest.navigation, 'navigation');
    const budgetJson = json(manifest.budget, 'budget');
    current.shellReady = Promise.all([registryJson, navigationJson]).then(([registry, navigation]) => {
      validateReferences(manifest, { registry, navigation });
      current.registryById = new Map(registry.objects.map(object => [object.objectId, object]));
      current.navigationData = navigation;
      current.walkAvailable = navigation.mode !== 'orbit-only';
      ui['journey-path'].replaceChildren(...manifest.paths.map(path => {
        const option = document.createElement('option');
        option.value = path.id; option.textContent = path.label ?? path.id;
        return option;
      }));
      if (!current.walkAvailable) current.walkNote = 'Walk mode is unavailable: this export declares orbit-only navigation (no walkable floor plan).';
      return { shell: { registry, navigation } };
    });
    current.shellReady.catch(() => {});
    current.streamer = new RoomStreamer({
      graph, loader: current.loader, current: initialRoom, alsoHigh: options?.mode === 'warm' ? benchmarkPath.rooms : [],
      bindStandard: (roomId, assets) => bindRoom(current, roomId, assets),
      acceptHigh: async (roomId, result) => { current.pendingHighs.set(roomId, result); requestRender('high-ready'); },
      whenReady: (roomId, signal) => {
        const gate = current.readyGates.get(roomId).promise;
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Room request was cancelled.', 'AbortError')), { once: true });
          gate.then(resolve, reject);
        });
      },
      onFailure: failure => reportFailure(current, failure),
    });
    // P0 shell and the first room's reference before any room request is queued behind them.
    const backgroundTask = current.loader.loadBackground();
    const sourceTask = ensureSource(current, initialRoom, 'P0');
    current.streamer.start();
    const results = await Promise.allSettled([
      current.streamer.whenStandard(initialRoom), current.shellReady, budgetJson, backgroundTask, sourceTask,
    ]);
    if (session !== current || stopped) return;
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const [, , budget, background] = results.map(result => result.value);
    current.budget = budget;
    if (background) {
      // Own the same cube conversion Three otherwise hides in its private cache,
      // so resident bytes and teardown include the background's six GPU faces.
      current.backgroundTarget = new THREE.WebGLCubeRenderTarget(background.image.height, { depthBuffer: false })
        .fromEquirectangularTexture(renderer, background);
      current.residency.trackTarget('background-cube', current.backgroundTarget);
      scene.background = current.backgroundTarget.texture;
      scene.backgroundIntensity = manifest.background.intensity;
    }
    setLoadPhase(2);
    configureInteractionContent(current);
    updateSourceImage(current);
    const calibrated = await current.scheduler.ready;
    if (stopped || session !== current) return;
    if (state.error) throw new Error(state.error);
    if (!calibrated) throw new Error('Renderer calibration was cancelled.');
    setLoadPhase(3);
    // Finish first-use shader/link work before declaring the scene interactive.
    // Streamed rooms resume from interactive.promise, so keep that declaration in its own task.
    renderCurrent(current, false);
    await yieldToBrowser();
    if (stopped || session !== current) return;
    current.loader.markReady(initialRoom);
    current.readyGates.get(initialRoom).resolve();
    if (options) {
      const context = globalThis.__interiorBenchmarkContext ?? {};
      current.benchmark = new InteriorBenchmark({ manifest, camera: current.camera, controls, scheduler: current.scheduler, renderer,
        manifestRecord: fetchedRecord(await hashFetchedBytes(manifestUrl, manifestBytes)),
        budgetRecord: current.fetchedAssets.find(record => record.role === 'budget'),
        viewerRecords: current.viewerRecords, shaderCompilation: current.shaderCompilation,
        networkConditions: context.networkConditions ?? null, environment: context.environment ?? null, options,
        requirement: () => benchmarkRequirement(current),
        onComplete: () => { ui['load-status'].textContent = 'Benchmark receipt ready.'; },
        onError: error => { ui['load-status'].textContent = `Benchmark failed: ${error.message}`; },
      });
      for (const record of current.fetchedAssets) current.benchmark.recordAsset(record);
    }
    state.status = 'ready';
    current.interactive.resolve();
    setLoadPhase(4);
    ui['load-status'].textContent = `${loadSummary(current)} Fetching high detail.`;
    rebuildObjectList();
    syncObjectControls();
    syncControls();
    current.benchmark?.markInteractive();
    if (options) collectViewerRecords(current).catch(error => {
      if (session === current) current.benchmark.fail(error);
    });
    evaluatePressure(current);
    requestRender('ready');
  } catch (error) {
    if (!stopped && generation === run) await fail(error);
  } finally {
    if (generation === run) {
      loading = false;
      if (stopped) await disposeSession();
      else syncControls();
    }
  }
}

ui['mode-3d'].addEventListener('click', () => setMode('3d'));
ui['mode-source'].addEventListener('click', () => setMode('source'));
ui['nav-orbit'].addEventListener('click', () => setNavigationMode('orbit'));
ui['nav-walk'].addEventListener('click', () => {
  if (setNavigationMode('walk')) revealViewport();
});
ui['journey-start'].addEventListener('click', startJourney);
ui['journey-pause'].addEventListener('click', () => {
  const journey = session?.journey;
  if (!journey) return;
  if (journey.snapshot().state === 'paused') {
    journey.resume();
    revealViewport();
  } else journey.pause();
  syncControls();
  requestRender('journey');
});
ui['journey-stop'].addEventListener('click', () => {
  stopJourney(true);
  revealViewport();
});
ui.wireframe.addEventListener('click', () => setWireframe(!state.wireframe));
ui.reset.addEventListener('click', reset);
ui['retry-load'].addEventListener('click', start);
ui['retry-detail'].addEventListener('click', retryFailures);
ui['finish-group'].addEventListener('change', () => chooseFinishGroup(ui['finish-group'].value));
ui['object-list'].addEventListener('change', () => session?.objects.select(ui['object-list'].value || null));
ui['object-hide'].addEventListener('click', () => {
  const selected = session.objects.list().find(object => object.objectId === state.selected);
  if (selected) session.objects[selected.hidden ? 'show' : 'hide'](selected.objectId);
});
ui['object-isolate'].addEventListener('click', () => session.objectApi.isolate(state.isolated === state.selected ? null : state.selected));
ui['objects-show-all'].addEventListener('click', () => {
  session.objectApi.isolate(null);
  for (const object of session.objects.list()) if (object.hidden) session.objects.show(object.objectId);
});
ui['curtain-amount'].addEventListener('input', () => setCurtainClosure(Number(ui['curtain-amount'].value)/100));
ui['curtain-open'].addEventListener('click', () => setCurtainClosure(0));
ui['curtain-close'].addEventListener('click', () => setCurtainClosure(1));
ui['curtain-wind'].addEventListener('click', () => setCurtainWind(!currentCurtains().wind));
setupJoystick();
window.addEventListener('keyup', cameraKeyUp);
window.addEventListener('blur', () => { keysHeld.clear(); buttonsHeld.clear(); });
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(ui.viewport);
window.addEventListener('resize', resize);
window.addEventListener('pagehide', event => {
  if (!event.persisted) {
    stopped = true;
    resizeObserver.disconnect();
    for (const cloth of allCurtains()) cloth.setEnabled(false);
    void disposeSession();
  }
});
start();
