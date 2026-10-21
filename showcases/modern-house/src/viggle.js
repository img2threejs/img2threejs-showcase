import './viggle.css';
import { Scene, Environment } from '@viggle/splat-engine';

// Isolated Viggle capture viewer. One of two unmodified SPZ captures is
// rendered by the official engine in its own document so its renderer, CSS and
// workers never touch the Three.js house viewer:
//   house    - a Viggle Gaussian splat reconstructed from a Cycles 360 render
//              taken inside the authored img2interior house. Single-viewpoint
//              reconstruction: unseen areas are filled in by the engine, the
//              layout follows the authored house at that viewpoint, scale is
//              arbitrary and nothing here is registered to the Three.js scene.
//   original - Viggle's earlier capture inferred from the source image. Its
//              layout differs from the authored house.
// The camera never leaves the capture origin: input only changes yaw and pitch.
const CHANNEL = 'house-tour.viggle';
const BASE = new URL(import.meta.env.BASE_URL, window.location.href);
const SCENES = Object.freeze({
  house: Object.freeze({
    url: new URL('assets/viggle-house/scene.spz', BASE).href,
    startLook: Object.freeze({ yaw: 20, pitch: 0 }),
    fov: 70,
    name: 'Viggle capture of the authored house (reconstructed from an img2interior render)',
    loadingTitle: 'Opening the Viggle capture of the authored house',
    errorTitle: 'Could not open the Viggle capture of the authored house',
    aria: 'Viggle capture of the authored house, reconstructed from an img2interior render and seen from one fixed point.',
  }),
  original: Object.freeze({
    url: new URL('assets/viggle/scene.spz', BASE).href,
    startLook: Object.freeze({ yaw: 90, pitch: 0 }),
    fov: 70,
    name: 'Original Viggle capture (inferred from the source image)',
    loadingTitle: 'Opening the original Viggle capture',
    errorTitle: 'Could not open the original Viggle capture',
    aria: 'Original Viggle capture, inferred from the source image and seen from one fixed point.',
  }),
});
const DEFAULT_SCENE = 'house';
const isSceneName = name => typeof name === 'string' && Object.hasOwn(SCENES, name);
const requested = new URLSearchParams(window.location.search).get('scene');
let sceneName = isSceneName(requested) ? requested : DEFAULT_SCENE;
let config = SCENES[sceneName];
const PITCH_LIMIT = 80;
const PIXEL_RATIO_CAP = 1.5;
const FIRST_FRAMES = 2;
const KEY_STEP = 4;
const KEY_STEP_LARGE = 12;
const embedded = window.parent !== window;
const parentOrigin = window.location.origin;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const ui = Object.fromEntries(['viggle-host', 'viggle-message', 'viggle-message-title', 'viggle-message-detail',
  'viggle-progress', 'viggle-retry', 'viggle-hint'].map(id => [id, document.getElementById(id)]));
const study = { status: 'loading', error: null, detail: '', splatBytes: null, yaw: config.startLook.yaw, pitch: config.startLook.pitch,
  frames: 0, framesAfterLoad: 0, attempt: 0, loaded: false, hostPaused: false };
let scene = null;
let canvas = null;
let aborter = null;
let generation = 0;
let pointer = null;
let glide = null;
let glideRequest = 0;
let notifyTimer = 0;
let lastNotify = -Infinity;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const normalizeYaw = value => ((value % 360) + 360) % 360;
const round = value => Math.round(value * 100) / 100;
const isSuspended = () => study.hostPaused || document.hidden;
const megabytes = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

function snapshot() {
  const rendering = scene && canvas ? {
    backend: scene.graphicsDevice?.deviceType ?? null,
    canvasWidth: canvas.width, canvasHeight: canvas.height,
    cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
    devicePixelRatio: window.devicePixelRatio || 1, pixelRatioCap: PIXEL_RATIO_CAP,
    framesAfterLoad: study.framesAfterLoad,
    reportedGaussians: scene.app.stats.frame.gsplats,
    drawCalls: scene.app.stats.drawCalls.total,
  } : null;
  return { status: study.status, ready: study.status === 'ready', error: study.error, detail: study.detail,
    scene: sceneName, sceneLabel: config.name,
    yaw: round(study.yaw), pitch: round(study.pitch), fov: config.fov, paused: isSuspended(), frames: study.frames,
    attempt: study.attempt, splat: { url: config.url, bytes: study.splatBytes },
    camera: { position: [0, 0, 0], rotationOnly: true }, render: rendering };
}

