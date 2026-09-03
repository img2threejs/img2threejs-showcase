# Analytics

Google Analytics 4, installed for one primary reason: **logo sponsors are owed evidence that their
placement does something.** The whole sponsor report is two numbers per sponsor per month — how many
times the card was seen, how many times it was clicked — and everything else measured here exists to
answer "where do people actually spend their time on this site".

Every event the site can send is a named function in **[`src/analytics.ts`](../src/analytics.ts)**.
No page calls `gtag()` directly. If an event is not in that file, the site does not send it.

---

## 1. Setup, step by step

Nine steps. Steps 3, 4 and 5 are **not optional** — the site's own privacy page makes claims that
are only true if you do them, and step 5 prevents double-counted page views.

### Step 1 — Create the property and the data stream

1. <https://analytics.google.com> → **Admin** (bottom left) → **Create** → **Property**.
2. Property name `img2threejs`, reporting time zone **(GMT+07:00) Vietnam**, currency as you prefer.
3. Business details → whatever fits; objectives → **Examine user behavior**.
4. Platform → **Web**. Website URL `https://img2threejs.io`, stream name `img2threejs.io`.
5. On the stream page, copy the **Measurement ID** — it looks like `G-ABC1234XYZ`.

### Step 2 — Paste the Measurement ID in the two places that need it

It is not a secret; every visitor receives it in the page. It lives in the repo in the clear, in
**two** files, because `public/donate.html` is copied verbatim by Vite and cannot import from `src/`
(the same reason `index.html` duplicates `SITE_URL` in its Open Graph tags):

| File | What to change |
| --- | --- |
| `src/site-data.ts` | `export const GA_MEASUREMENT_ID: string = GA_MEASUREMENT_ID_PLACEHOLDER;` → `= 'G-ABC1234XYZ';` |
| `public/donate.html` | `var GA_MEASUREMENT_ID = 'G-XXXXXXXXXX';` → your ID |

Until both are changed, **nothing is sent at all** — no script is loaded, no `dataLayer` is created.
That is deliberate: an analytics install that silently half-works is worse than one that is off.

### Step 3 — Turn the advertising features off

The privacy page states that none of these are on. Make that true.

* **Admin → Data collection and modification → Data collection** → **Google signals**: off.
* Same screen → **Advertising personalization**: off (or exclude all regions).
* **Admin → Account settings → Data sharing settings**: uncheck the Google-products/advertising
  sharing options; leave technical support if you want it.

### Step 4 — Set data retention to 14 months

**Admin → Data collection and modification → Data retention** → **Event data retention: 14 months**
→ Save. The privacy page says 14 months by name, and the default for a new property is shorter than
that. 14 is also the shortest setting that still allows a year-on-year comparison in a sponsor report.

### Step 5 — Fix Enhanced measurement (this one matters)

**Admin → Data streams → your stream → Enhanced measurement → the gear icon.**

* **Page views → "Page changes based on browser history events": TURN THIS OFF.**
  The site is a hash router, and it rewrites the URL with `history.replaceState` every time you
  change exhibit or open a content page. Left on, GA4 would send its own page view for each of those
  *in addition* to the one the site sends, and every page-view number in the property would be
  roughly double. The site sends its own with `send_page_view: false` precisely so it can control this.
* **Site search: off.** The command palette already reports GA4's own `search` event with the real
  `search_term`; the automatic version looks for query parameters this site does not use.
* **Scrolls / Outbound clicks / File downloads: leave as they are.** They cost nothing and use
  different event names than ours, so they cannot double-count `outbound_click`.

### Step 6 — Register the custom dimensions

GA4 will collect the parameters immediately but will not *report* on them until they are registered,
and **registration is not retroactive** — so do this before you announce the site, not after.

**Admin → Data display → Custom definitions → Create custom dimension**, scope **Event** for every
one. Name it whatever reads well; the **Event parameter** must match exactly.

Do these five first — they are the sponsor report:

| Dimension name | Event parameter |
| --- | --- |
| Sponsor ID | `sponsor_id` |
| Sponsor name | `sponsor_name` |
| Placement | `placement` |
| Link CTA | `link_cta` |
| Support channel | `channel` |

Then these, for "where are people interacting":

| Dimension name | Event parameter |
| --- | --- |
| Exhibit ID | `exhibit_id` |
| Exhibit title | `exhibit_title` |
| Entry point | `entry` |
| Surface | `surface` |
| Drawer | `drawer` |
| Open source | `source` |
| Part name | `part_name` |
| Animation label | `action_label` |
| Quality level | `quality_level` |
| First input | `input` |
| FAQ question | `question` |
| Site version | `site_version` |

