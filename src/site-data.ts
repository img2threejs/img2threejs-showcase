/**
 * Single source of truth for site-wide links, contact info, sponsors and the public roadmap
 * summary. Pulled from img2threejs's own README.md / ROADMAP.md / CHANGELOG.md so the marketing
 * shell never invents a claim the core project doesn't already make.
 */

export const BASE = import.meta.env.BASE_URL;

/**
 * Canonical identity is the `img2threejs` org: it is what the core tool's own README and its git
 * origin use, and `registry.ts`'s `REPO` is aligned to it. The authenticity section renders these
 * verbatim, so they must not drift.
 *
 * `SITE_URL` is the apex custom domain, which is now the only address the project publishes. The
 * three URLs that used to appear in its place are all retired: `img2threejs.github.io/
 * img2threejs-showcase/` (the org's Pages project path, which GitHub now 301s here),
 * `hoainho.github.io/…` (a personal fork's Pages, never canonical) and
 * `img2threejs-showcase.pages.dev` (a secondary Cloudflare deploy). Reintroducing any of them
 * would split the site's identity across hosts again.
 *
 * `index.html` hardcodes this same origin in `og:image`, `og:url` and `link[rel=canonical]`,
 * because a static document cannot import from here — change both together.
 */
export const GITHUB_CORE = 'https://github.com/img2threejs/img2threejs';
export const GITHUB_SHOWCASE = 'https://github.com/img2threejs/img2threejs-showcase';
export const SITE_URL = 'https://img2threejs.io/';
export const CHANGELOG_URL = `${GITHUB_CORE}/blob/main/CHANGELOG.md`;
export const ROADMAP_URL = `${GITHUB_CORE}/blob/main/ROADMAP.md`;
export const LICENSE_URL = `${GITHUB_CORE}/blob/main/LICENSE`;
export const DISCORD_URL = 'https://discord.gg/8DS8RTyuR';
export const COFFEE_URL = 'https://ko-fi.com/iamnick';
export const DONATE_URL = `${BASE}donate.html`;

export const CONTACT_EMAIL = 'hoainho.work@gmail.com';
export const CONTACT_NAME = 'Nick';
export const CURRENT_VERSION = 'v1.5.1';

/* --------------------------------------------------------------------------- analytics */

/**
 * The GA4 measurement ID, committed in the clear on purpose: it is not a secret. Every visitor
 * receives it in the page anyway, Google's own install instructions put it in the HTML, and the
 * alternative — a build secret — would mean the ID is absent from local builds and PR previews,
 * which is exactly where an analytics change needs to be testable.
 *
 * Replace the placeholder with the property's real ID (Admin → Data streams → your stream → the
 * `G-` prefixed Measurement ID). While it is still the placeholder, `analytics.ts` sends nothing at
 * all and says why in the console under `?analytics_debug=1`.
 */
export const GA_MEASUREMENT_ID_PLACEHOLDER = 'G-XXXXXXXXXX';
export const GA_MEASUREMENT_ID: string = 'G-4MSYRF7901';

/**
 * Hostnames allowed to send measurements, so `localhost`, a `vite preview`, a fork's Pages build
 * and a Cloudflare preview deploy cannot pollute the property that sponsor reports are drawn from.
 * `?analytics_debug=1` overrides this for deliberate local verification.
 */
export const ANALYTICS_HOSTS: readonly string[] = ['img2threejs.io', 'www.img2threejs.io'];

/**
 * Wraps every occurrence of the product name in the animated gradient span, so the brand reads the
 * same everywhere it appears — including inside strings that come from the registry (blurbs and
 * `generatedWith` version chips) rather than from a page's own markup.
 *
 * Lives here rather than in one page because both the gallery and the demo viewer render registry
 * strings, and the demo viewer having its own un-branded copy is exactly how it ended up with zero
 * gradient nodes on the page.
 *
 * Emits markup, so it belongs in text positions only, never inside an attribute value.
 */
export function brand(text: string): string {
  return text.replace(/img2threejs/g, '<span class="grad">img2threejs</span>');
}

/**
 * U+FE0E, the text-presentation variation selector. `♥` (U+2665) and `↗` (U+2197) are both
 * `Emoji=Yes`, so iOS and Android swap in the colour emoji glyph by default — which would put
 * emoji on a page whose whole brief is "no emoji, coding style only". This pins them to the
 * monospace text glyph.
 */
export const TEXT_GLYPH = '︎';
export const HEART = `&#9829;${TEXT_GLYPH}`;
export const ARROW_OUT = `&#8599;${TEXT_GLYPH}`;