function notify(immediate = false) {
  if (!embedded || parentOrigin === 'null') return;
  const now = performance.now();
  if (!immediate && now - lastNotify < 120) {
    if (!notifyTimer) notifyTimer = window.setTimeout(() => { notifyTimer = 0; notify(true); }, 120 - (now - lastNotify));
    return;
  }
  window.clearTimeout(notifyTimer);
  notifyTimer = 0;
  lastNotify = now;
  window.parent.postMessage({ channel: CHANNEL, type: 'state', state: snapshot() }, parentOrigin);
}

function applySceneText() {
  document.title = config.name;
  ui['viggle-hint'].textContent = `${config.name}. You look around from one fixed point. Drag, or use the arrow keys when this view has focus. Home resets the look direction.`;
}

function renderMessage() {
  const error = study.status === 'error';
  document.documentElement.dataset.state = study.status;
  ui['viggle-message'].hidden = study.status === 'ready';
  ui['viggle-message'].dataset.state = study.status;
  ui['viggle-message-title'].textContent = error ? config.errorTitle : config.loadingTitle;
  ui['viggle-message-detail'].textContent = error ? study.error : study.detail;
  ui['viggle-progress'].hidden = study.status !== 'loading';
  ui['viggle-retry'].hidden = !error;
}

function setState(patch) {
  Object.assign(study, patch);
  renderMessage();
  notify(true);
}

function setLook(yaw, pitch = study.pitch) {
  study.yaw = normalizeYaw(yaw);
  study.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  scene?.cameraEntity.setEulerAngles(study.pitch, study.yaw, 0);
  notify();
}

function cancelGlide(complete) {
  if (!glide) return;
  const target = glide.to;
  glide = null;
  cancelAnimationFrame(glideRequest);
  glideRequest = 0;
  if (complete) setLook(target.yaw, target.pitch);
}

function stepGlide(time) {
  glideRequest = 0;
  if (!glide) return;
  glide.start ??= time;
  const t = clamp((time - glide.start) / glide.duration, 0, 1);
  // Exponential ease-out, normalised so t = 1 lands exactly on the target.
  const eased = t >= 1 ? 1 : (1 - 2 ** (-10 * t)) / (1 - 2 ** -10);
  const { from, to, delta } = glide;
  setLook(from.yaw + delta * eased, from.pitch + (to.pitch - from.pitch) * eased);
  if (t >= 1) { glide = null; return; }
  glideRequest = requestAnimationFrame(stepGlide);
}

function lookTo(yaw, pitch = 0) {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new RangeError('Look direction needs finite yaw and pitch.');
  cancelGlide(false);
  const to = { yaw: normalizeYaw(yaw), pitch: clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT) };
  if (!scene || reducedMotion.matches || isSuspended()) { setLook(to.yaw, to.pitch); return; }
  const delta = normalizeYaw(to.yaw - study.yaw + 180) - 180;
  glide = { start: null, from: { yaw: study.yaw, pitch: study.pitch }, to, delta, duration: Math.min(900, 320 + Math.abs(delta) * 3) };
  glideRequest = requestAnimationFrame(stepGlide);
}

const resetLook = () => lookTo(config.startLook.yaw, config.startLook.pitch);

function releasePointer() {
  if (pointer && canvas?.hasPointerCapture?.(pointer.id)) canvas.releasePointerCapture(pointer.id);
  pointer = null;
}

function applySuspension() {
  const suspended = isSuspended();
  if (suspended) { releasePointer(); cancelGlide(true); }
  scene?.setSuspended(suspended);
  if (study.status === 'loading' && study.loaded) {
    study.detail = suspended ? 'The capture is loaded and will start drawing when this view is visible.' : 'Preparing the first frame…';
    renderMessage();
  }
  notify(true);
}

