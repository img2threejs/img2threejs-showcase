/**
 * Analytics — Google Analytics 4, in one file.
 *
 * Every event this site can send is a named function below. Pages call `trackSponsorClick(...)`;
 * no page ever calls `gtag('event', ...)` itself. That is the whole point of the file: the event
 * taxonomy and its parameter names are readable in one place, so a report built in the GA4 UI
 * cannot be quietly orphaned by a page renaming its event, and a new page cannot invent a
 * seventeenth spelling of "the visitor clicked a sponsor".
 *
 * SPONSOR REPORTING IS THE PRIMARY JOB. Sponsors are sent an impression count, a click count and
 * the click-through rate between them, so both halves of that ratio have to be measured on the
 * same terms:
 *   - `sponsor_impression` fires when a sponsor's card is actually on screen (IntersectionObserver,
 *     not merely "the drawer was opened"), once per sponsor per drawer opening.
 *   - `sponsor_click` fires on the outbound click, carrying the same `sponsor_id`.
 * `sponsor_id` is a stable slug, never the display name: a sponsor that rebrands must not split
 * into two rows in a report that spans the rename.
 *
 * WHAT IS DELIBERATELY NOT COLLECTED: nothing typed by the visitor except exhibit-search terms
 * (which are matched against a fixed list of exhibit titles), no form input, no identifiers of our
 * own making, and no attempt to join a visit to a person. See the privacy drawer in `content.ts` —
 * it is written to match this file, and changing what is collected here means changing it there.
 */

import { isCaptureRun } from './capture-run';
import {
  ANALYTICS_HOSTS,
  CURRENT_VERSION,
  GA_MEASUREMENT_ID,
  GA_MEASUREMENT_ID_PLACEHOLDER,
  SPONSORS,
  type SponsorEntry,
} from './site-data';

/* --------------------------------------------------------------------------- types */

/** GA4 accepts strings, numbers and booleans as parameter values. `undefined` keys are dropped. */
export type EventParams = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/** Which UI a measurement came from. The same action exists in both, and they measure differently. */
export type Surface = 'workbench' | 'viewer';

/** Where a sponsor was shown or clicked. One value per physical place a sponsor link exists. */
export type SponsorPlacement =
  | 'sponsor_drawer'
  | 'demo_provenance'
  | 'menu_drawer'
  | 'donate_page';

/* ----------------------------------------------------------------------- GA4 limits */

/**
 * GA4 truncates silently rather than rejecting, which is how a report ends up full of values that
 * are almost right. Clipping here, where the limits are written down, at least makes the loss
 * visible in one place. Limits per Google's "GA4 event" reference: parameter name 40 characters,
 * parameter value 100 characters, 25 parameters per event.
 */
const MAX_PARAM_VALUE_CHARS = 100;
const MAX_PARAMS_PER_EVENT = 25;

function clip(value: string): string {
  return value.length <= MAX_PARAM_VALUE_CHARS ? value : value.slice(0, MAX_PARAM_VALUE_CHARS);
}

/* ------------------------------------------------------------------- enable / disable */

const OPT_OUT_KEY = 'img2threejs:analytics-opt-out';

/** `?analytics=off` opts out for good; `?analytics=on` undoes it. Both work on the hash too. */
function urlFlag(name: string): string | null {
  const fromSearch = new URLSearchParams(window.location.search).get(name);
  if (fromSearch !== null) return fromSearch;
  const hashQuery = window.location.hash.split('?')[1];
  return hashQuery ? new URLSearchParams(hashQuery).get(name) : null;
}

function readOptOut(): boolean {
  try {
    return window.localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    // Storage blocked entirely (private mode, hardened settings). Not an opt-out on its own.
    return false;
  }
}

/**
 * Persists the visitor's choice and takes effect immediately: GA's own kill switch
 * (`window['ga-disable-<ID>']`) is documented to stop all sending for that measurement ID without a
 * reload, so an opt-out does not have to wait for the next page load to mean something.
 */
