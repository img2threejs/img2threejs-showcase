import { Application, Container, Rectangle } from 'pixi.js';
import { createScene } from './scene.js';
import { loadGameFont } from './font.js';
import { loadResources, releaseResources } from './resources.js';
import { ATTACKS, type Attack, type Resources, type Scene, type Skill } from './types.js';
import { attackIconMarkup } from './attack-icons.js';
import { bindInput } from './input.js';
import type { GreenvaleInput } from './input.js';
import type { Movement } from './types.js';
import './style.css';

const WIDTH = 1536;
const HEIGHT = 1024;
const PAGE_TITLE = 'Greenvale — PixiJS';
const SKILL_LABELS: Record<Skill, string> = { heal: 'Heal', ice: 'Ice', fire: 'Fire' };

export interface GreenvaleApi {
  readonly ready: boolean;
  readonly app: Application;
  readonly scene: Scene;
  readonly resources: Resources;
  readonly input: GreenvaleInput;
  readonly movement: Movement;
  capture(): Promise<string>;
  reset(): void;
  recreate(): void;
  dispose(): void;
}

interface GreenvaleWindow extends Window {
  greenvaleApp?: GreenvaleApi;
  greenvaleError?: string;
}

type VisibilityListener = () => void;
type TickFn = () => void;

interface RuntimeState {
  app: Application | null;
  resources: Resources | null;
  canvas: HTMLCanvasElement | null;
  stageEl: HTMLElement | null;
  input: GreenvaleInput | null;
  scene: Scene | null;
  sceneRoot: Container | null;
  resizeObserver: ResizeObserver | null;
  visibilityListener: VisibilityListener | null;
  disposers: Array<() => void>;
  ticker: TickFn | null;
  pageHideListener: (() => void) | null;
  initialized: boolean;
  disposed: boolean;
}

function buildShell(): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = `
    <main class="greenvale-main">
      <div class="greenvale-play">
        <section class="greenvale-stage" id="greenvale-stage" aria-label="Greenvale canvas">
          <p class="greenvale-loading" id="greenvale-loading" role="status" aria-live="polite">Building Greenvale…</p>
        </section>
        <div class="greenvale-touch" role="group" aria-label="Mobile game controls">
          <div class="greenvale-touch__movement">
            <div id="gv-joystick" class="greenvale-joystick" role="group" tabindex="0"
              aria-label="Movement joystick. Drag to move, or focus and use arrow keys." aria-describedby="gv-touch-help">
              <span class="greenvale-joystick__thumb" aria-hidden="true"></span>
            </div>
            <div class="greenvale-touch__utilities">
              <button type="button" class="greenvale-touch__skill" data-greenvale-touch="run" aria-label="Hold to run">Run</button>
              <button type="button" class="greenvale-touch__skill" data-greenvale-touch="interact" aria-label="Talk or collect">Talk / E</button>
            </div>
          </div>
          <div class="greenvale-touch__skills" role="group" aria-label="Touch skills">
            <button type="button" class="greenvale-touch__skill" data-greenvale-touch="heal">${SKILL_LABELS.heal}<kbd>1</kbd></button>
            <button type="button" class="greenvale-touch__skill" data-greenvale-touch="ice">${SKILL_LABELS.ice}<kbd>2</kbd></button>
            <button type="button" class="greenvale-touch__skill" data-greenvale-touch="fire">${SKILL_LABELS.fire}<kbd>3</kbd></button>
            ${(Object.entries(ATTACKS) as [Attack, typeof ATTACKS[Attack]][]).map(([id, action]) =>
              `<button type="button" class="greenvale-touch__skill" data-greenvale-touch="${id}">${attackIconMarkup(id)}<span>${action.label}</span><kbd>${action.key}</kbd></button>`).join('')}
          </div>
          <p class="greenvale-touch__help" id="gv-touch-help">Drag to walk · Hold Run with another finger to run · Release to stop. Tap a skill to cast; attacks briefly lock movement.</p>
        </div>
      </div>
      <p class="greenvale-sr-only" id="gv-status" role="status" aria-live="polite"></p>
    </main>
    <div id="greenvale-error" class="greenvale-error" role="alert" hidden>
      <h2>Greenvale could not start</h2>
      <p id="greenvale-error-message">Something went wrong while loading the app.</p>
      <button type="button" id="greenvale-retry">Try again</button>
    </div>`;
  return tpl.content;
}