export interface SponsorEntry {
  /**
   * Stable reporting key, and the reason it exists separately from `name`: sponsor reports are
   * compared month over month, and a sponsor that rebrands must not become a second row that
   * splits its own history in half. Never rename an id once a report has been sent to the sponsor.
   */
  id: string;
  name: string;
  url: string;
  /**
   * Extra hostnames belonging to this sponsor, beyond the one in `url`. Analytics attributes a
   * click by hostname, so a link anywhere on the site — including a demo entry's `tripoUrl`
   * provenance link, which points at an asset page rather than the marketing site — lands in the
   * right sponsor's row without every page having to know who the sponsors are.
   */
  domains?: string[];
  /** The site renders dark-only (`color-scheme: dark`), so one light-on-dark mark is all it needs. */
  logo: string;
  /** What the sponsor sells, in their own terms. Sourced from their site, not written to flatter. */
  blurb: string;
  /**
   * Why that product and this one belong in the same sentence. Kept separate from `blurb` so the
   * card can mark it as our claim about the pairing rather than the sponsor's claim about itself.
   */
  pairing: string;
  /** Label for the card's outbound button. Named per sponsor so the CTA says where it actually goes. */
  cta: string;
}

/**
 * Logo sponsors, in the order they should render. Stacked as cards rather than looped as a
 * marquee: at this length a slider just reads as stuck, and each entry carries prose a logo strip
 * has nowhere to put.
 */
export const SPONSORS: SponsorEntry[] = [
  {
    id: 'atlas-cloud',
    name: 'Atlas Cloud',
    url: 'https://www.atlascloud.ai/console/coding-plan',
    logo: `${BASE}sponsors/atlas-cloud-logomark-white.svg`,
    blurb:
      'A full-modal AI inference platform: one API for video generation, image generation and ' +
      'LLM access across 300+ curated models, instead of managing a separate integration per vendor.',
    pairing:
      'Reconstruction-by-code is an LLM workload before it is a graphics one — every img2threejs ' +
      'gate rerun spends tokens. One endpoint across 300+ models is what keeps that loop affordable.',
    cta: 'Open the coding plan',
  },
  {
    id: 'tripo',
    name: 'Tripo',
    url: 'https://www.tripo3d.ai/',
    // `studio.tripo3d.ai` is where a demo's `tripoUrl` provenance link points; the resolver matches
    // subdomains, so the marketing host alone would already cover it. Named anyway, because it is
    // the one sponsor whose links appear outside the sponsor drawer.
    domains: ['tripo3d.ai'],
    logo: `${BASE}sponsors/tripo-logomark-white.svg`,
    blurb:
      'Image- and text-to-3D at production quality: High Detail meshes up to 2M polygons, artist-' +
      'grade quad Smart Mesh from 500 to 50K, AI auto-rigging, 8K PBR texturing and part-level ' +
      'segmentation — exported as GLB, FBX, OBJ, USD, STL or 3MF, with plugins for Blender, Unity, ' +
      'Unreal, Godot, Cocos and ComfyUI.',
    pairing:
      'Its quad meshes and auto-rig give an img2threejs rebuild something to be measured against: a ' +
      'second read on silhouette, proportion and joint placement that one reference photo cannot ' +
      'settle on its own.',
    cta: 'Open Tripo Studio',
  },
  {
    id: 'hyper3d',
    name: 'Hyper3D',
    url: 'https://hyper3d.ai/',
    logo: `${BASE}sponsors/hyper3d-logomark-white.png`,
    blurb:
      'Hyper3D Rodin turns a prompt or a reference image into a 3D asset in seconds, with bounding-' +
      'box, voxel and point-cloud ControlNet guidance, partial editing for one region at a time, ' +
      'low-poly optimisation, and ChatAvatar for rigged faces. Exports STL, FBX, OBJ, GLB, glTF and USDZ.',
    pairing:
      'Rodin answers the one question a single photograph never can — what the back looks like. ' +
      'Generate, orbit it, and the hidden sides become references the img2threejs material and ' +
      'surface gates can actually be run against.',
    cta: 'Open Hyper3D Rodin',
  },
];

export type RoadmapStatus = 'shipped' | 'latest' | 'in-progress' | 'planned';

export interface RoadmapEntry {
  version: string;
  theme: string;
  status: RoadmapStatus;
  date?: string;
  highlights: string[];
  /** What a release deliberately did NOT deliver. ROADMAP.md tracks this; hiding it would oversell. */
  notShipped?: string;
}