export function setAnalyticsOptOut(optedOut: boolean): void {
  try {
    if (optedOut) window.localStorage.setItem(OPT_OUT_KEY, '1');
    else window.localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    /* nothing we can do; the window flag below still applies for this page's lifetime */
  }
  (window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`] = optedOut;
  enabled = !optedOut && disabledReason() === null;
  /**
   * Opting back in has to actually resume, in this page's lifetime.
   *
   * A visitor who opted out on an earlier visit gets no gtag.js at all — `initAnalytics` returned
   * before loading it — so flipping `enabled` back on would leave the privacy page saying
   * "analytics is on" while `track()` silently dropped everything for want of a `gtag`. Loading it
   * here is what makes the switch mean the same thing in both directions.
   */
  if (enabled && !window.gtag) loadGtag();
}

export function isOptedOut(): boolean {
  return readOptOut();
}

/**
 * Why analytics is off, or `null` when it is on. Returned as a string rather than a boolean so
 * `?analytics_debug=1` can print the actual reason — "it silently does nothing" is the single most
 * expensive failure mode in an analytics install.
 */
function disabledReason(): string | null {
  if (GA_MEASUREMENT_ID === GA_MEASUREMENT_ID_PLACEHOLDER || !GA_MEASUREMENT_ID) {
    return 'no measurement ID configured in src/site-data.ts';
  }
  if (readOptOut()) return 'visitor opted out';
  if (isCaptureRun()) return 'headless capture run';
  // Playwright and every other WebDriver-based runner sets this. The review harness loads exhibit
  // pages dozens of times per run; counting those as visits would make the whole property useless.
  if (navigator.webdriver) return 'automated browser (navigator.webdriver)';
  if (debugForced) return null;
  if (!ANALYTICS_HOSTS.includes(window.location.hostname)) {
    return `host "${window.location.hostname}" is not a production host`;
  }
  return null;
}

let debugForced = false;
let enabled = false;
let initialized = false;

export function isAnalyticsEnabled(): boolean {
  return enabled;
}

/* -------------------------------------------------------------------------- loading */

/**
 * Loads gtag.js and configures the property. Safe to call once, from `main.ts`, before anything
 * else renders — events fired before the script finishes downloading are not lost, because
 * `dataLayer` is a plain array until gtag.js replaces it and drains what is already queued.
 */
export function initAnalytics(): void {
  if (initialized) return;
  initialized = true;

  debugForced = urlFlag('analytics_debug') === '1';

  // `?analytics=off` / `=on` is the opt-out the privacy drawer documents, honoured before anything
  // is loaded so an opt-out link never causes a single measurement of its own.
  const choice = urlFlag('analytics');
  if (choice === 'off') setAnalyticsOptOut(true);
  else if (choice === 'on') setAnalyticsOptOut(false);

  const reason = disabledReason();
  if (debugForced) {
    // eslint-disable-next-line no-console
    console.info(
      reason ? `[analytics] disabled — ${reason}` : `[analytics] enabled — ${GA_MEASUREMENT_ID}`,
    );
  }
  if (reason !== null) return;

  loadGtag();
  enabled = true;
}

/**
 * The documented gtag.js snippet, as a function so the opt-out switch can call it too.
 *
 * `dataLayer` is a plain array until gtag.js replaces it, and gtag.js drains whatever is already
 * queued — so an event fired during page mount, before the script has finished downloading, is not
 * lost. That is why `initAnalytics` can be called before the first render.
 */
function loadGtag(): void {
  window.dataLayer = window.dataLayer || [];
  const gtag: (...args: unknown[]) => void = function gtag() {
    // The documented snippet pushes `arguments` itself, not an array built from it: gtag.js reads
    // the pushed objects back as Arguments, and an array does not deserialise the same way.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID, {
    /**
     * Manual, because this is a hash router and GA4 would get every route wrong on its own: it
     * derives its page dimensions from `page_location` with the fragment STRIPPED, so `#/privacy`,
     * `#/x/warrior` and `#/demo/awp-medusa-v2` would all report as `/` and the whole "where are
     * people spending time" question would be unanswerable. `trackPageView` below sends a
     * `page_location` with the route promoted out of the fragment into a real path instead.
     */
    send_page_view: false,
    debug_mode: debugForced,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
  document.head.appendChild(script);
}

/* --------------------------------------------------------------------------- sending */

/**
 * The one place an event leaves the site.
 *
 * `site_version` rides on every event explicitly rather than through `gtag('config')`: a report
 * that cannot separate "v1.5.1 visitors" from "v1.6 visitors" cannot tell a regression from a
 * change in the audience, and config-level parameter inheritance is not something to bet a whole
 * property's data on.
 */
export function track(name: string, params: EventParams = {}): void {
  if (!enabled || !window.gtag) return;

  const payload: Record<string, string | number | boolean> = { site_version: CURRENT_VERSION };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Object.keys(payload).length >= MAX_PARAMS_PER_EVENT) break;
    payload[key] = typeof value === 'string' ? clip(value) : value;
  }

  window.gtag('event', name, payload);
  if (debugForced) {
    // eslint-disable-next-line no-console
    console.debug('[analytics]', name, payload);
  }
}