function attachShell(): void {
  const characterStyles = document.getElementById('character-styles');
  if (characterStyles) characterStyles.remove();
  document.title = PAGE_TITLE;
  document.documentElement.lang = 'en';
  document.body.className = 'greenvale-page';
  document.body.removeAttribute('data-loading');
  document.body.replaceChildren(buildShell());
}

function showError(message: string): void {
  const host = document.getElementById('greenvale-error') as HTMLElement | null;
  if (!host) return;
  host.hidden = false;
  const p = host.querySelector<HTMLElement>('#greenvale-error-message');
  if (p) p.textContent = message;
  const retry = document.getElementById('greenvale-retry');
  if (retry) retry.addEventListener('click', () => location.reload());
}

function setStatus(message: string): void {
  const status = document.getElementById('gv-status');
  if (!status) return;
  status.textContent = message;
}

function bindUi(state: RuntimeState, api: GreenvaleApi): void {
  // Defensive guard: dispose any previous UI bindings before re-attaching so
  // repeated recreate calls do not stack listeners.
  for (let i = state.disposers.length - 1; i >= 0; i--) state.disposers[i]!();
  state.disposers.length = 0;

  const mobileDevice = window.matchMedia('(max-width: 900px), (any-pointer: coarse)');
  const syncMode = (): void => {
    document.body.dataset.mobile = String(mobileDevice.matches);
    state.input?.reset();
  };
  mobileDevice.addEventListener('change', syncMode);
  state.disposers.push(() => mobileDevice.removeEventListener('change', syncMode));
  syncMode();

  const fullscreen = async (toggle: boolean): Promise<void> => {
    try {
      if (document.fullscreenElement) {
        if (toggle) await document.exitFullscreen();
      } else if (document.fullscreenEnabled) {
        await document.documentElement.requestFullscreen();
      }
    } catch (error: unknown) {
      // Viewport-filling gameplay remains available when a browser denies fullscreen.
      console.warn('Fullscreen unavailable', error);
      setStatus('Fullscreen unavailable. The game still fills this browser window.');
    }
  };
  const play = document.querySelector<HTMLElement>('.greenvale-play')!;
  const onFirstGesture = (): void => {
    // Browser fullscreen requires activation; never request it during boot.
    void fullscreen(false);
    if (state.scene?.world.state.paused && state.scene.world.state.time === 0) {
      state.scene.world.state.paused = false;
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'KeyF') {
      event.preventDefault();
      void fullscreen(true);
    } else if (event.code === 'KeyP' && state.scene) {
      event.preventDefault();
      state.scene.world.state.paused = !state.scene.world.state.paused;
      state.input?.reset();
    } else if (event.code === 'KeyR') {
      event.preventDefault();
      api.reset();
    }
  };
  const onFullscreenChange = (): void => {
    state.input?.reset();
    fitStage(state);
  };
  play.addEventListener('pointerup', onFirstGesture, { once: true });
  window.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  state.disposers.push(() => play.removeEventListener('pointerup', onFirstGesture));
  state.disposers.push(() => window.removeEventListener('keydown', onKey));
  state.disposers.push(() => document.removeEventListener('fullscreenchange', onFullscreenChange));
}

function fitStage(state: RuntimeState): void {
  if (!state.app || !state.stageEl || !state.sceneRoot) return;
  const box = state.stageEl.getBoundingClientRect();
  const scale = Math.max(0.1, Math.min(box.width / WIDTH, box.height / HEIGHT));
  state.app.renderer.resize(Math.max(1, box.width), Math.max(1, box.height));
  state.sceneRoot.scale.set(scale);
  state.sceneRoot.position.set(
    (box.width - WIDTH * scale) / 2,
    (box.height - HEIGHT * scale) / 2,
  );
}