Optional, if you want them in reports: `subject_class`, `exhibit_status`, `generated_with`,
`action_id`, `part_kind`, `link_url`, `link_domain`, `link_label`, `prewarm`, `isolated`.

And as **custom metrics** (same screen, *Custom metrics* tab, scope Event, unit *Standard*
except where noted):

| Metric name | Event parameter | Unit |
| --- | --- | --- |
| Load time | `load_ms` | Milliseconds |
| Triangles | `triangles` | Standard |
| Part count | `part_count` | Standard |
| Explode value | `explode_value` | Standard |
| Search results | `result_count` | Standard |

### Step 7 — Mark the key events

**Admin → Data display → Key events → New key event** (older UI: *Conversions*):

* `sponsor_click` — the one that pays for the compute.
* `support_click` — donations.
* `source_click` — someone went to read generated code, which is the product's actual pitch.

Key events show up in the standard reports without an Exploration, which is what makes a monthly
sponsor number a thirty-second job instead of a report build.

### Step 8 — Verify before you trust it

Two independent checks, and do both:

1. **On the deployed site**: open `https://img2threejs.io/?analytics_debug=1#/` and watch the
   browser console. Every event prints with its parameters as it is sent, and if analytics is off
   the console says which of the five reasons it is off for. Then open **Admin → DebugView** in GA4
   and confirm the same events arrive there within a few seconds.
2. **Locally**: `npm run dev`, then `http://localhost:5173/?analytics_debug=1#/` (whatever port Vite
   prints). `analytics_debug=1`
   is what overrides the production-host allowlist, so this is the only way local events are sent —
   point it at a throwaway property, or just read the console and let the sends fail.

`?analytics_debug=1` is also the honest answer to a visitor who asks whether the privacy page is
accurate: it prints exactly what leaves the browser.

### Step 9 — Deploy

Nothing to configure. `.github/workflows/deploy.yml` builds and publishes on push to `main`; the
Measurement ID is in the source, so there is no secret to add and no workflow change to make.

---

## 2. Every event this site sends

`site_version` rides on all of them.

### Sponsors — the reason this exists

| Event | When | Parameters |
| --- | --- | --- |
| `sponsor_impression` | ≥25% of a sponsor's card is on screen, once per sponsor per opening of the sponsor page | `sponsor_id`, `sponsor_name`, `placement` |
| `sponsor_click` | A sponsor link is clicked **anywhere on the site** | `sponsor_id`, `sponsor_name`, `placement`, `link_url`, `link_cta`, `exhibit_id` |
| `support_click` | A donation or community channel is clicked | `channel`, `placement` |

`placement` for a sponsor is one of `sponsor_drawer`, `demo_provenance` (an exhibit's own
"Generated by Tripo" provenance link), `menu_drawer`, `donate_page`.
`channel` is one of `kofi`, `donate_page`, `paypal`, `discord`, `github_sponsors`, `email`.
`momo_vietqr` exists in the vocabulary but is never emitted: the MoMo/VietQR code is an image, and
the scan happens on a phone the page never hears from. Inventing an event for it would put a number
in the report that means nothing, so the donate page measures the two real links and stops there.

Attribution is by **hostname**, resolved against `SPONSORS` in `src/site-data.ts`. That is what makes
an exhibit's Tripo provenance link count for Tripo without `pages/demo.ts` knowing what a sponsor is —
add another sponsor link anywhere tomorrow and it is attributed with no code change.

### Exhibits

| Event | When | Parameters |
| --- | --- | --- |
| `exhibit_view` | An exhibit is selected or deep-linked | `exhibit_id`, `exhibit_title`, `subject_class`, `exhibit_status`, `generated_with`, `entry`, `surface` |
| `exhibit_ready` | The viewer painted a real frame — after prewarm, build, texture decode and shader compile | `exhibit_id`, `exhibit_title`, `load_ms`, `triangles`, `part_count`, `prewarm`, `surface` |
| `exhibit_prewarm_failed` | A heavy exhibit's precompute rejected and it fell back | `exhibit_id`, `surface` |
| `viewer_interact` | First orbit / zoom / touch, **once per exhibit load** | `exhibit_id`, `input`, `surface` |
| `animation_play` / `animation_stop` | An animation button | `exhibit_id`, `action_id`, `action_label`, `surface` |
| `explode_use` | Explode slider settled (700 ms debounce) or the viewer's toggle | `exhibit_id`, `explode_value`, `surface` |
| `part_select` / `part_isolate` | A named part is inspected | `exhibit_id`, `part_name`, `part_kind`, `triangles`, `surface` |
| `quality_switch` | A detail-level button, sent before the reload it triggers | `exhibit_id`, `quality_level` |