/**
 * Condensed from img2threejs/ROADMAP.md's own table — version numbers, theme names, statuses and
 * dates are copied exactly; the highlight bullets are shortened from the table's cells, not quoted
 * verbatim, and no capability appears here that the table does not already claim.
 *
 * Two rows carry emphasis because the doc gives them two different kinds of "now": `v1.5` is the
 * latest shipped release (ROADMAP.md "Shipped", CHANGELOG `[1.5.0] — 2026-08-12`), while
 * `v1.2-gates` is the only row the table marks **In progress**. Labelling v1.5 "current" alone
 * would have contradicted its own source doc.
 */
export const ROADMAP: RoadmapEntry[] = [
  {
    version: 'v1.0', theme: 'Object pipeline', status: 'shipped', date: '2026-07-15',
    highlights: [
      'Staged sculpt pipeline, blockout through optimization',
      'Render-vs-reference review loop',
      'Action-ready runtime hierarchy',
    ],
  },
  {
    version: 'v1.1', theme: 'Detail-first analysis', status: 'shipped', date: '2026-07-15',
    highlights: [
      'Required detailInventory artifact (gloss, bevel, fasteners, linework, stains)',
      'Strict-quality gate blocking shallow specs before codegen',
    ],
  },
  {
    version: 'v1.2-gates', theme: 'Portable structural gates', status: 'in-progress',
    highlights: [
      'Portable ledger, geometry, evidence and report gates run in forge scripts',
      'Host-specific tool-call enforcement is deferred',
    ],
  },
  {
    version: 'v1.2', theme: 'Humanoid character generator', status: 'shipped', date: '2026-07-21',
    highlights: [
      'Character / hybrid domain detection',
      'Anatomy and facial landmarks',
      'Proportion-lock and feature-placement build passes, per-part character materials',
    ],
  },
  {
    version: 'v1.3', theme: 'Quality & efficiency (Divine Eye)', status: 'shipped', date: '2026-07-22',
    highlights: [
      'Deterministic review harness',
      'Input-integrity and geometry-truth gates',
      'Projection-first texture/material analysis, CIEDE2000 colour math',
    ],
  },
  {
    version: 'v1.4', theme: 'The Weapon Update', status: 'shipped', date: '2026-07-25–26',
    highlights: [
      'CS2 image-matched reconstruction, provenance-aware intake',
      'Projection-first finishes, family-specific adapters',
      'Structural and component-coverage gates',
    ],
  },
  {
    version: 'v1.5', theme: 'The Character Update', status: 'latest', date: '2026-08-12',
    highlights: [
      'Component-derived skeleton bound to SkinnedMesh geometry, geodesic skinning',
      'Hair subsystem across all five stages, chirality gates',
      'Interior-difference review, material pipeline, resumable workflow state',
    ],
    notShipped: 'hairProfile compiler, IK, pose-sweep gating, clothing',
  },
  {
    version: 'v1.6', theme: 'The Environment Update', status: 'planned',
    highlights: [
      'Buildings, rooms, streets, trees & vegetation',
      'Terrain-aware generation',
      'Multi-object reconstruction',
    ],
  },
  {
    version: 'v1.7', theme: 'The Game Pipeline Update', status: 'planned',
    highlights: [
      'Unity exporter, Unreal exporter, Blender bridge',
      'FBX / OBJ / glTF improvements',
      'LOD generation, collision mesh generation',
    ],
  },
  {
    version: 'v1.8', theme: 'The Animation Update', status: 'planned',
    highlights: [
      'Auto rigging, auto skin weights',
      'Mixamo compatibility, facial rig',
      'Lip-sync preparation, animation-ready exports',
    ],
  },
  {
    version: 'v1.9', theme: 'The AI Studio Update', status: 'planned',
    highlights: [
      'Web UI, drag & drop workflow',
      'Batch processing, visual prompt builder',
      'Cloud rendering, public showcase integration',
    ],
  },
  {
    version: 'v2.0', theme: 'The Procedural World Update', status: 'planned',
    highlights: [
      'Multi-view reconstruction, semantic world understanding',
      'Procedural city generation, interior reconstruction',
      'Plugin ecosystem & API',
    ],
  },
];

/**
 * The version tag inside a `generatedWith` string.
 *
 * Shared rather than copied: the workbench readout and the demo panel's version badge must never
 * disagree about which version built an exhibit. Case-insensitive because one entry records `V2`, and
 * the optional suffix catches `v1.5-beta`. Returns null for the entries that name no version at all --
 * the reference baseline is rendered as shipped, so there is nothing to claim.
 */
const VERSION_TAG = /v\d+(?:\.\d+){0,2}(?:-[a-z0-9.]+)?/i;

export function extractVersion(generatedWith: string): string | null {
  return generatedWith.match(VERSION_TAG)?.[0] ?? null;
}

/** Escape text destined for an HTML attribute. */
export function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
