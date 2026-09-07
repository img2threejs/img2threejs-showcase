import { currentRoute, onRouteChange, type DrawerKey, type Route } from './router';
import { dismissPendingIntro, hasPendingIntro, runIntro } from './intro';
import { isCaptureRun } from './capture-run';
import { initAnalytics, reportableLocation, trackPageView } from './analytics';

const app = document.getElementById('app')!;

let cleanupCurrentRoute: (() => void) | null = null;
let firstRender = true;
let pendingTransition: number | null = null;
let routeGeneration = 0;
/** The route the mounted view belongs to, so an in-place exhibit swap does not remount. */
let mountedKind: 'workbench' | 'demo' | null = null;

/**
 * Page modules are intentionally loaded only after the router has chosen a surface. The workbench
 * owns the editor UI and the dedicated viewer owns export tooling; each selected model runtime is
 * loaded separately by the lightweight registry. Keeping both page surfaces out of this shell lets
 * the fallback document paint and the intro finish while the selected route downloads.
 */
const loadWorkbenchPage = () => import('./pages/workbench');
const loadDemoPage = () => import('./pages/demo');

function readableId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** A route-aware document that remains useful when a page chunk is slow or unavailable. */
function renderRouteFallback(route: Route): void {
  const isDemo = route.name === 'demo';
  const subject = isDemo
    ? readableId(route.id)
    : route.name === 'drawer'
      ? readableId(route.key)
      : 'Procedural Three.js models rebuilt from one reference image.';
  const kicker = isDemo ? 'Loading live model inspector' : 'Open-source image-to-3D studies';
  const description = isDemo
    ? 'The inspector shell is ready. Its live Three.js scene and model controls are loading now.'
    : 'Explore live objects and characters written in TypeScript. Inspect their geometry, separate named parts, play available animations and read the source behind each model.';

  app.setAttribute('aria-busy', 'true');
  app.innerHTML = `
    <header class="seo-fallback-head">
      <a href="#/" aria-label="img2threejs home">img<span>2</span>threejs</a>
      <a href="https://github.com/img2threejs/img2threejs">View the Open-Source Project</a>
    </header>
    <main class="seo-fallback-main" aria-live="polite">
      <p>${kicker}</p>
      <h1>${escapeHtml(subject)}</h1>
      <p>${description}</p>
      <nav aria-label="Showcase shortcuts">
        ${isDemo ? '<a href="#/">Back to the showcase</a>' : ''}
        <a href="#/x/awp-medusa-v2">AWP Medusa procedural model</a>
        <a href="#/x/warrior">Rigged mouse warrior character</a>
        <a href="#/x/girl-character">Dual-sword procedural character</a>
      </nav>
    </main>`;
}

function renderRouteLoadError(route: Route): void {
  renderRouteFallback(route);
  app.setAttribute('aria-busy', 'false');
  const status = app.querySelector<HTMLElement>('.seo-fallback-main > p:not(:first-child)');
  if (status) {
    status.textContent = 'The interactive viewer could not be loaded. Check your connection and reload this page.';
  }
}

const DRAWER_ROUTE_TITLES: Record<DrawerKey, string> = {
  menu: 'Menu',
  'how-it-works': 'How It Works',
  faq: 'FAQ',
  privacy: 'Privacy',
  attribution: 'Attribution',
  roadmap: 'Roadmap',
  sponsor: 'Sponsors',
  about: 'About',
};

/**
 * Analytics titles stay in the lightweight shell so a page view is not held behind a page or model
 * chunk. Exhibit slugs are readable and stable; known drawer routes retain their exact labels.
 */
function routeTitle(route: Route): string {
  if (route.name === 'demo') return `Viewer — ${readableId(route.id) || route.id}`;
  if (route.name === 'workbench') return `Workbench — ${readableId(route.id) || route.id}`;
  if (route.name === 'drawer') return DRAWER_ROUTE_TITLES[route.key];
  return 'Workbench';
}

/**
 * Reports each browser navigation exactly once and immediately. Passing the location explicitly
 * also makes the event immune to a later hash change in the same task.
 */
function reportRouteView(route: Route): void {
  trackPageView(routeTitle(route), reportableLocation());
}

