/**
 * Drawer content — the site's prose surface.
 *
 * Every factual claim here is sourced from something checkable in the repos rather than written to
 * sound good: the pipeline stage list and the gate names come from img2threejs's own README, the
 * per-exhibit numbers come from `registry.ts`, and the privacy statements were verified against the
 * shipped code (see the notes in `privacyDrawer`). Where the honest answer is "we don't know" or
 * "that's your call, not ours" — model licensing, most obviously — it says so instead of guessing.
 */

import { demos } from './demos/registry';
import {
  ARROW_OUT,
  brand,
  CHANGELOG_URL,
  COFFEE_URL,
  CONTACT_EMAIL,
  CONTACT_NAME,
  DISCORD_URL,
  DONATE_URL,
  GITHUB_CORE,
  GITHUB_SHOWCASE,
  HEART,
  LICENSE_URL,
  ROADMAP,
  ROADMAP_URL,
  SITE_URL,
  SPONSORS,
} from './site-data';

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const STATUS_LABEL: Record<string, string> = {
  shipped: 'Shipped',
  latest: 'Latest release',
  'in-progress': 'In progress',
  planned: 'Planned',
};

/* ------------------------------------------------------------------ roadmap */

function roadmapDrawer(): string {
  const rows = ROADMAP.map((entry) => {
    const link = entry.status === 'planned' || entry.status === 'in-progress'
      ? ''
      : `<a class="rd-link" href="${CHANGELOG_URL}" target="_blank" rel="noopener noreferrer">Changelog ${ARROW_OUT}</a>`;
    const notShipped = entry.notShipped
      ? `<p class="rd-not">Not shipped &mdash; ${entry.notShipped}</p>`
      : '';
    return `
      <li class="rd-row rd-${entry.status}">
        <div class="rd-key">
          <span class="rd-v mono">${entry.version}</span>
          <span class="rd-status label">${STATUS_LABEL[entry.status]}</span>
        </div>
        <div class="rd-body">
          <h3>${entry.theme}</h3>
          <ul>${entry.highlights.map((h) => `<li>${brand(h)}</li>`).join('')}</ul>
          ${notShipped}
          ${link}
        </div>
        <span class="rd-date mono">${entry.date ?? ''}</span>
      </li>`;
  }).join('');

  return `
    <h2>Roadmap</h2>
    <p class="dr-lede">
      One theme per release, from single-object reconstruction toward whole scenes. Statuses and
      dates are taken from ${brand('img2threejs')}&rsquo;s own ROADMAP, including what a release
      deliberately did not deliver.
      <a class="rd-link" href="${ROADMAP_URL}" target="_blank" rel="noopener noreferrer">Full roadmap ${ARROW_OUT}</a>
    </p>
    <ol class="rd-list">${rows}</ol>`;
}

/* ----------------------------------------------------------------- sponsors */

function sponsorDrawer(): string {
  const logos = SPONSORS.map(
    (s) => `
      <article class="sp-logo">
        <img src="${s.logo}" alt="${escapeAttr(s.name)}" loading="lazy" />
        <h3 class="sp-name">${escapeAttr(s.name)}</h3>
        <p class="sp-blurb">${escapeAttr(s.blurb)}</p>
        <p class="sp-pair">${brand(escapeAttr(s.pairing))}</p>
        <a class="btn sp-cta" href="${s.url}" target="_blank" rel="noopener noreferrer">
          ${escapeAttr(s.cta)} ${ARROW_OUT}
        </a>
      </article>`,
  ).join('');

  return `
    <h2>Sponsors</h2>
    <p class="dr-lede">
      ${brand('img2threejs')} is free and open source under Apache&nbsp;2.0. Sponsorship pays for the
      compute the reconstruction loop burns.
    </p>
    <div class="sp-grid">${logos}</div>
    <div class="dr-actions">
      <a class="btn btn-accent" href="${COFFEE_URL}" target="_blank" rel="noopener noreferrer">${HEART} Buy me a coffee</a>
      <a class="btn" href="${DONATE_URL}" target="_blank" rel="noopener noreferrer">VietQR &middot; MoMo &middot; PayPal</a>
      <a class="btn" href="${DISCORD_URL}" target="_blank" rel="noopener noreferrer">Join the Discord</a>
    </div>
    <p class="dr-note">
      Want your logo in this list? Write to
      <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
    </p>`;
}

