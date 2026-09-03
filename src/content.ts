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
import { isOptedOut } from './analytics';
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
      <article class="sp-logo" data-sponsor="${escapeAttr(s.id)}">
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
    <div class="dr-actions" data-placement="sponsor_support">
      <a class="btn btn-accent" href="${COFFEE_URL}" target="_blank" rel="noopener noreferrer">${HEART} Support on Ko-fi</a>
      <a class="btn" href="${DONATE_URL}" target="_blank" rel="noopener noreferrer">VietQR &middot; MoMo &middot; PayPal</a>
      <a class="btn" href="${DISCORD_URL}" target="_blank" rel="noopener noreferrer">Join the Discord</a>
    </div>
    <p class="dr-note">
      Want your logo in this list? Write to
      <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. Sponsors are sent an anonymous,
      aggregate monthly count of how many times their card was seen and how many times it was
      clicked &mdash; never anything about who did either. The
      <button type="button" class="dr-inline-link" data-drawer="privacy">privacy page</button>
      states exactly what is measured.
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
  const optedOut = isOptedOut();

  return `
    <h2>Privacy</h2>
    <p class="dr-lede">
      Short version: this site measures how it is used, with Google Analytics. There is no
      advertising, no account, no personal information asked for and nothing sold or shared with
      anyone but the analytics provider that processes it. This page lists what is actually
      collected, names the cookies, and gives you a switch to turn it off.
    </p>

    <p class="dr-copy">
      This page used to say the site had no analytics at all, and for a while that was true. It
      changed when the project took on logo sponsors: a sponsor paying for compute is owed evidence
      of what their placement did, and &ldquo;trust us, people click it&rdquo; is not evidence. So the
      claim changed rather than the page quietly staying as it was.
    </p>

    <h3 class="dr-h3">What is measured</h3>
    <p class="dr-copy">
      Interactions with the site, sent to Google Analytics 4 as named events. The complete list is
      in <a href="${GITHUB_SHOWCASE}/blob/main/src/analytics.ts" target="_blank" rel="noopener noreferrer">
      one source file</a> &mdash; every event this site can send is a named function in it, so the
      list below can be checked against the code rather than taken on faith:
    </p>
    <dl class="dr-defs">
      <div><dt class="label">Navigation</dt><dd>Which route you open &mdash; an exhibit, the roadmap, this page &mdash; and how you got there (rail, arrow keys, search, a shared link)</dd></div>
      <div><dt class="label">Exhibits</dt><dd>Which model, how long it took to build on your machine, whether it finished, and whether you orbited it at all</dd></div>
      <div><dt class="label">Controls</dt><dd>Animations played, the explode slider, and which named part you selected</dd></div>
      <div><dt class="label">Reading</dt><dd>Which content pages and which FAQ questions get opened</dd></div>
      <div><dt class="label">Search</dt><dd>What you type into the exhibit palette (&#8984;K). It matches against a fixed list of exhibit titles; nothing else on the site accepts text</dd></div>
      <div><dt class="label">Outbound clicks</dt><dd>Links to GitHub, Discord, ArtStation, the donation channels &mdash; and sponsor cards, which is the reason any of this exists</dd></div>
      <div><dt class="label">From Google, not from us</dt><dd>Approximate location derived from your IP (country, region, city), device, browser, screen size, language, and the site that referred you</dd></div>
    </dl>

    <h3 class="dr-h3">What sponsors are told</h3>
    <p class="dr-copy">
      Two numbers per sponsor per month: how many times their card was on screen, and how many times
      it was clicked. A card counts as seen when at least a quarter of it scrolls into view, once per
      visit to the sponsor page &mdash; a deliberately conservative denominator, so the click-through
      rate a sponsor is shown is not inflated by counting cards nobody scrolled to. Sponsors receive
      totals and nothing else: no visitor, no session, no location, no list of who clicked.
    </p>

    <h3 class="dr-h3">What is not collected</h3>
    <p class="dr-copy">
      No name, email, or account &mdash; the site has no login and no form. No identifier of this
      project's own making. Nothing you type anywhere except the exhibit search above. No
      advertising features: Google Signals, ad personalisation and data sharing for ads are all off
      on the property, so nothing here feeds cross-site ad profiling. Nothing is sold, and no data
      is shared with any third party other than Google as the processor.
    </p>

    <h3 class="dr-h3">Cookies, named</h3>
    <p class="dr-copy">
      Google Analytics sets two first-party cookies on this domain: <span class="mono">_ga</span> and
      <span class="mono">_ga_&lt;stream&nbsp;id&gt;</span>. They hold a randomly generated number that
      lets a second page view be recognised as the same browser rather than a new one, they expire
      two years after your last visit, and they are readable only by this domain. That is the whole
      set &mdash; there is no advertising cookie, and Google Analytics 4 does not log or store IP
      addresses. Event data is retained for 14 months on the property and then deleted by Google.
    </p>

    <h3 class="dr-h3">The one thing stored by the site itself</h3>
    <p class="dr-copy">
      A single <span class="mono">sessionStorage</span> entry,
      <span class="mono">img2threejs:intro-seen</span>, so the opening animation plays once per
      browser session instead of on every navigation. It holds the value
      <span class="mono">"1"</span>, it never leaves your device, and your browser discards it when
      you close the tab. Turning analytics off with the switch below adds a second one,
      <span class="mono">img2threejs:analytics-opt-out</span>, in
      <span class="mono">localStorage</span> &mdash; the choice has to outlive the tab to be worth
      anything.
    </p>

    <h3 class="dr-h3">The exhibits themselves still make no requests</h3>
    <p class="dr-copy">
      Worth separating from the above, because it is the claim this project actually stakes something
      on: the models are code, and that code reaches the network never. The safety check that runs on
      every contribution rejects <span class="mono">fetch</span>,
      <span class="mono">XMLHttpRequest</span> and <span class="mono">WebSocket</span> in exhibit
      code, and there are no imported meshes, no CDN and no remote fonts. The only third-party
      request this site makes is the analytics script, and it is not involved in rendering anything.
    </p>

    <h3 class="dr-h3">Who processes it</h3>
    <p class="dr-copy">
      Google, as the analytics provider &mdash; see
      <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google's privacy policy</a>
      and
      <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer">how Google uses data from sites that use its services</a>.
      Separately, and as with any web host, GitHub Pages receives your IP address and user agent in
      the ordinary course of delivering this page; that is governed by GitHub's own privacy
      statement and is outside this project's control.
    </p>

    <h3 class="dr-h3">Turning it off</h3>
    <p class="dr-copy">
      ${optedOut
        ? 'Analytics is <strong>off</strong> in this browser. Nothing is being sent, and the analytics script is not loaded.'
        : 'Analytics is <strong>on</strong> in this browser. One click stops it, permanently, on this device.'}
      The setting is stored on your device, not against any identity, so it applies to this browser
      only. An ad blocker, tracker blocker or a browser that blocks
      <span class="mono">googletagmanager.com</span> achieves the same thing and is not worked around
      here.
    </p>
    <div class="dr-actions">
      <button type="button" class="btn ${optedOut ? '' : 'btn-accent'}" data-analytics-toggle="${optedOut ? 'on' : 'off'}">
        ${optedOut ? 'Turn analytics back on' : 'Turn analytics off in this browser'}
      </button>
    </div>

    <h3 class="dr-h3">Verify it yourself</h3>
    <p class="dr-copy">
      Do not take any of this on trust. Open your browser's developer tools, go to the Network panel
      and reload: apart from <span class="mono">googletagmanager.com</span> and the
      <span class="mono">/g/collect</span> requests it makes, every request should be to this domain.
      Add <span class="mono">?analytics_debug=1</span> to the URL and the console prints every event
      as it is sent, with its parameters &mdash; which is the fastest way to check that this page
      describes what the code does. The Application panel will show the cookies and storage entries
      named above and nothing else.
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
    'It measures you, and it should say so plainly: Google Analytics is installed, it sets two first-party cookies, and it records which exhibits you open, whether you orbit them, which pages you read and which outbound links you click. It exists for one reason — logo sponsors are owed evidence that their placement does something, and the whole sponsor report is two numbers per sponsor: card seen, card clicked. There is no advertising, no account, nothing you type except the exhibit search, and no data sold or shared with anyone but Google as the processor. The privacy page names the cookies, lists every event, gives you a switch to turn it off, and tells you how to verify all of it in your own developer tools. This answer used to be a flat "no", and changing it was the honest thing to do when the site changed.',
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
      no downloaded art packs and no network call anywhere in the rendering path &mdash; the geometry
      is executed in your browser from code that ${brand('img2threejs')} generated from a single
      reference photo. The site's one third-party request is its analytics script, which renders
      nothing; the <button type="button" class="dr-inline-link" data-drawer="privacy">privacy
      page</button> covers it.
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
      <div><dt class="label">Payments</dt><dd>ko-fi.com/iamnick, the donate page on this domain, GitHub Sponsors &mdash; nothing else</dd></div>
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
    ['privacy', 'Privacy', 'What analytics collects, the cookies it sets, and the switch to stop it'],
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