function onFrame() {
  if (isSuspended()) return;
  study.frames++;
  // frameend also fires without drawing; wait for actual Gaussian render passes.
  if (!study.loaded || !(scene.app.stats.frame.gsplats > 0)) return;
  study.framesAfterLoad++;
  if (study.status === 'loading' && study.framesAfterLoad >= FIRST_FRAMES) setState({ status: 'ready', detail: '' });
}

function onPointerDown(event) {
  if (study.status !== 'ready' || (event.pointerType === 'mouse' && event.button !== 0)) return;
  if (pointer) { if (pointer.id !== event.pointerId) releasePointer(); return; }
  cancelGlide(false);
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  // Degrees per pixel follows the field of view so one drag feels the same at any size.
  const sensitivity = clamp(1.6 * config.fov / Math.max(1, canvas.clientHeight), 0.12, 0.32);
  setLook(study.yaw - (event.clientX - pointer.x) * sensitivity, study.pitch - (event.clientY - pointer.y) * sensitivity);
  pointer.x = event.clientX;
  pointer.y = event.clientY;
}

function onKeyDown(event) {
  if (study.status !== 'ready' || event.altKey || event.ctrlKey || event.metaKey) return;
  const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  cancelGlide(false);
  if (event.key === 'ArrowLeft') setLook(study.yaw + step);
  else if (event.key === 'ArrowRight') setLook(study.yaw - step);
  else if (event.key === 'ArrowUp') setLook(study.yaw, study.pitch + step * 0.75);
  else if (event.key === 'ArrowDown') setLook(study.yaw, study.pitch - step * 0.75);
  else if (event.key === 'Home') resetLook();
  else return;
  event.preventDefault();
}

function createCanvas() {
  const element = document.createElement('canvas');
  element.tabIndex = 0;
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', config.aria);
  element.setAttribute('aria-describedby', 'viggle-hint');
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  for (const type of ['pointerup', 'pointercancel']) element.addEventListener(type, releasePointer);
  element.addEventListener('lostpointercapture', () => { pointer = null; });
  element.addEventListener('keydown', onKeyDown);
  element.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    if (element === canvas) fail(new Error('The graphics context was lost. Choose Retry capture to rebuild the view.'), 'The Viggle capture');
  });
  return element;
}

function teardown() {
  aborter?.abort();
  aborter = null;
  cancelGlide(false);
  releasePointer();
  const old = scene;
  scene = null;
  study.loaded = false;
  study.framesAfterLoad = 0;
  if (old) {
    try { old.destroy(); } catch (error) { console.error('Viggle scene teardown failed', error); }
  }
  canvas?.remove();
  canvas = null;
  ui['viggle-host'].replaceChildren();
}

function fail(error, stage) {
  const message = error instanceof Error ? error.message : String(error);
  teardown();
  setState({ status: 'error', error: `${stage}: ${message}`, detail: '' });
}