/* -------------------------------------------------------------- how it works */

/** The eight build passes, quoted from the core README's pipeline line. */
const PASSES: Array<[string, string]> = [
  ['blockout', 'Mass and proportion only. A pass that cannot hold the silhouette does not get to continue.'],
  ['structural', 'Real components with real joins, so a shell cannot stand in for a mechanism.'],
  ['form', 'Cross-sections stop being constant: a dust cover thins, a blade grinds toward its apex.'],
  ['material', 'Each visible region is cropped from the reference, analysed and fitted — then gated per region.'],
  ['surface', 'Relief that rides a shell: serrations, jimping, stitch lines, fasteners.'],
  ['lighting', 'One bespoke rig per subject, solved against the reference rather than a generic studio preset.'],
  ['interaction', 'Pivots, sockets and an idle tick, so the result is animation-ready rather than a still.'],
  ['optimization', 'Triangle budget and draw calls, without giving back the detail the gates just bought.'],
];

function howItWorksDrawer(): string {
  const passes = PASSES.map(
    ([name, why], i) => `
      <li class="hw-pass">
        <span class="hw-n mono">${String(i + 1).padStart(2, '0')}</span>
        <div>
          <h4 class="mono">${name}</h4>
          <p>${why}</p>
        </div>
      </li>`,
  ).join('');

  // A real example beats a description of one. Only some entries record the prompt they were built
  // from; this picks a recorded one rather than paraphrasing what a prompt looks like.
  const withPrompt = demos.filter((d) => d.prompt);
  const example = withPrompt[0];
  const examplePanel = example
    ? `
      <h3 class="dr-h3">A real example</h3>
      <p class="dr-copy">
        This is the actual prompt behind one exhibit &mdash; ${escapeAttr(example.title)} &mdash;
        kept next to the result so the two can be read against each other.
        ${withPrompt.length} of ${demos.length} exhibits record theirs.
      </p>
      <blockquote class="hw-prompt mono">${escapeAttr(example.prompt!)}</blockquote>
      <p class="dr-note" style="margin-top:0.8rem;border:0;padding:0">
        Built with <span class="mono">${escapeAttr(example.generatedWith)}</span> &middot;
        <a href="${example.sourceUrl}" target="_blank" rel="noopener noreferrer">read the generated source ${ARROW_OUT}</a>
      </p>`
    : '';

  return `
    <h2>How it works</h2>
    <p class="dr-lede">
      ${brand('img2threejs')} does not generate a mesh and hand it to you. It writes a TypeScript
      function that BUILDS the mesh, then argues with itself about the result until the geometry
      matches the photograph. Everything in this workbench is the output of that argument.
    </p>

    <h3 class="dr-h3">One photo in</h3>
    <p class="dr-copy">
      A single reference image is analysed into a spec before any code exists: subject class, an
      inventory of identity-defining details (gloss, bevels, fasteners, linework, wear), material
      regions, and for characters an anatomy and landmark pass. A spec too shallow to be worth
      building is rejected at the strict-quality gate rather than generating code that looks
      plausible and measures wrong.
    </p>

    <h3 class="dr-h3">Eight passes out</h3>
    <p class="dr-copy">
      Code is generated and vision-reviewed one pass at a time, self-correcting until every
      identity-defining feature clears its threshold. The order is not cosmetic &mdash; a later pass
      cannot rescue a silhouette the blockout got wrong.
    </p>
    <ol class="hw-passes">${passes}</ol>

    <h3 class="dr-h3">What stops it lying</h3>
    <p class="dr-copy">
      Deterministic scripts do the validation and gating; the model is spent on visual judgment and
      code, not on grading its own homework. A few gates worth naming:
    </p>
    <dl class="dr-defs">
      <div><dt class="label">Map-stripped blockout</dt><dd>Reviewed with textures off, so a convincing finish cannot stand in for real structure</dd></div>
      <div><dt class="label">Component coverage</dt><dd>Every part the spec promised has to exist as its own component</dd></div>
      <div><dt class="label">Chirality</dt><dd>Left and right are checked as code, because a mirrored hand or a swapped scabbard reads instantly</dd></div>
      <div><dt class="label">Scalp exposure</dt><dd>Zero tolerance: hair that lets the scalp show through fails outright</dd></div>
      <div><dt class="label">Per-region material</dt><dd>Each material region is accepted only against its own reference crop</dd></div>
    </dl>

    <h3 class="dr-h3">Two honest routes</h3>
    <p class="dr-copy">
      Some finishes are <span class="mono">procedural</span> &mdash; generated from measured values.
      Others are <span class="mono">projection</span> &mdash; the reference's own de-lit pixels
      projected through the camera the plates are registered to. Projection is used where inventing
      the pattern would be a worse lie than borrowing it, and each exhibit records which route it
      took in its readout.
    </p>

    <h3 class="dr-h3">What it cannot do</h3>
    <p class="dr-copy">
      One photograph carries no information about the side it cannot see. Thickness, interior
      joinery and hidden faces are inferences, and the pipeline records them as inferences rather
      than presenting them as measurements. Multi-view reconstruction is the v2.0 answer to this and
      has not shipped.
    </p>

    ${examplePanel}

    <p class="dr-note">
      The full architecture, gate list and self-correction logic live in the core repository:
      <a href="${GITHUB_CORE}" target="_blank" rel="noopener noreferrer">${GITHUB_CORE.replace(/^https:\/\//, '')}</a>
    </p>`;
}