function tickScene(state: RuntimeState): TickFn {
  let lastMessage = '';
  return (): void => {
    if (!state.app || !state.scene || !state.input) return;
    const world = state.scene.world.state;
    const dt = world.paused ? 0 : Math.min(state.app.ticker.deltaMS / 1000, 0.05);
    state.scene.update(dt, state.input.movement);
    // Canvas text shrinks with the artboard on phones; keep dialogue readable
    // in the existing live region without re-announcing it every frame.
    if (world.message !== lastMessage) {
      lastMessage = world.message;
      setStatus(lastMessage);
    }
  };
}

async function start(state: RuntimeState): Promise<void> {
  attachShell();
  const stageEl = document.getElementById('greenvale-stage') as HTMLElement;
  state.stageEl = stageEl;
  // Load font + resources before initing the Application so a half-initialised
  // Pixi application never lingers on a boot error.
  await loadGameFont();
  const resources = await loadResources();
  state.resources = resources;
  const app = new Application();
  try {
    await app.init({
      width: WIDTH,
      height: HEIGHT,
      resolution: 1,
      antialias: true,
      preference: 'webgl',
      sharedTicker: false,
      autoStart: false,
    });
  } catch (error) {
    await releaseResources(resources).catch((relErr) => console.warn('Resource release failed', relErr));
    throw error;
  }
  state.app = app;
  state.initialized = true;
  const canvas = app.canvas as HTMLCanvasElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Greenvale: use WASD, Shift, E, 1/2/3 to play');
  canvas.classList.add('greenvale-canvas');
  stageEl.replaceChildren(canvas);
  state.canvas = canvas;
  let scene: Scene;
  try {
    scene = createScene(resources);
  } catch (error) {
    try { app.destroy({ removeView: true }, { children: true }); }
    catch (destroyErr) { console.warn('Pixi destroy error', destroyErr); }
    await releaseResources(resources).catch((relErr) => console.warn('Resource release failed', relErr));
    state.app = null;
    throw error;
  }
  scene.world.state.paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  state.scene = scene;
  state.sceneRoot = scene.root;
  app.stage.addChild(scene.root);
  const input = bindInput(canvas, () => {
    if (!state.scene) throw new Error('Scene missing');
    return state.scene;
  });
  state.input = input;
  const resizeObserver = new ResizeObserver(() => fitStage(state));
  resizeObserver.observe(stageEl);
  state.resizeObserver = resizeObserver;
  const visibilityListener: VisibilityListener = () => {
    if (!state.app || state.disposed) return;
    if (document.hidden) state.app.stop();
    else state.app.start();
  };
  document.addEventListener('visibilitychange', visibilityListener);
  state.visibilityListener = visibilityListener;
  const tickFn = tickScene(state);
  state.app.ticker.add(tickFn);
  state.ticker = tickFn;
  if (!document.hidden) state.app.start();
  fitStage(state);
}

function teardown(state: RuntimeState): void {
  if (state.disposed) return;
  state.disposed = true;
  if (state.pageHideListener) {
    window.removeEventListener('pagehide', state.pageHideListener);
    state.pageHideListener = null;
  }
  if (state.visibilityListener) {
    document.removeEventListener('visibilitychange', state.visibilityListener);
    state.visibilityListener = null;
  }
  if (state.resizeObserver) {
    state.resizeObserver.disconnect();
    state.resizeObserver = null;
  }
  if (state.ticker && state.app) {
    state.app.ticker.remove(state.ticker);
  }
  state.ticker = null;
  for (let i = state.disposers.length - 1; i >= 0; i--) state.disposers[i]!();
  state.disposers.length = 0;
  state.input?.dispose();
  state.input = null;
  state.scene?.dispose();
  state.scene = null;
  if (state.app && state.initialized) {
    try { state.app.destroy({ removeView: true }, { children: true }); }
    catch (error) { console.warn('Pixi destroy error', error); }
  }
  state.app = null;
  state.sceneRoot = null;
  if (state.resources) {
    const snapshot = state.resources;
    state.resources = null;
    void releaseResources(snapshot).catch((error) => {
      console.warn('Resource release failed', error);
    });
  }
}

let currentState: RuntimeState | null = null;

