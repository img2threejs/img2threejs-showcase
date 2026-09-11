import * as THREE from 'three';
import { getDemo, loadDemo } from '../demos/registry';
import { Viewer, type PartInfo } from '../scene';
import { navigate } from '../router';
import { brand, extractVersion, escapeAttr, GITHUB_CORE as GITHUB_URL } from '../site-data';
import { createLoader, whenViewerReady } from '../loader';
import {
  EXPORT_FORMATS,
  exportAllFormatsZip,
  exportModel,
  exportModelsFor,
  saveBlob,
  type ExportFormat,
  type ExportModelScope,
  type ExportReport,
} from '../exporters';
import {
  resetExhibitOnceKeys,
  trackAnimationPlay,
  trackAnimationStop,
  trackExhibitPrewarmFailed,
  trackExhibitReady,
  trackExhibitView,
  trackExplode,
  trackLinkClick,
  trackPartIsolate,
  trackPartSelect,
  trackQualitySwitch,
  trackSourceClick,
  trackViewerInteract,
} from '../analytics';

/** Viewports where the info panel becomes a collapsible bottom sheet over the model. */
const COMPACT_QUERY = '(max-width: 960px), (max-height: 520px)';

/**
 * Whether the details sheet is expanded, remembered across demo navigations within a session.
 * `null` = untouched, so each viewport gets its own sensible default (open on desktop, collapsed
 * on a phone, where an open panel would cover the model entirely).
 */
let panelExpanded: boolean | null = null;


/**
 * Loads one selected runtime, then renders the full-viewport demo viewer + info panel for `id`.
 * Resolves to a cleanup function the router must call before switching routes.
 * If `id` is unknown, redirects to home and returns a no-op cleanup.
 */