`entry` says how they got there: `default`, `rail`, `arrow`, `keyboard`, `palette`, `deeplink`,
`hashchange`. `surface` is `workbench` (the landing workbench) or `viewer` (`#/demo/:id`).

**The number worth watching**: `exhibit_view` minus `exhibit_ready`, per exhibit. A visitor who
leaves during a multi-second precompute never becomes an `exhibit_ready`, so that gap is the
abandonment rate for the slow exhibits — which no session-duration average will tell you.

### Navigation and reading

| Event | When | Parameters |
| --- | --- | --- |
| `page_view` | Every route, sent manually | `page_location`, `page_title`, `page_referrer` |
| `drawer_open` | A content page opens | `drawer`, `source` |
| `search` | Command palette query, settled (900 ms debounce) | `search_term`, `result_count` |
| `palette_open` | ⌘K or the Exhibits button | `source` |
| `faq_open` | A FAQ answer is expanded | `question_index`, `question` |
| `source_click` | "Read the source" / "View generated source" | `exhibit_id`, `surface` |
| `open_full_viewer` | Workbench → `#/demo/:id` | `exhibit_id` |
| `outbound_click` | Any other external link | `link_url`, `link_domain`, `link_label`, `placement`, `exhibit_id` |

`drawer_open`'s `source` distinguishes `header_nav`, `header_cta` (the Sponsor button in the top
bar), `menu_button`, `menu_drawer` and `deeplink` — which is how the header CTA earns its place.

**On `page_location`**: the route is promoted out of the fragment before it is reported, so
`https://img2threejs.io/#/x/warrior` is sent as `https://img2threejs.io/x/warrior`. The address bar
is untouched. Without this, GA4 strips the fragment and every route on the site reports as `/`.

---

## 3. The monthly sponsor report

**Explore → Blank**, then:

* **Dimensions**: add `Sponsor name`, `Placement`, `Event name`.
* **Metrics**: add `Event count`.
* **Rows**: `Sponsor name`. **Columns**: `Event name`. **Values**: `Event count`.
* **Filter**: `Event name` *matches regex* `sponsor_impression|sponsor_click`.
* Set the date range to the month.

That gives one row per sponsor with an impressions column and a clicks column; CTR is clicks ÷
impressions. Add `Placement` as a second row dimension to split a sponsor's own card from its
provenance links on the exhibits.

**Say what the numbers mean when you send them.** Impressions are "at least a quarter of the card
scrolled into view, counted once per visit to the sponsor page" — a deliberately conservative
denominator that does not count cards nobody scrolled to. Clicks are outbound clicks, not verified
arrivals; a sponsor's own analytics will read slightly lower, and it is better for them to hear that
from you first. Ad blockers suppress both sides of the ratio, so the CTR is sound even though the
absolute numbers are floors, not totals.

---

## 4. Changing things

**A new sponsor**: add an entry to `SPONSORS` in `src/site-data.ts` with a stable `id`. Impressions,
clicks and hostname attribution all start working with no other change. **Never rename an `id`** once
a report has gone out — it splits that sponsor's history into two rows.

**A new event**: add a named function to `src/analytics.ts` and call it from the page. Nothing else
should ever call `gtag()`. Then register any new parameters as custom dimensions (step 6) —
otherwise they are collected but not reportable.

**A change to what is collected**: update the privacy drawer in `src/content.ts` in the same commit.
It is written to match `src/analytics.ts` line for line, it names the cookies, and it tells visitors
to verify it with `?analytics_debug=1`. A privacy page that has drifted from the code is worse than
no privacy page, because it is a claim rather than an omission.

## 5. When nothing is sent

`src/analytics.ts` refuses to measure, in this order, and `?analytics_debug=1` prints which:

1. The Measurement ID is still the placeholder.
2. The visitor opted out — `img2threejs:analytics-opt-out` in `localStorage`, set by the switch on
   the privacy page or by `?analytics=off`. It also sets GA's own `ga-disable-<ID>` kill switch, so
   it takes effect without a reload.
3. A headless capture run (`?capture=1`, `mask`, `back`, `bg`, `reviewWhite`) — `scripts/capture-*.mjs`
   loads exhibit pages dozens of times per review and none of it is traffic.
4. An automated browser (`navigator.webdriver`) — the same reason, for runners that pass no flag.
5. The hostname is not in `ANALYTICS_HOSTS`, so `localhost`, `vite preview`, a fork's Pages build and
   any preview deploy cannot pollute the property the sponsor report is drawn from.
