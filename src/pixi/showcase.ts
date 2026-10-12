import { Application } from 'pixi.js';
import type { Container } from 'pixi.js';
import type { PixiDemoMetadata } from './registry';

export interface PixiShowcaseArtwork {
  root: Container;
  setTime(seconds: number): void;
  dispose(): Promise<void>;
}


/**
 * Reusable PixiJS viewer shell for the dedicated 2D exhibits. The page that mounts a pixi demo
 * pre-builds a `.pixi-showcase` root with all markup in place; this shell only applies
 * metadata (titles, blurb, artboard, reference image) via textContent and attributes, then
 * drives the Application lifecycle.
 *
 * The shell is fully self-contained: it never queries globals, never reads from
 * `localStorage`, and never calls into a Three.js surface.
 *
 * Returns an idempotent asynchronous cleanup. Renderer bindings are released before the
 * artwork's framed textures and atlas leases.
 */
export async function mountPixiShowcase(
  root: HTMLElement,
  metadata: PixiDemoMetadata,
  isCurrent: () => boolean = () => true,
): Promise<() => Promise<void>> {
  // Apply metadata. Anything user-controllable lands via textContent or attribute setters;
  // the host already injected the static markup.
  const [artWidth, artHeight] = metadata.artboard;
  const titleEl = root.querySelector('#pixi-artwork-title');
  if (titleEl) titleEl.textContent = metadata.title;
  const panelTitleEl = root.querySelector('#pixi-panel-title');
  if (panelTitleEl) panelTitleEl.textContent = metadata.title;
  const descEl = root.querySelector('#pixi-artwork-description');
  if (descEl) descEl.textContent = metadata.blurb;
  const captionEl = root.querySelector('#pixi-reference-caption');
  if (captionEl) captionEl.textContent = `Original artwork · ${artWidth} × ${artHeight}`;
  const reference = root.querySelector<HTMLImageElement>('#pixi-reference-image');
  if (reference) {
    reference.alt = metadata.referenceAlt;
    reference.width = artWidth;
    reference.height = artHeight;
    reference.src = metadata.fullReferenceImage;
  }

  const canvasRoot = root.querySelector<HTMLDivElement>('#pixi-canvas-root');
  const panelBody = root.querySelector<HTMLDivElement>('#pixi-panel-body');
  const toggle = root.querySelector<HTMLButtonElement>('#pixi-panel-toggle');
  const toggleLabel = root.querySelector<HTMLSpanElement>('#pixi-panel-toggle-label');
  const status = root.querySelector<HTMLParagraphElement>('#pixi-status');
  if (!canvasRoot || !panelBody || !toggle || !toggleLabel || !status) {
    throw new Error('pixi showcase root is missing required nodes');
  }
  const compact = matchMedia('(max-width: 860px), (max-height: 520px)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const previousTitle = document.title;
  document.title = `${metadata.title} — PixiJS Showcase`;

  let expanded = !compact.matches;
  let userToggled = false;
  const syncPanel = (): void => {
    root.dataset.expanded = String(expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} description and reference`);
    toggleLabel.textContent = expanded ? 'Hide' : 'Info';
    panelBody.hidden = !expanded;
    panelBody.inert = !expanded;
  };
  const onToggle = (): void => { userToggled = true; expanded = !expanded; syncPanel(); };
  const onCompact = (): void => {
    if (!userToggled) { expanded = !compact.matches; syncPanel(); }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && expanded) {
      userToggled = true; expanded = false; syncPanel(); toggle.focus();
    }
  };
  syncPanel();
  toggle.addEventListener('click', onToggle);
  compact.addEventListener('change', onCompact);
  root.addEventListener('keydown', onKey);

  const app = new Application();
  let artwork: PixiShowcaseArtwork | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let renderingDisposal: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let time = 0;

  const syncTicker = (): void => {
    if (!app.ticker) return;
    if (renderingDisposal) return;
    if (!isCurrent() || document.hidden || reducedMotion.matches) app.ticker.stop();
    else app.ticker.start();
  };

  const disposeRendering = (): Promise<void> => renderingDisposal ??= (async () => {
    document.removeEventListener('visibilitychange', syncTicker);
    reducedMotion.removeEventListener('change', syncTicker);
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    if (app.ticker) app.ticker.stop();
    if (artwork) artwork.root.removeFromParent();
    // Renderer releases shader bindings before the scene releases borrowed atlas frames.
    if (app.renderer) app.destroy(true, { children: true, texture: false, textureSource: false });
    await artwork?.dispose();
  })();

  const dispose = (): Promise<void> => disposal ??= (async () => {
    toggle.removeEventListener('click', onToggle);
    compact.removeEventListener('change', onCompact);
    root.removeEventListener('keydown', onKey);
    await disposeRendering();
    root.dataset.state = 'disposed';
    if (document.title === `${metadata.title} — PixiJS Showcase`) {
      document.title = previousTitle;
    }
  })();

  try {
    artwork = await metadata.loadArtwork();
    if (!isCurrent()) {
      await dispose();
      return dispose;
    }
    // Initialize after the atlas is ready. This presentation-only artboard disables Pixi
    // pointer/wheel features and scene hit testing instead of installing camera controls.
    await app.init({
      width: 1, height: 1, preference: 'webgl', backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio, 2), autoDensity: true,
      antialias: false, autoStart: false, sharedTicker: false,
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    if (!isCurrent()) {
      await dispose();
      return dispose;
    }
    const canvas = app.canvas as HTMLCanvasElement;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${metadata.title}, animated 2D artwork`);
    canvasRoot.appendChild(canvas);
    artwork.root.eventMode = 'none';
    artwork.root.interactiveChildren = false;
    app.stage.addChild(artwork.root);
    const resize = (): void => {
      const width = Math.max(1, canvasRoot.clientWidth);
      const height = Math.max(1, canvasRoot.clientHeight);
      app.renderer.resize(width, height);
      const scale = Math.min(width / artWidth, height / artHeight);
      artwork!.root.scale.set(scale);
      artwork!.root.position.set(
        (width - artWidth * scale) / 2,
        (height - artHeight * scale) / 2,
      );
      app.renderer.render({ container: app.stage });
    };
    artwork.setTime(0);
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvasRoot);
    resize();
    app.ticker.add((ticker) => {
      if (!isCurrent()) { app.ticker.stop(); return; }
      time += Math.min(ticker.deltaMS / 1000, 0.05);
      artwork!.setTime(time);
    });
    document.addEventListener('visibilitychange', syncTicker);
    reducedMotion.addEventListener('change', syncTicker);
    status.hidden = true;
    root.dataset.state = 'ready';
    syncTicker();
    return dispose;
  } catch (error) {
    await disposeRendering();
    root.dataset.state = 'error';
    status.hidden = false;
    const message = error instanceof Error ? error.message : String(error);
    status.textContent =
      `Unable to load artwork: ${message}. Reload this page to try again.`;
    return dispose;
  }
}