export async function renderDemo(
  mount: HTMLElement,
  id: string,
  isCurrent: () => boolean = () => true,
): Promise<() => void> {
  const metadata = getDemo(id);
  if (!metadata) {
    navigate('#/');
    return () => {};
  }

  const startedAt = performance.now();
  // Count the chosen exhibit before its model chunk arrives; a failed or abandoned download is
  // still a real visit and must remain visible in the exhibit-view to exhibit-ready funnel.
  resetExhibitOnceKeys(metadata.id);
  trackExhibitView(metadata, 'deeplink', 'viewer');

  const demo = await loadDemo(id);
  // A hash change can supersede this import while the network is in flight. Do not let that stale
  // route replace the newer route's DOM or create a Viewer after its generation was invalidated.
  if (!demo || !isCurrent()) return () => {};

  let disposed = false;
  let signalDisposed!: () => void;
  const disposedSignal = new Promise<void>((resolve) => {
    signalDisposed = resolve;
  });
  const routeIsActive = (): boolean => !disposed && isCurrent();

  const compact = window.matchMedia(COMPACT_QUERY);
  const expanded = panelExpanded ?? !compact.matches;
  /**
   * Always 'deeplink': `#/demo/<id>` owns a separate viewer page, whether it is reached from a
   * shared link, a README link, an archive card or the landing page's primary viewer CTA. In-place
   * workbench swaps report their own entry source before this route is involved.
   *
   * Unguarded by `capture`, because it does not need to be: a capture run is a headless browser on
   * localhost, and `analytics.ts` refuses to send for either of those reasons on its own.
   */
  // Read structurally, like `toneMapping`, so this file stays independent of the fields being declared
  // on DemoEntry. `image` is the default because every demo predating the field was built from
  // photographs -- the honest default rather than the flattering one.
  const refKind = (demo as { referenceKind?: 'image' | 'model' }).referenceKind ?? 'image';
  const turntable = (demo as { turntable?: boolean }).turntable ?? false;
  // The version gets a badge of its own; the rest of `generatedWith` -- adapter names, pipeline notes --
  // moves to its tooltip. It is a sentence, and a sentence in a pill is not a badge.
  const version = extractVersion(demo.generatedWith);

  mount.innerHTML = `
    <div class="demo-page" data-inspector-open="${expanded}">
      <div class="demo-canvas-mount" id="demo-canvas-mount"></div>
      <a class="back-link" href="#/" aria-label="Back to Showcase">
        <span class="back-arrow" aria-hidden="true">&larr;</span>
        <span class="back-text">Back to Showcase</span>
      </a>
      <div class="demo-stage-label" aria-hidden="true">
        <span>Procedural Scene</span>
        <strong>${demo.id}</strong>
      </div>
      <div class="demo-stage-axis" aria-hidden="true">
        <span class="axis-x">X</span><span class="axis-y">Y</span><span class="axis-z">Z</span>
      </div>
      <section class="demo-panel" id="demo-panel" data-expanded="${expanded}" aria-label="Model Inspector">
        <div class="demo-panel-bar">
          <span class="demo-panel-mark mono" aria-hidden="true">I / 3</span>
          <span class="demo-bar-title">Model Inspector</span>
          <span class="demo-panel-mode mono"><i aria-hidden="true"></i> Live Inspector</span>
          <button class="panel-toggle" type="button" id="panel-toggle"
                  aria-controls="demo-panel-body" aria-expanded="${expanded}"
                  aria-label="${expanded ? 'Close' : 'Open'} Model Inspector">
            <span class="panel-toggle-label">${expanded ? 'Hide' : 'Inspect'}</span>
            <span class="panel-toggle-chevron" aria-hidden="true"></span>
          </button>
        </div>
        <div class="demo-panel-body" id="demo-panel-body" aria-hidden="${!expanded}"${expanded ? '' : ' inert'}>
          <div class="demo-panel-inner">
            <header class="demo-panel-head">
              <div class="demo-head-line">
                <span class="demo-kicker">${brand('img2threejs')} / Live Model</span>
                <span class="demo-model-type mono">${demo.subjectClass}</span>
              </div>
              <h2>${demo.title}</h2>
              <p class="demo-author">Created By
                <a href="${demo.authorUrl}" target="_blank" rel="noopener noreferrer">${demo.author}</a>
              </p>
            </header>
            <div class="demo-inspector-shell">
              <nav class="demo-inspector-tabs" aria-label="Inspector Sections" role="tablist">
                <button class="demo-inspector-tab is-active" id="demo-tab-details" type="button"
                        data-inspector-tab="details" role="tab" aria-selected="true"
                        aria-controls="demo-pane-details">
                  <span class="demo-tab-index mono" aria-hidden="true">01</span>
                  <span>Overview</span>
                </button>
                <button class="demo-inspector-tab" id="demo-tab-animation" type="button"
                        data-inspector-tab="animation" role="tab" aria-selected="false"
                        aria-controls="demo-pane-animation" aria-disabled="true" disabled>
                  <span class="demo-tab-index mono" aria-hidden="true">02</span>
                  <span>Motion</span>
                </button>
                <button class="demo-inspector-tab" id="demo-tab-parts" type="button"
                        data-inspector-tab="parts" role="tab" aria-selected="false"
                        aria-controls="demo-pane-parts" aria-disabled="true" disabled>
                  <span class="demo-tab-index mono" aria-hidden="true">03</span>
                  <span>Parts</span>
                </button>
                <button class="demo-inspector-tab" id="demo-tab-export" type="button"
                        data-inspector-tab="export" role="tab" aria-selected="false"
                        aria-controls="demo-pane-export">
                  <span class="demo-tab-index mono" aria-hidden="true">04</span>
                  <span>Export</span>
                </button>
              </nav>
              <div class="demo-inspector-panes">
                <section class="demo-inspector-pane is-active" id="demo-pane-details"
                         data-inspector-pane="details" role="tabpanel" aria-labelledby="demo-tab-details">
                  <div class="demo-pane-intro">
                    <span class="mono">Scene Overview</span>
                    <p>Inspect The Source, Build Profile, And Provenance.</p>
                  </div>
                  <div class="demo-overview">
                    <figure class="demo-ref">
                      <img class="demo-ref-thumb" src="${demo.referenceImage}" alt="${demo.title} reference" />
                      <figcaption>${refKind === 'model' ? 'Reference Model' : 'Source Reference'}</figcaption>
                    </figure>
                    <div class="demo-meta">
                      <span class="parts-title">Model Profile</span>
                      <div class="badges">
                        <span class="badge badge-ref badge-ref-${refKind}" title="${refKind === 'model'
                          ? 'Rebuilt from a 3D asset: geometry is measured, so triangle counts and cross-sections are read off the reference.'
                          : 'Rebuilt from images: depth and every hidden face are inferred, not measured.'}">${refKind} reference</span>
                        <span class="badge badge-${demo.subjectClass}">${demo.subjectClass}</span>
                        ${version ? `<span class="badge badge-version"
                          title="${escapeAttr(demo.generatedWith)}">${version}</span>` : ''}
                        <span class="badge badge-status status-${demo.status}">${demo.status}</span>
                      </div>
                    </div>
                  </div>
                  <section class="demo-description" aria-labelledby="demo-description-title">
                    <span class="parts-title" id="demo-description-title">Build Notes</span>
                    <p>${demo.blurb}</p>
                  </section>
                  <div class="demo-links demo-source-links">
                    <a class="btn" href="${demo.sourceUrl}" target="_blank" rel="noopener noreferrer"
                       data-track-skip>
                      &lt;/&gt; View Generated Source
                    </a>
                    ${demo.referenceUrl ? `<a class="btn btn-ref-link" href="${demo.referenceUrl}"
                      target="_blank" rel="noopener noreferrer">
                      <span class="ref-glyph">&#9670;</span> Generated by Hyper3D
                    </a>` : ''}
                    ${demo.tripoUrl ? `
                    <a class="btn" href="${demo.tripoUrl}" target="_blank" rel="noopener noreferrer">
                      &#9670; Generated by Tripo
                    </a>` : ''}
                    ${demo.artstationUrl ? `
                    <a class="btn" href="${demo.artstationUrl}" target="_blank" rel="noopener noreferrer">
                      &#9650; View on ArtStation
                    </a>` : ''}
                    <a class="btn btn-star" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">
                      &#9733; Star ${brand('img2threejs')} on GitHub
                    </a>
                  </div>
                </section>
                <section class="demo-inspector-pane" id="demo-pane-animation"
                         data-inspector-pane="animation" role="tabpanel" aria-labelledby="demo-tab-animation" hidden>
                  <div class="demo-pane-intro">
                    <span class="mono">Performance Controls</span>
                    <p>Preview Motion, Effects, And Scene Behavior In Real Time.</p>
                  </div>
                  <section class="demo-animations demo-motion" id="demo-animations" hidden aria-labelledby="demo-animations-title">
                    <div class="demo-animations-head">
                      <div>
                        <span class="parts-title" id="demo-animations-title">Motion Library</span>
                        <span class="demo-animations-note">Choose a Clip · ↻ Loop · ▶ Once</span>
                      </div>
                      <output class="demo-animation-status" id="demo-animation-status" data-state="idle">Ready</output>
                    </div>
                    <div class="demo-animation-buttons" id="demo-animation-buttons"></div>
                    <div class="demo-animation-footer" id="demo-animation-footer"></div>
                  </section>
                  <section class="demo-animations" id="demo-vfx" hidden aria-labelledby="demo-vfx-title">
                    <div class="demo-animations-head">
                      <span class="parts-title" id="demo-vfx-title">Strike Element</span>
                      <output class="demo-animation-status" id="demo-vfx-status"></output>
                    </div>
                    <div class="demo-animation-buttons" id="demo-vfx-buttons"></div>
                  </section>
                  <section class="demo-animations" id="demo-detail" hidden aria-labelledby="demo-detail-title">
                    <div class="demo-animations-head">
                      <span class="parts-title" id="demo-detail-title">Quality</span>
                      <output class="demo-animation-status" id="demo-detail-status"></output>
                    </div>
                    <div class="demo-animation-buttons" id="demo-detail-buttons"></div>
                  </section>
                  <div class="demo-links demo-model-controls">
                    <button class="btn btn-explode" id="demo-explode" type="button" aria-pressed="false" hidden>
                      <span class="explode-glyph">&#10021;</span> <span class="explode-label">Explode Parts</span>
                    </button>
                    <button class="btn btn-spin" id="demo-spin" type="button" aria-pressed="false" hidden>
                      <span class="explode-glyph">&#8635;</span> <span class="spin-label">Stop Turntable</span>
                    </button>
                  </div>
                </section>
                <section class="demo-inspector-pane" id="demo-pane-parts"
                         data-inspector-pane="parts" role="tabpanel" aria-labelledby="demo-tab-parts" hidden>
                  <div class="demo-pane-intro">
                    <span class="mono">Assembly Inspector</span>
                    <p>Select A Mesh In The Scene Or Browse The Model Structure.</p>
                  </div>
                  <section class="demo-parts" id="demo-parts" hidden>
                    <div class="parts-head">
                      <span class="parts-title">Model Parts</span>
                      <span class="parts-count" id="parts-count"></span>
                    </div>
                    <div class="part-card" id="part-card" hidden></div>
                    <div class="parts-scroll"><ul class="parts-list" id="parts-list"></ul></div>
                    <p class="parts-prov" id="parts-prov" hidden></p>
                  </section>
                </section>
                <section class="demo-inspector-pane" id="demo-pane-export"
                         data-inspector-pane="export" role="tabpanel" aria-labelledby="demo-tab-export" hidden>
                  <div class="demo-pane-intro">
                    <span class="mono">Production Export</span>
                    <p>Validate The Current Scene And Download A Portable 3D Asset.</p>
                  </div>
                  <section class="demo-export" id="demo-export" aria-labelledby="demo-export-title">
                    <div class="demo-export-head">
                      <div>
                        <span class="parts-title" id="demo-export-title">Export a 3D Asset</span>
                        <span class="demo-export-subtitle">From Stage</span>
                      </div>
                      <output class="demo-export-status" id="demo-export-status" data-state="ready">Ready</output>
                    </div>
                    <div class="demo-export-scope" id="demo-export-scope" hidden>
                      <label for="demo-export-scope-select">Export scope</label>
                      <select id="demo-export-scope-select" aria-describedby="demo-export-scope-note"></select>
                      <p id="demo-export-scope-note">Choose the complete assembly or one independently declared model.</p>
                    </div>
                    <div class="demo-export-formats" id="demo-export-formats">
                      ${EXPORT_FORMATS.map(({ format, label, note, keeps, limits }) => `
                        <div class="demo-export-format-row" data-export-row="${format}">
                          <button class="demo-export-format" type="button" data-export-format="${format}">
                            <span class="demo-export-label">${label}</span>
                            <span class="demo-export-note">${note}</span>
                            <span class="demo-export-arrow" aria-hidden="true">&darr;</span>
                          </button>
                          <button class="demo-export-info" type="button" data-export-info="${format}"
                                  aria-label="What ${label} export includes"
                                  aria-describedby="demo-export-tooltip-${format}" aria-expanded="false">i</button>
                          <div class="demo-export-tooltip" id="demo-export-tooltip-${format}" role="tooltip">
                            <strong>${label} portability</strong>
                            <p><span>Keeps</span>${keeps}</p>
                            <p><span>Limits</span>${limits}</p>
                          </div>
                        </div>
                      `).join('')}
                    </div>
                    <button class="demo-export-all" id="demo-export-all" type="button">
                      <span>
                        <strong>Export all formats</strong>
                        <small>Current scope · 6 validated assets + manifest</small>
                      </span>
                      <span class="demo-export-zip" aria-hidden="true">.ZIP &darr;</span>
                    </button>
                    <div class="demo-export-report" id="demo-export-report" hidden>
                      <p id="demo-export-summary"></p>
                      <ul id="demo-export-warnings"></ul>
                    </div>
                  </section>
                </section>
              </div>
            </div>
          </div>
        </div>
      </section>
      <div class="hint" id="demo-hint">
        <span class="hint-state"><i aria-hidden="true"></i> Interactive</span>
        <span class="hint-divider" aria-hidden="true"></span>
        <span class="hint-pointer">Drag To Orbit &middot; Scroll To Zoom &middot; Select A Part</span>
        <span class="hint-touch">Drag To Orbit &middot; Pinch To Zoom &middot; Tap A Part</span>
      </div>
    </div>
  `;

  // Per-demo theming: tint the panel accent to the object's signature colour.
  if (demo.accent) {
    const page = mount.querySelector<HTMLElement>('.demo-page');
    page?.style.setProperty('--accent', demo.accent);
    page?.style.setProperty('--accent-strong', demo.accent);
    page?.classList.add('demo-themed');
  }

  // Headless-evaluation capture mode: `#/demo/<id>?capture=1` renders on a flat white studio
  // background with a frozen camera for the Divine Eye reference loop. Default off (normal viewing).
  const capture = /[?&]capture=1\b/.test(window.location.hash) ||
    new URLSearchParams(window.location.search).get('capture') === '1';
  const backCapture = new URLSearchParams(window.location.search).get('back') === '1';

  // The inspector reveals one concern at a time. Runtime-dependent tabs stay disabled until their
  // capability exists, so an exhibit never opens into an empty panel while a lazy asset is loading.
  type InspectorSection = 'details' | 'animation' | 'parts' | 'export';
  const inspectorTabs = [...mount.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]')];
  const inspectorPanes = [...mount.querySelectorAll<HTMLElement>('[data-inspector-pane]')];
  const inspectorCleanups: Array<() => void> = [];
  let inspectorTouched = false;
  let activeInspectorSection: InspectorSection = 'details';
  const setInspectorSection = (section: InspectorSection, userInitiated = false): void => {
    const nextTab = inspectorTabs.find((tab) => tab.dataset.inspectorTab === section);
    if (!nextTab || nextTab.disabled) return;
    activeInspectorSection = section;
    if (userInitiated) inspectorTouched = true;
    for (const tab of inspectorTabs) {
      const selected = tab === nextTab;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const pane of inspectorPanes) {
      const selected = pane.dataset.inspectorPane === section;
      pane.hidden = !selected;
      pane.classList.toggle('is-active', selected);
    }
  };
  const enableInspectorSection = (section: InspectorSection, prefer = false): void => {
    const tab = inspectorTabs.find((candidate) => candidate.dataset.inspectorTab === section);
    if (!tab) return;
    tab.disabled = false;
    tab.removeAttribute('aria-disabled');
    if (prefer && !inspectorTouched && activeInspectorSection === 'details') {
      setInspectorSection(section);
    }
  };
  for (const tab of inspectorTabs) {
    const onClick = (): void => setInspectorSection(
      tab.dataset.inspectorTab as InspectorSection,
      true,
    );
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const enabledTabs = inspectorTabs.filter((candidate) => !candidate.disabled);
      const currentIndex = Math.max(0, enabledTabs.indexOf(tab));
      let nextIndex = currentIndex;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = enabledTabs.length - 1;
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
      } else {
        nextIndex = (currentIndex + 1) % enabledTabs.length;
      }
      const nextTab = enabledTabs[nextIndex];
      nextTab?.focus();
      if (nextTab) setInspectorSection(nextTab.dataset.inspectorTab as InspectorSection, true);
    };
    tab.addEventListener('click', onClick);
    tab.addEventListener('keydown', onKeyDown);
    inspectorCleanups.push(() => {
      tab.removeEventListener('click', onClick);
      tab.removeEventListener('keydown', onKeyDown);
    });
  }
  setInspectorSection('details');

  const cameraPosition: [number, number, number] = backCapture
    ? [-demo.cameraPosition[0], demo.cameraPosition[1], -demo.cameraPosition[2]]
    : demo.cameraPosition;

  // Per-demo tone-mapping (optional on the entry; read structurally so demo.ts is independent of
  // the DemoEntry field being declared). AgX preserves the Ruby-Doppler crimson that ACES washes.
  const toneMapping = (demo as { toneMapping?: 'aces' | 'agx' | 'neutral' }).toneMapping;

  const canvasMount = mount.querySelector<HTMLDivElement>('#demo-canvas-mount')!;

  /**
   * Branded build loader. Mounted BEFORE the Viewer so it is on screen for the whole build, and
   * never during a capture run — the review harness screenshots this route as soon as the model
   * reports ready, and an overlay would land in the evaluation frame.
   *
   * It is dismissed on the viewer's first-good-frame signal, and for the two `prewarm` demos only
   * after that promise settles too: their geometry arrives after `build()` returns, so releasing on
   * the ready flag alone would uncover an empty scene.
   */
  const loader = capture
    ? null
    : createLoader(canvasMount, demo.prewarm ? 'Precomputing field' : 'Building geometry');

  const viewer = new Viewer(canvasMount, {
    cameraPosition,
    cameraTarget: demo.cameraTarget,
    cameraFov: demo.cameraFov,
    backgroundGradient: demo.backgroundGradient,
    exposure: demo.exposure,
    environmentIntensity: demo.environmentIntensity,
    installLights: demo.installLights,
    toneMapping,
    capture,
    turntable,
  });

  const model = demo.build(viewer.scene);
  let prewarmFailureTracked = false;
  let prewarmSettled = false;
  const detachDisposedModel = (): void => {
    // Wait for BOTH events. If cleanup wins, the factory may still attach children later; if
    // prewarm wins, the outgoing viewer may still be drawing during the route transition.
    if (disposed && prewarmSettled) model.removeFromParent();
  };
  /**
   * One invocation and one settlement path per rendered demo. Consumers share `prewarmCurrent`
   * instead of calling the cached demo function independently. The final continuation also gives a
   * stale render one place to detach geometry that arrived after its Viewer was disposed.
   */
  const prewarmSettlement: Promise<void> = demo.prewarm
    ? demo.prewarm().catch(() => {
        if (routeIsActive() && !prewarmFailureTracked) {
          prewarmFailureTracked = true;
          trackExhibitPrewarmFailed(demo.id, 'viewer');
        }
      })
    : Promise.resolve();
  const prewarmCurrent: Promise<boolean> = prewarmSettlement.then(() => {
    prewarmSettled = true;
    if (routeIsActive()) return true;
    // A factory can cache materials, textures or other resources across builds. Detach only this
    // render's root after its own bind callback has run; disposing here could poison a newer render
    // of the same demo that shares those module-owned resources.
    detachDisposedModel();
    return false;
  });
  type AnimationController = {
    actions: ReadonlyArray<{ id: string; label: string; loop: boolean }>;
    readonly active: string;
    play: (name: string) => void;
    stop: () => void;
    subscribe: (listener: (active: string) => void) => () => void;
  };
  const animationController = (
    model.userData.sculptRuntime as { animationController?: AnimationController } | undefined
  )?.animationController;
  const animationSection = mount.querySelector<HTMLElement>('#demo-animations');
  const animationButtons = mount.querySelector<HTMLElement>('#demo-animation-buttons');
  const animationFooter = mount.querySelector<HTMLElement>('#demo-animation-footer');
  const animationStatus = mount.querySelector<HTMLOutputElement>('#demo-animation-status');
  const animationButtonCleanups: Array<() => void> = [];
  let unsubscribeAnimation: (() => void) | undefined;
  let mountedAnimationController: AnimationController | undefined;
  /**
   * Mounted as a function, not inline, because a demo whose geometry arrives through `prewarm` has no
   * animation runtime yet when `build()` returns -- its rig ships inside the lazily imported payload,
   * so the inline form left those demos with no panel at all. Demos that expose a controller
   * synchronously take exactly the same path as before.
   */
  const mountAnimationPanel = (controller: AnimationController | undefined): void => {
    if (!controller || controller === mountedAnimationController) return;
    if (!animationSection || !animationButtons || capture) return;
    mountedAnimationController = controller;
    animationSection.hidden = false;
    enableInspectorSection('animation', true);
    const buttons = new Map<string, HTMLButtonElement>();
    for (const [actionIndex, action] of controller.actions.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn demo-animation-btn demo-animation-action';
      button.dataset.animation = action.id;
      button.dataset.playback = action.loop ? 'loop' : 'once';
      button.setAttribute('aria-pressed', 'false');
      const behavior = action.loop ? 'Loops Until Stopped' : 'Plays Once';
      button.title = `${action.label} · ${behavior}`;
      const indexLabel = document.createElement('span');
      indexLabel.className = 'demo-animation-index mono';
      indexLabel.textContent = String(actionIndex + 1).padStart(2, '0');
      const actionLabel = document.createElement('span');
      actionLabel.className = 'demo-animation-label';
      actionLabel.textContent = action.label;
      const playGlyph = document.createElement('span');
      playGlyph.className = 'demo-animation-play';
      playGlyph.textContent = action.loop ? '↻' : '▶';
      button.append(indexLabel, actionLabel, playGlyph);
      const onClick = (): void => {
        controller.play(action.id);
        trackAnimationPlay(demo.id, action, 'viewer');
      };
      button.addEventListener('click', onClick);
      animationButtonCleanups.push(() => button.removeEventListener('click', onClick));
      animationButtons.appendChild(button);
      buttons.set(action.id, button);
    }
    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'btn demo-animation-btn demo-animation-stop';
    stopButton.dataset.animation = 'stop';
    stopButton.innerHTML = '<span aria-hidden="true">■</span><span>Stop and Return to Idle</span>';
    const onStop = (): void => {
      controller.stop();
      trackAnimationStop(demo.id, 'viewer');
    };
    stopButton.addEventListener('click', onStop);
    animationButtonCleanups.push(() => stopButton.removeEventListener('click', onStop));
    (animationFooter ?? animationButtons).appendChild(stopButton);
    // Autoplay before subscribing is safe either way: `subscribe` replays the active id immediately,
    // so the highlighted button and the status text agree with whatever is already running.
    if (demo.defaultAnimation && !capture) {
      const wanted = controller.actions.find((action) => action.id === demo.defaultAnimation);
      if (wanted) controller.play(wanted.id);
    }
    unsubscribeAnimation = controller.subscribe((active) => {
      if (animationStatus) {
        const activeLabel = controller.actions.find((action) => action.id === active)?.label;
        animationStatus.value = active === 'idle'
          ? 'Idle'
          : `Playing · ${activeLabel ?? active.charAt(0).toUpperCase() + active.slice(1)}`;
        animationStatus.dataset.state = active === 'idle' ? 'idle' : 'playing';
      }
      for (const [id, button] of buttons) {
        const selected = id === active;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
      }
    });
  };
  mountAnimationPanel(animationController);

  /**
   * Strike-element selector, for a runtime that offers one. Mounted the same way and for the same
   * reason as the animation panel: the runtime arrives with the lazily imported payload.
   */
  type VfxRuntime = {
    elements: ReadonlyArray<{ id: string; label: string }>;
    current: string;
    setElement(id: string): void;
  };
  let vfxMounted = false;
  const mountVfxPanel = (): void => {
    if (vfxMounted || capture) return;
    const runtime = (model.userData.sculptRuntime as { strikeVfx?: VfxRuntime } | undefined)?.strikeVfx;
    const section = mount.querySelector<HTMLElement>('#demo-vfx');
    const host = mount.querySelector<HTMLElement>('#demo-vfx-buttons');
    const status = mount.querySelector<HTMLOutputElement>('#demo-vfx-status');
    if (!runtime?.elements?.length || !section || !host) return;
    vfxMounted = true;
    section.hidden = false;
    enableInspectorSection('animation', true);
    const buttons = new Map<string, HTMLButtonElement>();
    const select = (id: string): void => {
      runtime.setElement(id);
      for (const [key, button] of buttons) {
        const on = key === id;
        button.classList.toggle('is-active', on);
        button.setAttribute('aria-pressed', String(on));
      }
      if (status) status.value = buttons.get(id)?.textContent ?? id;
    };
    for (const entry of runtime.elements) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn demo-animation-btn';
      button.dataset.vfxElement = entry.id;
      button.textContent = entry.label;
      const onClick = (): void => select(entry.id);
      button.addEventListener('click', onClick);
      animationButtonCleanups.push(() => button.removeEventListener('click', onClick));
      host.appendChild(button);
      buttons.set(entry.id, button);
    }
    select(runtime.current);
  };
  mountVfxPanel();

  /**
   * Detail levels, for demos that ship more than one build of the same surfaces.
   *
   * Switching RELOADS rather than swapping in place. The geometry arrives through `prewarm`, the
   * animation rig is bound to it, and the parts list and explode offsets are derived from it -- so a
   * live swap would have to tear down and rebuild four dependent structures in the right order. A
   * reload rebuilds them all through the path that is already tested, and the level is a query
   * parameter the demo already reads.
   */
  type DetailLevels = {
    current: string;
    options: ReadonlyArray<{ id: string; label: string; note: string }>;
  };
  const detail = (model.userData.sculptRuntime as { detailLevels?: DetailLevels } | undefined)
    ?.detailLevels;
  const detailSection = mount.querySelector<HTMLElement>('#demo-detail');
  const detailButtons = mount.querySelector<HTMLElement>('#demo-detail-buttons');
  if (detail && detailSection && detailButtons && !capture) {
    detailSection.hidden = false;
    enableInspectorSection('animation', true);
    const status = mount.querySelector<HTMLOutputElement>('#demo-detail-status');
    for (const option of detail.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn demo-animation-btn';
      button.textContent = option.label;
      button.title = option.note;
      const selected = option.id === detail.current;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
      if (selected && status) status.value = option.note;
      button.addEventListener('click', () => {
        // Sent before the navigation: switching detail level reloads the page, so an event queued
        // after `location.href` is assigned may never leave the browser.
        trackQualitySwitch(demo.id, option.id);
        const url = new URL(window.location.href);
        url.searchParams.delete('lod');
        url.searchParams.delete('sdf');
        url.searchParams.set('quality', option.id);
        window.location.href = url.toString();
      });
      detailButtons.appendChild(button);
    }
  }

  viewer.setExplodeRoot(model);

  // --- validated asset export -----------------------------------------------------------
  // Every format goes through one serializer and one validation path. The test hook returns only
  // the JSON report (never the potentially huge Blob), so browser QA can exercise the exact same
  // operation as a visitor without intercepting or retaining downloads.
  const exportButtons = [...mount.querySelectorAll<HTMLButtonElement>('[data-export-format]')];
  const exportStatus = mount.querySelector<HTMLOutputElement>('#demo-export-status');
  const exportReport = mount.querySelector<HTMLElement>('#demo-export-report');
  const exportSummary = mount.querySelector<HTMLElement>('#demo-export-summary');
  const exportWarnings = mount.querySelector<HTMLUListElement>('#demo-export-warnings');
  const exportScope = mount.querySelector<HTMLElement>('#demo-export-scope');
  const exportScopeSelect = mount.querySelector<HTMLSelectElement>('#demo-export-scope-select');
  const exportScopeNote = mount.querySelector<HTMLElement>('#demo-export-scope-note');
  const exportAllButton = mount.querySelector<HTMLButtonElement>('#demo-export-all');
  const exportAllNote = exportAllButton?.querySelector<HTMLElement>('small');
  const exportInfoButtons = [...mount.querySelectorAll<HTMLButtonElement>('[data-export-info]')];
  const exportButtonCleanups: Array<() => void> = [];
  let declaredExportModels: ExportModelScope[] = [];
  let exportBusy = false;

  const readableBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  const showExportReport = (report: ExportReport): void => {
    if (!routeIsActive()) return;
    if (!exportReport || !exportSummary || !exportWarnings) return;
    const materialFormat = report.format === 'glb' || report.format === 'gltf' || report.format === 'usdz';
    const vertexColourFormat = report.format === 'glb' || report.format === 'gltf' || report.format === 'ply';
    const facts = [
      `${report.triangleCount.toLocaleString()} triangles`,
      `${report.meshCount.toLocaleString()} mesh nodes`,
      `${report.namedPartCount.toLocaleString()} named parts`,
      materialFormat
        ? report.portableMaterialCount === report.materialCount
          ? `${report.materialCount.toLocaleString()} materials`
          : `${report.portableMaterialCount.toLocaleString()}/${report.materialCount.toLocaleString()} portable materials`
        : null,
      materialFormat
        ? report.portableTextureCount === report.textureCount
          ? `${report.textureCount.toLocaleString()} image textures`
          : `${report.portableTextureCount.toLocaleString()}/${report.textureCount.toLocaleString()} portable textures`
        : null,
      vertexColourFormat && report.vertexColourMeshCount
        ? `${report.vertexColourMeshCount.toLocaleString()} vertex-colour meshes`
        : null,
      report.skinnedMeshCount ? `${report.jointCount.toLocaleString()} joints` : null,
      report.sourceAnimationCount
        ? `${report.animationCount}/${report.sourceAnimationCount} clips`
        : null,
      report.instanceCount ? `${report.instanceCount.toLocaleString()} instances` : null,
      report.roundTripValidated ? 'round-trip passed' : null,
      readableBytes(report.bytes),
    ].filter((fact): fact is string => !!fact);
    exportSummary.textContent = facts.join(' · ');
    exportWarnings.replaceChildren();
    for (const warning of report.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      exportWarnings.appendChild(item);
    }
    exportWarnings.hidden = report.warnings.length === 0;
    exportReport.hidden = false;
  };

  const showExportError = (error: unknown, context: string): void => {
    if (!routeIsActive()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (exportSummary && exportReport && exportWarnings) {
      exportSummary.textContent = message;
      exportWarnings.replaceChildren();
      exportWarnings.hidden = true;
      exportReport.hidden = false;
    }
    if (exportStatus) {
      exportStatus.value = 'Export blocked';
      exportStatus.dataset.state = 'error';
    }
    console.error(`[export:${demo.id}:${context}]`, error);
  };

  const scopeForId = (scopeId = exportScopeSelect?.value ?? 'all'): ExportModelScope | undefined => (
    scopeId === 'all' ? undefined : declaredExportModels.find((scope) => scope.id === scopeId)
  );
  const currentScope = (): { id: string; label: string; root?: THREE.Object3D } => {
    const selected = scopeForId();
    return selected ?? {
      id: 'all',
      label: declaredExportModels.length > 1
        ? `All models (${declaredExportModels.length})`
        : 'Complete showcase assembly',
    };
  };
  const syncExportScopes = (): void => {
    if (!routeIsActive()) return;
    const previous = exportScopeSelect?.value ?? 'all';
    declaredExportModels = exportModelsFor(model);
    const multiple = declaredExportModels.length > 1;
    if (!exportScope || !exportScopeSelect) return;
    exportScope.hidden = !multiple;
    exportScopeSelect.replaceChildren();
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = `All models (${declaredExportModels.length})`;
    exportScopeSelect.appendChild(all);
    for (const scope of declaredExportModels) {
      const option = document.createElement('option');
      option.value = scope.id;
      option.textContent = scope.label;
      exportScopeSelect.appendChild(option);
    }
    exportScopeSelect.value = multiple && (previous === 'all' || scopeForId(previous)) ? previous : 'all';
    if (exportScopeNote) {
      exportScopeNote.textContent = multiple
        ? `${declaredExportModels.length} independent models declared. Parts inside each model stay together.`
        : 'The complete showcase assembly will be exported.';
    }
    if (exportAllNote) exportAllNote.textContent = 'Current scope · 6 validated assets + manifest';
  };
  syncExportScopes();
  void prewarmCurrent.then((current) => {
    if (current && routeIsActive()) syncExportScopes();
  });

  const createExport = async (format: ExportFormat, scopeId?: string) => {
    const current = await prewarmCurrent;
    if (!current || !routeIsActive()) throw new Error('The demo route changed before export was ready.');
    syncExportScopes();
    const selected = scopeForId(scopeId);
    const artifact = await exportModel(
      model,
      format,
      (snapshot) => viewer.withAssetExportState(snapshot),
      selected?.root,
    );
    if (!routeIsActive()) throw new Error('The demo route changed during export.');
    return artifact;
  };
  const exportForQa = async (format: ExportFormat, scopeId = 'all'): Promise<ExportReport> => {
    if (!routeIsActive()) throw new Error('The demo route is no longer active.');
    if (!EXPORT_FORMATS.some((entry) => entry.format === format)) {
      throw new Error(`Unsupported export format: ${String(format)}`);
    }
    const report = (await createExport(format, scopeId)).report;
    if (!routeIsActive()) throw new Error('The demo route changed during export.');
    (window as unknown as Record<string, unknown>).__IMG2THREEJS_LAST_EXPORT_REPORT__ = report;
    return report;
  };
  const qaWindow = window as unknown as Record<string, unknown>;
  qaWindow.__IMG2THREEJS_EXPORT__ = exportForQa;

  const setExportBusy = (busy: boolean): void => {
    if (!routeIsActive()) return;
    exportBusy = busy;
    for (const candidate of exportButtons) candidate.disabled = busy;
    if (exportAllButton) exportAllButton.disabled = busy;
    if (exportScopeSelect) exportScopeSelect.disabled = busy;
  };
  const showBundleReport = (
    reports: ExportReport[],
    bytes: number,
    scopeLabel: string,
  ): void => {
    if (!routeIsActive()) return;
    if (!exportReport || !exportSummary || !exportWarnings) return;
    const warnings = [...new Set(reports.flatMap((report) => report.warnings))];
    exportSummary.textContent = `${scopeLabel} · ${reports.length} formats · manifest.json · ${readableBytes(bytes)}`;
    exportWarnings.replaceChildren();
    for (const warning of warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      exportWarnings.appendChild(item);
    }
    exportWarnings.hidden = warnings.length === 0;
    exportReport.hidden = false;
  };

  const closeExportTooltips = (except?: HTMLElement): void => {
    for (const row of mount.querySelectorAll<HTMLElement>('[data-export-row]')) {
      if (row === except) continue;
      row.classList.remove('is-info-open');
      row.querySelector<HTMLButtonElement>('[data-export-info]')?.setAttribute('aria-expanded', 'false');
    }
  };
  for (const button of exportInfoButtons) {
    const onInfo = (event: MouseEvent): void => {
      event.stopPropagation();
      const row = button.closest<HTMLElement>('[data-export-row]');
      if (!row) return;
      const open = !row.classList.contains('is-info-open');
      closeExportTooltips(row);
      row.classList.toggle('is-info-open', open);
      button.setAttribute('aria-expanded', String(open));
    };
    button.addEventListener('click', onInfo);
    exportButtonCleanups.push(() => button.removeEventListener('click', onInfo));
  }
  const onExportOutsideClick = (event: MouseEvent): void => {
    if (!(event.target as HTMLElement).closest('.demo-export-tooltip, [data-export-info]')) {
      closeExportTooltips();
    }
  };
  const onExportEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    closeExportTooltips();
    exportInfoButtons.find((button) => button.matches(':focus'))?.focus();
  };
  mount.addEventListener('click', onExportOutsideClick);
  mount.addEventListener('keydown', onExportEscape);
  exportButtonCleanups.push(() => mount.removeEventListener('click', onExportOutsideClick));
  exportButtonCleanups.push(() => mount.removeEventListener('keydown', onExportEscape));

  if (exportScopeSelect) {
    const onScopeChange = (): void => {
      const scope = currentScope();
      if (exportStatus) {
        exportStatus.value = scope.id === 'all' ? 'All models selected' : `${scope.label} selected`;
        exportStatus.dataset.state = 'ready';
      }
      exportReport?.setAttribute('hidden', '');
    };
    exportScopeSelect.addEventListener('change', onScopeChange);
    exportButtonCleanups.push(() => exportScopeSelect.removeEventListener('change', onScopeChange));
  }

  if (!capture) {
    for (const button of exportButtons) {
      const format = button.dataset.exportFormat as ExportFormat;
      const onExport = async (): Promise<void> => {
        if (exportBusy) return;
        setExportBusy(true);
        button.classList.add('is-exporting');
        exportReport?.setAttribute('hidden', '');
        const scope = currentScope();
        if (exportStatus) {
          exportStatus.value = `Validating ${format.toUpperCase()}`;
          exportStatus.dataset.state = 'busy';
        }
        try {
          const artifact = await createExport(format, scope.id);
          if (!routeIsActive()) return;
          qaWindow.__IMG2THREEJS_LAST_EXPORT_REPORT__ = artifact.report;
          showExportReport(artifact.report);
          const filename = scope.id === 'all'
            ? `${demo.id}.${artifact.filenameExtension}`
            : `${demo.id}--${scope.id}.${artifact.filenameExtension}`;
          saveBlob(artifact.blob, filename);
          if (exportStatus) {
            exportStatus.value = artifact.report.warnings.length ? 'Validated with limits' : 'Validated';
            exportStatus.dataset.state = artifact.report.warnings.length ? 'warning' : 'success';
          }
        } catch (error) {
          if (routeIsActive()) showExportError(error, format);
        } finally {
          if (routeIsActive()) {
            setExportBusy(false);
            button.classList.remove('is-exporting');
          }
        }
      };
      button.addEventListener('click', onExport);
      exportButtonCleanups.push(() => button.removeEventListener('click', onExport));
    }

    if (exportAllButton) {
      const onExportAll = async (): Promise<void> => {
        if (exportBusy) return;
        setExportBusy(true);
        exportAllButton.classList.add('is-exporting');
        exportReport?.setAttribute('hidden', '');
        try {
          const current = await prewarmCurrent;
          if (!current || !routeIsActive()) return;
          syncExportScopes();
          const scope = currentScope();
          const bundle = await exportAllFormatsZip(model, {
            assetId: demo.id,
            scopeId: scope.id,
            scopeLabel: scope.label,
            selectedRoot: scope.root,
            snapshot: (snapshot) => viewer.withAssetExportState(snapshot),
            onProgress: ({ label, index, total }) => {
              if (routeIsActive() && exportStatus) {
                exportStatus.value = `${label} ${index}/${total}`;
                exportStatus.dataset.state = 'busy';
              }
            },
          });
          if (!routeIsActive()) return;
          qaWindow.__IMG2THREEJS_LAST_EXPORT_BUNDLE__ = {
            bytes: bundle.blob.size,
            filename: bundle.filename,
            files: bundle.files,
            reports: bundle.reports,
          };
          showBundleReport(bundle.reports, bundle.blob.size, scope.label);
          saveBlob(bundle.blob, bundle.filename);
          const hasWarnings = bundle.reports.some((report) => report.warnings.length > 0);
          if (exportStatus) {
            exportStatus.value = hasWarnings ? 'Bundle validated with limits' : 'Bundle validated';
            exportStatus.dataset.state = hasWarnings ? 'warning' : 'success';
          }
        } catch (error) {
          if (routeIsActive()) showExportError(error, 'zip');
        } finally {
          if (routeIsActive()) {
            exportAllButton.classList.remove('is-exporting');
            setExportBusy(false);
          }
        }
      };
      exportAllButton.addEventListener('click', onExportAll);
      exportButtonCleanups.push(() => exportAllButton.removeEventListener('click', onExportAll));
    }
  }
  // QA capture scripts may place a diagnostic camera on a named socket. This
  // is not part of the demo UI or model geometry; it exposes only the existing
  // viewer instance to the local evidence harness.
  qaWindow.__IMG2THREEJS_VIEWER__ = viewer;
  type ModelRuntime = {
    pivots?: Record<string, unknown>;
    sockets?: Record<string, unknown>;
    actionAnchors?: Record<string, unknown>;
    colliders?: unknown[];
    adjacency?: unknown[];
    attachmentGate?: unknown;
    attachmentAudit?: unknown;
    destructionGroups?: Record<string, unknown>;
    logicalComponents?: Record<string, { kind?: string; binding?: string; boundMeshes?: string[] }>;
  };
  const currentModelRuntime = (): ModelRuntime | undefined => (
    model.userData.sculptRuntime as ModelRuntime | undefined
  );
  let publishedRuntime: unknown;
  const publishRuntime = (): void => {
    if (!routeIsActive()) return;
    const modelRuntime = currentModelRuntime();
    publishedRuntime = {
      model: id,
      hasTick: typeof model.userData.tick === 'function',
      pivotNames: Object.keys(modelRuntime?.pivots ?? model.userData.pivots ?? {}),
      socketNames: Object.keys(modelRuntime?.sockets ?? {}),
      actionAnchors: modelRuntime?.actionAnchors ?? model.userData.actionAnchors ?? {},
      colliderCount: modelRuntime?.colliders?.length ?? 0,
      adjacencyCount: modelRuntime?.adjacency?.length ?? 0,
      attachmentGate: modelRuntime?.attachmentGate ?? null,
      attachmentAudit: modelRuntime?.attachmentAudit ?? null,
      destructionGroupNames: Object.keys(modelRuntime?.destructionGroups ?? {}),
    };
    qaWindow.__IMG2THREEJS_RUNTIME__ = publishedRuntime;
  };
  publishRuntime();
  // The dedicated inspector is a containment view: unlike an editorial thumbnail, it must expose
  // the complete subject at every panel state so a visitor can inspect the silhouette and parts.
  viewer.fitToViewport(model, true);

  // Part tree published for the assembly gate (forge/stage4_review/check_part_coverage.py).
  // Set in capture mode too — that is the headless run the gate reads it from.
  // Logical entries describe a coverage binding only; they do not add
  // geometry, selectable meshes, or a camera-facing surface to the model.
  // Re-published after prewarm as well: a demo whose meshes arrive lazily had none to report on the
  // first pass, which left the assembly gate reading zero parts for a model that ships 69 of them.
  let publishedPartManifest: unknown;
  const publishPartManifest = (): void => {
    if (!routeIsActive()) return;
    const logicalParts = Object.entries(currentModelRuntime()?.logicalComponents ?? {})
      .map(([name, value]) => ({
        name,
        module: null,
        kind: value.kind ?? 'logical',
        triangles: 0,
        materials: [],
      }));
    const live = viewer.partManifest();
    publishedPartManifest = {
      model: id,
      ...(live ?? { parts: [], unnamedMeshes: 0, integralMeshes: 0 }),
      parts: [...(live?.parts ?? []), ...logicalParts],
    };
    qaWindow.__IMG2THREEJS_PARTS__ = publishedPartManifest;
  };
  publishPartManifest();

  // Explode control. Hidden for single-mesh demos and in capture mode, where the panel is
  // hidden anyway and the evaluation frame must stay deterministic.
  // Turntable control. Only for demos that ask for one -- a toggle on a subject with one interesting
  // side is a button nobody wanted -- and never in capture mode, where the camera is frozen.
  const spinBtn = mount.querySelector<HTMLButtonElement>('#demo-spin');
  if (spinBtn && turntable && !capture) {
    spinBtn.hidden = false;
    enableInspectorSection('animation', true);
    const syncSpin = (): void => {
      const on = viewer.turntable;
      spinBtn.setAttribute('aria-pressed', String(on));
      spinBtn.classList.toggle('is-active', on);
      spinBtn.querySelector('.spin-label')!.textContent = on ? 'Stop Turntable' : 'Turntable';
    };
    spinBtn.addEventListener('click', () => {
      viewer.setTurntable(!viewer.turntable);
      syncSpin();
    });
    syncSpin();
  }

  const explodeBtn = mount.querySelector<HTMLButtonElement>('#demo-explode');
  /**
   * Re-checked, not decided once. A demo whose geometry arrives through `prewarm` has an EMPTY model
   * root at this point -- girl-character loads 16 implicit surfaces that way -- so `canExplode` was
   * false when the page was built and the button stayed hidden forever, even though the finished model
   * has 16 parts. The parts list did not have this bug because it is already rebuilt after prewarm.
   */
  const syncExplodeButton = (): void => {
    if (!explodeBtn || capture) return;
    explodeBtn.hidden = !viewer.canExplode;
    if (viewer.canExplode) enableInspectorSection('animation', true);
  };
  if (explodeBtn && !capture) {
    syncExplodeButton();
    let exploded = false;
    explodeBtn.addEventListener('click', () => {
      exploded = !exploded;
      trackExplode(demo.id, exploded ? 1 : 0, 'viewer');
      viewer.setExplode(exploded ? 1 : 0);
      explodeBtn.setAttribute('aria-pressed', String(exploded));
      explodeBtn.classList.toggle('is-active', exploded);
      explodeBtn.querySelector('.explode-label')!.textContent = exploded ? 'Assemble' : 'Explode Parts';
    });
  }

  // Part inspector: click any component in the viewer (or in the list) to select, name and
  // isolate it. Off in capture mode — the evaluation frame must show the assembled object.
  const partsSection = mount.querySelector<HTMLElement>('#demo-parts')!;
  const partsList = mount.querySelector<HTMLUListElement>('#parts-list')!;
  const partCard = mount.querySelector<HTMLElement>('#part-card')!;

  /** Small DOM builder. Part names and material strings go in as text, never as markup. */
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K, cls?: string, text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const fact = (label: string, value: string): HTMLElement => {
    const row = el('div');
    row.append(el('dt', undefined, label), el('dd', undefined, value));
    return row;
  };

  const renderSelection = (sel: PartInfo | null): void => {
    for (const item of partsList.querySelectorAll<HTMLElement>('.part-item')) {
      item.classList.toggle('is-active', !!sel && item.dataset.part === sel.name);
    }
    if (!sel) {
      partCard.hidden = true;
      partCard.replaceChildren();
      return;
    }
    enableInspectorSection('parts');
    setInspectorSection('parts', true);
    partCard.hidden = false;

    const head = el('div', 'part-card-head');
    head.append(el('strong', undefined, sel.name), el('span', `part-kind part-kind-${sel.kind}`, sel.kind));

    const facts = el('dl', 'part-facts');
    if (sel.module) facts.append(fact('module', sel.module));
    facts.append(fact('triangles', sel.triangles.toLocaleString()));
    for (const m of sel.materials) facts.append(fact('material', m));

    const isolateBtn = el('button', 'btn part-btn', viewer.isolated ? 'Show all' : 'Isolate');
    isolateBtn.type = 'button';
    isolateBtn.setAttribute('aria-pressed', String(viewer.isolated));
    // No manual re-render: setIsolate reports back through onSelect.
    isolateBtn.addEventListener('click', () => {
      trackPartIsolate(demo.id, !viewer.isolated, 'viewer');
      viewer.setIsolate(!viewer.isolated);
    });
    const clearBtn = el('button', 'btn part-btn', 'Clear');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      viewer.setIsolate(false);
      viewer.selectByName(null);
    });
    const actions = el('div', 'part-actions');
    actions.append(isolateBtn, clearBtn);

    partCard.replaceChildren(head, facts, actions);
    partsList.querySelector('.part-item.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  let populateParts: (() => void) | undefined;
  if (!capture) {
    viewer.enableInspect({ onSelect: renderSelection });

    populateParts = (): void => {
      const parts = viewer.parts;
      // One nameless blob is not a part tree — leave the section hidden rather than show a list
      // of one. This is what keeps the demos with unnamed meshes from looking broken.
      if (parts.length <= 1) return;
      partsSection.hidden = false;
      enableInspectorSection('parts');
      mount.querySelector<HTMLElement>('#parts-count')!.textContent = String(parts.length);
      partsList.replaceChildren();

      const groups = new Map<string, PartInfo[]>();
      for (const p of parts) {
        const key = p.module ?? 'ungrouped';
        let arr = groups.get(key);
        if (!arr) groups.set(key, (arr = []));
        arr.push(p);
      }
      const labelled = groups.size > 1 || !groups.has('ungrouped');
      for (const [mod, items] of groups) {
        if (labelled) partsList.append(el('li', 'parts-group', mod));
        for (const p of items) {
          const btn = el('button', 'part-item');
          btn.type = 'button';
          btn.dataset.part = p.name;
          btn.append(
            el('span', 'part-name', p.name),
            el('span', 'part-tri', p.triangles >= 1000
              ? `${(p.triangles / 1000).toFixed(1)}k` : String(p.triangles)),
          );
          const row = el('li');
          row.append(btn);
          partsList.append(row);
        }
      }

      // Model-level, not per-part: this is what the pipeline recorded about the whole
      // reconstruction, and it is the honest caption for every number above it.
      const prov = viewer.provenance;
      if (prov) {
        const provEl = mount.querySelector<HTMLElement>('#parts-prov')!;
        provEl.hidden = false;
        provEl.textContent = [
          prov.route,
          prov.exactnessTier,
          prov.thicknessConfidence !== undefined
            ? `z-depth confidence ${prov.thicknessConfidence}` : null,
        ].filter(Boolean).join(' · ');
      }

    };

    // Delegated from the list, and registered ONCE rather than inside populateParts: repopulating
    // replaces the buttons but would stack a second identical handler on the list itself.
    partsList.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.part-item');
      if (!btn?.dataset.part) return;
      viewer.selectByName(btn.dataset.part);
      const part = viewer.parts.find((candidate) => candidate.name === btn.dataset.part);
      if (part) trackPartSelect(demo.id, part, 'viewer');
    });

    populateParts();
  }

  /**
   * Refresh state that depends on children attached after the synchronous build. This runs for
   * capture and interactive routes alike; only the inspector DOM work below is interactive-only.
   */
  const refreshCompletedModel = (): boolean => {
    if (!routeIsActive()) return false;
    viewer.rebuildParts();
    publishRuntime();
    publishPartManifest();
    // The runtime and its per-frame ticker can arrive with the lazy geometry.
    viewer.refreshTickers();
    return routeIsActive();
  };

  let capturePrepared = false;
  const prepareCapture = (): boolean => {
    if (!capture || capturePrepared || !routeIsActive()) return false;
    capturePrepared = true;
    // Flat white bg + hide the UI overlay + freeze per-frame animation so the evaluation
    // frame is deterministic and shows only the object (matches the reference plate).
    //
    // `?bg=RRGGBB` overrides the white, for a subject whose reference plate is NOT white. This is the
    // SECOND place the capture background is set — the Viewer constructor sets it too — so changing
    // only one of them silently leaves the other in charge. A render captured on white while its
    // reference sits on #0f0f0f turns every foreground and silhouette number into a measurement of
    // that mismatch. `mask=1` still wins: an alpha capture needs no background at all.
    const bgParam = new URLSearchParams(window.location.search).get('bg');
    const maskCapture = new URLSearchParams(window.location.search).get('mask') === '1';
    if (!maskCapture) {
      viewer.scene.background = bgParam && /^#?[0-9a-fA-F]{6}$/.test(bgParam)
        ? new THREE.Color(parseInt(bgParam.replace('#', ''), 16))
        : new THREE.Color(0xffffff);
    }
    viewer.scene.traverse((o) => {
      if ((o.userData as { tick?: unknown }).tick) delete (o.userData as { tick?: unknown }).tick;
    });
    for (const sel of ['.demo-panel', '.hint']) {
      mount.querySelector<HTMLElement>(sel)?.style.setProperty('display', 'none');
    }
    // Side-on auto-framing so the evaluation silhouette matches the side-on reference plate.
    const captureOffsetX = backCapture
      ? demo.captureTargetOffsetXBack ?? demo.captureTargetOffsetX
      : demo.captureTargetOffsetX;
    if (captureOffsetX !== undefined) model.position.x += captureOffsetX;
    // A pinned camera makes the review shot independent of the geometry it reviews; the auto-fit
    // below reads the scene bbox, so any envelope change reframes the shot and contaminates the
    // silhouette metric it feeds.
    if (demo.capturePinnedCamera) {
      viewer.pinCaptureCamera(
        backCapture ? demo.capturePinnedCamera.back : demo.capturePinnedCamera.front,
      );
    } else {
      viewer.frameForCapture(
        20,
        demo.captureMargin ?? 1.12,
        backCapture ? -1 : 1,
        backCapture ? demo.captureTargetOffsetYBack ?? demo.captureTargetOffsetY ?? 0 : demo.captureTargetOffsetY ?? 0,
      );
    }
    return routeIsActive();
  };

  // Interactive routes keep progressive rendering: start immediately, then refresh the inspector
  // when the shared prewarm settles. Capture routes wait so their first ready frame, globals and
  // framing all describe the completed model rather than the synchronous placeholder root.
  if (!capture) viewer.start();
  if (demo.prewarm) {
    void prewarmCurrent.then((current) => {
      if (!current || !refreshCompletedModel()) return;
      if (capture) {
        if (prepareCapture() && routeIsActive()) viewer.start();
        return;
      }
      populateParts?.();
      syncExplodeButton();
      mountAnimationPanel(
        (model.userData.sculptRuntime as { animationController?: AnimationController } | undefined)
          ?.animationController,
      );
      mountVfxPanel();
    });
  } else if (capture && refreshCompletedModel() && prepareCapture()) {
    viewer.start();
  }

  /**
   * Dismissal, owned in exactly one place so there is no second handler racing it.
   *
   * A `prewarm` demo's geometry lands AFTER `build()` returns, so waiting on the viewer's ready
   * flag alone would uncover an empty scene. The loader shares the render's single prewarm
   * settlement with the parts and export paths. A rejection is treated as settled because the demo
   * can fall back to simpler geometry.
   */
  if (loader) {
    void (async () => {
      const current = await prewarmCurrent;
      if (!current || !routeIsActive()) return;
      loader.phase('Framing');
      const viewerBecameReady = await Promise.race([
        whenViewerReady().then(() => true),
        disposedSignal.then(() => false),
      ]);
      if (!viewerBecameReady || !routeIsActive()) return;
      loader.done();
      const manifest = viewer.partManifest();
      trackExhibitReady(
        demo,
        {
          loadMs: performance.now() - startedAt,
          triangles: manifest
            ? manifest.parts.reduce((sum, part) => sum + part.triangles, 0)
            : 0,
          partCount: manifest ? manifest.parts.length : 0,
          prewarm: !!demo.prewarm,
        },
        'viewer',
      );
    })();
  }

  // --- collapsible details sheet ---------------------------------------------------------
  const panel = mount.querySelector<HTMLElement>('#demo-panel')!;
  const panelBody = mount.querySelector<HTMLElement>('#demo-panel-body')!;
  const bar = mount.querySelector<HTMLElement>('.demo-panel-bar')!;
  const toggle = mount.querySelector<HTMLButtonElement>('#panel-toggle')!;
  const toggleLabel = toggle.querySelector<HTMLElement>('.panel-toggle-label');
  const page = mount.querySelector<HTMLElement>('.demo-page')!;
  let resizeFrame = 0;
  const setExpanded = (next: boolean): void => {
    panelExpanded = next;
    panel.dataset.expanded = String(next);
    page.dataset.inspectorOpen = String(next);
    panelBody.inert = !next;
    panelBody.setAttribute('aria-hidden', String(!next));
    toggle.setAttribute('aria-expanded', String(next));
    toggle.setAttribute('aria-label', `${next ? 'Close' : 'Open'} Model Inspector`);
    if (toggleLabel) toggleLabel.textContent = next ? 'Hide' : 'Inspect';
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  // The whole bar is the hit target (the button's click bubbles up to it), so a sheet on a phone
  // toggles from anywhere along the header — everywhere except the back link.
  const onBarClick = (event: MouseEvent): void => {
    if ((event.target as HTMLElement).closest('.back-link')) return;
    setExpanded(panel.dataset.expanded !== 'true');
  };
  bar.addEventListener('click', onBarClick);

  // Viewport changes reset an untouched panel to that viewport's default (rotating a phone to
  // landscape, resizing a window across the breakpoint).
  const onCompactChange = (event: MediaQueryListEvent): void => {
    if (panelExpanded === null) setExpanded(!event.matches);
  };
  compact.addEventListener('change', onCompactChange);

  // --- orbit hint: says its piece, then gets out of the way ------------------------------
  const hint = mount.querySelector<HTMLElement>('#demo-hint')!;
  const hideHint = (): void => hint.classList.add('is-gone');
  const hintTimer = window.setTimeout(hideHint, 6000);
  canvasMount.addEventListener('pointerdown', hideHint, { once: true });

  /* --- measurement ------------------------------------------------------------------------
   *
   * Two handlers, both delegated, both removed in the cleanup below.
   *
   * The link handler is the reason the Tripo provenance link on an exhibit counts for Tripo without
   * this file knowing that Tripo is a sponsor: `trackLinkClick` resolves the destination's hostname
   * against the sponsor list, so a sponsor's own asset page lands in the same report row as their
   * card in the sponsor drawer. Add another provenance link tomorrow and it is attributed with no
   * change here. `data-track-skip` marks the source link, which sends a richer event of its own.
   */
  const reportFirstInput = (input: 'pointer' | 'wheel' | 'touch') => (): void => {
    trackViewerInteract(demo.id, input, 'viewer');
  };
  const onFirstPointer = reportFirstInput('pointer');
  const onFirstWheel = reportFirstInput('wheel');
  const onFirstTouch = reportFirstInput('touch');
  canvasMount.addEventListener('pointerdown', onFirstPointer);
  canvasMount.addEventListener('wheel', onFirstWheel, { passive: true });
  canvasMount.addEventListener('touchstart', onFirstTouch, { passive: true });

  const onPanelLinkClick = (event: MouseEvent): void => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (anchor.hasAttribute('data-track-skip')) {
      trackSourceClick(demo.id, 'viewer');
      return;
    }
    // `#/` is the back link. The route it leads to reports its own page view.
    if (!href || href.startsWith('#')) return;
    trackLinkClick({
      url: anchor.href,
      label: anchor.textContent?.trim().replace(/\s+/g, ' '),
      placement: 'demo_panel',
      exhibitId: demo.id,
    });
  };
  mount.addEventListener('click', onPanelLinkClick);

  return () => {
    // Flip lifecycle state before any teardown so already-queued promise continuations become inert.
    disposed = true;
    signalDisposed();
    window.clearTimeout(hintTimer);
    window.cancelAnimationFrame(resizeFrame);
    bar.removeEventListener('click', onBarClick);
    compact.removeEventListener('change', onCompactChange);
    canvasMount.removeEventListener('pointerdown', hideHint);
    canvasMount.removeEventListener('pointerdown', onFirstPointer);
    canvasMount.removeEventListener('wheel', onFirstWheel);
    canvasMount.removeEventListener('touchstart', onFirstTouch);
    mount.removeEventListener('click', onPanelLinkClick);
    if (qaWindow.__IMG2THREEJS_EXPORT__ === exportForQa) {
      delete qaWindow.__IMG2THREEJS_EXPORT__;
    }
    if (qaWindow.__IMG2THREEJS_VIEWER__ === viewer) delete qaWindow.__IMG2THREEJS_VIEWER__;
    if (qaWindow.__IMG2THREEJS_RUNTIME__ === publishedRuntime) delete qaWindow.__IMG2THREEJS_RUNTIME__;
    if (qaWindow.__IMG2THREEJS_PARTS__ === publishedPartManifest) delete qaWindow.__IMG2THREEJS_PARTS__;
    delete qaWindow.__IMG2THREEJS_LAST_EXPORT_REPORT__;
    delete qaWindow.__IMG2THREEJS_LAST_EXPORT_BUNDLE__;
    for (const cleanup of exportButtonCleanups) cleanup();
    for (const cleanup of inspectorCleanups) cleanup();
    mountedAnimationController?.stop();
    unsubscribeAnimation?.();
    for (const cleanup of animationButtonCleanups) cleanup();
    viewer.dispose();
    // If prewarm already bound the completed model, release the old scene's reference only after
    // its renderer and ordinary resource sweep are finished. Otherwise prewarmCurrent does this
    // when the late bind settles; neither path traverses or disposes a newer model.
    detachDisposedModel();
  };
}
