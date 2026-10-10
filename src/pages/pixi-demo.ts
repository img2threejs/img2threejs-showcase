import { getPixiDemo } from '../pixi/registry';
import { mountPixiShowcase } from '../pixi/showcase';
import { navigate } from '../router';
import '../pixi/showcase.css';

// In-flight loads and completed-host cleanup both own atlas leases. Serialize both.
let mountBarrier: Promise<void> = Promise.resolve();
let pendingDisposal: Promise<void> = Promise.resolve();

function buildRootShell(artboard: readonly [number, number]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'pixi-showcase';
  root.dataset.expanded = 'true';
  root.dataset.state = 'loading';
  root.innerHTML = `
    <a class="pixi-back-link" href="#/" aria-label="Back to Showcase">
      <span class="pixi-back-arrow" aria-hidden="true">&larr;</span>
      <span class="pixi-back-text">Back to Showcase</span>
    </a>
    <section class="pixi-stage" aria-label="2D artwork">
      <header class="pixi-stage-caption">
        <p class="pixi-eyebrow mono">PixiJS / 2D Showcase</p>
        <h1 id="pixi-artwork-title" class="pixi-title mono"></h1>
      </header>
      <div id="pixi-canvas-root" class="pixi-canvas-root"></div>
      <p id="pixi-status" class="pixi-status" role="status">Loading artwork…</p>
    </section>
    <aside class="pixi-panel" id="pixi-panel" aria-labelledby="pixi-panel-title">
      <div class="pixi-panel-bar">
        <span class="pixi-eyebrow mono">01 / Scene info</span>
        <button id="pixi-panel-toggle" class="pixi-panel-toggle" type="button"
                aria-controls="pixi-panel-body" aria-expanded="true"
                aria-label="Hide description and reference">
          <span id="pixi-panel-toggle-label">Hide</span>
          <span class="pixi-toggle-chevron" aria-hidden="true"></span>
        </button>
      </div>
      <div id="pixi-panel-body" class="pixi-panel-body">
        <header class="pixi-panel-heading">
          <h2 id="pixi-panel-title"></h2>
          <p class="pixi-scene-kind mono">2D illustration · PixiJS</p>
        </header>
        <section class="pixi-panel-section" aria-labelledby="pixi-description-title">
          <h3 id="pixi-description-title" class="pixi-eyebrow mono">Description</h3>
          <p id="pixi-artwork-description" class="pixi-description"></p>
        </section>
        <section class="pixi-panel-section" aria-labelledby="pixi-reference-title">
          <h3 id="pixi-reference-title" class="pixi-eyebrow mono">Source reference</h3>
          <figure class="pixi-reference">
            <img id="pixi-reference-image" class="pixi-reference-image"
                 width="${artboard[0]}" height="${artboard[1]}" alt="" decoding="async" />
            <figcaption id="pixi-reference-caption" class="pixi-reference-caption mono"></figcaption>
          </figure>
        </section>
      </div>
    </aside>`;
  return root;
}


export async function renderPixiDemo(
  mount: HTMLElement,
  id: string,
  isCurrent: () => boolean = () => true,
): Promise<() => void> {
  const previousMount = mountBarrier;
  let releaseMount!: () => void;
  mountBarrier = new Promise<void>(resolve => { releaseMount = resolve; });
  try {
    await previousMount;
    // Read the latest disposal AFTER the previous load finishes: it may have been superseded.
    await pendingDisposal;
    if (!isCurrent()) return () => {};
    const metadata = getPixiDemo(id);
    if (!metadata) {
      navigate('#/');
      return () => {};
    }

    const root = buildRootShell(metadata.artboard);
    mount.replaceChildren(root);
    mount.setAttribute('aria-busy', 'true');
    let disposed = false;
    let disposeArtwork: (() => Promise<void>) | undefined;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      if (root.parentElement === mount) {
        mount.removeAttribute('aria-busy');
        root.remove();
      }
      if (disposeArtwork) {
        pendingDisposal = disposeArtwork();
        void pendingDisposal.catch(console.error);
      }
    };
    try {
      disposeArtwork = await mountPixiShowcase(root, metadata, isCurrent);
      if (!isCurrent()) {
        dispose();
        await pendingDisposal;
      } else if (root.parentElement === mount) {
        mount.removeAttribute('aria-busy');
      }
      return dispose;
    } catch (error) {
      dispose();
      await pendingDisposal;
      throw error;
    }
  } finally {
    releaseMount();
  }
}
