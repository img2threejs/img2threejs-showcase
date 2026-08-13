import * as THREE from 'three';
import { getDemo } from '../demos/registry';
import { Viewer, type PartInfo } from '../scene';
import { navigate } from '../router';

const GITHUB_URL = 'https://github.com/hoainho/img2threejs';

/** Viewports where the info panel becomes a collapsible bottom sheet over the model. */
const COMPACT_QUERY = '(max-width: 860px), (max-height: 520px)';

/**
 * Whether the details sheet is expanded, remembered across demo navigations within a session.
 * `null` = untouched, so each viewport gets its own sensible default (open on desktop, collapsed
 * on a phone, where an open panel would cover the model entirely).
 */
let panelExpanded: boolean | null = null;

/**
 * Renders the full-viewport demo viewer + info panel for `id`.
 * Returns a cleanup function the router must call before switching routes.
 * If `id` is unknown, redirects to home and returns a no-op cleanup.
 */
export function renderDemo(mount: HTMLElement, id: string): () => void {
  const demo = getDemo(id);
  if (!demo) {
    navigate('#/');
    return () => {};
  }

  const compact = window.matchMedia(COMPACT_QUERY);
  const expanded = panelExpanded ?? !compact.matches;

  mount.innerHTML = `
    <div class="demo-page">
      <div class="demo-canvas-mount" id="demo-canvas-mount"></div>
      <section class="demo-panel" id="demo-panel" data-expanded="${expanded}">
        <div class="demo-panel-bar">
          <a class="back-link" href="#/" aria-label="Back to gallery">
            <span class="back-arrow" aria-hidden="true">&larr;</span>
            <span class="back-text">Back to gallery</span>
          </a>
          <span class="demo-bar-title">${demo.title}</span>
          <button class="panel-toggle" type="button" id="panel-toggle"
                  aria-controls="demo-panel-body" aria-expanded="${expanded}">
            <span class="panel-toggle-label">Details</span>
            <span class="panel-toggle-chevron" aria-hidden="true"></span>
          </button>
        </div>
        <div class="demo-panel-body" id="demo-panel-body">
          <div class="demo-panel-inner">
            <header class="demo-panel-head">
              <span class="demo-kicker">img2threejs · reconstruction</span>
              <h2>${demo.title}</h2>
              <p class="demo-author">by
                <a href="${demo.authorUrl}" target="_blank" rel="noopener noreferrer">${demo.author}</a>
              </p>
            </header>
            <figure class="demo-ref">
              <img class="demo-ref-thumb" src="${demo.referenceImage}" alt="${demo.title} reference" />
              <figcaption>source reference</figcaption>
            </figure>
            <div class="demo-meta">
              <div class="badges">
                <span class="badge badge-${demo.subjectClass}">${demo.subjectClass}</span>
                <span class="badge">${demo.generatedWith}</span>
                <span class="badge badge-status status-${demo.status}">${demo.status}</span>
              </div>
              <p>${demo.blurb}</p>
            </div>
            <section class="demo-animations" id="demo-animations" hidden aria-labelledby="demo-animations-title">
              <div class="demo-animations-head">
                <span class="parts-title" id="demo-animations-title">Animations</span>
                <output class="demo-animation-status" id="demo-animation-status">Idle</output>
              </div>
              <div class="demo-animation-buttons" id="demo-animation-buttons"></div>
            </section>
            <section class="demo-parts" id="demo-parts" hidden>
              <div class="parts-head">
                <span class="parts-title">Parts</span>
                <span class="parts-count" id="parts-count"></span>
              </div>
              <div class="part-card" id="part-card" hidden></div>
              <div class="parts-scroll"><ul class="parts-list" id="parts-list"></ul></div>
              <p class="parts-prov" id="parts-prov" hidden></p>
            </section>
            <div class="demo-links">
              <button class="btn btn-explode" id="demo-explode" type="button" aria-pressed="false" hidden>
                <span class="explode-glyph">&#10021;</span> <span class="explode-label">Explode parts</span>
              </button>
              <label class="explode-slider" id="demo-explode-slider-wrap" hidden>
                <span class="explode-slider-label">Explosion <output id="demo-explode-value">0%</output></span>
                <input id="demo-explode-slider" type="range" min="0" max="1" step="0.01" value="0" aria-label="Explosion amount" />
              </label>
              <button class="btn" id="demo-reset-camera" type="button">Reset camera</button>
              <button class="btn" id="demo-reset-explosion" type="button" hidden>Reset explosion</button>
              <a class="btn" href="${demo.sourceUrl}" target="_blank" rel="noopener noreferrer">
                &lt;/&gt; View generated source
              </a>
              <a class="btn btn-star" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">
                &#9733; Star img2threejs on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>
      <div class="hint" id="demo-hint">
        <span class="hint-glyph" aria-hidden="true">&#8635;</span>
        <span class="hint-pointer">drag to orbit &middot; scroll to zoom</span>
        <span class="hint-touch">drag to orbit &middot; pinch to zoom</span>
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
  const requestedCaptureProfile = new URLSearchParams(window.location.search).get('captureProfile') ?? undefined;
  const activeCaptureCamera = (requestedCaptureProfile ? demo.captureProfiles?.[requestedCaptureProfile] : undefined)
    ?? demo.captureCamera;

  // Per-demo tone-mapping (optional on the entry; read structurally so demo.ts is independent of
  // the DemoEntry field being declared). AgX preserves the Ruby-Doppler crimson that ACES washes.
  const toneMapping = (demo as { toneMapping?: 'aces' | 'agx' | 'neutral' }).toneMapping;

  const canvasMount = mount.querySelector<HTMLDivElement>('#demo-canvas-mount')!;
  const viewer = new Viewer(canvasMount, {
    cameraPosition: demo.cameraPosition,
    cameraTarget: demo.cameraTarget,
    cameraFov: demo.cameraFov,
    backgroundGradient: demo.backgroundGradient,
    captureBackgroundGradient: demo.captureBackgroundGradient,
    exposure: demo.exposure,
    environmentIntensity: demo.environmentIntensity,
    bloom: demo.bloom,
    installLights: demo.installLights,
    toneMapping,
    captureCamera: activeCaptureCamera,
    capture,
  });

  const model = demo.build(viewer.scene, { capture, captureProfile: requestedCaptureProfile });

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
  const animationStatus = mount.querySelector<HTMLOutputElement>('#demo-animation-status');
  const animationButtonCleanups: Array<() => void> = [];
  let unsubscribeAnimation: (() => void) | undefined;
  if (animationController && animationSection && animationButtons && !capture) {
    animationSection.hidden = false;
    const buttons = new Map<string, HTMLButtonElement>();
    for (const action of animationController.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn demo-animation-btn';
      button.dataset.animation = action.id;
      button.textContent = action.label;
      button.setAttribute('aria-pressed', 'false');
      button.title = action.loop ? `${action.label} (loops until stopped)` : `${action.label} (plays once)`;
      const onClick = (): void => animationController.play(action.id);
      button.addEventListener('click', onClick);
      animationButtonCleanups.push(() => button.removeEventListener('click', onClick));
      animationButtons.appendChild(button);
      buttons.set(action.id, button);
    }
    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'btn demo-animation-btn demo-animation-stop';
    stopButton.dataset.animation = 'stop';
    stopButton.textContent = 'Stop / Reset';
    const onStop = (): void => animationController.stop();
    stopButton.addEventListener('click', onStop);
    animationButtonCleanups.push(() => stopButton.removeEventListener('click', onStop));
    animationButtons.appendChild(stopButton);

    unsubscribeAnimation = animationController.subscribe((active) => {
      if (animationStatus) animationStatus.value = active === 'idle'
        ? 'Idle'
        : buttons.get(active)?.textContent ?? active.charAt(0).toUpperCase() + active.slice(1);
      for (const [id, button] of buttons) {
        const selected = id === active;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
      }
    });
  }

  viewer.setExplodeRoot(model);
  // Responsive framing: keeps the authored desktop composition, dollies back on narrow/short
  // viewports so the whole subject stays in frame instead of being cropped away.
  viewer.fitToViewport(model);

  // Part tree published for the assembly gate (forge/stage4_review/check_part_coverage.py).
  // Set in capture mode too — that is the headless run the gate reads it from.
  (window as unknown as Record<string, unknown>).__IMG2THREEJS_PARTS__ = {
    model: id,
    triangles: (model.userData as { triangleCount?: number }).triangleCount ?? null,
    ...viewer.partManifest(),
  };

  // Explode control. Hidden for single-mesh demos and in capture mode, where the panel is
  // hidden anyway and the evaluation frame must stay deterministic.
  const explodeBtn = mount.querySelector<HTMLButtonElement>('#demo-explode');
  const explodeSliderWrap = mount.querySelector<HTMLElement>('#demo-explode-slider-wrap');
  const explodeSlider = mount.querySelector<HTMLInputElement>('#demo-explode-slider');
  const explodeValue = mount.querySelector<HTMLOutputElement>('#demo-explode-value');
  let exploded = false;
  const applyExplosionUi = (value: number): void => {
    const clamped = Math.max(0, Math.min(1, value));
    exploded = clamped > 0.5;
    viewer.setExplode(clamped);
    if (explodeSlider) explodeSlider.value = String(clamped);
    if (explodeValue) explodeValue.value = `${Math.round(clamped * 100)}%`;
    explodeBtn?.setAttribute('aria-pressed', String(exploded));
    explodeBtn?.classList.toggle('is-active', exploded);
    explodeBtn?.querySelector('.explode-label')?.replaceChildren(
      document.createTextNode(exploded ? 'Assemble' : 'Explode parts'),
    );
  };
  if (explodeBtn && viewer.canExplode && !capture) {
    explodeBtn.hidden = false;
    explodeBtn.addEventListener('click', () => {
      applyExplosionUi(exploded ? 0 : 1);
    });
  }
  const onExplosionInput = (): void => applyExplosionUi(Number(explodeSlider?.value ?? 0));
  if (explodeSlider && explodeSliderWrap && viewer.canExplode && !capture) {
    explodeSliderWrap.hidden = false;
    explodeSlider.addEventListener('input', onExplosionInput);
  }

  const resetCameraBtn = mount.querySelector<HTMLButtonElement>('#demo-reset-camera');
  const resetExplosionBtn = mount.querySelector<HTMLButtonElement>('#demo-reset-explosion');
  const onResetCamera = (): void => viewer.resetCamera();
  const onResetExplosion = (): void => {
    viewer.resetExplosion();
    applyExplosionUi(0);
  };
  resetCameraBtn?.addEventListener('click', onResetCamera);
  if (resetExplosionBtn && viewer.canExplode && !capture) {
    resetExplosionBtn.hidden = false;
    resetExplosionBtn.addEventListener('click', onResetExplosion);
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
    isolateBtn.addEventListener('click', () => viewer.setIsolate(!viewer.isolated));
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

  if (!capture) {
    viewer.enableInspect({ onSelect: renderSelection });
    const parts = viewer.parts;
    // One nameless blob is not a part tree — leave the section hidden rather than show a list
    // of one. This is what keeps the demos with unnamed meshes from looking broken.
    if (parts.length > 1) {
      partsSection.hidden = false;
      mount.querySelector<HTMLElement>('#parts-count')!.textContent = String(parts.length);

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

      partsList.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.part-item');
        if (btn?.dataset.part) viewer.selectByName(btn.dataset.part);
      });

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

      // Wrapped in its own span so the compact layout can drop it: the hint is a single-line
      // pill, and this clause alone is wider than a phone screen.
      const inspectHint = document.createElement('span');
      inspectHint.className = 'hint-extra';
      inspectHint.textContent =
        ' · click a part to inspect · click again to reach what is behind it';
      mount.querySelector<HTMLElement>('.hint')!.append(inspectHint);
    }
  }

  if (capture) {
    // Match the admitted Dragon plates' navy studio background when requested by the review plan.
    // The component-ID pass temporarily switches back to white because its classifier uses the
    // flat ID/background colour cube; beauty captures must retain the photographic background.
    const captureBackground = new URLSearchParams(window.location.search).get('captureBg');
    // Viewer already installed the demo-specific capture plate when one is
    // declared. Only override it for the legacy explicit dark/white switch.
    if (captureBackground) {
      viewer.scene.background = new THREE.Color(captureBackground === 'dark' ? 0x182331 : 0xffffff);
    }
    viewer.scene.traverse((o) => {
      if ((o.userData as { tick?: unknown }).tick) delete (o.userData as { tick?: unknown }).tick;
    });
    for (const sel of ['.demo-panel', '.hint']) {
      mount.querySelector<HTMLElement>(sel)?.style.setProperty('display', 'none');
    }
    // Side-on auto-framing so the evaluation silhouette matches the side-on reference plate.
    // Reference camera sweep: a slightly wider FOV places the camera nearer at the same
    // angular framing, matching the photographed foreshortening better than the near-ortho 20°.
    if (demo.captureBounds) {
      viewer.frameForFixedCapture(
        demo.captureBounds.size,
        demo.captureBounds.center,
        activeCaptureCamera?.fov ?? 21,
        demo.captureMargin ?? 1.12,
        activeCaptureCamera,
      );
    } else {
      viewer.frameForCapture(activeCaptureCamera?.fov ?? 21, demo.captureMargin ?? 1.12, activeCaptureCamera);
    }
  }
  viewer.start();

  // --- collapsible details sheet ---------------------------------------------------------
  const panel = mount.querySelector<HTMLElement>('#demo-panel')!;
  const bar = mount.querySelector<HTMLElement>('.demo-panel-bar')!;
  const toggle = mount.querySelector<HTMLButtonElement>('#panel-toggle')!;
  const setExpanded = (next: boolean): void => {
    panelExpanded = next;
    panel.dataset.expanded = String(next);
    toggle.setAttribute('aria-expanded', String(next));
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

  return () => {
    window.clearTimeout(hintTimer);
    bar.removeEventListener('click', onBarClick);
    compact.removeEventListener('change', onCompactChange);
    canvasMount.removeEventListener('pointerdown', hideHint);
    resetCameraBtn?.removeEventListener('click', onResetCamera);
    resetExplosionBtn?.removeEventListener('click', onResetExplosion);
    explodeSlider?.removeEventListener('input', onExplosionInput);
    animationController?.stop();
    unsubscribeAnimation?.();
    for (const cleanup of animationButtonCleanups) cleanup();
    viewer.dispose();
  };
}
