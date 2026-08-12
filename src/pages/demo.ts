import * as THREE from 'three';
import { getDemo } from '../demos/registry';
import { Viewer, type PartInfo } from '../scene';
import { navigate } from '../router';
import { createScopeMode, type OpticSocket } from '../scopeMode';
import {
  createElectricMouseMascotLookDevLights,
  createElectricMouseMascotModel,
} from '../demos/electric-mouse-mascot/createElectricMouseMascotModel';

const GITHUB_URL = 'https://github.com/hoainho/img2threejs';

/** Viewports where the info panel becomes a collapsible bottom sheet over the model. */
const COMPACT_QUERY = '(max-width: 860px), (max-height: 520px)';

/**
 * Whether the details sheet is expanded, remembered across demo navigations within a session.
 * `null` = untouched, so each viewport gets its own sensible default (open on desktop, collapsed
 * on a phone, where an open panel would cover the model entirely).
 */
let panelExpanded: boolean | null = null;

function createAwpScopeMascotTarget(
  scene: THREE.Scene,
  model: THREE.Object3D,
  socket: OpticSocket,
): { setVisible: (visible: boolean) => void; triggerElectric: () => void; dispose: () => void } {
  model.updateWorldMatrix(true, true);
  const eye = socket.getWorldPosition(new THREE.Vector3());
  const axisArray = socket.userData.socket?.axis ?? [1, 0, 0];
  const axis = new THREE.Vector3(axisArray[0], axisArray[1], axisArray[2])
    .transformDirection(socket.matrixWorld)
    .normalize();

  const target = new THREE.Group();
  target.name = 'scope-target-electric-mouse';
  target.userData.effectOnly = true;
  target.position.copy(eye).addScaledVector(axis, 20);
  // The mascot is authored facing +Z. Turn that face toward the eye station.
  target.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().negate());

  const mascot = createElectricMouseMascotModel({ includeSpeechBubble: false });
  mascot.name = 'scope-target-electric-mouse-model';
  mascot.scale.setScalar(0.32);
  // The authored mascot origin is near its feet; lower it so its face/body centre sits on the
  // optical axis rather than touching the lower reticle edge.
  const mascotHolder = new THREE.Group();
  mascotHolder.name = 'scope-target-electric-mouse-holder';
  mascotHolder.position.y = -0.54;
  mascotHolder.add(mascot);
  target.add(mascotHolder, createElectricMouseMascotLookDevLights());

  // The rifle's inner tube is intentionally opaque outside its bore. Render this small scope-only
  // target above that tube, while keeping a stable layer order inside the mascot so the body does
  // not paint over its eyes and mouth when depth testing is bypassed.
  mascot.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh;
    const isFaceDetail = /Eye|EyeHighlight|Nose|Mouth|Tongue|Cheek/.test(mesh.name);
    mesh.renderOrder = isFaceDetail ? 220 : mesh.name === 'Body_Head_Main' ? 200 : 210;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      material.depthTest = false;
      material.depthWrite = false;
    });
  });

  const runtime = mascot.userData.electricMouseMascotRuntime as ReturnType<typeof createElectricMouseMascotModel>['userData']['electricMouseMascotRuntime'];
  target.userData.tick = (_dt: number, elapsed: number) => {
    if (target.visible) runtime.update(elapsed);
  };
  target.visible = false;
  scene.add(target);

  return {
    setVisible: (visible: boolean) => { target.visible = visible; },
    triggerElectric: () => { if (target.visible) runtime.triggerElectric(); },
    dispose: () => { target.removeFromParent(); },
  };
}

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
              <button class="btn btn-scope" id="demo-scope" type="button" aria-pressed="false" hidden>
                <span class="scope-glyph">&#9678;</span> <span class="scope-label">Look through scope</span>
              </button>
              <button class="btn btn-action" id="demo-fire" type="button" hidden>
                <span class="action-glyph">&#9889;</span> <span class="action-label">Fire</span>
              </button>
              <button class="btn btn-action btn-bipod" id="demo-bipod" type="button" aria-pressed="false" hidden>
                <span class="action-glyph">&#9660;</span> <span class="action-label">Deploy bipod</span>
              </button>
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
  const backCapture = new URLSearchParams(window.location.search).get('back') === '1';
  const cameraPosition: [number, number, number] = backCapture
    ? [-demo.cameraPosition[0], demo.cameraPosition[1], -demo.cameraPosition[2]]
    : demo.cameraPosition;

  // Per-demo tone-mapping (optional on the entry; read structurally so demo.ts is independent of
  // the DemoEntry field being declared). AgX preserves the Ruby-Doppler crimson that ACES washes.
  const toneMapping = (demo as { toneMapping?: 'aces' | 'agx' | 'neutral' }).toneMapping;

  const canvasMount = mount.querySelector<HTMLDivElement>('#demo-canvas-mount')!;
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
  });

  const model = demo.build(viewer.scene);
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
  // QA capture scripts may place a diagnostic camera on a named socket. This
  // is not part of the demo UI or model geometry; it exposes only the existing
  // viewer instance to the local evidence harness.
  (window as unknown as Record<string, unknown>).__IMG2THREEJS_VIEWER__ = viewer;
  const modelRuntime = model.userData.sculptRuntime as {
    pivots?: Record<string, unknown>;
    sockets?: Record<string, unknown>;
    actionAnchors?: Record<string, unknown>;
    colliders?: unknown[];
    adjacency?: unknown[];
    attachmentGate?: unknown;
    attachmentAudit?: unknown;
    destructionGroups?: Record<string, unknown>;
    logicalComponents?: Record<string, { kind?: string; binding?: string; boundMeshes?: string[] }>;
  } | undefined;
  (window as unknown as Record<string, unknown>).__IMG2THREEJS_RUNTIME__ = {
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
  // Responsive framing: keeps the authored desktop composition, dollies back on narrow/short
  // viewports so the whole subject stays in frame instead of being cropped away.
  viewer.fitToViewport(model);

  // Part tree published for the assembly gate (forge/stage4_review/check_part_coverage.py).
  // Set in capture mode too — that is the headless run the gate reads it from.
  const partManifest = viewer.partManifest();
  const logicalParts = Object.entries(modelRuntime?.logicalComponents ?? {}).map(([name, value]) => ({
    name,
    module: null,
    kind: value.kind ?? 'logical',
    triangles: 0,
    materials: [],
  }));
  // Logical entries describe a coverage binding only; they do not add
  // geometry, selectable meshes, or a camera-facing surface to the model.
  (window as unknown as Record<string, unknown>).__IMG2THREEJS_PARTS__ = {
    model: id,
    ...(partManifest ?? { parts: [], unnamedMeshes: 0, integralMeshes: 0 }),
    parts: [...(partManifest?.parts ?? []), ...logicalParts],
  };

  // Firing + bipod controls, driven purely by capabilities the model publishes
  // on `model.userData` (a `fire()` function and a `bipod` controller). No
  // demo-specific ids or special-casing — any future model gets the same
  // buttons by publishing the same hooks. Suppressed in capture mode.
  const modelHooks = model.userData as {
    fire?: () => boolean;
    bipod?: { deployed?: boolean; toggle?: () => boolean };
  };
  const fireBtn = mount.querySelector<HTMLButtonElement>('#demo-fire');
  if (fireBtn && typeof modelHooks.fire === 'function' && !capture) {
    // Cinematic recoil punch: the authored framing sits tight on the weapon
    // body, so a muzzle flash at the bore would fire off-frame. When the shot
    // goes off, briefly dolly the camera back along its own view direction so
    // the flash, tracer streak and barrel enter frame, then ease home. Orbit
    // controls come back the moment the camera settles. Skipped while scoped
    // (the optic owns the camera there) and while a punch is already running.
    let punchRaf = 0;
    let punching = false;
    const punchEase = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const firePunch = (): void => {
      if (punching || scopeMode?.active) return;
      punching = true;
      cancelAnimationFrame(punchRaf);
      const from = viewer.camera.position.clone();
      const toward = viewer.controls.target;
      const dir = from.clone().sub(toward);
      const len = dir.length();
      if (len < 1e-6) { punching = false; return; }
      const to = from.clone().addScaledVector(dir.normalize(), Math.min(5.5, len * 0.48));
      const wasEnabled = viewer.controls.enabled;
      viewer.controls.enabled = false;
      const t0 = performance.now();
      const out = (now: number): void => {
        const k = punchEase(Math.min(1, (now - t0) / 280));
        viewer.camera.position.lerpVectors(from, to, k);
        viewer.controls.update();
        if (k < 1) { punchRaf = requestAnimationFrame(out); return; }
        const t1 = performance.now();
        const back = (now2: number): void => {
          const k2 = punchEase(Math.min(1, (now2 - t1) / 520));
          viewer.camera.position.lerpVectors(to, from, k2);
          viewer.controls.update();
          if (k2 < 1) { punchRaf = requestAnimationFrame(back); return; }
          viewer.controls.enabled = wasEnabled;
          punching = false;
        };
        punchRaf = requestAnimationFrame(back);
      };
      punchRaf = requestAnimationFrame(out);
    };
    fireBtn.hidden = false;
    fireBtn.addEventListener('click', () => {
      if (modelHooks.fire?.()) {
        firePunch();
        // Scoped shots land on the reticle — the hit marker and ring play on
        // the optic overlay (no-op outside scope mode).
        scopeMode?.hit();
        scopeTarget?.triggerElectric();
      }
    });
    // Cancel a half-finished punch when the route unmounts so the camera never
    // stays pinned mid-flight for the next demo.
    (mount as HTMLElement & { __firePunchCancel__?: () => void }).__firePunchCancel__ = () => {
      cancelAnimationFrame(punchRaf);
      viewer.controls.enabled = true;
    };
  }
  const bipodBtn = mount.querySelector<HTMLButtonElement>('#demo-bipod');
  const bipodApi = modelHooks.bipod;
  if (bipodBtn && bipodApi && typeof bipodApi.toggle === 'function' && !capture) {
    const syncBipod = (): void => {
      const deployed = !!bipodApi.deployed;
      bipodBtn.setAttribute('aria-pressed', String(deployed));
      bipodBtn.classList.toggle('is-active', deployed);
      const label = bipodBtn.querySelector('.action-label')!;
      label.textContent = deployed ? 'Fold bipod' : 'Deploy bipod';
    };
    bipodBtn.hidden = false;
    bipodBtn.addEventListener('click', () => { bipodApi.toggle?.(); syncBipod(); });
    syncBipod();
  }

  // Explode control. Hidden for single-mesh demos and in capture mode, where the panel is
  // hidden anyway and the evaluation frame must stay deterministic.
  // Look-through-the-optic mode. Offered only when the MODEL publishes a `scope-sight-line` socket,
  // so this stays data-driven rather than special-casing the rifle. Suppressed in capture mode, where
  // the evaluation frame must stay deterministic.
  const scopeBtn = mount.querySelector<HTMLButtonElement>('#demo-scope');
  const sightSocket = modelRuntime?.sockets?.['scope-sight-line'] as OpticSocket | undefined;
  const scopeTarget = !capture && id === 'awp-medusa-v2' && sightSocket
    ? createAwpScopeMascotTarget(viewer.scene, model, sightSocket)
    : null;
  const scopeMode = capture ? null : createScopeMode(viewer, canvasMount, model, sightSocket, {
    onActiveChange: (active) => scopeTarget?.setVisible(active),
  });
  if (scopeBtn && scopeMode) {
    scopeBtn.hidden = false;
    const label = scopeBtn.querySelector('.scope-label')!;
    scopeBtn.addEventListener('click', () => {
      scopeMode.toggle();
      scopeBtn.setAttribute('aria-pressed', String(scopeMode.active));
      scopeBtn.classList.toggle('is-active', scopeMode.active);
      label.textContent = scopeMode.active ? 'Exit scope' : 'Look through scope';
    });
  }

  const explodeBtn = mount.querySelector<HTMLButtonElement>('#demo-explode');
  if (explodeBtn && demo.enableExplode !== false && viewer.canExplode && !capture) {
    explodeBtn.hidden = false;
    let exploded = false;
    explodeBtn.addEventListener('click', () => {
      exploded = !exploded;
      viewer.setExplode(exploded ? 1 : 0);
      explodeBtn.setAttribute('aria-pressed', String(exploded));
      explodeBtn.classList.toggle('is-active', exploded);
      explodeBtn.querySelector('.explode-label')!.textContent = exploded ? 'Assemble' : 'Explode parts';
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
    // Flat white bg + hide the UI overlay + freeze per-frame animation so the evaluation
    // frame is deterministic and shows only the object (matches the reference plate).
    viewer.scene.background = new THREE.Color(0xffffff);
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
    (mount as HTMLElement & { __firePunchCancel__?: () => void }).__firePunchCancel__?.();
    scopeMode?.dispose();
    scopeTarget?.dispose();
    animationController?.stop();
    unsubscribeAnimation?.();
    for (const cleanup of animationButtonCleanups) cleanup();
    viewer.dispose();
  };
}