/* -------------------------------------------------------------- attribution */

/**
 * Subjects whose identity belongs to someone else. Grouped by rights holder rather than listed per
 * exhibit, because that is the axis a rights holder or a lawyer would read it on.
 */
const THIRD_PARTY: Array<{ holder: string; subjects: string }> = [
  {
    holder: 'Valve Corporation',
    subjects: 'AWP | Medusa, Glock-18 | Ghost Protocol, Classic Knife | Fade, M9 Bayonet | Doppler, ★ Talon Knife | Doppler Ruby — weapon finishes from Counter-Strike',
  },
  {
    holder: 'Nintendo · Creatures · GAME FREAK · The Pokémon Company',
    subjects: 'the yellow electric-mouse mascot in “Pikachu 10K Star Celebration”',
  },
  {
    holder: 'Fujiko-Pro · Shogakukan · TV Asahi',
    subjects: 'the characters and house in “Doraemon House”',
  },
  { holder: 'Sony Group Corporation', subjects: 'WF-1000XM3 earbuds and charging case' },
  { holder: 'Gerber Gear', subjects: 'the Paracord Knife' },
];

function attributionDrawer(): string {
  const rows = THIRD_PARTY.map(
    (t) => `
      <div>
        <dt class="label">${escapeAttr(t.holder)}</dt>
        <dd>${escapeAttr(t.subjects)}</dd>
      </div>`,
  ).join('');

  return `
    <h2>Attribution &amp; trademarks</h2>
    <p class="dr-lede">
      Several exhibits reconstruct subjects that somebody else designed. This page says who, plainly,
      because a gallery that shows other people's designs without naming them is not being honest
      about what it is.
    </p>

    <p class="dr-copy">
      All product names, trademarks, characters and designs named below are the property of their
      respective owners. ${brand('img2threejs')} is not affiliated with, endorsed by, or sponsored by
      any of them. The exhibits are independent procedural reconstructions built from a reference
      photograph for the purpose of demonstrating and testing a reconstruction pipeline &mdash; they
      are not official assets and are not offered as substitutes for them.
    </p>

    <dl class="dr-defs">${rows}</dl>

    <h3 class="dr-h3">What is actually licensed under Apache 2.0</h3>
    <p class="dr-copy">
      The Apache&nbsp;2.0 licence covers the ${brand('img2threejs')} <em>tool</em> and this site's own
      code. It does not, and cannot, grant you rights in a third party's design, trademark or
      character. If you intend to use a reconstruction of somebody else's product commercially, that
      is a question for a lawyer who knows your jurisdiction and your use &mdash; not one this page
      can answer for you.
    </p>

    <p class="dr-note">
      A rights holder who wants a subject removed or credited differently:
      <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. It will be actioned, not argued about.
    </p>`;
}