async function preflight(signal) {
  let response;
  try {
    response = await fetch(config.url, { method: 'HEAD', cache: 'no-cache', signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`The capture file could not be requested (${error.message}). Check your connection and that ${new URL(config.url).pathname} is served.`);
  }
  if (response.status === 405 || response.status === 501) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(config.url).pathname}. Place the scene.spz there, then choose Retry capture.`);
  if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error(`${new URL(config.url).pathname} returned a web page instead of the capture file. Place the scene.spz there, then choose Retry capture.`);
  }
  const length = Number(response.headers.get('content-length'));
  return Number.isFinite(length) && length > 0 ? length : null;
}

async function start() {
  const run = ++generation;
  teardown();
  Object.assign(study, { error: null, splatBytes: null, frames: 0, attempt: study.attempt + 1 });
  setState({ status: 'loading', detail: 'Checking the capture file…' });
  const controller = new AbortController();
  aborter = controller;
  let stage = 'Could not request the capture';
  try {
    const bytes = await preflight(controller.signal);
    if (run !== generation || controller.signal.aborted) return;
    study.splatBytes = bytes;
    setState({ detail: bytes
      ? `Decoding ${megabytes(bytes)} of captured splats. The engine reports no progress while it decodes, so this bar stays indeterminate.`
      : 'Decoding the captured splats. The engine reports no progress while it decodes, so this bar stays indeterminate.' });
    stage = 'Could not start the graphics engine';
    const element = createCanvas();
    canvas = element;
    ui['viggle-host'].replaceChildren(element);
    const created = await Scene.create(element, {
      loadSkeleton: false,
      backend: 'webgl',
      bgColor: { r: 0.149, g: 0.133, b: 0.114, a: 1 },
      cameraPosition: { x: 0, y: 0, z: 0 },
      cameraTarget: { x: 0, y: 0, z: -1 },
      near: 0.005,
      far: 100,
      fov: config.fov,
      maxPixelRatio: Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP),
    });
    if (run !== generation || controller.signal.aborted) { created.destroy(); return; }
    scene = created;
    scene.app.on('postrender', onFrame);
    scene.start();
    setLook(study.yaw, study.pitch);
    applySuspension();
    stage = 'Could not decode the capture';
    await Environment.load(scene, config.url);
    if (run !== generation || scene.destroyed) return;
    study.loaded = true;
    study.framesAfterLoad = 0;
    setState({ detail: isSuspended() ? 'The capture is loaded and will start drawing when this view is visible.' : 'Preparing the first frame…' });
    scene.setSuspended(isSuspended());
  } catch (error) {
    if (run !== generation || controller.signal.aborted) return;
    fail(error, stage);
  }
}

// Switch capture in place: the old engine instance and canvas are destroyed by
// start() before the next is created, so exactly one renderer ever exists.
function setScene(name) {
  if (!isSceneName(name)) return false;
  if (name === sceneName) return true;
  sceneName = name;
  config = SCENES[name];
  study.yaw = config.startLook.yaw;
  study.pitch = config.startLook.pitch;
  applySceneText();
  const url = new URL(window.location.href);
  url.searchParams.set('scene', name);
  window.history.replaceState(null, '', url);
  start();
  return true;
}

function receive(event) {
  if (!embedded || event.source !== window.parent || event.origin !== parentOrigin) return;
  const message = event.data;
  if (!message || message.channel !== CHANNEL || typeof message.type !== 'string') return;
  if (message.type === 'pause' || message.type === 'resume') {
    study.hostPaused = message.type === 'pause';
    applySuspension();
  } else if (message.type === 'look') {
    if (Number.isFinite(message.yaw) && (message.pitch === undefined || Number.isFinite(message.pitch))) lookTo(message.yaw, message.pitch ?? 0);
  } else if (message.type === 'scene') setScene(message.name);
  else if (message.type === 'reset') resetLook();
  else if (message.type === 'retry') start();
  else if (message.type === 'focus') canvas?.focus({ preventScroll: true });
  else if (message.type === 'request-state') notify(true);
}

Object.defineProperty(window, 'viggleStudy', {
  value: Object.freeze({
    get status() { return study.status; },
    get ready() { return study.status === 'ready'; },
    get error() { return study.error; },
    get yaw() { return round(study.yaw); },
    get pitch() { return round(study.pitch); },
    get fov() { return config.fov; },
    get scene() { return sceneName; },
    setScene,
    get paused() { return isSuspended(); },
    get frames() { return study.frames; },
    get render() { return snapshot().render; },
    get camera() { return snapshot().camera; },
    get splat() { return snapshot().splat; },
    snapshot,
    // Immediate look change for verification; lookTo glides unless motion is reduced.
    setLook(yaw, pitch = 0) {
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new RangeError('Look direction needs finite yaw and pitch.');
      cancelGlide(false);
      setLook(yaw, pitch);
    },
    lookTo,
    reset: resetLook,
    pause() { study.hostPaused = true; applySuspension(); },
    resume() { study.hostPaused = false; applySuspension(); },
    retry: start,
  }),
});

document.documentElement.toggleAttribute('data-embedded', embedded);
ui['viggle-retry'].addEventListener('click', start);
window.addEventListener('message', receive);
window.addEventListener('blur', releasePointer);
document.addEventListener('visibilitychange', applySuspension);
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  generation++;
  teardown();
});
applySceneText();
start();
