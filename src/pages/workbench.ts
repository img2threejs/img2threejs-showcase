import { demos, getDemo, loadDemo, type DemoEntry, type DemoMetadata } from '../demos/registry';
import { Viewer, type PartInfo } from '../scene';
import { parseRoute, replaceHashSilently } from '../router';
import { createLoader, whenViewerReady, type Loader } from '../loader';
import { DRAWERS } from '../content';
import {
  brand,
  CURRENT_VERSION,
  DONATE_URL,
  GITHUB_CORE,
  SPONSORS,
  X_URL,
  YOUTUBE_URL,
  extractVersion,
  escapeAttr,
} from '../site-data';
import {
  trackAnimationPlay,
  trackAnimationStop,
  trackDrawerOpen,
  trackExhibitPrewarmFailed,
  trackExhibitReady,
  trackExhibitView,
  trackExplode,
  trackFaqOpen,
  trackLinkClick,
  trackOpenFullViewer,
  trackPageView,
  trackPaletteOpen,
  trackPartSelect,
  trackSearch,
  trackSourceClick,
  trackSponsorImpression,
  trackViewerInteract,
  resetExhibitOnceKeys,
  setAnalyticsOptOut,
  type ExhibitEntry,
} from '../analytics';
import { STANDARD_PROMPTS } from '../standard-prompts';

const PIPELINE_STAGES = [
  {
    id: 'blockout',
    label: 'Blockout',
    summary: 'Lock the silhouette, camera and broad proportions before detail can hide a bad read.',
    artifact: 'proportion + silhouette study',
    gate: 'map-stripped comparison',
  },
  {
    id: 'structural',
    label: 'Structural',
    summary: 'Split the subject into named, inspectable parts with real relationships and attachment logic.',
    artifact: 'component hierarchy',
    gate: 'part coverage',
  },
  {
    id: 'form',
    label: 'Form',
    summary: 'Shape the secondary volumes, bevels, contours and transitions that make the subject recognisable.',
    artifact: 'refined geometry',
    gate: 'multi-angle review',
  },
  {
    id: 'material',
    label: 'Material',
    summary: 'Assign physically meaningful regions and derive finish behaviour from visible reference evidence.',
    artifact: 'material regions',
    gate: 'per-region acceptance',
  },
  {
    id: 'surface',
    label: 'Surface',
    summary: 'Add the projected or procedural markings, seams, wear and micro-detail that carry identity.',
    artifact: 'surface evidence',
    gate: 'interior difference',
  },
  {
    id: 'lighting',
    label: 'Lighting',
    summary: 'Match the reference read without letting a flattering studio setup compensate for weak geometry.',
    artifact: 'camera + light rig',
    gate: 'controlled render',
  },
  {
    id: 'interaction',
    label: 'Interaction',
    summary: 'Expose pivots, sockets, named parts and an idle tick so the result behaves like an asset, not a still.',
    artifact: 'action-ready runtime',
    gate: 'pivot + socket check',
  },
  {
    id: 'optimization',
    label: 'Optimization',
    summary: 'Reduce triangles and draw calls only after the likeness gates have protected the detail that matters.',
    artifact: 'budgeted factory',
    gate: 'geometry truth',
  },
] as const;

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

type AnimationController = {
  actions: ReadonlyArray<{ id: string; label: string; loop: boolean }>;
  readonly active: string;
  play: (name: string) => void;
  stop: () => void;
  subscribe: (listener: (active: string) => void) => () => void;
};

/**
 * The exhibit the workbench opens on: the first one in the gallery, whatever that is.
 *
 * The registry sorts newest-first, so this is the most recent piece of work — which is the one a
 * first-time visitor should meet. It used to skip any exhibit declaring `prewarm`, on the reasoning
 * that a multi-second field precompute is a poor first impression. That trade stopped being worth
 * it once the newest exhibits became the heavy ones: the site opened on a months-old model while
 * the work it exists to show sat three places down the rail, and the landing URL was rewritten to
 * that older exhibit as if the visitor had asked for it.
 *
 * The wait is real and is handled where it belongs — the heavy exhibits ship `detailLevels` and
 * open at their lowest, and the loader covers the gap — rather than by showing something else.
 */
function defaultExhibit(): DemoMetadata {
  return demos[0];
}

/* ------------------------------------------------------------------- render */

/**
 * The workbench: one persistent full-bleed canvas with the information laid over it, and an
 * exhibit rail that swaps the model in place instead of navigating. Everything it shows about a
 * model — triangle counts, part names, animation actions — is read back off the live scene through
 * the existing `Viewer` API rather than restated in this file, so a number on screen cannot drift
 * from the geometry that is actually running.
 */