async function init(): Promise<GreenvaleApi> {
  currentState = {
    app: null, resources: null, canvas: null, stageEl: null,
    input: null, scene: null, sceneRoot: null,
    resizeObserver: null, visibilityListener: null,
    disposers: [], ticker: null, pageHideListener: null,
    initialized: false, disposed: false,
  };
  let apiRef: GreenvaleApi | null = null;
  const state = currentState;
  const api: GreenvaleApi = {
    get ready(): boolean { return currentState !== null && !currentState.disposed; },
    get app(): Application {
      if (!state.app) throw new Error('Greenvale has been released.');
      return state.app;
    },
    get scene(): Scene {
      if (!state.scene) throw new Error('Scene missing');
      return state.scene;
    },
    get resources(): Resources {
      if (!state.resources) throw new Error('Resources released');
      return state.resources;
    },
    get input(): GreenvaleInput {
      if (!state.input) throw new Error('Input disposed');
      return state.input;
    },
    get movement(): Movement {
      if (!state.input) return { x: 0, y: 0, run: false };
      return state.input.movement;
    },
    async capture(): Promise<string> {
      if (!state.app || !state.sceneRoot || state.disposed) throw new Error('Greenvale is not ready.');
      state.app.stop();
      const sceneRoot = state.sceneRoot;
      const prevScale = { x: sceneRoot.scale.x, y: sceneRoot.scale.y };
      const prevPos = { x: sceneRoot.x, y: sceneRoot.y };
      const frame = new Rectangle(0, 0, WIDTH, HEIGHT);
      // Force the scene into its native reference size for the extraction so the
      // captured PNG matches the underlying artboard exactly; the existing
      // fit-to-stage transform is restored after the snapshot completes.
      sceneRoot.scale.set(1);
      sceneRoot.position.set(0, 0);
      try {
        return await state.app.renderer.extract.base64({
          target: sceneRoot,
          frame,
          resolution: 1,
          format: 'png',
        });
      } finally {
        sceneRoot.scale.set(prevScale.x, prevScale.y);
        sceneRoot.position.set(prevPos.x, prevPos.y);
        if (state.app && !state.disposed && !document.hidden) state.app.start();
      }
    },
    reset(): void {
      if (!state.scene || state.disposed) return;
      state.scene.reset();
      state.input?.reset();
    },
    recreate(): void {
      if (!state.app || state.disposed || !state.resources) return;
      if (state.input) state.input.dispose();
      state.input = null;
      if (state.scene) {
        state.scene.dispose();
        state.scene = null;
      }
      state.sceneRoot = null; // Scene.dispose owns root destruction and detachment.
      const next = createScene(state.resources);
      state.scene = next;
      state.sceneRoot = next.root;
      state.app.stage.addChild(next.root);
      const input = bindInput(state.canvas as HTMLCanvasElement, () => {
        if (!state.scene) throw new Error('Scene missing');
        return state.scene;
      });
      state.input = input;
      bindUi(state, this);
      fitStage(state);
    },
    dispose(): void {
      if (!currentState) return;
      teardown(currentState);
      currentState = null;
    },
  };
  apiRef = api;
  try {
    await start(state);
    bindUi(state, api);
    const pageHide = (): void => {
      if (currentState) teardown(currentState);
      currentState = null;
    };
    window.addEventListener('pagehide', pageHide);
    if (state.pageHideListener) {
      window.removeEventListener('pagehide', state.pageHideListener);
    }
    state.pageHideListener = pageHide;
    return apiRef;
  } catch (error: unknown) {
    if (state.disposed) {
      currentState = null;
    }
    const message = error instanceof Error ? error.message : String(error);
    showError(message);
    throw error;
  }
}

function bootOnce(): void {
  init()
    .then((api) => {
      const w = window as GreenvaleWindow;
      w.greenvaleApp = api;
    })
    .catch((error: unknown) => {
      const w = window as GreenvaleWindow;
      w.greenvaleError = error instanceof Error ? error.message : String(error);
      console.error('Greenvale boot failed', error);
    });
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootOnce, { once: true });
} else {
  bootOnce();
}