/* ------------------------------------------------------------------ privacy */

function privacyDrawer(): string {
  return `
    <h2>Privacy</h2>
    <p class="dr-lede">
      Short version: this site has no analytics, no cookies, no tracking, no advertising, and no
      account of any kind. It never asks you for a single piece of personal information, because
      there is nothing here that would use one.
    </p>

    <h3 class="dr-h3">What the page loads</h3>
    <p class="dr-copy">
      Everything is bundled and served from this domain. The models are code that runs in your
      browser, the fonts are the ones already on your system, and the page makes no request to any
      third party &mdash; the safety check that runs on every contribution rejects
      <span class="mono">fetch</span>, <span class="mono">XMLHttpRequest</span> and
      <span class="mono">WebSocket</span> in exhibit code, so this holds for demos too. Outbound
      links (GitHub, Discord, the sponsor and donation pages) reach those services only if you
      click them.
    </p>

    <h3 class="dr-h3">The one thing stored on your device</h3>
    <p class="dr-copy">
      A single <span class="mono">sessionStorage</span> entry,
      <span class="mono">img2threejs:intro-seen</span>, so the opening animation plays once per
      browser session instead of on every navigation. It holds the value
      <span class="mono">"1"</span> and nothing else, it never leaves your device, and your browser
      discards it when you close the tab. There are no cookies and no
      <span class="mono">localStorage</span>.
    </p>

    <h3 class="dr-h3">What the host can still see</h3>
    <p class="dr-copy">
      Being straight about the limit of the claim: this site is served by GitHub Pages, and like any
      web host GitHub receives your IP address and user agent in the ordinary course of delivering
      the page. That is outside this project's control and is governed by GitHub's own privacy
      statement. No such data is collected, requested or received by ${brand('img2threejs')}.
    </p>

    <h3 class="dr-h3">Verify it yourself</h3>
    <p class="dr-copy">
      Do not take the claim on trust &mdash; it is checkable in about thirty seconds. Open your
      browser's developer tools, go to the Network panel, and reload this page: every request should
      be to this domain. The Application panel will show the single session entry described above and
      no cookies. The site's full source is public.
    </p>

    <p class="dr-note">
      Questions, or something on this page that does not match what you observe:
      <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> &middot;
      <a href="${GITHUB_SHOWCASE}" target="_blank" rel="noopener noreferrer">read the source</a>
    </p>`;
}

/* ---------------------------------------------------------------------- FAQ */