export function renderWorkbench(
  mount: HTMLElement,
  opts: { focusId?: string; drawer?: string } = {},
): () => void {
  const { focusId, drawer: initialDrawer } = opts;
  const initial = (focusId && getDemo(focusId)) || defaultExhibit();
  let index = Math.max(0, demos.indexOf(initial));
  /**
   * Whether the address bar is currently describing a chosen exhibit.
   *
   * False on the landing load: a visitor who typed the bare domain has not asked for any particular
   * exhibit, and rewriting their URL to `#/x/<whatever-is-first>` reads as the site redirecting
   * them. It flips the first time they actually pick one, and from then on the URL follows the rail
   * so an exhibit stays shareable.
   */
  let urlOwnedByExhibit = false;

  const railThumbs = demos
    .map(
      (demo, i) => `
      <button type="button" class="rail-item" data-index="${i}" role="tab"
              aria-selected="${i === index}" aria-label="${String(i + 1).padStart(2, '0')} — View ${escapeAttr(demo.title)}"
              title="${escapeAttr(demo.title)}">
        <img src="${demo.referenceImage}" alt="" loading="lazy"
             onerror="this.classList.add('missing')" />
        <span class="rail-num mono">${String(i + 1).padStart(2, '0')}</span>
      </button>`,
    )
    .join('');

  // Standalone product experiences share the archive card and filters while keeping their viewer.
  const archiveEntries = [
    {
      id: 'iphone-duo',
      title: 'iPhone Duo — A Whole New Dimension',
      subjectClass: 'object',
      blurb: 'A folding-phone showcase with a continuous display, six finishes and two release sequences. '
        + 'Inspect the model and explore the img2threejs workflow behind the experience.',
      referenceImage: `${import.meta.env.BASE_URL}iphone-duo/showcase-preview.webp`,
      imageAlt: 'iPhone Duo showcase with the continuous display open',
      imageLabel: 'Showcase preview',
      href: `${import.meta.env.BASE_URL}iphone-duo.html#explore`,
      status: 'final',
      generationLabel: 'Product Study',
      generatedWith: 'img2threejs · Product Study',
      referenceLabel: 'Measured Model',
      linkLabel: 'Open Live 3D Showcase',
    },
    ...demos.map((demo) => ({
      ...demo,
      imageAlt: `Reference used to reconstruct ${demo.title}`,
      imageLabel: 'Reference image',
      href: `#/demo/${demo.id}`,
      generationLabel: extractVersion(demo.generatedWith) ?? CURRENT_VERSION,
      referenceLabel: demo.referenceKind === 'model' ? 'Measured Model' : 'Image Reference',
      linkLabel: 'Open Live 3D Inspector',
    })),
  ];
  const archiveCharacterCount = archiveEntries.filter((demo) => demo.subjectClass === 'character').length;
  const archiveObjectCount = archiveEntries.length - archiveCharacterCount;
  const archiveCards = archiveEntries
    .map(
      (demo, i) => `
      <a class="archive-card" href="${demo.href}" data-archive-subject="${demo.subjectClass}">
        <div class="archive-card-surface">
          <figure class="archive-image">
            <span class="archive-live mono">${escapeAttr(demo.imageLabel)}</span>
            <span class="archive-model-stage">
              <img src="${demo.referenceImage}" alt="${escapeAttr(demo.imageAlt)}" loading="lazy"
                   onerror="this.classList.add('missing')" />
            </span>
            <span class="archive-viewer-cue mono" aria-hidden="true">${escapeAttr(demo.linkLabel)}</span>
            <figcaption class="mono">${String(i + 1).padStart(2, '0')} / ${demo.subjectClass}</figcaption>
          </figure>
          <div class="archive-copy">
            <div class="archive-card-head">
              <p class="archive-status mono">${demo.status === 'final' ? 'Released Study' : 'Working Study'}</p>
              <span class="archive-card-index mono">${String(i + 1).padStart(2, '0')}</span>
            </div>
            <h3>${escapeAttr(demo.title)}</h3>
            <p class="archive-description">${brand(demo.blurb)}</p>
            <div class="archive-meta mono">
              <span>Live 3D on open</span>
              <span>${escapeAttr(demo.generationLabel)}</span>
              <span>${escapeAttr(demo.referenceLabel)}</span>
            </div>
            <span class="archive-link">${escapeAttr(demo.linkLabel)} <span aria-hidden="true">↗</span></span>
          </div>
        </div>
      </a>`,
    )
    .join('');

  const pipelineButtons = PIPELINE_STAGES.map(
    (stage, i) => `
      <button type="button" class="pipeline-step${i === 0 ? ' is-active' : ''}"
              id="pipeline-tab-${stage.id}" tabindex="${i === 0 ? '0' : '-1'}"
              data-pipeline-index="${i}" role="tab" aria-selected="${i === 0}"
              aria-controls="pipeline-stage-detail">
        <span class="pipeline-step-num mono">${String(i + 1).padStart(2, '0')}</span>
        <span>${stage.label}</span>
      </button>`,
  ).join('');

  const promptTabs = STANDARD_PROMPTS.map(
    (template, i) => `
      <button type="button" class="prompt-tab${i === 0 ? ' is-active' : ''}"
              id="prompt-tab-${template.id}" tabindex="${i === 0 ? '0' : '-1'}"
              data-prompt-index="${i}" role="tab" aria-selected="${i === 0}"
              aria-controls="prompt-panel">${template.label}</button>`,
  ).join('');

  const sponsorSlides = SPONSORS.map(
    (sponsor, i) => `
      <article class="sponsor-slide${i === 0 ? ' is-active' : ''}" data-sponsor-index="${i}"
               role="group" aria-roledescription="slide"
               aria-label="${i + 1} of ${SPONSORS.length}: ${escapeAttr(sponsor.name)}"
               aria-hidden="${i !== 0}">
        <div class="sponsor-brand-field">
          <span class="sponsor-signal mono">PARTNER SIGNAL / ${String(i + 1).padStart(2, '0')}</span>
          <div class="sponsor-mark">
            <img src="${sponsor.logo}" alt="" />
            <strong>${escapeAttr(sponsor.name)}</strong>
          </div>
          <span class="sponsor-orbit" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <div class="sponsor-story">
          <p class="sponsor-label mono">SPONSOR / ${escapeAttr(sponsor.name)}</p>
          <h3>${escapeAttr(sponsor.headline)}</h3>
          <p>${escapeAttr(sponsor.blurb)}</p>
          <p class="sponsor-pairing"><span>Why it fits the loop</span>${brand(escapeAttr(sponsor.pairing))}</p>
          <a class="sponsor-link" href="${sponsor.url}" target="_blank" rel="sponsored noopener noreferrer">
            ${escapeAttr(sponsor.cta)} <span aria-hidden="true">↗</span>
          </a>
        </div>
      </article>`,
  ).join('');

  const sponsorDots = SPONSORS.map(
    (sponsor, i) => `
      <button type="button" class="sponsor-dot${i === 0 ? ' is-active' : ''}"
              data-sponsor-dot="${i}" aria-label="Show ${escapeAttr(sponsor.name)}"
              aria-pressed="${i === 0 ? 'true' : 'false'}">
        <span class="mono">${String(i + 1).padStart(2, '0')}</span>${escapeAttr(sponsor.name)}
      </button>`,
  ).join('');

  mount.innerHTML = `
    <div class="wb">
      <div class="scroll-progress" aria-hidden="true"><span></span></div>
      <a class="skip-link" href="#workbench-main" data-jump="#workbench-main" data-jump-focus>Skip to the live model</a>
      <header class="wb-top">
        <a class="wb-brand" href="#/">
          <img src="${import.meta.env.BASE_URL}favicon.svg" alt="" width="22" height="22" />
          <span>img<span class="wb-brand-2">2</span>threejs</span>
          <span class="wb-ver mono">open source · ${CURRENT_VERSION}</span>
        </a>
        <nav class="wb-nav" aria-label="Sections">
          <a class="wb-navlink" href="#pipeline" data-jump="#pipeline">Pipeline</a>
          <a class="wb-navlink" href="#prompt-guide" data-jump="#prompt-guide">Prompt Kit</a>
          <a class="wb-navlink" href="#sponsors" data-jump="#sponsors">Sponsors</a>
          <a class="wb-navlink" href="#archive" data-jump="#archive">Archive</a>
        </nav>
        <div class="wb-top-right">
          <button type="button" class="wb-search" id="wb-open-palette">
            <span>Find a Study</span><kbd class="mono">⌘K</kbd>
          </button>
          <a class="wb-star" href="${GITHUB_CORE}" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
          <a class="wb-support" href="${DONATE_URL}" data-placement="header_support">Donate</a>
          <button type="button" class="wb-sponsor" data-drawer="sponsor">Become a Sponsor</button>
          <!-- Phone/tablet only: the link row above is hidden for width, and without this the
               content pages have no tappable route in at all. -->
          <button type="button" class="wb-menu" data-drawer="menu" aria-label="Open menu">
            <span aria-hidden="true"></span>
          </button>
        </div>
      </header>

      <main class="wb-stage" id="workbench-main" tabindex="-1">
        <section class="wb-caption">
          <p class="wb-kicker mono">IMAGE → TYPESCRIPT → LIVE SCENE</p>
          <h1 class="wb-pitch">
            Build the mesh.<br /><em>Keep the source.</em>
          </h1>
          <p class="hero-lede">
            img2threejs studies one reference, writes the geometry as maintainable TypeScript,
            and checks every pass against the image. The result is not a sealed asset. It is code
            you can inspect, animate and change.
          </p>
          <div class="hero-proof" aria-label="Workflow summary">
            <div><span class="mono">01</span><p>One Reference</p></div>
            <div><span class="mono">08</span><p>Gated Passes</p></div>
            <div><span class="mono">.ts</span><p>Code-Native Output</p></div>
          </div>
          <div class="wb-caption-actions">
            <a class="btn btn-accent" id="wb-open-full" href="#/demo/${initial.id}">Explore the Live Model <span aria-hidden="true">↗</span></a>
            <a class="text-link hero-process-link" href="#pipeline" data-jump="#pipeline">See How It Is Built <span aria-hidden="true">↓</span></a>
          </div>
          <nav class="hero-social" aria-label="Follow img2threejs">
            <span class="mono">FOLLOW THE BUILD LOG</span>
            <a href="${YOUTUBE_URL}" target="_blank" rel="noopener noreferrer">YouTube ↗</a>
            <a href="${X_URL}" target="_blank" rel="noopener noreferrer">X / @NickDevFE ↗</a>
          </nav>
          <div class="hero-code" aria-label="Example generated TypeScript">
            <div class="hero-code-top mono"><span>createModel.ts</span><span>GENERATED / EDITABLE</span></div>
            <pre><code><span>export function</span> createModel(scene: THREE.Scene) {
  <i>const</i> model = <b>new</b> THREE.Group();
  model.userData.tick = (dt) =&gt; animate(dt);
  scene.add(model);
  <span>return</span> model;
}</code></pre>
          </div>
        </section>

        <section class="hero-visual" aria-label="Live procedural Three.js result">
          <div class="wb-canvas" id="wb-canvas"></div>
          <p class="wb-edition mono"><span></span> LIVE WEBGL / CODE-BUILT</p>
          <figure class="wb-ref" id="wb-ref">
            <img id="wb-ref-img" alt="" onerror="this.classList.add('missing')" />
            <figcaption class="label">01 / SOURCE IMAGE</figcaption>
          </figure>
          <div class="hero-output">
            <div>
              <span class="label">LIVE OUTPUT / <b class="mono" id="rail-count"></b></span>
              <h2 class="wb-title" id="wb-title" aria-live="polite"></h2>
            </div>
            <p class="wb-blurb" id="wb-blurb"></p>
            <a class="hero-source" id="wb-open-source" href="${initial.sourceUrl}" target="_blank" rel="noopener noreferrer" data-track-skip>View Source ↗</a>
          </div>
          <div class="hero-transform" aria-hidden="true">
            <span>reference</span><i></i><span>factory.ts</span><i></i><span>runtime</span>
          </div>
          <p class="wb-orbit-note mono" aria-hidden="true"><span></span> drag to orbit / click to inspect</p>
        </section>

        <!-- The full inspection UI still exists on the dedicated demo route. These hidden nodes
             keep the live landing model wired to the same truthful runtime measurements without
             turning the hero back into a dashboard. -->
        <aside class="wb-side" hidden aria-hidden="true">
          <section class="wb-panel wb-readout">
            <h2 class="label">Readout</h2>
            <dl id="wb-specs"></dl>
          </section>

          <section class="wb-panel wb-controls" id="wb-controls" hidden>
            <h2 class="label">Controls</h2>
            <div class="wb-explode">
              <label class="wb-slider-label" for="wb-explode-range">
                <span>Explode</span><output class="mono" id="wb-explode-out">0.00</output>
              </label>
              <input type="range" id="wb-explode-range" min="0" max="1" step="0.01" value="0" />
            </div>
            <div class="wb-actions" id="wb-anim-actions"></div>
          </section>

          <section class="wb-panel wb-parts" id="wb-parts" hidden>
            <h2 class="label">Parts <span class="wb-parts-count mono" id="wb-parts-count"></span></h2>
            <div class="wb-part-selected" id="wb-part-selected" hidden></div>
            <ul class="wb-part-list" id="wb-part-list"></ul>
          </section>
        </aside>
      </main>

      <footer class="wb-rail" hidden aria-hidden="true">
        <button type="button" class="rail-arrow" id="rail-prev" aria-label="Previous exhibit">&#8249;</button>
        <div class="rail-track" id="rail-track" role="tablist" aria-label="Exhibits">${railThumbs}</div>
        <button type="button" class="rail-arrow" id="rail-next" aria-label="Next exhibit">&#8250;</button>
      </footer>

      <section class="pipeline" id="pipeline" aria-labelledby="pipeline-title">
        <header class="section-head pipeline-head">
          <p class="section-index mono">01 / THE PIPELINE</p>
          <div class="section-title-wrap">
            <h2 id="pipeline-title">Eight passes.<br /><em>No hidden mesh.</em></h2>
            <p>The order comes directly from the img2threejs workflow. Every pass produces an inspectable artifact and must clear a gate before the next one starts.</p>
          </div>
          <button type="button" class="text-link section-deep-link" data-drawer="how-it-works">Read the Full Process <span aria-hidden="true">↗</span></button>
        </header>

        <div class="pipeline-lab">
          <div class="pipeline-steps" role="tablist" aria-label="Reconstruction stages">${pipelineButtons}</div>
          <div class="pipeline-stage" id="pipeline-stage-detail" role="tabpanel" aria-labelledby="pipeline-tab-blockout">
            <div class="pipeline-visual" aria-hidden="true">
              <div class="pipeline-grid"></div>
              <span class="pipeline-axis pipeline-axis-x"></span>
              <span class="pipeline-axis pipeline-axis-y"></span>
              <div class="pipeline-object">
                <span class="pipeline-plane plane-a"></span>
                <span class="pipeline-plane plane-b"></span>
                <span class="pipeline-plane plane-c"></span>
                <span class="pipeline-core"></span>
              </div>
              <div class="pipeline-scan"></div>
              <p class="pipeline-visual-label mono">LIVE PASS / <span id="pipeline-visual-id">BLOCKOUT</span></p>
            </div>
            <div class="pipeline-detail">
              <div class="pipeline-detail-head">
                <span class="pipeline-current mono" id="pipeline-current">01 / 08</span>
                <div class="pipeline-sequence-controls">
                  <span class="pipeline-auto mono" aria-hidden="true"><i></i><span id="pipeline-auto-label">AUTO SEQUENCE</span></span>
                  <button type="button" class="sequence-toggle" id="pipeline-sequence-toggle"
                          aria-label="Pause automatic pipeline sequence">
                    Pause sequence
                  </button>
                </div>
              </div>
              <h3 id="pipeline-stage-name">Blockout</h3>
              <p id="pipeline-stage-summary">${PIPELINE_STAGES[0].summary}</p>
              <dl class="pipeline-facts">
                <div><dt class="mono">Artifact</dt><dd id="pipeline-stage-artifact">${PIPELINE_STAGES[0].artifact}</dd></div>
                <div><dt class="mono">Gate</dt><dd id="pipeline-stage-gate">${PIPELINE_STAGES[0].gate}</dd></div>
              </dl>
              <div class="pipeline-meter" aria-hidden="true"><span></span></div>
            </div>
          </div>
        </div>
      </section>

      <section class="prompt-guide" id="prompt-guide" aria-labelledby="prompt-guide-title">
        <header class="section-head prompt-head">
          <p class="section-index mono">02 / STANDARD PROMPTS</p>
          <div class="section-title-wrap">
            <h2 id="prompt-guide-title">Choose the Job.<br /><em>Copy the Standard.</em></h2>
            <p>Four canonical prompts cover reconstruction, measured GLB parity, bounded polish and clip-driven VFX. Choose the job, replace every placeholder and run it as one prompt.</p>
          </div>
          <a class="text-link section-deep-link" href="${GITHUB_CORE}/tree/main/docs/standard-prompts" target="_blank" rel="noopener noreferrer">View Canonical Prompts <span aria-hidden="true">↗</span></a>
        </header>

        <div class="prompt-workspace">
          <div class="guide-flow">
            <article><span class="mono">01</span><div><h3>Choose the Job</h3><p>Build from a reference, force measurements from a GLB, correct one defect, or add VFX to working clips.</p></div></article>
            <article><span class="mono">02</span><div><h3>Replace Every Placeholder</h3><p>Supply the real paths, subject name, demo id, profile and cycle budget the selected prompt requests.</p></div></article>
            <article><span class="mono">03</span><div><h3>Respect the Exit Condition</h3><p>Produce the requested evidence, stop only for the named blockers and report what still does not match.</p></div></article>
            <aside class="guide-rule">
              <span class="mono">THE SHARED RULE</span>
              <p>“A gate is a question. Answer it with evidence, or say you could not — never by lowering the bar, and never by stopping before you have tried to produce the evidence it asked for.”</p>
            </aside>
          </div>
          <div class="prompt-console">
            <div class="prompt-console-top">
              <div class="prompt-tabs" role="tablist" aria-label="Prompt templates">${promptTabs}</div>
              <button type="button" class="prompt-copy" id="prompt-copy"><span>Copy Prompt</span><i aria-hidden="true"></i></button>
            </div>
            <pre id="prompt-panel" role="tabpanel" aria-labelledby="prompt-tab-${STANDARD_PROMPTS[0].id}"
                 tabindex="0" aria-label="Selected prompt. Scroll to read the complete template."><code id="prompt-code">${escapeAttr(STANDARD_PROMPTS[0].prompt)}</code></pre>
            <div class="prompt-console-foot mono">
              <span>SCROLL PROMPT / REPLACE PLACEHOLDERS / RUN AS ONE PROMPT</span>
              <a id="prompt-source" href="${STANDARD_PROMPTS[0].sourceUrl}" target="_blank" rel="noopener noreferrer">OPEN CANONICAL SOURCE ↗</a>
            </div>
          </div>
        </div>
      </section>

      <section class="sponsors" id="sponsors" aria-labelledby="sponsors-title">
        <header class="sponsor-head">
          <p class="section-index mono">03 / SPONSOR SIGNAL</p>
          <div>
            <h2 id="sponsors-title">Tools that keep<br />the loop <em>moving.</em></h2>
            <p>Selected partners support the open-source work. Each one solves a real problem around the reconstruction loop.</p>
          </div>
          <div class="sponsor-invite">
            <span class="sponsor-invite-label mono">Partnerships Open</span>
            <button type="button" class="text-link" data-drawer="sponsor">
              Become a Sponsor <span aria-hidden="true">↗</span>
            </button>
            <small>Logo · Story · Direct Link</small>
          </div>
        </header>
        <div class="sponsor-carousel" aria-roledescription="carousel" aria-label="Project sponsors">
          <div class="sponsor-slides" aria-live="off">${sponsorSlides}</div>
          <div class="sponsor-controls">
            <div class="sponsor-dots">${sponsorDots}</div>
            <div class="sponsor-arrows">
              <button type="button" id="sponsor-prev" aria-label="Previous sponsor">←</button>
              <button type="button" class="sequence-toggle" id="sponsor-sequence-toggle"
                      aria-label="Pause automatic sponsor rotation">
                Pause rotation
              </button>
              <button type="button" id="sponsor-next" aria-label="Next sponsor">→</button>
            </div>
          </div>
          <p class="wb-sr-only" id="sponsor-status" aria-live="polite" aria-atomic="true"></p>
          <div class="sponsor-progress" aria-hidden="true"><span></span></div>
        </div>
        <aside class="community-support" data-placement="landing_support" aria-labelledby="community-support-title">
          <div>
            <p class="section-index mono">COMMUNITY SUPPORT</p>
            <h3 id="community-support-title">Help fund another open build.</h3>
            <p>A one-time donation supports hosting and reconstruction runs. Commercial sponsorship is the separate route for logo, story and direct-link placement.</p>
          </div>
          <a class="btn btn-accent" href="${DONATE_URL}">Donate to img2threejs <span aria-hidden="true">↗</span></a>
        </aside>
      </section>

      <section class="archive" id="archive" aria-labelledby="archive-title">
        <header class="archive-head section-head">
          <p class="section-index mono">04 / THE ARCHIVE</p>
          <div class="section-title-wrap">
            <h2 id="archive-title">A library of<br /><em>working geometry.</em></h2>
            <p>Explore live Three.js studies: orbit models, play their animations and discover how each one was made. Each card opens its interactive viewer.</p>
          </div>
          <p class="archive-count mono">${String(archiveEntries.length).padStart(2, '0')} STUDIES<br />OBJECTS + CHARACTERS</p>
        </header>
        <div class="archive-toolbar" aria-label="Archive Controls">
          <div class="archive-filters" role="group" aria-label="Filter Studies">
            <button type="button" class="archive-filter is-active" data-archive-filter="all" aria-pressed="true">
              <span>All Studies</span><strong class="mono">${String(archiveEntries.length).padStart(2, '0')}</strong>
            </button>
            <button type="button" class="archive-filter" data-archive-filter="character" aria-pressed="false">
              <span>Characters</span><strong class="mono">${String(archiveCharacterCount).padStart(2, '0')}</strong>
            </button>
            <button type="button" class="archive-filter" data-archive-filter="object" aria-pressed="false">
              <span>Objects</span><strong class="mono">${String(archiveObjectCount).padStart(2, '0')}</strong>
            </button>
          </div>
          <p class="archive-filter-status mono" id="archive-filter-status" aria-live="polite">
            <span>On View</span><strong>06 / ${String(archiveEntries.length).padStart(2, '0')}</strong>
          </p>
        </div>
        <div class="archive-grid" id="archive-grid">${archiveCards}</div>
        <button type="button" class="archive-more" id="archive-more" aria-expanded="false" aria-controls="archive-grid">
          <span>Show the Complete Archive</span><strong class="mono">06 / ${String(archiveEntries.length).padStart(2, '0')}</strong>
        </button>
      </section>

      <footer class="site-footer">
        <div class="footer-mark">img<span>2</span>threejs</div>
        <p>One reference image. A model you can inspect, animate and maintain as code.</p>
        <nav aria-label="Project links">
          <a href="${YOUTUBE_URL}" target="_blank" rel="noopener noreferrer">YouTube ↗</a>
          <a href="${X_URL}" target="_blank" rel="noopener noreferrer">X ↗</a>
          <a href="${DONATE_URL}" data-placement="footer_support">Donate</a>
          <button type="button" data-drawer="privacy">Privacy</button>
          <button type="button" data-drawer="attribution">Attribution</button>
          <button type="button" data-drawer="faq">FAQ</button>
          <a href="${GITHUB_CORE}" target="_blank" rel="noopener noreferrer">Source ↗</a>
        </nav>
        <span class="mono">© ${new Date().getFullYear()} / APACHE 2.0</span>
      </footer>

      <!-- drawers -->
      <div class="wb-scrim" id="wb-scrim" hidden aria-hidden="true"></div>
      <aside class="wb-drawer" id="wb-drawer" hidden aria-modal="true" role="dialog" tabindex="-1">
        <button type="button" class="wb-drawer-close" id="wb-drawer-close" aria-label="Close">&#215;</button>
        <div class="wb-drawer-body" id="wb-drawer-body"></div>
      </aside>

      <!-- command palette -->
      <div class="wb-palette" id="wb-palette" hidden role="dialog" aria-modal="true" aria-label="Jump to exhibit" tabindex="-1">
        <div class="pal-box">
          <label class="wb-sr-only" for="pal-input">Search exhibits</label>
          <input type="text" id="pal-input" class="pal-input" role="combobox" aria-expanded="true"
                 aria-controls="pal-list" aria-autocomplete="list" placeholder="Jump to an Exhibit…"
                 autocomplete="off" spellcheck="false" />
          <ul class="pal-list" id="pal-list" role="listbox" aria-label="Matching exhibits"></ul>
        </div>
      </div>
    </div>
  `;

  /* ------------------------------------------------------------ element refs */
  const canvasMount = mount.querySelector<HTMLElement>('#wb-canvas')!;
  const refImg = mount.querySelector<HTMLImageElement>('#wb-ref-img')!;
  const titleEl = mount.querySelector<HTMLElement>('#wb-title')!;
  const blurbEl = mount.querySelector<HTMLElement>('#wb-blurb')!;
  const specsEl = mount.querySelector<HTMLElement>('#wb-specs')!;
  const openFull = mount.querySelector<HTMLAnchorElement>('#wb-open-full')!;
  const openSource = mount.querySelector<HTMLAnchorElement>('#wb-open-source')!;
  const controlsEl = mount.querySelector<HTMLElement>('#wb-controls')!;
  const explodeRange = mount.querySelector<HTMLInputElement>('#wb-explode-range')!;
  const explodeOut = mount.querySelector<HTMLOutputElement>('#wb-explode-out')!;
  const animActions = mount.querySelector<HTMLElement>('#wb-anim-actions')!;
  const partsEl = mount.querySelector<HTMLElement>('#wb-parts')!;
  const partsCount = mount.querySelector<HTMLElement>('#wb-parts-count')!;
  const partList = mount.querySelector<HTMLElement>('#wb-part-list')!;
  const partSelected = mount.querySelector<HTMLElement>('#wb-part-selected')!;
  const railTrack = mount.querySelector<HTMLElement>('#rail-track')!;
  const railCount = mount.querySelector<HTMLElement>('#rail-count')!;
  const scrim = mount.querySelector<HTMLElement>('#wb-scrim')!;
  const drawer = mount.querySelector<HTMLElement>('#wb-drawer')!;
  const drawerBody = mount.querySelector<HTMLElement>('#wb-drawer-body')!;
  const palette = mount.querySelector<HTMLElement>('#wb-palette')!;
  const palInput = mount.querySelector<HTMLInputElement>('#pal-input')!;
  const palList = mount.querySelector<HTMLElement>('#pal-list')!;

  /* ------------------------------------------------------------ viewer state */
  let viewer: Viewer | null = null;
  let loader: Loader | null = null;
  let loadError: HTMLElement | null = null;
  let unsubscribeAnimation: (() => void) | null = null;
  /** Bumped on every load; an async prewarm that resolves after a newer load started is discarded. */
  let loadToken = 0;
  let disposed = false;
  /**
   * The landing viewer is useful only while its hero has visible pixels. Keep this state separate
   * from document visibility so a tab returning in the middle of the page does not restart WebGL.
   */
  const heroRect = canvasMount.getBoundingClientRect();
  let heroInViewport = heroRect.bottom > 0
    && heroRect.right > 0
    && heroRect.top < window.innerHeight
    && heroRect.left < window.innerWidth;

  const syncViewerActivity = (target: Viewer | null = viewer): void => {
    if (!target) return;
    if (heroInViewport && document.visibilityState !== 'hidden') target.resume();
    else target.pause();
  };
  /**
   * False until the initial synchronous mount has finished. `main.ts` sends the first `page_view`
   * for whatever route this mount settles on, so the exhibit load and the deep-linked drawer that
   * run during mount must not each send one of their own — the same visit would be three pages.
   */
  let booted = false;
  /**
   * Incremented every time the sponsor drawer is opened. Sponsor impressions are deduplicated per
   * round, so a visitor who scrolls a card out of view and back is one impression, while a visitor
   * who genuinely returns to the sponsor page later is a second — which is the distinction a CTR
   * reported to a sponsor stands or falls on.
   */
  let sponsorRound = 0;

  const teardownViewer = (): void => {
    unsubscribeAnimation?.();
    unsubscribeAnimation = null;
    viewer?.dispose();
    viewer = null;
  };

  const clearLoadError = (): void => {
    loadError?.remove();
    loadError = null;
  };

  const setSpecs = (rows: Array<[string, string]>): void => {
    specsEl.innerHTML = rows
      .map(([k, v]) => `<div><dt class="label">${k}</dt><dd class="mono">${v}</dd></div>`)
      .join('');
  };

  const renderParts = (): void => {
    const manifest = viewer?.partManifest();
    if (!manifest || manifest.parts.length === 0) {
      partsEl.hidden = true;
      return;
    }
    partsEl.hidden = false;
    partsCount.textContent = String(manifest.parts.length);
    partList.innerHTML = manifest.parts
      .map(
        (p) => `
        <li>
          <button type="button" class="wb-part" data-part="${escapeAttr(p.name)}">
            <span class="wb-part-name">${p.name}</span>
            <span class="wb-part-tri mono">${formatCount(p.triangles)}</span>
          </button>
        </li>`,
      )
      .join('');
  };

  const showSelectedPart = (sel: PartInfo | null): void => {
    for (const b of partList.querySelectorAll<HTMLButtonElement>('.wb-part')) {
      b.classList.toggle('is-active', !!sel && b.dataset.part === sel.name);
    }
    if (!sel) {
      partSelected.hidden = true;
      partSelected.innerHTML = '';
      return;
    }
    partSelected.hidden = false;
    partSelected.innerHTML = `
      <div class="wb-sel-head">
        <span class="wb-sel-name mono">${sel.name}</span>
        <span class="wb-sel-kind label">${sel.kind}</span>
      </div>
      <dl class="wb-sel-facts">
        <div><dt class="label">Triangles</dt><dd class="mono">${sel.triangles.toLocaleString()}</dd></div>
        ${sel.module ? `<div><dt class="label">Module</dt><dd class="mono">${sel.module}</dd></div>` : ''}
        ${sel.materials.length ? `<div><dt class="label">Material</dt><dd class="mono">${escapeAttr(sel.materials[0])}</dd></div>` : ''}
      </dl>`;
  };

  /* ------------------------------------------------------------------- load */

  async function loadExhibit(nextIndex: number, entry: ExhibitEntry = 'rail'): Promise<void> {
    const metadata = demos[nextIndex];
    if (!metadata || disposed) return;
    const token = ++loadToken;
    index = nextIndex;
    const startedAt = performance.now();
    // First-orbit is measured once per exhibit LOAD, not once per page: coming back to an exhibit
    // and orbiting it again is a fresh engagement signal.
    resetExhibitOnceKeys(metadata.id);
    trackExhibitView(metadata, entry, 'workbench');

    // The old rail remains as a progressive enhancement hook, but the redesigned landing hides
    // its whole footer. Do not measure or update hidden descendants during hero startup.
    if (!railTrack.closest('[hidden]')) {
      for (const b of railTrack.querySelectorAll<HTMLButtonElement>('.rail-item')) {
        const active = Number(b.dataset.index) === index;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
        if (active) {
          const left = b.offsetLeft - (railTrack.clientWidth - b.offsetWidth) / 2;
          railTrack.scrollTo({ left, behavior: 'smooth' });
        }
      }
    }
    railCount.textContent = `${String(index + 1).padStart(2, '0')} / ${demos.length}`;
    titleEl.textContent = metadata.title;
    blurbEl.innerHTML = brand(metadata.blurb);
    refImg.classList.remove('missing');
    refImg.src = metadata.referenceImage;
    refImg.alt = `Reference image used to reconstruct ${metadata.title}`;
    openFull.href = `#/demo/${metadata.id}`;
    openSource.href = metadata.sourceUrl;
    // `default` is the landing load — nobody asked for this exhibit by name, so the bare domain is
    // left exactly as the visitor typed it. Every other entry point is a deliberate choice and does
    // claim the URL.
    if (entry !== 'default') {
      urlOwnedByExhibit = true;
      replaceHashSilently(`#/x/${metadata.id}`);
    }
    // `replaceHashSilently` fires no `hashchange`, so the listener in `main.ts` never sees an
    // in-place exhibit swap. Without this, the standard Pages report would credit every exhibit on
    // the site to whichever one the visitor happened to land on first.
    //
    // Except when the swap CAME FROM a hashchange — a back/forward step — because that is the one
    // case the listener in `main.ts` did see and has already counted. Same guard the drawer path
    // spells as `syncUrl`: whoever owns the URL change owns the page view.
    if (booted && entry !== 'hashchange') trackPageView(`Workbench — ${metadata.title}`);

    setSpecs([
      ['Generated with', metadata.generatedWith],
      ['Subject', metadata.subjectClass],
      ['Status', metadata.status],
      ['Author', metadata.author],
    ]);
    partsEl.hidden = true;
    controlsEl.hidden = true;
    animActions.innerHTML = '';
    showSelectedPart(null);

    // One loader per load, torn down with the exhibit it belongs to, so a fast click-through of
    // the rail cannot leave a stack of overlays behind.
    loader?.done();
    clearLoadError();
    loader = createLoader(canvasMount, 'Loading model code');

    teardownViewer();

    let demo: DemoEntry | undefined;
    try {
      demo = await loadDemo(metadata.id);
    } catch (error) {
      if (token !== loadToken || disposed) return;
      console.error(`Failed to load model code for ${metadata.id}`, error);
      loader?.done();
      loader = null;
      const failure = document.createElement('div');
      failure.className = 'ldr wb-model-load-error';
      failure.setAttribute('role', 'alert');
      failure.innerHTML = `
        <div class="ldr-inner">
          <p class="ldr-phase">Model code could not be loaded.</p>
          <button class="btn" type="button">Try ${escapeAttr(metadata.title)} again</button>
        </div>`;
      failure.querySelector<HTMLButtonElement>('button')?.addEventListener('click', () => {
        if (!disposed) void loadExhibit(nextIndex, entry);
      }, { once: true });
      canvasMount.appendChild(failure);
      loadError = failure;
      setSpecs([
        ['Load', 'Unavailable — retry available'],
        ['Subject', metadata.subjectClass],
        ['Author', metadata.author],
      ]);
      return;
    }
    if (token !== loadToken || disposed || !demo) return;
    loader?.phase(demo.prewarm ? 'Precomputing field' : 'Building geometry');

    // Yield one frame for EVERY exhibit, not just the heavy ones. Without it a demo with no
    // `prewarm` created the loader and tore it down inside a single task, so the browser never
    // painted it and a texture-heavy exhibit (the AWP decodes two 1.2MB plates) showed a bare
    // canvas with no indication anything was happening.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (token !== loadToken || disposed) return;

    // Heavy demos precompute off the critical path; `prewarm` yields to the browser as it goes.
    if (demo.prewarm) {
      try {
        await demo.prewarm();
      } catch {
        /* a failed prewarm still lets build() run, just slower */
        trackExhibitPrewarmFailed(demo.id, 'workbench');
      }
      if (token !== loadToken || disposed) return;
      loader?.phase('Building geometry');
      // Another frame so the new phase paints before a synchronous multi-second build blocks the
      // thread — after that point nothing on screen can update until build() returns.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (token !== loadToken || disposed) return;
    }

    if (token !== loadToken || disposed) return;
    const v = new Viewer(canvasMount, {
      cameraPosition: demo.cameraPosition,
      cameraTarget: demo.cameraTarget,
      cameraFov: demo.cameraFov,
      backgroundGradient: demo.backgroundGradient,
      exposure: demo.exposure,
      environmentIntensity: demo.environmentIntensity,
      installLights: demo.installLights,
      toneMapping: demo.toneMapping,
    });
    viewer = v;

    if (token !== loadToken || disposed) {
      v.dispose();
      if (viewer === v) viewer = null;
      return;
    }
    const model = demo.build(v.scene);
    v.setExplodeRoot(model);
    // Each demo's authored camera was framed against a full-viewport canvas. The workbench has the
    // same canvas but a different aspect (a top bar and a rail eat height), which cropped wide
    // subjects — the AWP ran off the left edge. This keeps the authored ANGLE and only corrects
    // distance to fit, and it no-ops under capture so the review framing stays deterministic.
    v.fitToViewport(model);
    v.enableInspect({ onSelect: showSelectedPart });
    // The observer may have run while an async prewarm was still resolving. Apply its latest state
    // before start so a newly loaded offscreen exhibit never creates even its first RAF request.
    syncViewerActivity(v);
    v.start();

    if (token !== loadToken || disposed) {
      // A newer exhibit was requested while this one was building — drop this one on the floor.
      v.dispose();
      if (viewer === v) viewer = null;
      return;
    }

    // Held until the viewer reports a real frame, so the overlay does not lift onto a blank canvas
    // while textures are still decoding and shaders compiling. Guarded by the token: a rail
    // click-through must not let a stale load dismiss the loader the current one just raised.
    const ownLoader = loader;
    ownLoader?.phase('Framing');
    void whenViewerReady().then(() => {
      if (token !== loadToken || disposed) return;
      ownLoader?.done();
      // Reported here rather than after `build()` because this is the moment the visitor can see
      // something: it includes prewarm, geometry, texture decode and shader compile.
      const readyManifest = v.partManifest();
      trackExhibitReady(
        demo,
        {
          loadMs: performance.now() - startedAt,
          triangles: readyManifest
            ? readyManifest.parts.reduce((sum, part) => sum + part.triangles, 0)
            : 0,
          partCount: readyManifest ? readyManifest.parts.length : 0,
          prewarm: !!demo.prewarm,
        },
        'workbench',
      );
    });

    const manifest = v.partManifest();
    const triangles = manifest
      ? manifest.parts.reduce((sum, p) => sum + p.triangles, 0)
      : 0;
    const version = extractVersion(demo.generatedWith);
    setSpecs([
      ['Version', version ?? '—'],
      ['Triangles', triangles ? formatCount(triangles) : '—'],
      ['Parts', manifest ? String(manifest.parts.length) : '—'],
      ['Subject', demo.subjectClass],
      ['Status', demo.status],
      ['Author', demo.author],
    ]);

    renderParts();

    // Controls appear only for what this exhibit actually supports.
    const controller = (model.userData.sculptRuntime as { animationController?: AnimationController } | undefined)
      ?.animationController;
    const hasParts = !!manifest && manifest.parts.length > 1;
    if (hasParts || controller) {
      controlsEl.hidden = false;
      explodeRange.value = '0';
      explodeOut.value = '0.00';
      explodeRange.disabled = !hasParts;
    }

    if (controller) {
      const buttons = new Map<string, HTMLButtonElement>();
      for (const action of controller.actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm';
        b.textContent = action.label;
        b.title = action.loop ? `${action.label} (loops)` : `${action.label} (plays once)`;
        b.addEventListener('click', () => {
          if (controller.active === action.id) {
            controller.stop();
            trackAnimationStop(demo.id, 'workbench');
          } else {
            controller.play(action.id);
            trackAnimationPlay(demo.id, action, 'workbench');
          }
        });
        buttons.set(action.id, b);
        animActions.appendChild(b);
      }
      const sync = (active: string): void => {
        for (const [id, b] of buttons) b.classList.toggle('is-active', id === active);
      };
      sync(controller.active);
      unsubscribeAnimation = controller.subscribe(sync);
    }
  }

  /* --------------------------------------------------------------- listeners */
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement | Document | Window,
    type: K | string,
    handler: (e: never) => void,
    opts?: AddEventListenerOptions,
  ): void => {
    el.addEventListener(type, handler as EventListener, opts);
    cleanups.push(() => el.removeEventListener(type, handler as EventListener, opts));
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const nextRovingIndex = (
    event: KeyboardEvent,
    current: number,
    length: number,
  ): number | null => {
    if (event.key === 'Home') return 0;
    if (event.key === 'End') return length - 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return (current + 1) % length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return (current - 1 + length) % length;
    return null;
  };

  /* ------------------------------------------------ viewer activity budget */
  on(document, 'visibilitychange', () => syncViewerActivity());

  if ('IntersectionObserver' in window) {
    const heroObserver = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        // threshold 0 keeps rendering through every partial overlap and stops only once the hero
        // has completely left the viewport.
        heroInViewport = entry.isIntersecting;
        syncViewerActivity();
      },
      { threshold: 0 },
    );
    heroObserver.observe(canvasMount);
    cleanups.push(() => heroObserver.disconnect());
  }

  /* ----------------------------------------------------- pipeline sequence */
  const pipelineLab = mount.querySelector<HTMLElement>('.pipeline-lab')!;
  const pipelineStageName = mount.querySelector<HTMLElement>('#pipeline-stage-name')!;
  const pipelineStageSummary = mount.querySelector<HTMLElement>('#pipeline-stage-summary')!;
  const pipelineStageArtifact = mount.querySelector<HTMLElement>('#pipeline-stage-artifact')!;
  const pipelineStageGate = mount.querySelector<HTMLElement>('#pipeline-stage-gate')!;
  const pipelineCurrent = mount.querySelector<HTMLElement>('#pipeline-current')!;
  const pipelineVisualId = mount.querySelector<HTMLElement>('#pipeline-visual-id')!;
  const pipelinePanel = mount.querySelector<HTMLElement>('#pipeline-stage-detail')!;
  const pipelineTabs = [...pipelineLab.querySelectorAll<HTMLButtonElement>('.pipeline-step')];
  const pipelineToggle = mount.querySelector<HTMLButtonElement>('#pipeline-sequence-toggle')!;
  const pipelineAutoLabel = mount.querySelector<HTMLElement>('#pipeline-auto-label')!;
  let pipelineIndex = 0;
  let pipelineTimer: number | null = null;
  let pipelineInView = false;
  let pipelineManualPaused = reduceMotion;
  let pipelineHoverPaused = false;
  let pipelineFocusPaused = false;

  const stopPipelineSequence = (): void => {
    if (pipelineTimer !== null) window.clearTimeout(pipelineTimer);
    pipelineTimer = null;
    pipelineLab.classList.remove('is-running');
  };

  const schedulePipelineSequence = (): void => {
    stopPipelineSequence();
    const paused = pipelineManualPaused
      || pipelineHoverPaused
      || pipelineFocusPaused
      || !pipelineInView
      || document.visibilityState === 'hidden';
    pipelineAutoLabel.textContent = paused ? 'AUTO PAUSED' : 'AUTO SEQUENCE';
    if (paused) return;
    // Restart the visible meter from zero whenever the stage changes.
    void pipelineLab.offsetWidth;
    pipelineLab.classList.add('is-running');
    pipelineTimer = window.setTimeout(() => {
      setPipelineStage((pipelineIndex + 1) % PIPELINE_STAGES.length);
    }, 4200);
  };

  const setPipelineStage = (next: number): void => {
    pipelineIndex = (next + PIPELINE_STAGES.length) % PIPELINE_STAGES.length;
    const stage = PIPELINE_STAGES[pipelineIndex];
    for (const button of pipelineTabs) {
      const active = Number(button.dataset.pipelineIndex) === pipelineIndex;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active) pipelinePanel.setAttribute('aria-labelledby', button.id);
    }
    pipelineLab.style.setProperty('--pipeline-stage', String(pipelineIndex));
    pipelineCurrent.textContent = `${String(pipelineIndex + 1).padStart(2, '0')} / ${String(PIPELINE_STAGES.length).padStart(2, '0')}`;
    pipelineVisualId.textContent = stage.id.toUpperCase();
    pipelineStageName.textContent = stage.label;
    pipelineStageSummary.textContent = stage.summary;
    pipelineStageArtifact.textContent = stage.artifact;
    pipelineStageGate.textContent = stage.gate;
    schedulePipelineSequence();
  };

  on(pipelineLab, 'click', (e: Event) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.pipeline-step');
    if (!button?.dataset.pipelineIndex) return;
    setPipelineStage(Number(button.dataset.pipelineIndex));
    button.focus();
  });
  on(mount.querySelector<HTMLElement>('.pipeline-steps')!, 'keydown', (e: KeyboardEvent) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.pipeline-step');
    if (!button) return;
    const current = pipelineTabs.indexOf(button);
    const next = nextRovingIndex(e, current, pipelineTabs.length);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setPipelineStage(next);
    pipelineTabs[next].focus();
  });
  on(pipelineToggle, 'click', () => {
    pipelineManualPaused = !pipelineManualPaused;
    pipelineToggle.classList.toggle('is-paused', pipelineManualPaused);
    pipelineToggle.textContent = pipelineManualPaused ? 'Play sequence' : 'Pause sequence';
    pipelineToggle.setAttribute(
      'aria-label',
      pipelineManualPaused ? 'Play automatic pipeline sequence' : 'Pause automatic pipeline sequence',
    );
    schedulePipelineSequence();
  });
  on(pipelineLab, 'pointerenter', () => {
    pipelineHoverPaused = true;
    schedulePipelineSequence();
  });
  on(pipelineLab, 'pointerleave', () => {
    pipelineHoverPaused = false;
    schedulePipelineSequence();
  });
  on(pipelineLab, 'focusin', () => {
    pipelineFocusPaused = true;
    schedulePipelineSequence();
  });
  on(pipelineLab, 'focusout', (e: FocusEvent) => {
    if (pipelineLab.contains(e.relatedTarget as Node | null)) return;
    pipelineFocusPaused = false;
    schedulePipelineSequence();
  });
  on(document, 'visibilitychange', schedulePipelineSequence);

  if ('IntersectionObserver' in window) {
    const pipelineObserver = new IntersectionObserver(
      ([entry]) => {
        pipelineInView = entry.isIntersecting;
        schedulePipelineSequence();
      },
      { threshold: 0.35 },
    );
    pipelineObserver.observe(pipelineLab);
    cleanups.push(() => pipelineObserver.disconnect());
  } else {
    pipelineInView = true;
  }
  pipelineToggle.classList.toggle('is-paused', pipelineManualPaused);
  pipelineToggle.textContent = pipelineManualPaused ? 'Play sequence' : 'Pause sequence';
  pipelineToggle.setAttribute(
    'aria-label',
    pipelineManualPaused ? 'Play automatic pipeline sequence' : 'Pause automatic pipeline sequence',
  );
  schedulePipelineSequence();
  cleanups.push(stopPipelineSequence);

  /* --------------------------------------------------------- prompt kit */
  const promptCode = mount.querySelector<HTMLElement>('#prompt-code')!;
  const promptPanel = mount.querySelector<HTMLElement>('#prompt-panel')!;
  const promptCopy = mount.querySelector<HTMLButtonElement>('#prompt-copy')!;
  const promptSource = mount.querySelector<HTMLAnchorElement>('#prompt-source')!;
  const promptTablist = mount.querySelector<HTMLElement>('.prompt-tabs')!;
  const promptTabEls = [...promptTablist.querySelectorAll<HTMLButtonElement>('.prompt-tab')];
  let activePrompt = 0;
  let copyResetTimer: number | null = null;

  const setPrompt = (next: number): void => {
    const template = STANDARD_PROMPTS[next];
    if (!template) return;
    activePrompt = next;
    promptCode.textContent = template.prompt;
    promptSource.href = template.sourceUrl;
    for (const button of promptTabEls) {
      const active = Number(button.dataset.promptIndex) === next;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active) promptPanel.setAttribute('aria-labelledby', button.id);
    }
  };

  on(promptTablist, 'click', (e: Event) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.prompt-tab');
    if (!button?.dataset.promptIndex) return;
    setPrompt(Number(button.dataset.promptIndex));
    button.focus();
  });
  on(promptTablist, 'keydown', (e: KeyboardEvent) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.prompt-tab');
    if (!button) return;
    const current = promptTabEls.indexOf(button);
    const next = nextRovingIndex(e, current, promptTabEls.length);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setPrompt(next);
    promptTabEls[next].focus();
  });

  on(promptCopy, 'click', async () => {
    const value = STANDARD_PROMPTS[activePrompt].prompt;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('Copy command was rejected');
      }
      promptCopy.classList.add('is-copied');
      promptCopy.querySelector('span')!.textContent = 'Copied';
    } catch {
      promptCopy.classList.add('is-copy-error');
      promptCopy.querySelector('span')!.textContent = 'Select and Copy';
    }
    if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(() => {
      promptCopy.classList.remove('is-copied', 'is-copy-error');
      promptCopy.querySelector('span')!.textContent = 'Copy Prompt';
    }, 1800);
  });
  cleanups.push(() => {
    if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
  });

  /* ---------------------------------------------------- sponsor carousel */
  const sponsorCarousel = mount.querySelector<HTMLElement>('.sponsor-carousel')!;
  const sponsorToggle = mount.querySelector<HTMLButtonElement>('#sponsor-sequence-toggle')!;
  const sponsorStatus = mount.querySelector<HTMLElement>('#sponsor-status')!;
  let sponsorIndex = 0;
  let sponsorTimer: number | null = null;
  let sponsorInView = false;
  let sponsorManualPaused = reduceMotion;
  let sponsorHoverPaused = false;
  let sponsorFocusPaused = false;

  const stopSponsorCarousel = (): void => {
    if (sponsorTimer !== null) window.clearTimeout(sponsorTimer);
    sponsorTimer = null;
    sponsorCarousel.classList.remove('is-running');
  };

  const scheduleSponsorCarousel = (): void => {
    stopSponsorCarousel();
    const paused = sponsorManualPaused
      || sponsorHoverPaused
      || sponsorFocusPaused
      || !sponsorInView
      || document.visibilityState === 'hidden';
    if (paused || SPONSORS.length < 2) return;
    void sponsorCarousel.offsetWidth;
    sponsorCarousel.classList.add('is-running');
    sponsorTimer = window.setTimeout(() => {
      showSponsor((sponsorIndex + 1) % SPONSORS.length);
    }, 6500);
  };

  const showSponsor = (next: number, announce = false): void => {
    sponsorIndex = (next + SPONSORS.length) % SPONSORS.length;
    for (const slide of sponsorCarousel.querySelectorAll<HTMLElement>('.sponsor-slide')) {
      const active = Number(slide.dataset.sponsorIndex) === sponsorIndex;
      slide.classList.toggle('is-active', active);
      slide.setAttribute('aria-hidden', String(!active));
      slide.inert = !active;
    }
    for (const dot of sponsorCarousel.querySelectorAll<HTMLButtonElement>('.sponsor-dot')) {
      const active = Number(dot.dataset.sponsorDot) === sponsorIndex;
      dot.classList.toggle('is-active', active);
      dot.setAttribute('aria-pressed', String(active));
    }
    if (announce) {
      sponsorStatus.textContent = `${SPONSORS[sponsorIndex].name}, sponsor ${sponsorIndex + 1} of ${SPONSORS.length}`;
    }
    scheduleSponsorCarousel();
  };

  showSponsor(0);

  on(sponsorCarousel, 'click', (e: Event) => {
    const dot = (e.target as HTMLElement).closest<HTMLButtonElement>('.sponsor-dot');
    if (dot?.dataset.sponsorDot) showSponsor(Number(dot.dataset.sponsorDot), true);
  });
  on(mount.querySelector<HTMLElement>('#sponsor-prev')!, 'click', () => showSponsor(sponsorIndex - 1, true));
  on(mount.querySelector<HTMLElement>('#sponsor-next')!, 'click', () => showSponsor(sponsorIndex + 1, true));
  on(sponsorToggle, 'click', () => {
    sponsorManualPaused = !sponsorManualPaused;
    sponsorToggle.classList.toggle('is-paused', sponsorManualPaused);
    sponsorToggle.textContent = sponsorManualPaused ? 'Play rotation' : 'Pause rotation';
    sponsorToggle.setAttribute(
      'aria-label',
      sponsorManualPaused ? 'Play automatic sponsor rotation' : 'Pause automatic sponsor rotation',
    );
    scheduleSponsorCarousel();
  });
  on(sponsorCarousel, 'pointerenter', () => {
    sponsorHoverPaused = true;
    scheduleSponsorCarousel();
  });
  on(sponsorCarousel, 'pointerleave', () => {
    sponsorHoverPaused = false;
    scheduleSponsorCarousel();
  });
  on(sponsorCarousel, 'focusin', () => {
    sponsorFocusPaused = true;
    scheduleSponsorCarousel();
  });
  on(sponsorCarousel, 'focusout', (e: FocusEvent) => {
    if (sponsorCarousel.contains(e.relatedTarget as Node | null)) return;
    sponsorFocusPaused = false;
    scheduleSponsorCarousel();
  });
  on(document, 'visibilitychange', scheduleSponsorCarousel);

  if ('IntersectionObserver' in window) {
    const sponsorObserver = new IntersectionObserver(
      ([entry]) => {
        sponsorInView = entry.isIntersecting;
        scheduleSponsorCarousel();
      },
      { threshold: 0.3 },
    );
    sponsorObserver.observe(sponsorCarousel);
    cleanups.push(() => sponsorObserver.disconnect());
  } else {
    sponsorInView = true;
  }
  sponsorToggle.classList.toggle('is-paused', sponsorManualPaused);
  sponsorToggle.textContent = sponsorManualPaused ? 'Play rotation' : 'Pause rotation';
  sponsorToggle.setAttribute(
    'aria-label',
    sponsorManualPaused ? 'Play automatic sponsor rotation' : 'Pause automatic sponsor rotation',
  );
  scheduleSponsorCarousel();
  cleanups.push(stopSponsorCarousel);

  on(railTrack, 'click', (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.rail-item');
    if (!btn?.dataset.index) return;
    void loadExhibit(Number(btn.dataset.index), 'rail');
  });

  const archiveGrid = mount.querySelector<HTMLElement>('.archive-grid')!;
  const archiveMore = mount.querySelector<HTMLButtonElement>('#archive-more')!;
  const archiveStatus = mount.querySelector<HTMLElement>('#archive-filter-status strong')!;
  const archiveFilters = [...mount.querySelectorAll<HTMLButtonElement>('[data-archive-filter]')];
  const archiveCardEls = [...archiveGrid.querySelectorAll<HTMLElement>('.archive-card')];
  const compactArchiveQuery = window.matchMedia('(max-width: 520px)');
  let archiveExpanded = false;
  let archiveFilter = 'all';

  const applyArchiveState = (animate = false): void => {
    const collapsedLimit = compactArchiveQuery.matches ? 4 : 6;
    archiveGrid.classList.toggle('is-expanded', archiveExpanded);
    archiveGrid.classList.toggle('is-filtered', archiveFilter !== 'all');
    archiveMore.hidden = archiveFilter !== 'all';
    archiveMore.setAttribute('aria-expanded', String(archiveExpanded));

    let matching = 0;
    let visible = 0;
    for (const [cardIndex, card] of archiveCardEls.entries()) {
      const match = archiveFilter === 'all' || card.dataset.archiveSubject === archiveFilter;
      card.hidden = !match;
      if (!match) continue;
      matching += 1;
      const inCollapsedSet = archiveFilter !== 'all' || archiveExpanded || cardIndex < collapsedLimit;
      if (!inCollapsedSet) continue;
      visible += 1;
      if (animate && !reduceMotion) {
        card.animate(
          [
            { opacity: 0, transform: 'translate3d(0, 1.5rem, 0) scale(0.985)' },
            { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
          ],
          {
            duration: 520,
            delay: Math.min(visible - 1, 7) * 42,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            fill: 'none',
          },
        );
      }
    }

    const total = archiveFilter === 'all' ? archiveEntries.length : matching;
    archiveStatus.textContent = `${String(visible).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
    archiveMore.querySelector('span')!.textContent = archiveExpanded
      ? `Show the Essential ${collapsedLimit === 4 ? 'Four' : 'Six'}`
      : 'Show the Complete Archive';
    archiveMore.querySelector('strong')!.textContent = archiveExpanded
      ? `${String(archiveEntries.length).padStart(2, '0')} / ${String(archiveEntries.length).padStart(2, '0')}`
      : `${String(Math.min(collapsedLimit, archiveEntries.length)).padStart(2, '0')} / ${String(archiveEntries.length).padStart(2, '0')}`;
    for (const button of archiveFilters) {
      const active = button.dataset.archiveFilter === archiveFilter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  };

  on(mount.querySelector<HTMLElement>('.archive-filters')!, 'click', (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-archive-filter]');
    if (!button?.dataset.archiveFilter || button.dataset.archiveFilter === archiveFilter) return;
    archiveFilter = button.dataset.archiveFilter;
    applyArchiveState(true);
  });

  on(archiveMore, 'click', () => {
    archiveExpanded = !archiveExpanded;
    applyArchiveState(true);
  });

  const handleArchiveBreakpoint = (): void => applyArchiveState();
  compactArchiveQuery.addEventListener('change', handleArchiveBreakpoint);
  cleanups.push(() => compactArchiveQuery.removeEventListener('change', handleArchiveBreakpoint));

  // Fine-pointer visitors can physically "aim" each study. The transform is isolated on the
  // card's inner surface so it never conflicts with the archive's scroll-reveal choreography.
  if (!reduceMotion && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    for (const card of archiveCardEls) {
      let tiltFrame = 0;
      const resetTilt = (): void => {
        if (tiltFrame) window.cancelAnimationFrame(tiltFrame);
        tiltFrame = 0;
        card.classList.remove('is-tracking');
        card.style.removeProperty('--archive-tilt-x');
        card.style.removeProperty('--archive-tilt-y');
        card.style.removeProperty('--archive-light-x');
        card.style.removeProperty('--archive-light-y');
      };
      on(card, 'pointermove', (event: PointerEvent) => {
        if (tiltFrame) window.cancelAnimationFrame(tiltFrame);
        tiltFrame = window.requestAnimationFrame(() => {
          tiltFrame = 0;
          const rect = card.getBoundingClientRect();
          const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
          const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
          card.classList.add('is-tracking');
          card.style.setProperty('--archive-tilt-x', `${((0.5 - y) * 4.5).toFixed(2)}deg`);
          card.style.setProperty('--archive-tilt-y', `${((x - 0.5) * 5.5).toFixed(2)}deg`);
          card.style.setProperty('--archive-light-x', `${(x * 100).toFixed(1)}%`);
          card.style.setProperty('--archive-light-y', `${(y * 100).toFixed(1)}%`);
        });
      });
      on(card, 'pointerleave', resetTilt);
      cleanups.push(resetTilt);
    }
  }

  applyArchiveState();

  /* ----------------------------------------------- active section navigation */
  const sectionNavLinks = [...mount.querySelectorAll<HTMLAnchorElement>('.wb-navlink[href^="#"]')];
  const sectionNavTargets = sectionNavLinks
    .map((link) => {
      const id = link.getAttribute('href')?.slice(1) ?? '';
      const section = id ? mount.querySelector<HTMLElement>(`#${id}`) : null;
      return section ? { id, link, section } : null;
    })
    .filter((entry): entry is { id: string; link: HTMLAnchorElement; section: HTMLElement } => entry !== null);
  let sectionNavFrame = 0;

  const updateActiveSection = (): void => {
    sectionNavFrame = 0;
    const probe = Math.min(window.innerHeight * 0.42, 260);
    const active = sectionNavTargets.find(({ section }) => {
      const rect = section.getBoundingClientRect();
      return rect.top <= probe && rect.bottom > probe;
    });
    for (const { id, link } of sectionNavTargets) {
      const current = id === active?.id;
      link.classList.toggle('is-current', current);
      if (current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  const scheduleActiveSection = (): void => {
    if (sectionNavFrame) return;
    sectionNavFrame = window.requestAnimationFrame(updateActiveSection);
  };
  on(window, 'scroll', scheduleActiveSection, { passive: true });
  on(window, 'resize', scheduleActiveSection, { passive: true });
  cleanups.push(() => {
    if (sectionNavFrame) window.cancelAnimationFrame(sectionNavFrame);
  });
  updateActiveSection();

  const step = (delta: number, entry: ExhibitEntry = 'arrow'): void => {
    void loadExhibit((index + delta + demos.length) % demos.length, entry);
  };
  on(mount.querySelector<HTMLElement>('#rail-prev')!, 'click', () => step(-1));
  on(mount.querySelector<HTMLElement>('#rail-next')!, 'click', () => step(1));

  /**
   * The slider emits an `input` event per pixel of travel. Reporting each one would spend the
   * property's event quota on a single drag and tell us nothing the settled value does not, so only
   * where the visitor let go is measured.
   */
  let explodeReportTimer: number | null = null;

  /* --------------------------------------------------------- scroll motion */
  const revealTargets = mount.querySelectorAll<HTMLElement>(
    '.section-head, .pipeline-lab, .guide-flow > *, .prompt-console, .sponsor-head > *, .sponsor-carousel, .archive-card, .archive-more, .site-footer > *',
  );

  if (!reduceMotion && 'IntersectionObserver' in window) {
    document.body.classList.add('motion-ready');
    revealTargets.forEach((el) => el.classList.add('od-reveal'));

    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -7% 0px' },
    );
    revealTargets.forEach((el) => revealObserver.observe(el));
    cleanups.push(() => revealObserver.disconnect());

    const stage = mount.querySelector<HTMLElement>('.wb-stage')!;
    let motionFrame = 0;
    let measureFrame = 0;
    let scrollable = 1;
    let heroDistance = 1;
    const updateScrollMotion = (): void => {
      motionFrame = 0;
      const pageProgress = Math.min(1, Math.max(0, window.scrollY / scrollable));
      const heroProgress = Math.min(1, Math.max(0, window.scrollY / heroDistance));
      mount.style.setProperty('--page-progress', pageProgress.toFixed(4));
      stage.style.setProperty('--hero-scroll', heroProgress.toFixed(4));
    };
    const scheduleScrollMotion = (): void => {
      if (motionFrame) return;
      motionFrame = window.requestAnimationFrame(updateScrollMotion);
    };
    // Layout dimensions change on resize and when the archive expands, not on every scroll tick.
    // Cache them in a dedicated frame so the scroll handler never mixes layout reads and writes.
    const scheduleScrollMeasure = (): void => {
      if (measureFrame) return;
      measureFrame = window.requestAnimationFrame(() => {
        measureFrame = 0;
        scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        heroDistance = Math.max(1, stage.offsetHeight * 0.82);
        updateScrollMotion();
      });
    };
    on(window, 'scroll', scheduleScrollMotion, { passive: true });
    on(window, 'resize', scheduleScrollMeasure, { passive: true });
    const layoutObserver = new ResizeObserver(scheduleScrollMeasure);
    layoutObserver.observe(document.documentElement);
    layoutObserver.observe(stage);
    cleanups.push(() => {
      if (motionFrame) window.cancelAnimationFrame(motionFrame);
      if (measureFrame) window.cancelAnimationFrame(measureFrame);
      layoutObserver.disconnect();
      document.body.classList.remove('motion-ready');
    });
    scheduleScrollMeasure();
  } else {
    revealTargets.forEach((el) => el.classList.add('is-visible'));
  }
  on(explodeRange, 'input', () => {
    const t = Number(explodeRange.value);
    explodeOut.value = t.toFixed(2);
    viewer?.setExplode(t);
    if (explodeReportTimer !== null) window.clearTimeout(explodeReportTimer);
    explodeReportTimer = window.setTimeout(() => {
      explodeReportTimer = null;
      if (t > 0) trackExplode(demos[index].id, t, 'workbench');
    }, 700);
  });
  cleanups.push(() => {
    if (explodeReportTimer !== null) window.clearTimeout(explodeReportTimer);
  });

  on(partList, 'click', (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.wb-part');
    if (!btn?.dataset.part) return;
    const already = btn.classList.contains('is-active');
    viewer?.selectByName(already ? null : btn.dataset.part);
    if (!already) {
      const part = viewer?.partManifest()?.parts.find((candidate) => candidate.name === btn.dataset.part);
      if (part) trackPartSelect(demos[index].id, part, 'workbench');
    }
  });

  /**
   * Did the visitor actually touch the model? Answered once per exhibit load, from the canvas's own
   * first input — this is the difference between "the exhibit was on screen" and "the exhibit was
   * used", and it is the number that says whether the 3D is doing its job at all.
   */
  const reportFirstInput = (input: 'pointer' | 'wheel' | 'touch') => (): void => {
    trackViewerInteract(demos[index].id, input, 'workbench');
  };
  on(canvasMount, 'pointerdown', reportFirstInput('pointer'));
  on(canvasMount, 'wheel', reportFirstInput('wheel'), { passive: true });
  on(canvasMount, 'touchstart', reportFirstInput('touch'), { passive: true });

  /* ---- drawers ---- */
  let openDrawer: string | null = null;
  let activeOverlay: 'drawer' | 'palette' | null = null;
  let overlayOpener: HTMLElement | null = null;
  const wbRoot = mount.querySelector<HTMLElement>('.wb')!;
  const backgroundState = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
  const overlayBackground = [...wbRoot.children].filter(
    (element): element is HTMLElement => element instanceof HTMLElement
      && element !== scrim
      && element !== drawer
      && element !== palette,
  );

  const setOverlayBackgroundHidden = (hidden: boolean): void => {
    if (hidden) {
      if (backgroundState.size > 0) return;
      for (const element of overlayBackground) {
        backgroundState.set(element, {
          inert: element.inert,
          ariaHidden: element.getAttribute('aria-hidden'),
        });
        element.inert = true;
        element.setAttribute('aria-hidden', 'true');
      }
      return;
    }
    for (const [element, state] of backgroundState) {
      element.inert = state.inert;
      if (state.ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', state.ariaHidden);
    }
    backgroundState.clear();
  };

  const canRestoreFocus = (element: HTMLElement | null): element is HTMLElement => {
    if (!element?.isConnected || element.closest('[hidden], [inert]')) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };

  const rememberOverlayOpener = (candidate?: HTMLElement | null): void => {
    if (activeOverlay !== null || overlayOpener) return;
    const target = candidate ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!target || drawer.contains(target) || palette.contains(target)) return;
    overlayOpener = target;
  };

  const closeOverlays = (
    { restoreFocus = true, syncUrl = true }: { restoreFocus?: boolean; syncUrl?: boolean } = {},
  ): void => {
    const wasDrawer = activeOverlay === 'drawer' || openDrawer !== null;
    const restoreTarget = overlayOpener;
    openDrawer = null;
    activeOverlay = null;
    overlayOpener = null;
    sponsorObserver?.disconnect();
    sponsorObserver = null;
    drawer.hidden = true;
    palette.hidden = true;
    scrim.hidden = true;
    document.body.classList.remove('wb-overlay-open');
    setOverlayBackgroundHidden(false);
    palInput.removeAttribute('aria-activedescendant');
    // Hand the URL back to the exhibit, so closing the privacy page does not leave the address bar
    // claiming you are still on it.
    // Hand the URL back to whatever it was before the drawer took it. For a visitor still on the
    // landing page that is the bare domain — restoring an exhibit hash here would smuggle in the
    // same unrequested redirect by another route.
    if (wasDrawer && syncUrl) replaceHashSilently(urlOwnedByExhibit ? `#/x/${demos[index].id}` : '');
    if (restoreFocus && restoreTarget) {
      window.requestAnimationFrame(() => {
        if (!disposed && canRestoreFocus(restoreTarget)) restoreTarget.focus();
      });
    }
  };

  /**
   * `syncUrl` is false only when the caller IS the URL — i.e. this open came from a deep link or a
   * back/forward step, so writing the hash again would be circular.
   */
  const showDrawer = (
    key: string,
    source: string,
    syncUrl = true,
    opener?: HTMLElement | null,
  ): void => {
    const entry = DRAWERS[key];
    if (!entry) return;
    if (activeOverlay === 'drawer' && openDrawer === key) {
      closeOverlays();
      return;
    }
    rememberOverlayOpener(opener);
    sponsorObserver?.disconnect();
    sponsorObserver = null;
    openDrawer = key;
    activeOverlay = 'drawer';
    drawerBody.innerHTML = entry.build();
    const heading = drawerBody.querySelector<HTMLElement>('h2');
    if (heading) {
      heading.id = 'wb-drawer-title';
      drawer.setAttribute('aria-labelledby', heading.id);
      drawer.removeAttribute('aria-label');
    } else {
      drawer.removeAttribute('aria-labelledby');
      drawer.setAttribute('aria-label', entry.title);
    }
    // Every link inside a drawer inherits its placement from the drawer it is in, so the delegated
    // click handler below does not need a per-link annotation to say where a click came from.
    drawerBody.dataset.placement = `drawer_${key}`;
    drawer.hidden = false;
    palette.hidden = true;
    scrim.hidden = false;
    document.body.classList.add('wb-overlay-open');
    setOverlayBackgroundHidden(true);
    drawer.scrollTop = 0;
    mount.querySelector<HTMLElement>('#wb-drawer-close')?.focus();
    // Content pages are linkable: /#/privacy has to survive being copied out of the address bar.
    if (syncUrl) replaceHashSilently(`#/${key}`);

    trackDrawerOpen(key, source);
    // `replaceHashSilently` fires no `hashchange`, so a drawer opened by tapping a nav button is
    // invisible to the page-view listener in `main.ts`. Deep links and back/forward steps arrive
    // with `syncUrl` false, and those the listener has already counted.
    if (booted && syncUrl) trackPageView(entry.title);
    if (key === 'sponsor') watchSponsorImpressions();
  };

  /**
   * Sponsor impressions, measured from the card actually being on screen rather than from the
   * drawer being opened.
   *
   * This is the denominator of the click-through rate a sponsor is sent, so it has to mean
   * something: a visitor who opens the sponsor page and closes it without scrolling has seen the
   * first card and not the third, and reporting three impressions for that would overstate reach
   * and understate CTR for every sponsor below the fold.
   *
   * 25% of the card, once, per opening. Not the IAB display-ad standard (50% for one continuous
   * second) on purpose: these are prose cards that can stand taller than a phone's drawer, where a
   * 50% threshold would never fire at all and the sponsor at the bottom would look unseen rather
   * than unscrolled. `docs/ANALYTICS.md` states this in the same words, so a sponsor being sent the
   * number is told what it counts.
   */
  let sponsorObserver: IntersectionObserver | null = null;

  function watchSponsorImpressions(): void {
    sponsorObserver?.disconnect();
    sponsorObserver = null;
    const cards = Array.from(drawerBody.querySelectorAll<HTMLElement>('[data-sponsor]'));
    if (cards.length === 0) return;

    const round = ++sponsorRound;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = entry.target as HTMLElement;
          const sponsor = SPONSORS.find((candidate) => candidate.id === card.dataset.sponsor);
          if (sponsor) trackSponsorImpression(sponsor, 'sponsor_drawer', round);
          // Stop watching a card that has been counted: the dedupe in `analytics.ts` would drop the
          // repeat anyway, but there is no reason to keep paying for the callback.
          observer.unobserve(card);
        }
      },
      { root: drawer, threshold: 0.25 },
    );
    for (const card of cards) observer.observe(card);
    sponsorObserver = observer;
  }
  cleanups.push(() => sponsorObserver?.disconnect());

  /**
   * Delegated at the root rather than bound per button: the menu drawer's own entries are
   * `[data-drawer]` buttons that do not exist until that drawer is built, so a one-time query over
   * the initial markup would have wired the top bar and left every menu item dead.
   */
  /** Which control opened a drawer. `Sponsor` in the top bar and `Sponsors` in the nav are the same
   *  drawer reached two different ways, and knowing which one people use is how the CTA earns its
   *  place in the header. */
  const drawerSource = (btn: HTMLElement): string => {
    if (btn.classList.contains('wb-sponsor')) return 'header_cta';
    if (btn.classList.contains('wb-navlink')) return 'header_nav';
    if (btn.classList.contains('wb-menu')) return 'menu_button';
    if (btn.classList.contains('mn-item')) return 'menu_drawer';
    return 'other';
  };

  on(mount, 'click', (e: Event) => {
    const jump = (e.target as HTMLElement).closest<HTMLElement>('[data-jump]');
    if (jump?.dataset.jump) {
      e.preventDefault();
      closeOverlays();
      const target = mount.querySelector<HTMLElement>(jump.dataset.jump);
      window.requestAnimationFrame(() => {
        target?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
        if (jump.hasAttribute('data-jump-focus')) target?.focus({ preventScroll: true });
      });
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-drawer]');
    if (btn?.dataset.drawer) showDrawer(btn.dataset.drawer, drawerSource(btn), true, btn);
  });

  /**
   * The opt-out switch on the privacy page. Rebuilds the drawer afterwards so the page states the
   * choice that is now in force — a privacy control that leaves you guessing whether it took effect
   * is not much of a control. `setAnalyticsOptOut` applies immediately, without a reload.
   */
  on(mount, 'click', (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-analytics-toggle]');
    if (!btn) return;
    setAnalyticsOptOut(btn.dataset.analyticsToggle === 'off');
    const privacy = DRAWERS.privacy;
    if (openDrawer === 'privacy' && privacy) {
      drawerBody.innerHTML = privacy.build();
      const heading = drawerBody.querySelector<HTMLElement>('h2');
      if (heading) heading.id = 'wb-drawer-title';
      mount.querySelector<HTMLElement>('#wb-drawer-close')?.focus();
    }
  });

  /**
   * Every outbound link on the page, in one handler.
   *
   * Delegated rather than bound per link because drawer content is rebuilt from a string each time
   * it opens — a sponsor CTA, a mailto, a Discord invite and a licence link do not exist until then.
   * `trackLinkClick` decides whether a destination is a sponsor, a support channel or a plain
   * outbound click, so this stays a routing decision about WHERE the click happened.
   */
  const placementFor = (anchor: HTMLElement): string => {
    const declared = anchor.closest<HTMLElement>('[data-placement]')?.dataset.placement;
    if (declared) return declared;
    if (anchor.closest('.wb-top')) return 'header';
    if (anchor.closest('.wb-caption')) return 'exhibit_caption';
    return 'other';
  };

  on(mount, 'click', (e: Event) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!anchor || anchor.hasAttribute('data-track-skip')) return;
    const href = anchor.getAttribute('href') ?? '';
    // In-site navigation. The route it leads to reports itself as a page view, and the two links
    // that deserve more than that (`Open full viewer`, `Read the source`) have their own events.
    if (!href || href.startsWith('#')) return;

    const card = anchor.closest<HTMLElement>('[data-sponsor]');
    trackLinkClick({
      url: anchor.href,
      label: anchor.textContent?.trim().replace(/\s+/g, ' '),
      placement: placementFor(anchor),
      sponsorId: card?.dataset.sponsor,
      // An exhibit is only context for a link rendered over the exhibit itself; a sponsor click
      // from inside the privacy page has nothing to do with whatever model is loaded behind it.
      exhibitId: drawerBody.contains(anchor) ? undefined : demos[index].id,
    });
  });

  /**
   * Which FAQ answers get opened — the site's own list of what it failed to explain up front.
   *
   * `toggle` does not bubble, so this listens in the CAPTURE phase: a capture-phase listener on an
   * ancestor still receives a non-bubbling event, which is what makes one delegated handler work
   * for questions that are rebuilt from a string every time the drawer opens.
   */
  on(
    drawerBody,
    'toggle',
    (e: Event) => {
      const details = e.target as HTMLElement;
      if (!(details instanceof HTMLDetailsElement) || !details.open) return;
      if (!details.classList.contains('faq-item')) return;
      const items = Array.from(drawerBody.querySelectorAll<HTMLElement>('.faq-item'));
      trackFaqOpen(
        items.indexOf(details) + 1,
        details.querySelector('summary')?.textContent?.trim() ?? '',
      );
    },
    { capture: true },
  );
  on(mount.querySelector<HTMLElement>('#wb-drawer-close')!, 'click', () => closeOverlays());
  on(scrim, 'click', () => closeOverlays());

  /* ---- command palette ---- */
  let palIndex = 0;

  const palMatches = (): typeof archiveEntries => {
    const q = palInput.value.trim().toLowerCase();
    if (!q) return archiveEntries;
    return archiveEntries.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.id.includes(q) ||
        d.subjectClass.includes(q) ||
        d.generatedWith.toLowerCase().includes(q),
    );
  };

  const drawPalette = (): void => {
    const matches = palMatches();
    palIndex = Math.min(palIndex, Math.max(0, matches.length - 1));
    palList.innerHTML = matches.length
      ? matches
          .map(
            (d, i) => `
          <li role="none">
            <button type="button" class="pal-item${i === palIndex ? ' is-active' : ''}" data-id="${d.id}"
                    id="pal-option-${d.id}" role="option" aria-selected="${i === palIndex}" tabindex="-1">
              <span class="pal-title">${escapeAttr(d.title)}</span>
              <span class="pal-meta mono">${escapeAttr(d.subjectClass)} · ${escapeAttr(d.generationLabel)}</span>
            </button>
          </li>`,
          )
          .join('')
      : `<li class="pal-empty">No exhibit matches that.</li>`;
    const active = matches[palIndex];
    if (active) palInput.setAttribute('aria-activedescendant', `pal-option-${active.id}`);
    else palInput.removeAttribute('aria-activedescendant');
  };

  const openPalette = (source: 'button' | 'keyboard', opener?: HTMLElement | null): void => {
    rememberOverlayOpener(opener);
    const replacedDrawer = activeOverlay === 'drawer' || openDrawer !== null;
    sponsorObserver?.disconnect();
    sponsorObserver = null;
    trackPaletteOpen(source);
    activeOverlay = 'palette';
    palette.hidden = false;
    drawer.hidden = true;
    openDrawer = null;
    scrim.hidden = false;
    document.body.classList.add('wb-overlay-open');
    setOverlayBackgroundHidden(true);
    if (replacedDrawer) replaceHashSilently(urlOwnedByExhibit ? `#/x/${demos[index].id}` : '');
    palInput.value = '';
    palIndex = 0;
    drawPalette();
    palInput.focus();
  };

  const commitPalette = (id?: string): void => {
    const matches = palMatches();
    const target = id ?? matches[palIndex]?.id;
    if (!target) return;
    const i = demos.findIndex((d) => d.id === target);
    if (i >= 0) {
      void loadExhibit(i, 'palette');
    } else {
      const standalone = archiveEntries.find((entry) => entry.id === target);
      if (standalone) window.location.assign(standalone.href);
    }
    closeOverlays();
  };

  on(openFull, 'click', () => trackOpenFullViewer(demos[index].id));
  on(openSource, 'click', () => trackSourceClick(demos[index].id, 'workbench'));

  const paletteButton = mount.querySelector<HTMLElement>('#wb-open-palette')!;
  on(paletteButton, 'click', () => openPalette('button', paletteButton));
  /**
   * Reported as GA4's own `search` event so the palette shows up in the built-in site-search
   * reporting, and debounced to the settled query: sending a measurement per keystroke would turn
   * one search for "medusa" into six rows reading m, me, med, medu, medus, medusa.
   */
  let searchReportTimer: number | null = null;
  on(palInput, 'input', () => {
    palIndex = 0;
    drawPalette();
    if (searchReportTimer !== null) window.clearTimeout(searchReportTimer);
    searchReportTimer = window.setTimeout(() => {
      searchReportTimer = null;
      trackSearch(palInput.value, palMatches().length);
    }, 900);
  });
  cleanups.push(() => {
    if (searchReportTimer !== null) window.clearTimeout(searchReportTimer);
  });
  on(palList, 'click', (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.pal-item');
    if (btn?.dataset.id) commitPalette(btn.dataset.id);
  });

  on(document, 'keydown', (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (palette.hidden) {
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        openPalette('keyboard', opener);
      }
      else closeOverlays();
      return;
    }
    if (e.key === 'Escape' && activeOverlay) {
      closeOverlays();
      return;
    }
    if (e.key === 'Tab' && activeOverlay) {
      const dialog = activeOverlay === 'drawer' ? drawer : palette;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.tabIndex >= 0 && canRestoreFocus(element));
      if (focusables.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (!palette.hidden) {
      const matches = palMatches();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        palIndex = Math.min(palIndex + 1, matches.length - 1);
        drawPalette();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        palIndex = Math.max(palIndex - 1, 0);
        drawPalette();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commitPalette();
      }
      return;
    }
  });

  /**
   * The workbench owns the hash while it is mounted (main.ts deliberately does not remount it on a
   * hash change, because remounting would dispose a live viewer to rebuild it identically). That
   * leaves one gap: a hash the workbench did NOT write — a pasted `#/x/<id>`, or a back/forward
   * step — would otherwise change the URL and nothing else. Its own writes go through
   * `replaceHashSilently`, which uses replaceState and fires no event, so this cannot loop.
   */
  on(window, 'hashchange', () => {
    const route = parseRoute(window.location.hash);
    if (route.name === 'drawer') {
      // `false`: the URL is already what it should be — this open came FROM it.
      showDrawer(route.key, 'deeplink', false);
      return;
    }
    if (route.name === 'workbench') {
      if (activeOverlay) closeOverlays({ syncUrl: false });
      const target = demos.findIndex((d) => d.id === route.id);
      if (target >= 0 && target !== index) void loadExhibit(target, 'hashchange');
      return;
    }
    if (route.name === 'home' && activeOverlay) closeOverlays({ syncUrl: false });
  });

  /* ------------------------------------------------------------------ start */
  railCount.textContent = `${String(index + 1).padStart(2, '0')} / ${demos.length}`;
  document.body.classList.add('workbench-active');
  void loadExhibit(index, focusId ? 'deeplink' : 'default');
  // A deep link straight to a content page opens it over the workbench, which keeps loading behind
  // it — the reader gets the page immediately and the exhibit is already there when they close it.
  //
  // The write is a no-op when the hash is already this drawer, which is the deep-link case; it
  // matters for the mobile menu, which opens a drawer without the URL having named it.
  if (initialDrawer) showDrawer(initialDrawer, 'deeplink');

  // Everything above is the initial mount, which `main.ts` reports as one page view for whatever
  // route it settles on. From here on, an exhibit swap or a drawer opening is a navigation of its
  // own and reports itself.
  booted = true;

  return () => {
    disposed = true;
    loadToken++;
    closeOverlays({ restoreFocus: false, syncUrl: false });
    for (const off of cleanups) off();
    teardownViewer();
    // The loader lives in the canvas mount, which innerHTML would take with it anyway — removing it
    // explicitly keeps its pending timer from firing against a detached node.
    loader?.done();
    loader = null;
    clearLoadError();
    document.body.classList.remove('workbench-active');
    document.body.classList.remove('wb-overlay-open');
  };
}
