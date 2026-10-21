// Parent-side owner of the isolated Viggle iframe. The iframe is created only
// when the visitor first chooses the Viggle capture, so the engine, workers and
// the multi-megabyte SPZ never load for the default Detail 3D view.
const CHANNEL = 'house-tour.viggle';
const HELLO_TIMEOUT_MS = 15000;

// Look directions are the yaw (degrees) the camera faces in each capture,
// measured from actual renders of that capture at 5-15 degree steps (yaw grows
// as the view turns left). They describe where the view is pointing; a capture
// is rotation-only and has no positions, rooms or floor plan to travel between.
// `house` is the splat reconstructed from the img2interior render of the authored
// house; `original` is Viggle's earlier capture inferred from the source image,
// whose layout is different and not registered to the authored house.
export const SCENE_NAMES = Object.freeze(['house', 'original']);
export const DEFAULT_SCENE = 'house';
export const SCENE_LABELS = Object.freeze({
  house: 'Viggle capture of the authored house (reconstructed from an img2interior render)',
  original: 'Original Viggle capture (inferred from the source image)',
});
export const LOOK_DIRECTIONS = Object.freeze({
  house: Object.freeze([
    { id: 'living', label: 'Living', yaw: 30, description: 'television wall and sofa' },
    { id: 'kitchen', label: 'Kitchen', yaw: 300, description: 'kitchen run, island and extractor hood' },
    { id: 'garden', label: 'Garden doors', yaw: 335, description: 'glazed garden doors beside the kitchen' },
    { id: 'bedroom', label: 'Bed & bath', yaw: 180, description: 'bed and glazed shower side of the house' },
  ]),
  original: Object.freeze([
    { id: 'living', label: 'Living', yaw: 90, description: 'television wall and garden glazing' },
    { id: 'kitchen', label: 'Kitchen', yaw: 0, description: 'kitchen run, island and dining table' },
    { id: 'garden', label: 'Garden doors', yaw: 180, description: 'glazed garden doors' },
    { id: 'bedroom', label: 'Bed & bath', yaw: 270, description: 'bedroom and shower area' },
  ]),
});

export const isSceneName = name => SCENE_NAMES.includes(name);
export const lookDirectionsFor = name => LOOK_DIRECTIONS[isSceneName(name) ? name : DEFAULT_SCENE];

export function createViggleHost({ container, onChange }) {
  let frame = null;
  let watchdog = 0;
  let desiredRunning = false;
  let requestedRunning = null;
  let disposed = false;
  let remote = null;
  let hostError = null;
  let scene = DEFAULT_SCENE;

  function state() {
    if (hostError) return { status: 'error', ready: false, hostLevel: true, error: hostError, detail: '', scene, yaw: remote?.yaw ?? null, pitch: remote?.pitch ?? null, paused: true };
    if (!frame) return { status: 'idle', ready: false, error: null, detail: '', scene, yaw: null, pitch: null, paused: true };
    if (!remote) return { status: 'loading', ready: false, error: null, detail: 'Opening the Viggle capture page…', scene, yaw: null, pitch: null, paused: !desiredRunning };
    return remote;
  }

  const sceneUrl = () => {
    const url = new URL('viggle.html', new URL(import.meta.env.BASE_URL, window.location.href));
    url.searchParams.set('scene', scene);
    return url.href;
  };
  const frameTitle = () => `${SCENE_LABELS[scene]}, viewed from one fixed point`;

  const emit = () => { if (!disposed) onChange(state()); };

  function post(type, payload = {}) {
    // The iframe is same-origin by construction; never broadcast to other origins.
    frame?.contentWindow?.postMessage({ channel: CHANNEL, type, ...payload }, window.location.origin);
  }

  // Send a pause/resume only when the request itself changes. Comparing against
  // the iframe's reported state would loop while its own document is hidden.
  function reconcile() {
    if (!remote || requestedRunning === desiredRunning) return;
    requestedRunning = desiredRunning;
    post(desiredRunning ? 'resume' : 'pause');
  }

  function onMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== 'state' || !message.state || typeof message.state !== 'object') return;
    window.clearTimeout(watchdog);
    watchdog = 0;
    hostError = null;
    // A report for another scene is stale (or the iframe opened before a scene
    // change): ask it to follow the host and wait for its own loading report.
    if (message.state.scene !== scene) {
      post('scene', { name: scene });
      return;
    }
    remote = message.state;
    reconcile();
    emit();
  }

  function mount() {
    hostError = null;
    remote = null;
    requestedRunning = null;
    frame = document.createElement('iframe');
    frame.className = 'viggle-frame';
    frame.title = frameTitle();
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'same-origin');
    // BASE_URL is '/' standalone and '/modern-house/' when built under that base.
    frame.src = sceneUrl();
    container.replaceChildren(frame);
    watchdog = window.setTimeout(() => {
      watchdog = 0;
      hostError = 'The capture page did not respond within 15 seconds. Check that viggle.html is served from this site, then retry.';
      emit();
    }, HELLO_TIMEOUT_MS);
    emit();
  }

  function unmount() {
    window.clearTimeout(watchdog);
    watchdog = 0;
    frame?.remove();
    frame = null;
    remote = null;
  }

  window.addEventListener('message', onMessage);

  return {
    // Lazy: the first call creates the iframe, later calls are no-ops.
    open() { if (!disposed && !frame) mount(); },
    setRunning(running) {
      desiredRunning = running;
      reconcile();
    },
    look(yaw, pitch = 0) { post('look', { yaw, pitch }); },
    // Switch the capture in place: the iframe keeps one renderer, destroys the
    // old splat and opens the other one at that capture's own start look.
    setScene(name) {
      if (disposed || !isSceneName(name)) return false;
      if (name === scene) return true;
      scene = name;
      if (frame) {
        frame.title = frameTitle();
        if (remote) {
          remote = { ...remote, status: 'loading', ready: false, error: null, scene, detail: `Opening the ${scene === 'house' ? 'Viggle capture of the authored house' : 'original Viggle capture'}…` };
          post('scene', { name });
        }
        emit();
      }
      return true;
    },
    get scene() { return scene; },
    get lookDirections() { return lookDirectionsFor(scene); },
    reset() { post('reset'); },
    focus() { post('focus'); frame?.focus(); },
    retry() {
      if (disposed) return;
      if (frame && remote && !hostError) { post('retry'); return; }
      unmount();
      mount();
    },
    get state() { return state(); },
    get frame() { return frame; },
    // Same-origin read of the iframe's own diagnostic object.
    get snapshot() {
      try { return frame?.contentWindow?.viggleStudy?.snapshot() ?? null; } catch { return null; }
    },
    dispose() {
      disposed = true;
      window.removeEventListener('message', onMessage);
      unmount();
    },
  };
}