const FAQ: Array<[string, string]> = [
  [
    'Is this AI-generated 3D? Am I looking at a mesh a model spat out?',
    'No. There is no mesh file anywhere in this site. Each exhibit is a TypeScript function that constructs its geometry when the page runs it, and you can read that function — every card links to its source. A language model wrote the code and judged the renders; the geometry itself is executed maths, which is why it can be inspected part by part and exploded rather than only looked at.',
  ],
  [
    'Some exhibits say “placeholder”. What does that mean?',
    'That the reconstruction has not passed the pipeline\'s own gates yet, and the entry says so rather than quietly presenting an unfinished result as finished. “final” means it cleared them. Both are shown because hiding the in-progress ones would make the gallery look better than the tool is.',
  ],
  [
    'Do I need a powerful machine or a GPU?',
    'Any browser with WebGL will run it. Two exhibits are genuinely heavy — one evaluates a 2.12M-sample signed-distance field, another decodes a multi-megabyte encoded surface stream — and those show a build loader while they work. The rest are light. Nothing is downloaded to your machine beyond the page itself.',
  ],
  [
    'Will it work on any photo I give it?',
    'No, and the pipeline is designed to say so early. A reference has to actually show the subject: severe occlusion, motion blur, extreme perspective or a subject too small in frame get rejected at the reference-admission step instead of producing a confident wrong model. One photo also carries nothing about the side it cannot see — thickness and interiors are recorded as inferences, not measurements.',
  ],
  [
    'Can I use these models in my game or product?',
    'Two separate questions, and only one of them has a clean answer. The tool and this site\'s code are Apache 2.0 — use them. But a reconstruction of somebody else\'s design carries that owner\'s rights regardless of who wrote the code: several exhibits here are Counter-Strike finishes, a Pokémon character, Doraemon, a Sony product. Apache 2.0 grants you nothing in those. See the attribution page, and ask a lawyer about your specific use rather than treating this answer as one.',
  ],
  [
    'Why not just use a photogrammetry or image-to-3D service?',
    'Different output, not a better or worse one. Those give you a mesh; this gives you a function. A function can be edited, re-parameterised, diffed in review, rigged, animated and shipped as a few kilobytes of code with no asset pipeline. If what you want is a scanned mesh, use a scanner — it will be faster and more accurate at that job.',
  ],
  [
    'How do I add my own exhibit?',
    'Three files: the generated factory, one registry entry, and a reference image under 800 KB. A scaffold script creates the first two for you, and a safety check gates the pull request. The contributing guide in the showcase repository walks the whole flow.',
  ],
  [
    'Is the site tracking me?',
    'No — no analytics, no cookies, no third-party requests. The privacy page explains exactly what is stored (one session flag) and, honestly, what the host can still see. It also tells you how to verify all of it in your own developer tools rather than believing the claim.',
  ],
];

function faqDrawer(): string {
  const items = FAQ.map(
    ([q, a]) => `
      <details class="faq-item">
        <summary>${q}</summary>
        <div class="faq-a">${brand(a)}</div>
      </details>`,
  ).join('');

  return `
    <h2>FAQ</h2>
    <p class="dr-lede">
      The questions people actually ask, answered without marketing. Where the honest answer is
      &ldquo;that depends&rdquo; or &ldquo;ask a lawyer&rdquo;, it says that.
    </p>
    <div class="faq">${items}</div>
    <p class="dr-note">
      Something missing? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> &middot;
      <a href="${DISCORD_URL}" target="_blank" rel="noopener noreferrer">Discord</a>
    </p>`;
}

/* -------------------------------------------------------------------- about */