async function mountRoute(route: Route, generation: number): Promise<void> {
  if (generation !== routeGeneration) return;

  // `#/x/:id` and drawer routes are handled by the live workbench itself. Remounting would dispose
  // its viewer and rebuild the same surface just to reflect a hash it already observes.
  if (route.name !== 'demo' && mountedKind === 'workbench') return;

  cleanupCurrentRoute?.();
  cleanupCurrentRoute = null;
  mountedKind = null;
  renderRouteFallback(route);

  try {
    if (route.name === 'demo') {
      const { renderDemo } = await loadDemoPage();
      if (generation !== routeGeneration) return;
      const cleanup = await renderDemo(app, route.id, () => generation === routeGeneration);
      if (generation !== routeGeneration) {
        cleanup();
        return;
      }
      cleanupCurrentRoute = cleanup;
      mountedKind = 'demo';
    } else {
      const { renderWorkbench } = await loadWorkbenchPage();
      if (generation !== routeGeneration) return;
      const cleanup = renderWorkbench(app, {
        focusId: route.name === 'workbench' ? route.id : undefined,
        drawer: route.name === 'drawer' ? route.key : undefined,
      });
      if (generation !== routeGeneration) {
        cleanup();
        return;
      }
      cleanupCurrentRoute = cleanup;
      mountedKind = 'workbench';
    }
    app.removeAttribute('aria-busy');
  } catch (error) {
    if (generation !== routeGeneration) return;
    console.error('Failed to load route', error);
    renderRouteLoadError(route);
  }
}

const ROUTE_TRANSITION_MS = 200;

function render(route: Route): void {
  const generation = ++routeGeneration;

  // Every navigation invalidates an older delayed transition or import, including a return to the
  // workbench while a demo route is still waiting to mount.
  if (pendingTransition !== null) {
    window.clearTimeout(pendingTransition);
    pendingTransition = null;
  }
  app.classList.remove('route-leaving');

  if (firstRender) {
    firstRender = false;
    const shouldRunIntro = route.name === 'home' && !isCaptureRun() && hasPendingIntro();
    if (shouldRunIntro) document.body.classList.add('intro-active');

    // Start the route request and the intro timer independently. If the chunk is still loading when
    // the one-time intro releases, the meaningful HTML fallback is immediately visible underneath.
    void mountRoute(route, generation);
    if (shouldRunIntro) {
      runIntro(() => document.body.classList.remove('intro-active'));
    } else {
      // The URL can change between the parser-time bootstrap and this module executing. Never let a
      // stale pending state cover a deep-linked viewer or leave the document scroll-locked.
      dismissPendingIntro();
    }
    return;
  }

  // An in-place exhibit or drawer change must neither fade nor remount the live workbench. The
  // generation increment above still cancels a demo import that this navigation superseded.
  if (route.name !== 'demo' && mountedKind === 'workbench') return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || isCaptureRun()) {
    void mountRoute(route, generation);
    return;
  }

  app.classList.add('route-leaving');
  pendingTransition = window.setTimeout(() => {
    pendingTransition = null;
    if (generation !== routeGeneration) return;
    void mountRoute(route, generation);
    /**
     * `mountRoute` installs the fallback before its first await, so clearing this class in the same
     * task reveals real content while the route chunk loads. Visibility never depends on a later
     * animation frame landing under CPU pressure.
     */
    app.classList.remove('route-leaving');
  }, ROUTE_TRANSITION_MS);
}

/**
 * Before the first render, so an event fired during mount is queued on `dataLayer` rather than
 * dropped. Sends nothing on a capture run, an automated browser, a non-production host, or for a
 * visitor who has opted out — `analytics.ts` owns all four decisions.
 */
initAnalytics();

function handleRoute(route: Route): void {
  render(route);
  reportRouteView(route);
}

onRouteChange(handleRoute);
handleRoute(currentRoute());

/**
 * Page views follow the route rather than the mount. The workbench deliberately stays mounted
 * when it swaps exhibit or opens a drawer, and its own replaceState writes still fire no
 * `hashchange`; those in-place controls continue to report their page views from workbench.ts.
 */
