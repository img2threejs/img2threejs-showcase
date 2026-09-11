/**
 * Three routes, and the split between them is deliberate:
 *
 * - `home`      → the workbench (`#/`), the landing experience.
 * - `workbench` → the workbench focused on one exhibit (`#/x/:id`), so an exhibit is shareable
 *                 without leaving the workbench.
 * - `demo`      → the dedicated full-screen inspector (`#/demo/:id`). The headless review
 *                 harness (`scripts/capture-*.mjs`) loads this route and reads the
 *                 `__IMG2THREEJS_VIEWER__` / `__IMG2THREEJS_RUNTIME__` / `__IMG2THREEJS_PARTS__`
 *                 globals that `pages/demo.ts` publishes, and README links point here. Routing it
 *                 anywhere else would silently break the capture gate, so it keeps its own page.
 */
/**
 * The content pages are routes, not just drawer state, because people link to them: a privacy or
 * attribution notice that cannot be pointed at is not much of a notice. They render as the
 * workbench's own drawer so there is no second layout to maintain.
 */
export const DRAWER_ROUTES = ['how-it-works', 'faq', 'privacy', 'attribution', 'roadmap', 'sponsor', 'about', 'menu'] as const;
export type DrawerKey = (typeof DRAWER_ROUTES)[number];

export type Route =
  | { name: 'home' }
  | { name: 'workbench'; id: string }
  | { name: 'drawer'; key: DrawerKey }
  | { name: 'demo'; id: string };

/** Parses `location.hash` into a Route. Defaults to home for anything unrecognized. */
export function parseRoute(hash: string): Route {
  // Query flags (`?capture=1`, `?back=1`) can ride on the hash; they are not path segments.
  const clean = hash.replace(/^#\/?/, '').split('?')[0];
  if (!clean || clean === '') {
    return { name: 'home' };
  }
  const parts = clean.split('/').filter(Boolean);
  if (parts[0] === 'demo' && parts[1]) {
    return { name: 'demo', id: parts[1] };
  }
  if (parts[0] === 'x' && parts[1]) {
    return { name: 'workbench', id: parts[1] };
  }
  if (parts.length === 1 && (DRAWER_ROUTES as readonly string[]).includes(parts[0])) {
    return { name: 'drawer', key: parts[0] as DrawerKey };
  }
  return { name: 'home' };
}

export function currentRoute(): Route {
  return parseRoute(window.location.hash);
}

export function onRouteChange(handler: (route: Route) => void): () => void {
  const listener = (): void => handler(currentRoute());
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

/**
 * Rewrites the hash WITHOUT adding a history entry and without firing the route handler's
 * remount path. The workbench swaps models in place, so the URL has to follow the selected
 * exhibit while the page stays exactly where it is — a `location.hash =` assignment would
 * trigger `hashchange` and tear the whole workbench down to rebuild it identically.
 */
export function replaceHashSilently(hash: string): void {
  if (window.location.hash === hash) return;
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  window.history.replaceState(null, '', url);
}