function aboutDrawer(): string {
  const host = SITE_URL.replace(/^https:\/\//, '').replace(/\/$/, '');
  return `
    <h2>About &amp; contact</h2>
    <p class="dr-lede">
      Every model in this workbench is a TypeScript factory function. There are no imported meshes,
      no downloaded art packs and no runtime network calls &mdash; the geometry is executed in your
      browser from code that ${brand('img2threejs')} generated from a single reference photo.
    </p>

    <h3 class="dr-h3">This is the official site</h3>
    <p class="dr-copy">
      ${brand('img2threejs')} does not sell reconstructions, and takes money only through the channels
      listed below. A site that claims to be ${brand('img2threejs')} without linking back to these
      repositories is not affiliated with this project.
    </p>
    <dl class="dr-defs">
      <div><dt class="label">This site</dt><dd><a href="${SITE_URL}">${host}</a></dd></div>
      <div><dt class="label">Core tool</dt><dd><a href="${GITHUB_CORE}" target="_blank" rel="noopener noreferrer">${GITHUB_CORE.replace(/^https:\/\//, '')}</a></dd></div>
      <div><dt class="label">This gallery</dt><dd><a href="${GITHUB_SHOWCASE}" target="_blank" rel="noopener noreferrer">${GITHUB_SHOWCASE.replace(/^https:\/\//, '')}</a></dd></div>
      <div><dt class="label">Community</dt><dd><a href="${DISCORD_URL}" target="_blank" rel="noopener noreferrer">discord.gg/8DS8RTyuR</a></dd></div>
      <div><dt class="label">Payments</dt><dd>buymeacoffee.com/hoainhowors, the donate page on this domain, GitHub Sponsors &mdash; nothing else</dd></div>
    </dl>

    <h3 class="dr-h3">Contact</h3>
    <dl class="dr-defs">
      <div><dt class="label">Maintainer</dt><dd>${CONTACT_NAME} (Hoài Nhớ)</dd></div>
      <div><dt class="label">Email</dt><dd><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></dd></div>
      <div><dt class="label">Impersonation</dt><dd>report it to the same address</dd></div>
    </dl>

    <p class="dr-note">
      &copy; ${new Date().getFullYear()} Hoài Nhớ &middot;
      <a href="${LICENSE_URL}" target="_blank" rel="noopener noreferrer">Apache License 2.0</a> &middot;
      free and open source.
    </p>`;
}

/* --------------------------------------------------------------------- menu */

/**
 * Mobile navigation. The top bar's link row is hidden below 860px for width, which left every
 * content page on this list unreachable by tapping — the command palette only searches exhibits.
 * This is that row, as a list, reachable from the hamburger.
 */
function menuDrawer(): string {
  const items: Array<[string, string, string]> = [
    ['how-it-works', 'How it works', 'The pipeline, the gates, and what one photo cannot tell it'],
    ['roadmap', 'Roadmap', 'Every release, what shipped and what deliberately did not'],
    ['faq', 'FAQ', 'Straight answers, including the ones that are “ask a lawyer”'],
    ['sponsor', 'Sponsors', 'Who pays for the compute, and how to help'],
    ['attribution', 'Attribution', 'Whose designs these reconstructions belong to'],
    ['privacy', 'Privacy', 'No analytics, no cookies — and how to verify that'],
    ['about', 'About & contact', 'Official links, the maintainer, the licence'],
  ];
  return `
    <h2>Menu</h2>
    <nav class="mn-list" aria-label="Pages">
      ${items
        .map(
          ([key, title, blurb]) => `
        <button type="button" class="mn-item" data-drawer="${key}">
          <span class="mn-title">${title}</span>
          <span class="mn-blurb">${blurb}</span>
        </button>`,
        )
        .join('')}
    </nav>
    <div class="dr-actions">
      <a class="btn" href="${GITHUB_CORE}" target="_blank" rel="noopener noreferrer">Star on GitHub</a>
      <a class="btn btn-accent" href="${COFFEE_URL}" target="_blank" rel="noopener noreferrer">${HEART} Sponsor</a>
    </div>`;
}

/* --------------------------------------------------------------- public map */

/** Drawer key → builder. Keys match `DRAWER_ROUTES` in router.ts, so each one is deep-linkable. */
export const DRAWERS: Record<string, { title: string; build: () => string }> = {
  menu: { title: 'Menu', build: menuDrawer },
  'how-it-works': { title: 'How it works', build: howItWorksDrawer },
  faq: { title: 'FAQ', build: faqDrawer },
  privacy: { title: 'Privacy', build: privacyDrawer },
  attribution: { title: 'Attribution', build: attributionDrawer },
  roadmap: { title: 'Roadmap', build: roadmapDrawer },
  sponsor: { title: 'Sponsors', build: sponsorDrawer },
  about: { title: 'About', build: aboutDrawer },
};