/** One-shot guard for events that would otherwise fire on every frame or every scroll. */
const fired = new Set<string>();

function trackOnce(key: string, name: string, params: EventParams = {}): void {
  if (fired.has(key)) return;
  fired.add(key);
  track(name, params);
}

/**
 * Called when an exhibit loads, so its per-exhibit one-shots (first orbit) can fire again.
 *
 * Matched on the `viewer_interact:` prefix, not on the id alone: sponsor impression keys end in a
 * sponsor id, and no sponsor is currently named after an exhibit — but "currently" is not a
 * guarantee worth resting a silent data bug on.
 */
export function resetExhibitOnceKeys(exhibitId: string): void {
  for (const key of [...fired]) {
    if (key.startsWith('viewer_interact:') && key.endsWith(`:${exhibitId}`)) fired.delete(key);
  }
}

/* ------------------------------------------------------------------------ page views */

/**
 * Promotes the hash route into the path GA4 will actually report on.
 *
 * `https://img2threejs.io/#/x/warrior` becomes `https://img2threejs.io/x/warrior`. The address bar
 * is untouched — this is only the URL reported to GA4 — and it is the difference between a Pages
 * report that lists every exhibit and content page, and one that lists `/` eleven thousand times.
 */
function reportableLocation(): string {
  const { origin, pathname, hash, search } = window.location;
  const route = hash.replace(/^#\/?/, '').split('?')[0];
  const base = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return `${origin}${base}${route}${search}`;
}

export function trackPageView(title: string): void {
  track('page_view', {
    page_location: reportableLocation(),
    page_title: clip(title),
    page_referrer: document.referrer || undefined,
  });
}

/* --------------------------------------------------------------------------- sponsors */

/**
 * Hostname → sponsor, so a sponsor link is attributed wherever it appears.
 *
 * This is what makes `tripoUrl` on a demo entry count for Tripo without every page having to
 * remember that Tripo is a sponsor: the provenance link in the exhibit panel resolves through the
 * same table as the card in the sponsor drawer, and both land in the same report row.
 */
function sponsorHosts(): Array<{ host: string; sponsor: SponsorEntry }> {
  const rows: Array<{ host: string; sponsor: SponsorEntry }> = [];
  for (const sponsor of SPONSORS) {
    for (const host of [hostOf(sponsor.url), ...(sponsor.domains ?? [])]) {
      if (host) rows.push({ host: host.replace(/^www\./, ''), sponsor });
    }
  }
  return rows;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** The sponsor a URL belongs to, or `null`. Matches subdomains, so `studio.tripo3d.ai` counts. */
export function resolveSponsor(url: string): SponsorEntry | null {
  const host = hostOf(url)?.replace(/^www\./, '');
  if (!host) return null;
  for (const { host: sponsorHost, sponsor } of sponsorHosts()) {
    if (host === sponsorHost || host.endsWith(`.${sponsorHost}`)) return sponsor;
  }
  return null;
}

/**
 * A sponsor's card was genuinely on screen. Deduplicated per sponsor per `round`, where the caller
 * passes a value that changes each time the surface is reopened — otherwise scrolling a card out of
 * view and back would inflate the denominator of every CTR we report.
 */
export function trackSponsorImpression(
  sponsor: SponsorEntry,
  placement: SponsorPlacement,
  round: number,
): void {
  trackOnce(`sponsor_impression:${placement}:${round}:${sponsor.id}`, 'sponsor_impression', {
    sponsor_id: sponsor.id,
    sponsor_name: sponsor.name,
    placement,
  });
}

/** The event the sponsor report is built on. */
export function trackSponsorClick(
  sponsor: SponsorEntry,
  placement: SponsorPlacement,
  detail: { url: string; cta?: string; exhibitId?: string } = { url: '' },
): void {
  track('sponsor_click', {
    sponsor_id: sponsor.id,
    sponsor_name: sponsor.name,
    placement,
    link_url: detail.url || sponsor.url,
    link_cta: detail.cta,
    exhibit_id: detail.exhibitId,
  });
}

/**
 * Money that comes in without a logo attached: coffee, the VietQR/MoMo/PayPal page, GitHub
 * Sponsors, Discord. Separate from `sponsor_click` so a logo sponsor's CTR is never diluted by
 * donation traffic, and reported per channel because that is the only way to learn which channel
 * a Vietnamese visitor and an overseas one each actually use.
 */
export type SupportChannel =
  | 'kofi'
  | 'donate_page'
  | 'paypal'
  | 'momo_vietqr'
  | 'discord'
  | 'github_sponsors'
  | 'email';

export function trackSupportClick(channel: SupportChannel, placement: string): void {
  track('support_click', { channel, placement });
}

/* ------------------------------------------------------------------------- exhibits */

export interface ExhibitFacts {
  id: string;
  title: string;
  subjectClass: string;
  status: string;
  generatedWith: string;
}

/** How the visitor arrived at this exhibit. The single most useful parameter on the whole site. */
export type ExhibitEntry =
  | 'default'
  | 'rail'
  | 'arrow'
  | 'keyboard'
  | 'palette'
  | 'deeplink'
  | 'hashchange';

export function trackExhibitView(
  demo: ExhibitFacts,
  entry: ExhibitEntry,
  surface: Surface,
): void {
  track('exhibit_view', {
    exhibit_id: demo.id,
    exhibit_title: demo.title,
    subject_class: demo.subjectClass,
    exhibit_status: demo.status,
    generated_with: demo.generatedWith,
    entry,
    surface,
  });
}

/**
 * The exhibit finished building and the viewer painted a real frame.
 *
 * `load_ms` is the number to watch: the two character exhibits precompute million-sample fields,
 * and a visitor who leaves during that never becomes an `exhibit_ready` at all — so the gap
 * between `exhibit_view` and `exhibit_ready` counts, per exhibit, is the abandonment rate for the
 * slow ones. That is a product signal no amount of session-duration averaging will give you.
 */
export function trackExhibitReady(
  demo: ExhibitFacts,
  facts: { loadMs: number; triangles: number; partCount: number; prewarm: boolean },
  surface: Surface,
): void {
  track('exhibit_ready', {
    exhibit_id: demo.id,
    exhibit_title: demo.title,
    load_ms: Math.round(facts.loadMs),
    triangles: facts.triangles,
    part_count: facts.partCount,
    prewarm: facts.prewarm,
    surface,
  });
}

export function trackExhibitPrewarmFailed(exhibitId: string, surface: Surface): void {
  track('exhibit_prewarm_failed', { exhibit_id: exhibitId, surface });
}

/**
 * The visitor actually touched the model, once per exhibit load. Orbiting fires continuously, so
 * this is the first input only: what it answers is "did they engage with the 3D at all", and a
 * per-frame version of that question would blow the property's event quota for no extra insight.
 */
export function trackViewerInteract(
  exhibitId: string,
  input: 'pointer' | 'wheel' | 'touch',
  surface: Surface,
): void {
  trackOnce(`viewer_interact:${surface}:${exhibitId}`, 'viewer_interact', {
    exhibit_id: exhibitId,
    input,
    surface,
  });
}

export function trackAnimationPlay(
  exhibitId: string,
  action: { id: string; label: string },
  surface: Surface,
): void {
  track('animation_play', {
    exhibit_id: exhibitId,
    action_id: action.id,
    action_label: action.label,
    surface,
  });
}

export function trackAnimationStop(exhibitId: string, surface: Surface): void {
  track('animation_stop', { exhibit_id: exhibitId, surface });
}

/**
 * Explode is a slider in the workbench and a toggle in the viewer. Callers debounce: the slider
 * emits an `input` event per pixel of travel, and one event per pixel is not a measurement.
 */
export function trackExplode(exhibitId: string, value: number, surface: Surface): void {
  track('explode_use', {
    exhibit_id: exhibitId,
    // Two decimals: the slider's own resolution. A raw float would fragment the report into
    // hundreds of near-identical values.
    explode_value: Math.round(value * 100) / 100,
    surface,
  });
}

export function trackPartSelect(
  exhibitId: string,
  part: { name: string; kind: string; triangles: number },
  surface: Surface,
): void {
  track('part_select', {
    exhibit_id: exhibitId,
    part_name: part.name,
    part_kind: part.kind,
    triangles: part.triangles,
    surface,
  });
}

export function trackPartIsolate(exhibitId: string, isolated: boolean, surface: Surface): void {
  track('part_isolate', { exhibit_id: exhibitId, isolated, surface });
}

export function trackQualitySwitch(exhibitId: string, level: string): void {
  track('quality_switch', { exhibit_id: exhibitId, quality_level: level });
}

/* ------------------------------------------------------------- navigation & reading */

export function trackDrawerOpen(drawer: string, source: string): void {
  track('drawer_open', { drawer, source });
}

/**
 * `search` with `search_term` is GA4's own recommended pair, so the command palette shows up in the
 * built-in site-search reporting instead of needing a custom report. The term is matched against a
 * fixed list of exhibit titles; a palette that accepted free text about anything else would not be
 * safe to report on.
 */
export function trackSearch(term: string, resultCount: number): void {
  const trimmed = term.trim();
  if (!trimmed) return;
  track('search', { search_term: trimmed.toLowerCase(), result_count: resultCount });
}

export function trackPaletteOpen(source: 'button' | 'keyboard'): void {
  track('palette_open', { source });
}

/** Which questions people actually open. The FAQ's own list of what the site failed to explain. */
export function trackFaqOpen(index: number, question: string): void {
  track('faq_open', { question_index: index, question: clip(question) });
}

export function trackSourceClick(exhibitId: string, surface: Surface): void {
  track('source_click', { exhibit_id: exhibitId, surface });
}

export function trackOpenFullViewer(exhibitId: string): void {
  track('open_full_viewer', { exhibit_id: exhibitId });
}

/**
 * Any outbound link that is not a sponsor and not a support channel — GitHub, ArtStation, an
 * author's profile, the licence. `placement` is required: knowing that 40 people left for GitHub is
 * worth very little next to knowing whether they left from the exhibit panel or the About page.
 */
export function trackOutboundClick(detail: {
  url: string;
  label?: string;
  placement: string;
  exhibitId?: string;
}): void {
  track('outbound_click', {
    link_url: detail.url,
    link_domain: hostOf(detail.url) ?? undefined,
    link_label: detail.label,
    placement: detail.placement,
    exhibit_id: detail.exhibitId,
  });
}

/* ------------------------------------------------------- one entry point for a link */

/**
 * Classifies and reports any clicked link on the site, so a delegated click handler does not have
 * to know the sponsor list or the payment channels.
 *
 * Order matters: a sponsor is checked first, because a sponsor click must never be double-counted
 * as a generic outbound click — the sponsor CTR we report to a sponsor is the ratio of two events
 * defined here, and a click that lands in both rows would make the two disagree.
 *
 * Support channels are matched on the URL rather than declared per link, because the same coffee
 * and donate links appear in the sponsor drawer, the mobile menu and the donate page, and the
 * channel is a property of the destination, not of where it was rendered.
 */
export function trackLinkClick(detail: {
  url: string;
  label?: string;
  /** Where on the site the link was rendered. Required — an unplaced click barely answers anything. */
  placement: string;
  exhibitId?: string;
  /** Passed by a sponsor card, which knows its own sponsor without a hostname lookup. */
  sponsorId?: string;
  /** Impression round, so a sponsor CTA click can be tied to the impression that preceded it. */
  sponsorPlacement?: SponsorPlacement;
}): void {
  const { url, label, placement, exhibitId } = detail;

  const sponsor = detail.sponsorId
    ? SPONSORS.find((s) => s.id === detail.sponsorId) ?? resolveSponsor(url)
    : resolveSponsor(url);
  if (sponsor) {
    trackSponsorClick(sponsor, detail.sponsorPlacement ?? sponsorPlacementFor(placement), {
      url,
      cta: label,
      exhibitId,
    });
    return;
  }

  const channel = supportChannelFor(url);
  if (channel) {
    trackSupportClick(channel, placement);
    return;
  }

  if (/^https?:/i.test(url)) {
    trackOutboundClick({ url, label, placement, exhibitId });
  }
}

/** Best-effort mapping from a UI placement string onto the sponsor placement vocabulary. */
function sponsorPlacementFor(placement: string): SponsorPlacement {
  if (placement.startsWith('drawer_sponsor')) return 'sponsor_drawer';
  if (placement.startsWith('drawer_menu')) return 'menu_drawer';
  if (placement.startsWith('demo')) return 'demo_provenance';
  return 'sponsor_drawer';
}

function supportChannelFor(url: string): SupportChannel | null {
  if (/^mailto:/i.test(url)) return 'email';
  // The donate page is served from this domain, so it has no hostname to match on.
  if (/donate\.html(?:[?#]|$)/i.test(url)) return 'donate_page';
  const host = hostOf(url)?.replace(/^www\./, '');
  if (!host) return null;
  if (host === 'ko-fi.com') return 'kofi';
  if (host === 'paypal.com' || host === 'paypal.me') return 'paypal';
  if (host === 'discord.gg' || host.endsWith('discord.com')) return 'discord';
  if (host === 'github.com' && /\/sponsors\//i.test(url)) return 'github_sponsors';
  return null;
}
