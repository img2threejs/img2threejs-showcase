const SEEN_KEY = 'img2threejs:intro-seen';

declare global {
  interface Window {
    __IMG2THREEJS_INTRO_STARTED_AT__?: number;
    __IMG2THREEJS_INTRO_FAILSAFE__?: number;
  }
}

function safeSessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — the intro just replays next time, which is harmless */
  }
}

export function hasPendingIntro(): boolean {
  return document.documentElement.dataset.intro === 'pending';
}

/**
 * Measured: the hero's own staged entrance (`.home.ready .hero-copy > *`, 0.7s plus delays to
 * 0.41s) has fully settled by ~1.05s. Holding the overlay to 2s meant the fade revealed content
 * that had already finished animating, so the handoff looked static. Ending just as the last hero
 * element lands puts the two animations back in sequence.
 */
const RUN_DURATION_MS = 1250;
const FADE_DURATION_MS = 480;

/**
 * One-time full-viewport brand intro, built from the img2threejs mark itself: the same three
 * "source pixel" swatches and isometric cube as `favicon.svg`, animated through the pipeline's
 * own idea — reference image dissolving into a procedural 3D form — rather than a generic splash.
 *
 * The overlay itself lives in index.html so it can be the first painted surface even while the
 * application bundle is still loading. This function owns only the timed handoff to the mounted UI.
 */
export function runIntro(onDone: () => void): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    safeSessionSet(SEEN_KEY, '1');
    dismissPendingIntro();
    onDone();
    return;
  }

  const overlay = document.getElementById('intro-overlay');
  if (!overlay) {
    dismissPendingIntro();
    onDone();
    return;
  }

  const startedAt = window.__IMG2THREEJS_INTRO_STARTED_AT__ ?? performance.now();
  const remaining = Math.max(0, RUN_DURATION_MS - (performance.now() - startedAt));

  window.setTimeout(() => {
    document.documentElement.classList.add('intro-releasing');
    overlay.classList.add('intro-fade');
    window.setTimeout(() => {
      overlay.remove();
      dismissPendingIntro();
      onDone();
    }, FADE_DURATION_MS);
  }, remaining);

  safeSessionSet(SEEN_KEY, '1');
}

export function dismissPendingIntro(): void {
  if (window.__IMG2THREEJS_INTRO_FAILSAFE__ !== undefined) {
    window.clearTimeout(window.__IMG2THREEJS_INTRO_FAILSAFE__);
    delete window.__IMG2THREEJS_INTRO_FAILSAFE__;
  }
  document.documentElement.classList.remove('intro-releasing');
  delete document.documentElement.dataset.intro;
  delete window.__IMG2THREEJS_INTRO_STARTED_AT__;
}
